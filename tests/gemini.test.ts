/**
 * The Gemini client, against a fake network: what happens when the model is
 * slow, stalls, is rate limited or is cancelled, and how that depends on the
 * configured thinking level. No real API calls.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { runAgent } from "~/server/reconcile/agent";
import { CancelledError } from "~/server/reconcile/cancel";
import {
  attemptLadder, attemptTimeout, DEFAULT_TIMING, GeminiError, generateJson, type Timing,
} from "~/server/reconcile/gemini";
import { csv, decision, line, plan, prepare } from "./fixture";

const MAIN = "gemini-3.8-flash";
const LITE = "gemini-3.5-flash-lite";

// ------------------------------------------------------------ fake network

interface Call { model: string; thinkingLevel: string; input: string }
type Handler = (call: Call, signal: AbortSignal) => Response | Promise<Response>;
const calls: Call[] = [];

function fakeGemini(handler: Handler) {
  calls.length = 0;
  mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { model: string; input: string; generation_config: { thinking_level: string } };
    const call = { model: body.model, thinkingLevel: body.generation_config.thinking_level, input: body.input };
    calls.push(call);
    return handler(call, init.signal!);
  });
}
afterEach(() => mock.restoreAll());

const event = (data: object) => `data: ${JSON.stringify(data)}\n\n`;
/** A complete streamed answer: optional thought summaries, then the JSON output in two chunks. */
const answer = (json: unknown, thoughts: string[] = []) => answerText(JSON.stringify(json), thoughts);
function answerText(text: string, thoughts: string[] = []): Response {
  const half = Math.floor(text.length / 2);
  const body =
    event({ event_type: "interaction.created" }) +
    event({ event_type: "step.start", index: 0, step: { type: "thought" } }) +
    thoughts.map((t) => event({ event_type: "step.delta", index: 0, delta: { content: { text: t } } })).join("") +
    event({ event_type: "step.delta", index: 0, delta: { type: "thought_signature", signature: "x" } }) +
    event({ event_type: "step.start", index: 1, step: { type: "model_output" } }) +
    event({ event_type: "step.delta", index: 1, delta: { text: text.slice(0, half) } }) +
    event({ event_type: "step.delta", index: 1, delta: { text: text.slice(half) } }) +
    event({ event_type: "interaction.completed", interaction: { status: "completed" } });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}
/** Never answers; ends only when the client gives up. */
const hang = (signal: AbortSignal) =>
  new Promise<Response>((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
/** Opens the stream, sends one event, then goes silent. */
function stall(signal: AbortSignal): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(event({ event_type: "interaction.created" })));
      signal.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}
/** Keeps sending thought summaries forever: alive, but never done. */
function overthink(signal: AbortSignal): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(event({ event_type: "step.start", index: 0, step: { type: "thought" } })));
      const tick = setInterval(() => controller.enqueue(enc.encode(event({ event_type: "step.delta", index: 0, delta: { content: { text: "**Still deliberating**" } } }))), 15);
      signal.addEventListener("abort", () => {
        clearInterval(tick);
        controller.error(new DOMException("aborted", "AbortError"));
      });
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}
const httpError = (status: number, message: string) => new Response(JSON.stringify({ error: { message } }), { status });

/** Millisecond-scale limits so the tests run instantly; same shape as production. */
const FAST: Partial<Timing> = {
  budgetMs: 400, idleMs: 60, retryReserveMs: 100, minAttemptMs: 20,
  baseMs: { minimal: 80, low: 80, medium: 150, high: 200 },
  perRowMs: { minimal: 0, low: 0, medium: 0, high: 0 },
};

// ------------------------------------------------------------ the ladder (pure)

describe("attempt ladder", () => {
  it("steps down the thinking level before stepping down the model", () => {
    assert.deepEqual(attemptLadder(MAIN, LITE, "medium"), [
      { model: MAIN, thinkingLevel: "medium" },
      { model: MAIN, thinkingLevel: "low" },
      { model: LITE, thinkingLevel: "low" },
    ]);
    assert.deepEqual(attemptLadder(MAIN, LITE, "high").map((s) => s.thinkingLevel), ["high", "low", "low"]);
  });

  it("has no lighter level to retry at when already configured low or minimal", () => {
    assert.deepEqual(attemptLadder(MAIN, LITE, "low"), [{ model: MAIN, thinkingLevel: "low" }, { model: LITE, thinkingLevel: "low" }]);
    assert.deepEqual(attemptLadder(MAIN, LITE, "minimal").map((s) => s.thinkingLevel), ["minimal", "minimal"]);
    assert.equal(attemptLadder(MAIN, MAIN, "low").length, 1, "same model as fallback: one step");
  });

  it("allows more time for deeper thinking and for bigger files", () => {
    const t = (level: "low" | "medium" | "high", rows: number) => attemptTimeout({ model: MAIN, thinkingLevel: level }, rows, 1e9, false, DEFAULT_TIMING);
    assert.ok(t("low", 6) < t("medium", 6) && t("medium", 6) < t("high", 6));
    assert.ok(t("medium", 100) > t("medium", 6));
  });

  it("always leaves room in the budget for a fast retry, and never exceeds the budget", () => {
    const first = attemptTimeout({ model: MAIN, thinkingLevel: "high" }, 500, DEFAULT_TIMING.budgetMs, false, DEFAULT_TIMING);
    assert.equal(first, DEFAULT_TIMING.budgetMs - DEFAULT_TIMING.retryReserveMs);
    const last = attemptTimeout({ model: LITE, thinkingLevel: "low" }, 500, 12_000, true, DEFAULT_TIMING);
    assert.equal(last, 12_000);
    // The route's limit is 120 s; every attempt together must stay well inside it.
    assert.ok(DEFAULT_TIMING.budgetMs <= 105_000);
  });
});

// ------------------------------------------------------------ generateJson

describe("generateJson", () => {
  it("parses a streamed answer and streams thought summaries as they arrive", async () => {
    fakeGemini(() => answer({ ok: true }, ["**Comparing titles**\n\nLooking at row 1.", "**Checking rooms**"]));
    const seen: string[] = [];
    const r = await generateJson("input", {}, { onThought: (t) => seen.push(t) });
    assert.deepEqual(r.json, { ok: true });
    assert.equal(r.model, MAIN);
    assert.equal(r.thinkingLevel, "medium");
    assert.deepEqual(seen, ["**Comparing titles**\n\nLooking at row 1.", "**Checking rooms**"]);
  });

  it("a call that deliberates past its time limit is cut off and retried on the same model with less thinking", async () => {
    fakeGemini((call, signal) => (call.thinkingLevel === "medium" ? overthink(signal) : answer({ ok: true })));
    const attempts: string[] = [];
    const r = await generateJson("input", {}, { timing: FAST, onAttempt: (a) => attempts.push(`${a.model}/${a.thinkingLevel}/${a.reason ?? "first"}`) });
    assert.equal(r.thinkingLevel, "low");
    assert.deepEqual(attempts, [`${MAIN}/medium/first`, `${MAIN}/low/took too long`]);
  });

  it("a call that never answers at all is abandoned at the idle limit", async () => {
    fakeGemini((call, signal) => (call.thinkingLevel === "medium" ? hang(signal) : answer({ ok: true })));
    const reasons: (string | undefined)[] = [];
    const r = await generateJson("input", {}, { timing: FAST, onAttempt: (a) => reasons.push(a.reason) });
    assert.equal(r.thinkingLevel, "low");
    assert.deepEqual(reasons, [undefined, "stalled"]);
  });

  it("a stream that goes silent is detected long before the time limit", async () => {
    fakeGemini((call, signal) => (call.thinkingLevel === "medium" ? stall(signal) : answer({ ok: true })));
    const started = Date.now();
    const reasons: (string | undefined)[] = [];
    const r = await generateJson("input", {}, { timing: { ...FAST, baseMs: { ...FAST.baseMs!, medium: 5_000 }, budgetMs: 6_000 }, onAttempt: (a) => reasons.push(a.reason) });
    assert.equal(r.thinkingLevel, "low");
    assert.deepEqual(reasons, [undefined, "stalled"]);
    assert.ok(Date.now() - started < 1_000, "gave up after the idle limit, not the 5 s attempt limit");
  });

  it("a rate limit skips straight to the lighter model", async () => {
    fakeGemini((call) => (call.model === MAIN ? httpError(429, "quota exceeded") : answer({ ok: true })));
    const r = await generateJson("input", {}, { timing: FAST });
    assert.equal(r.model, LITE);
    assert.deepEqual(calls.map((c) => c.model), [MAIN, LITE]);
  });

  it("a rejected API key fails once, with no retries", async () => {
    fakeGemini(() => httpError(403, "API key not valid"));
    await assert.rejects(generateJson("input", {}, { timing: FAST }), (e) => e instanceof GeminiError && e.status === 403);
    assert.equal(calls.length, 1);
  });

  it("when every attempt hangs it gives up inside the budget", async () => {
    fakeGemini((_call, signal) => hang(signal));
    const started = Date.now();
    await assert.rejects(generateJson("input", {}, { timing: FAST }), (e) => e instanceof GeminiError && e.kind === "stalled");
    assert.ok(Date.now() - started <= FAST.budgetMs! + 150, `took ${Date.now() - started} ms`);
    assert.deepEqual(calls.map((c) => `${c.model}/${c.thinkingLevel}`), [`${MAIN}/medium`, `${MAIN}/low`, `${LITE}/low`]);
  });

  it("cancelling stops the call at once and is not retried", async () => {
    fakeGemini((_call, signal) => hang(signal));
    const cancel = new AbortController();
    setTimeout(() => cancel.abort(), 20);
    await assert.rejects(generateJson("input", {}, { timing: FAST, signal: cancel.signal }), CancelledError);
    assert.equal(calls.length, 1);
  });

  it("an answer that is not JSON is retried", async () => {
    let n = 0;
    fakeGemini(() => (n++ === 0 ? answerText("Sure! Here is the plan: {oops") : answer({ ok: true })));
    const r = await generateJson("input", {}, { timing: FAST });
    assert.deepEqual(r.json, { ok: true });
  });
});

// ------------------------------------------------------------ the agent around it

describe("runAgent with a fake model", () => {
  const text = csv(line("Dune: Part Two", "Auditorium 2", "2025-03-15T20:00:00Z", "2025-03-15T22:46:00Z", { format: "IMAX" }));
  const good = plan([decision(1, "update", { showtimeId: "st-dt-003", title: "Dune: Part Two", auditorium: "Auditorium 2", explanation: "Moves the 8:00 PM Dune showing to Auditorium 2." })]);

  it("turns the model's decisions into a verified proposal", async () => {
    fakeGemini(() => answer({ ...good, message: "I found 3 proposed changes. Does this look right?" }));
    const p = prepare(text);
    const out = await runAgent(p.ctx, p.rows, p.invalid);
    assert.equal(out.source, "agent");
    assert.equal(out.drafts.length, 1);
    assert.deepEqual(out.drafts[0]!.diffs, [{ field: "auditorium", oldValue: "Auditorium 1", newValue: "Auditorium 2" }]);
    assert.match(out.message, /^I found 1 proposed change\./, "the count in ScopeBot's line is corrected to the verified number");
  });

  it("falls back to rules, clearly labelled, when the model cannot be reached", async () => {
    fakeGemini(() => httpError(403, "API key not valid"));
    const p = prepare(text);
    const steps: string[] = [];
    const out = await runAgent(p.ctx, p.rows, p.invalid, undefined, (e) => e.type === "step" && steps.push(e.label));
    assert.equal(out.source, "rule");
    assert.equal(out.model, null);
    assert.equal(out.drafts[0]!.kind, "update");
    assert.match(out.message, /used my basic rules: 1 change\./);
    assert.ok(steps.some((s) => s.includes('so I used my basic rules')));
  });

  it("asks once for a repair when the answer does not fit the schema", async () => {
    let n = 0;
    fakeGemini(() => (n++ === 0 ? answer({ message: "hi", rows: "oops" }) : answer(good)));
    const p = prepare(text);
    const out = await runAgent(p.ctx, p.rows, p.invalid);
    assert.equal(out.source, "agent");
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.thinkingLevel, "low", "the repair turn does not need deep thinking");
  });

  it("says so when the answer came from a lighter pass than configured", async () => {
    fakeGemini((call) => (call.model === MAIN ? httpError(429, "quota") : answer(good)));
    const p = prepare(text);
    const out = await runAgent(p.ctx, p.rows, p.invalid);
    assert.equal(out.model, LITE);
    assert.ok(out.warnings.some((w) => w.includes('lighter pass')));
  });

  it("rows for another theater never reach the model and are never added", async () => {
    fakeGemini(() => answer(plan([decision(1, "unchanged", { showtimeId: "st-dt-003" })])));
    const mixed = csv(
      line("Dune: Part Two", "Auditorium 1", "2025-03-15T20:00:00Z", "2025-03-15T22:46:00Z", { format: "IMAX" }),
      line("The Fall Guy", "Auditorium A", "2025-03-15T19:15:00Z", "2025-03-15T21:21:00Z", { theater: "Riverside Multiplex" }),
    );
    const p = prepare(mixed);
    const out = await runAgent(p.ctx, p.rows, p.invalid);
    assert.ok(!calls[0]!.input.includes("The Fall Guy"), "the other theater's row is not in the prompt");
    assert.deepEqual(out.drafts.map((d) => d.kind), ["unchanged", "invalid"]);
    assert.match(out.drafts[1]!.explanation, /this row is for Riverside Multiplex, not Downtown Cinema 7/);
    assert.ok(out.warnings.some((w) => w.includes('1 row is for Riverside Multiplex')));
  });

  it("a file entirely for another theater proposes nothing and makes no model call", async () => {
    fakeGemini(() => answer(good));
    const p = prepare(csv(line("The Fall Guy", "Auditorium A", "2025-03-15T19:15:00Z", "2025-03-15T21:21:00Z", { theater: "Riverside Multiplex" })));
    const out = await runAgent(p.ctx, p.rows, p.invalid);
    assert.equal(calls.length, 0);
    assert.deepEqual(out.drafts.map((d) => d.kind), ["invalid"]);
    assert.match(out.message, /Every row in this file is for Riverside Multiplex/);
  });

  it("ScopeBot's line never claims work is finished before the review", async () => {
    fakeGemini(() => answer({ ...good, message: "All set! I applied 1 change to the schedule." }));
    const p = prepare(text);
    const out = await runAgent(p.ctx, p.rows, p.invalid);
    assert.equal(out.message, "I found 1 change to propose. Does this look right?");
  });

  it("the reviewer's Quick choice runs at low thinking, and is not reported as a lighter pass", async () => {
    fakeGemini(() => answer(good));
    const p = prepare(text);
    const out = await runAgent(p.ctx, p.rows, p.invalid, undefined, undefined, undefined, { thinkingLevel: "low" });
    assert.deepEqual(calls.map((c) => `${c.model}/${c.thinkingLevel}`), [`${MAIN}/low`]);
    assert.equal(out.thinkingLevel, "low");
    assert.ok(!out.warnings.some((w) => w.includes('lighter pass')), "low was what the reviewer asked for");
  });

  it("without a choice, the server's configured level is used", async () => {
    fakeGemini(() => answer(good));
    const p = prepare(text);
    const out = await runAgent(p.ctx, p.rows, p.invalid);
    assert.equal(calls[0]!.thinkingLevel, "medium");
    assert.equal(out.thinkingLevel, "medium");
  });

  it("a cancel is passed through, never turned into a rule-based proposal", async () => {
    fakeGemini((_call, signal) => hang(signal));
    const cancel = new AbortController();
    setTimeout(() => cancel.abort(), 20);
    const p = prepare(text);
    await assert.rejects(runAgent(p.ctx, p.rows, p.invalid, undefined, undefined, cancel.signal), CancelledError);
  });
});
