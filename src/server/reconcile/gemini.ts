import "server-only";

import { env } from "~/env";
import { CancelledError } from "./cancel";

/**
 * Minimal client for the Gemini Interactions API
 * (POST /v1beta/interactions) with JSON-schema constrained output and
 * thought summaries. No SDK: one fetch, parsed defensively.
 */

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
const API_REVISION = "2026-05-20";

export class GeminiError extends Error {
  constructor(
    message: string,
    public status: number | null,
    public retryable: boolean,
    /** "timeout": hit the attempt's time limit. "stalled": the stream went silent. */
    public kind: "timeout" | "stalled" | "error" = "error",
  ) {
    super(message);
  }
}

export interface GeminiResult {
  model: string;
  /** The level this answer was produced at (lower than configured if the first attempt was slow). */
  thinkingLevel: ThinkingLevel;
  json: unknown;
  thoughts: string[];
  latencyMs: number;
}

export const geminiConfigured = () => Boolean(env.GEMINI_API_KEY);

type Node = Record<string, unknown>;
const isObj = (v: unknown): v is Node => typeof v === "object" && v !== null && !Array.isArray(v);

/** Collect text from thought summaries and model output, whatever the nesting. */
function extract(body: unknown): { output: string; thoughts: string[] } {
  const outputs: string[] = [];
  const thoughts: string[] = [];
  const texts = (v: unknown, into: string[]) => {
    if (typeof v === "string") into.push(v);
    else if (Array.isArray(v)) v.forEach((x) => texts(x, into));
    else if (isObj(v)) {
      if (typeof v.text === "string") into.push(v.text);
      else Object.values(v).forEach((x) => texts(x, into));
    }
  };
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!isObj(v)) return;
    if (v.type === "thought" || v.thought === true) {
      texts(v.summary ?? (v.thought === true ? v.text : undefined), thoughts);
      return;
    }
    if (v.type === "model_output") {
      texts(v.content, outputs);
      return;
    }
    // generateContent-style candidates, in case the endpoint answers that way.
    if (Array.isArray(v.parts)) {
      for (const p of v.parts) {
        if (!isObj(p) || typeof p.text !== "string") continue;
        (p.thought === true ? thoughts : outputs).push(p.text);
      }
      return;
    }
    Object.values(v).forEach(walk);
  };
  walk(body);
  return { output: outputs.join(""), thoughts: thoughts.map((t) => t.trim()).filter(Boolean) };
}

function parseJsonLoose(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(t);
  } catch {
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(t.slice(start, end + 1));
    throw new GeminiError("Model returned text that is not JSON", null, true);
  }
}

interface CallLimits {
  timeoutMs: number;
  idleMs: number;
  signal?: AbortSignal;
  onThought?: (text: string) => void;
}

/** One attempt, bounded by a total time limit and a stall (idle) limit. */
async function callOnce(step: AttemptStep, input: string, schema: object, limits: CallLimits): Promise<GeminiResult> {
  const abort = new AbortController();
  let why: "timeout" | "stalled" | null = null;
  const stop = (kind: "timeout" | "stalled") => {
    why ??= kind;
    abort.abort();
  };
  const total = setTimeout(() => stop("timeout"), limits.timeoutMs);
  let idle = setTimeout(() => stop("stalled"), limits.idleMs);
  const alive = () => {
    clearTimeout(idle);
    idle = setTimeout(() => stop("stalled"), limits.idleMs);
  };
  const onCancel = () => abort.abort();
  limits.signal?.addEventListener("abort", onCancel, { once: true });
  if (limits.signal?.aborted) abort.abort();
  try {
    return await stream(step, input, schema, abort.signal, alive, limits.onThought);
  } catch (e) {
    if (limits.signal?.aborted) throw new CancelledError();
    if (why === "timeout") throw new GeminiError("Timed out waiting for the model", null, true, "timeout");
    if (why === "stalled") throw new GeminiError("The model stopped responding", null, true, "stalled");
    throw e;
  } finally {
    clearTimeout(total);
    clearTimeout(idle);
    limits.signal?.removeEventListener("abort", onCancel);
  }
}

async function stream(
  step: AttemptStep,
  input: string,
  schema: object,
  signal: AbortSignal,
  alive: () => void,
  onThought?: (text: string) => void,
): Promise<GeminiResult> {
  const { model, thinkingLevel } = step;
  const started = Date.now();
  const res = await fetch(ENDPOINT, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      "x-goog-api-key": env.GEMINI_API_KEY!,
      "api-revision": API_REVISION,
    },
    body: JSON.stringify({
      model,
      input,
      stream: true,
      response_format: { type: "text", mime_type: "application/json", schema },
      generation_config: {
        thinking_level: thinkingLevel,
        thinking_summaries: "auto",
        temperature: 0.2,
      },
    }),
  });
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    const msg =
      (isObj(body) && isObj(body.error) && typeof body.error.message === "string" && body.error.message) ||
      `HTTP ${res.status}`;
    throw new GeminiError(msg, res.status, res.status === 429 || res.status >= 500);
  }

  // Non-streaming answer (e.g. if the server ignores `stream`): parse as before.
  if (!res.headers.get("content-type")?.includes("text/event-stream")) {
    const { output, thoughts } = extract(await res.json());
    if (!output) throw new GeminiError("Model returned no output", res.status, true);
    thoughts.forEach((t) => onThought?.(t));
    return { model, thinkingLevel, json: parseJsonLoose(output), thoughts, latencyMs: Date.now() - started };
  }
  alive();

  // Server-sent events: step.start declares a step's type by index; step.delta
  // carries thought-summary text (thought steps) or answer text (model_output).
  const stepTypes = new Map<number, string>();
  const thoughts: string[] = [];
  let output = "";
  let status: string | null = null;
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const handle = (raw: string) => {
    const data = raw
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return;
    let evt: Node;
    try {
      evt = JSON.parse(data) as Node;
    } catch {
      return;
    }
    const type = evt.event_type;
    if (type === "error" || isObj(evt.error)) {
      const err = isObj(evt.error) ? evt.error : {};
      throw new GeminiError(typeof err.message === "string" ? err.message : "Stream error", null, true);
    }
    if (type === "step.start" && typeof evt.index === "number" && isObj(evt.step)) {
      stepTypes.set(evt.index, String(evt.step.type));
    } else if (type === "step.delta" && typeof evt.index === "number" && isObj(evt.delta)) {
      const delta = evt.delta;
      const stepType = stepTypes.get(evt.index);
      if (delta.type === "thought_signature") return;
      const text =
        typeof delta.text === "string" ? delta.text : isObj(delta.content) && typeof delta.content.text === "string" ? delta.content.text : "";
      if (!text) return;
      if (stepType === "thought" || delta.type === "thought_summary") {
        thoughts.push(text);
        onThought?.(text);
      } else {
        output += text;
      }
    } else if (type === "interaction.completed" && isObj(evt.interaction)) {
      status = typeof evt.interaction.status === "string" ? evt.interaction.status : null;
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    alive();
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let i: number;
    while ((i = buffer.indexOf("\n\n")) >= 0) {
      handle(buffer.slice(0, i));
      buffer = buffer.slice(i + 2);
    }
  }
  if (buffer.trim()) handle(buffer);
  if (!output) {
    throw new GeminiError(status === "incomplete" ? "Model ran out of output tokens" : "Model returned no output", null, true);
  }
  return { model, thinkingLevel, json: parseJsonLoose(output), thoughts: thoughts.map((t) => t.trim()).filter(Boolean), latencyMs: Date.now() - started };
}

// ------------------------------------------------------------------ attempts
//
// How long a call takes depends mostly on the thinking level (and a little on
// the file size), so the time limits do too. A slow or stalled call is retried
// once at a lighter thinking level before the lighter model is tried, and the
// whole thing fits inside one budget so the serverless function never dies
// mid-analysis. If every attempt fails the caller falls back to rules.

export const THINKING_LEVELS = ["minimal", "low", "medium", "high"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface Timing {
  /** Wall-clock budget for all attempts together (the route allows 120 s). */
  budgetMs: number;
  /** No bytes from the model for this long means the stream has stalled. */
  idleMs: number;
  /** Time kept back so a slow first attempt still leaves room for a fast retry. */
  retryReserveMs: number;
  /** Not worth starting an attempt with less than this left. */
  minAttemptMs: number;
  /** Per thinking level: time allowed for an attempt, plus an allowance per CSV row. */
  baseMs: Record<ThinkingLevel, number>;
  perRowMs: Record<ThinkingLevel, number>;
}

export const DEFAULT_TIMING: Timing = {
  budgetMs: 100_000,
  idleMs: 30_000,
  retryReserveMs: 25_000,
  minAttemptMs: 8_000,
  baseMs: { minimal: 25_000, low: 35_000, medium: 65_000, high: 75_000 },
  perRowMs: { minimal: 150, low: 150, medium: 250, high: 300 },
};

export interface AttemptStep {
  model: string;
  thinkingLevel: ThinkingLevel;
}

/** The lighter level a slow call is retried at. */
export const fasterLevel = (level: ThinkingLevel): ThinkingLevel => (level === "high" || level === "medium" ? "low" : level);

/**
 * Attempts in order: the configured model and thinking level, the same model
 * thinking less, then the lighter model. Steps that repeat are dropped, so a
 * "low" configuration has two steps and a "medium" one has three.
 */
export function attemptLadder(model: string, fallbackModel: string, level: ThinkingLevel): AttemptStep[] {
  const steps: AttemptStep[] = [
    { model, thinkingLevel: level },
    { model, thinkingLevel: fasterLevel(level) },
    { model: fallbackModel, thinkingLevel: fasterLevel(level) },
  ];
  return steps.filter((s, i) => steps.findIndex((o) => o.model === s.model && o.thinkingLevel === s.thinkingLevel) === i);
}

/** Time limit for one attempt, given what is left of the budget. */
export function attemptTimeout(step: AttemptStep, rows: number, remainingMs: number, isLast: boolean, timing: Timing): number {
  const wanted = timing.baseMs[step.thinkingLevel] + rows * timing.perRowMs[step.thinkingLevel];
  const afterReserve = remainingMs - (isLast ? 0 : timing.retryReserveMs);
  // If keeping a reserve would leave too little, spend what is left on this attempt.
  return Math.max(0, Math.min(wanted, afterReserve >= timing.minAttemptMs ? afterReserve : remainingMs));
}

export interface AttemptInfo extends AttemptStep {
  attempt: number;
  /** Why the previous attempt was abandoned (absent on the first). */
  reason?: string;
}

export interface GenerateOptions {
  /** Called with each thought-summary chunk as it streams in. */
  onThought?: (text: string) => void;
  /** Called when an attempt starts (including retries and fallbacks). */
  onAttempt?: (info: AttemptInfo) => void;
  /** Aborts the in-flight request (reviewer cancelled); throws CancelledError. */
  signal?: AbortSignal;
  /** CSV rows in the request; larger files are allowed more time. */
  rows?: number;
  /** Start from this thinking level instead of the configured one. */
  thinkingLevel?: ThinkingLevel;
  /** Override time limits (tests, or a caller with part of the budget already spent). */
  timing?: Partial<Timing>;
}

const describeFailure = (e: unknown) =>
  e instanceof GeminiError
    ? e.status === 429 ? "rate limited" : e.kind === "timeout" ? "took too long" : e.kind === "stalled" ? "stalled" : e.message
    : e instanceof Error ? e.message : "error";

/**
 * Generate JSON for `schema`, streaming thoughts. Walks the attempt ladder
 * until one attempt returns valid JSON or the budget runs out.
 */
export async function generateJson(input: string, schema: object, opts: GenerateOptions = {}): Promise<GeminiResult> {
  if (!env.GEMINI_API_KEY) throw new GeminiError("GEMINI_API_KEY is not set", null, false);
  const timing: Timing = { ...DEFAULT_TIMING, ...opts.timing };
  const deadline = Date.now() + timing.budgetMs;
  const steps = attemptLadder(env.GEMINI_MODEL, env.GEMINI_FALLBACK_MODEL, opts.thinkingLevel ?? env.GEMINI_THINKING_LEVEL);
  let last: unknown;
  let reason: string | undefined;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const remaining = deadline - Date.now();
    if (remaining < timing.minAttemptMs && i > 0) break;
    const timeoutMs = attemptTimeout(step, opts.rows ?? 0, remaining, i === steps.length - 1, timing);
    try {
      opts.onAttempt?.({ ...step, attempt: i, reason });
      return await callOnce(step, input, schema, { timeoutMs, idleMs: timing.idleMs, signal: opts.signal, onThought: opts.onThought });
    } catch (e) {
      if (e instanceof CancelledError || opts.signal?.aborted) throw new CancelledError();
      last = e;
      reason = describeFailure(e);
      const status = e instanceof GeminiError ? e.status : null;
      // A bad or unauthorised key fails the same way on every attempt.
      if (status === 401 || status === 403) break;
      // Rate limits and unknown-model errors belong to this model: skip to the next one.
      if (status === 429 || (status !== null && status >= 400 && status < 500)) {
        const next = steps.findIndex((s, j) => j > i && s.model !== step.model);
        if (next === -1) break;
        i = next - 1;
      }
    }
  }
  throw last instanceof Error ? last : new GeminiError("Model call failed", null, false);
}
