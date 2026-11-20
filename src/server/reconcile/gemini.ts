import "server-only";

import { env } from "~/env";

/**
 * Minimal client for the Gemini Interactions API
 * (POST /v1beta/interactions) with JSON-schema constrained output and
 * thought summaries. No SDK: one fetch, parsed defensively.
 */

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
const API_REVISION = "2026-05-20";
const FALLBACK_MODEL = "gemini-3.5-flash-lite";

export class GeminiError extends Error {
  constructor(
    message: string,
    public status: number | null,
    public retryable: boolean,
  ) {
    super(message);
  }
}

export interface GeminiResult {
  model: string;
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

async function callOnce(
  model: string,
  input: string,
  schema: object,
  signal: AbortSignal,
  onThought?: (text: string) => void,
): Promise<GeminiResult> {
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
        thinking_level: env.GEMINI_THINKING_LEVEL,
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
    return { model, json: parseJsonLoose(output), thoughts, latencyMs: Date.now() - started };
  }

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
    buffer += decoder.decode(value, { stream: true });
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
  return { model, json: parseJsonLoose(output), thoughts: thoughts.map((t) => t.trim()).filter(Boolean), latencyMs: Date.now() - started };
}

export interface GenerateOptions {
  timeoutMs?: number;
  /** Called with each thought-summary chunk as it streams in. */
  onThought?: (text: string) => void;
  /** Called when a model attempt starts (including retries and fallbacks). */
  onAttempt?: (info: { model: string; attempt: number; reason?: string }) => void;
}

/** Generate JSON for `schema`, streaming thoughts. Retries once, then falls back to a lighter model on rate limits. */
export async function generateJson(input: string, schema: object, opts: GenerateOptions = {}): Promise<GeminiResult> {
  if (!env.GEMINI_API_KEY) throw new GeminiError("GEMINI_API_KEY is not set", null, false);
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 100_000);
  const models = [...new Set([env.GEMINI_MODEL, FALLBACK_MODEL])];
  let last: unknown;
  let reason: string | undefined;
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        opts.onAttempt?.({ model, attempt, reason });
        return await callOnce(model, input, schema, signal, opts.onThought);
      } catch (e) {
        last = e;
        if (signal.aborted) throw new GeminiError("Timed out waiting for the model", null, false);
        reason = e instanceof GeminiError && e.status === 429 ? "rate limited" : e instanceof Error ? e.message : "error";
        const retryable = e instanceof GeminiError ? e.retryable : true;
        if (!retryable) break; // try the next model (e.g. unknown model id) or give up
        if (e instanceof GeminiError && e.status === 429) break; // rate limited: switch model now
        await new Promise((r) => setTimeout(r, 800));
      }
    }
  }
  throw last instanceof Error ? last : new GeminiError("Model call failed", null, false);
}
