/**
 * The Gemini client, against a fake network: what happens when the model is
 * slow, stalls, is rate limited or is cancelled, and how that depends on the
 * configured thinking level. No real API calls.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { PART_ROWS, partsOf, runAgent, triage, WHOLE_FILE_ROWS } from "~/server/reconcile/agent";
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

describe("large files: only the rows that need judgment go to the model", () => {
  // April: nothing stored at Downtown, so every row is a new showing. One every two hours.
  const slot = (n: number) => {
    const start = Date.UTC(2025, 3, 1, 10) + n * 2 * 3600_000;
    return [new Date(start).toISOString(), new Date(start + 90 * 60_000).toISOString()] as const;
  };
  const at = (n: number, title: string, room = `Auditorium ${(n % 4) + 1}`) => line(title, room, ...slot(n));
  const catalog = ["Dune: Part Two", "Wonka"];
  const known = (count: number, from = 0) => Array.from({ length: count }, (_, i) => at(from + i, i % 2 ? "Wonka" : "DUNE PART 2"));
  const premiere = (i: number) => `Premiere ${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}`;

  /** The CSV rows a prompt contains. */
  const shown = (call: Call) =>
    (JSON.parse(call.input.slice(call.input.indexOf("DATA (JSON):\n") + 13)) as { csvRows: { row: number; title: string; auditorium: string }[] }).csvRows;
  const titleCase = (t: string) => t.replace(/\b\w/g, (c) => c.toUpperCase());
  /** A model that calls every row it is shown a new showing, with a tidied title. */
  const addAll = (call: Call) =>
    answer(plan(shown(call).map((r) => decision(r.row, "add", { title: titleCase(r.title), auditorium: r.auditorium, explanation: "New showing." }))));

  it("a small file still goes to the model whole", async () => {
    fakeGemini(addAll);
    const p = prepare(csv(...known(WHOLE_FILE_ROWS)), { catalog });
    await runAgent(p.ctx, p.rows, p.invalid);
    assert.equal(calls.length, 1);
    assert.equal(shown(calls[0]!).length, WHOLE_FILE_ROWS);
    assert.ok(!calls[0]!.input.includes("one part of a larger file"));
  });

  it("exact matches are decided in code; one question is asked once and its answer reused", async () => {
    fakeGemini(addAll);
    const text = csv(
      ...known(44),
      ...Array.from({ length: 5 }, (_, i) => at(44 + i, "paper  lanterns", "Auditorium 1")), // a new film, five times
      at(49, "Wonka", "Screen 9"), // a known film in an unfamiliar room
    );
    const p = prepare(text, { catalog });
    const out = await runAgent(p.ctx, p.rows, p.invalid);

    assert.equal(calls.length, 1, "one model call for a 50-row file");
    assert.deepEqual(shown(calls[0]!).map((r) => r.row), [45, 50], "only the two rows that pose a question");
    assert.ok(calls[0]!.input.includes("one part of a larger file (50 rows)"));
    assert.equal(calls[0]!.thinkingLevel, "medium", "a single call keeps the level that was asked for");

    assert.equal(out.source, "agent");
    assert.equal(out.drafts.filter((d) => d.kind === "add").length, 50);
    assert.equal(out.drafts.filter((d) => d.source === "rule").length, 44);
    assert.deepEqual([...new Set(out.drafts.slice(0, 44).map((d) => d.movieTitle))].sort(), ["Dune: Part Two", "Wonka"], "catalog titles, not the file's spelling");
    const lanterns = out.drafts.filter((d) => d.csvRows.some((n) => n >= 45 && n <= 49));
    assert.deepEqual(lanterns.map((d) => `${d.movieTitle}/${d.source}`), Array.from({ length: 5 }, () => "Paper Lanterns/agent"));
    assert.match(lanterns[1]!.explanation, /same film as row 45/);
    assert.match(out.message, /^I went through all 50 rows and found 50 changes to propose\./);
    assert.match(out.summary, /44 of the 50 rows matched .* The model judged 2 rows that needed it, and its answers were reused for 4 more/);
    assert.deepEqual(out.warnings, []);
  });

  it("a file that is all exact matches needs no model call at all", async () => {
    fakeGemini(addAll);
    const p = prepare(csv(...known(60)), { catalog });
    const out = await runAgent(p.ctx, p.rows, p.invalid);
    assert.equal(calls.length, 0);
    assert.equal(out.source, "rule");
    assert.equal(out.error, null, "not a failure");
    assert.equal(out.drafts.filter((d) => d.kind === "add").length, 60);
    assert.match(out.message, /needed no AI guesswork\. I found 60 changes to propose/);
  });

  it("many rows that need judgment are split into parts that run side by side, thinking quickly", async () => {
    let open = 0;
    let peak = 0;
    fakeGemini(async (call) => {
      peak = Math.max(peak, ++open);
      await new Promise((r) => setTimeout(r, 10));
      open--;
      return addAll(call);
    });
    const p = prepare(csv(...Array.from({ length: 60 }, (_, i) => at(i, premiere(i)))), { catalog });
    const out = await runAgent(p.ctx, p.rows, p.invalid);

    assert.deepEqual(calls.map((c) => shown(c).length).sort((a, b) => b - a), [PART_ROWS, PART_ROWS, 10]);
    assert.ok(peak > 1, "parts overlap in time");
    assert.deepEqual([...new Set(calls.map((c) => `${c.model}/${c.thinkingLevel}`))], [`${MAIN}/low`]);
    assert.equal(out.drafts.filter((d) => d.kind === "add" && d.source === "agent").length, 60);
    assert.ok(out.warnings.some((w) => w.includes("needed 3 model calls")));
    assert.ok(!out.warnings.some((w) => w.includes("lighter pass")));
    for (const call of calls) {
      const stored = (JSON.parse(call.input.slice(call.input.indexOf("DATA (JSON):\n") + 13)) as { storedShowtimes: unknown[] }).storedShowtimes;
      assert.equal(stored.length, 0, "a part is shown only the schedule near its rows");
    }
  });

  it("a part the model cannot finish is decided by the rules, and only that part", async () => {
    fakeGemini((call) => (shown(call).some((r) => r.row === 1) ? httpError(500, "overloaded") : addAll(call)));
    const p = prepare(csv(...Array.from({ length: 60 }, (_, i) => at(i, premiere(i)))), { catalog });
    const out = await runAgent(p.ctx, p.rows, p.invalid);
    assert.equal(out.source, "agent");
    assert.equal(out.drafts.filter((d) => d.source === "rule").length, PART_ROWS);
    assert.equal(out.drafts.filter((d) => d.source === "agent").length, 35);
    assert.ok(out.warnings.some((w) => /on 1 of 3 parts, so 25 rows were matched by my basic rules/.test(w)), out.warnings.join(" | "));
  });

  it("when no part gets an answer the whole proposal is labelled rule-based", async () => {
    fakeGemini(() => httpError(403, "API key not valid"));
    const p = prepare(csv(...Array.from({ length: 60 }, (_, i) => at(i, premiere(i)))), { catalog });
    const out = await runAgent(p.ctx, p.rows, p.invalid);
    assert.equal(out.source, "rule");
    assert.match(out.message, /used my basic rules: 60 changes/);
  });

  it("after feedback every row goes back to the model, a part at a time", async () => {
    fakeGemini(addAll);
    const p = prepare(csv(...known(50)), { catalog });
    const previous = p.rows.map((r) => ({ kind: "add", rows: [r.row], title: r.movieTitle }));
    const out = await runAgent(p.ctx, p.rows, p.invalid, { text: "Use Auditorium 2 for the Wonka shows.", previous });
    assert.deepEqual(calls.map((c) => shown(c).length), [PART_ROWS, PART_ROWS]);
    assert.ok(calls.every((c) => c.input.includes("Use Auditorium 2 for the Wonka shows.")));
    const firstRows = new Set(shown(calls[0]!).map((r) => r.row));
    assert.ok(!calls[0]!.input.includes(`"rows":[${[...Array(51).keys()].slice(1).find((n) => !firstRows.has(n))}]`), "a part sees only its own previous decisions");
    assert.equal(out.drafts.filter((d) => d.source === "agent").length, 50);
  });

  it("a cancel stops every part and is never turned into a proposal", async () => {
    fakeGemini((_call, signal) => hang(signal));
    const cancel = new AbortController();
    setTimeout(() => cancel.abort(), 20);
    const p = prepare(csv(...Array.from({ length: 60 }, (_, i) => at(i, premiere(i)))), { catalog });
    await assert.rejects(runAgent(p.ctx, p.rows, p.invalid, undefined, undefined, cancel.signal), CancelledError);
  });

  describe("what counts as needing judgment", () => {
    const mar15 = (title: string, room: string, start = "2025-03-15T20:00:00Z") => line(title, room, start, "2025-03-15T22:46:00Z", { format: "IMAX" });
    const sort = (text: string) => {
      const p = prepare(text, { catalog });
      const t = triage(p.ctx, p.rows);
      return { decided: t.decided.map((d) => `${d.row}:${d.action}`), ask: t.ask.map((r) => r.row), followers: [...t.followers.values()].flat().map((f) => f.row.row) };
    };

    it("the stored showtime, exactly: decided (what changes is still worked out by the server)", () => {
      assert.deepEqual(sort(csv(mar15("Dune: Part Two", "Auditorium 1"))), { decided: ["1:update"], ask: [], followers: [] });
      assert.deepEqual(sort(csv(mar15("dune - part two", "auditorium 2"))).decided, ["1:update"], "case and punctuation are not a question; a known room is a room change");
    });

    it("another spelling, an unfamiliar room, or a showtime that may have moved: asked", () => {
      assert.deepEqual(sort(csv(mar15("DUNE PART 2", "Auditorium 1"))).ask, [1]);
      assert.deepEqual(sort(csv(mar15("Dune: Part Two", "Aud 1 (Laser)"))).ask, [1]);
      assert.deepEqual(sort(csv(mar15("Dune: Part Two", "Auditorium 1", "2025-03-15T20:30:00Z"))).ask, [1]);
    });

    it("a question is asked once: the same new film in several known rooms, or several known films in one new room", () => {
      const april = (n: number, title: string, room: string) => line(title, room, `2025-04-0${n}T18:00:00Z`, `2025-04-0${n}T20:00:00Z`);
      assert.deepEqual(
        sort(csv(april(1, "Paper Lanterns", "Auditorium 1"), april(2, "paper lanterns", "Auditorium 3"), april(3, "Wonka", "Screen 9"), april(4, "Dune: Part Two", "screen 9"), april(5, "Glass Harbor", "Screen 9"))),
        { decided: [], ask: [1, 3, 5], followers: [2, 4] },
      );
    });

    it("an exact repeat of an earlier row is a duplicate", () => {
      assert.deepEqual(sort(csv(mar15("Dune: Part Two", "Auditorium 1"), mar15("Dune: Part Two", "Auditorium 1"))).decided, ["1:update", "2:duplicate"]);
    });

    it("parts keep rows at the same start time together", () => {
      const rows = prepare(csv(...Array.from({ length: 30 }, (_, i) => line(premiere(i), "Auditorium 1", ...slot(i < 22 ? i : 22))))).rows;
      const parts = partsOf(rows);
      assert.deepEqual(parts.map((p) => p.length), [30], "rows 23 to 30 share a start time, so the part runs a little long");
    });
  });
});
