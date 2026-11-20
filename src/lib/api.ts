"use client";

import { useSyncExternalStore } from "react";
import type { ApiUploadDetail, QueryPlanSummary, ReconcileEvent } from "~/types/assessment";

export interface RequestLogEntry {
  id: number;
  at: number;
  method: string;
  url: string;
  status: number | "error";
  clientMs: number;
  serverMs?: number;
  rows?: number;
  plan?: QueryPlanSummary;
}

// A tiny external store so the Query Inspector can show live API traffic.
let log: RequestLogEntry[] = [];
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function record(entry: Omit<RequestLogEntry, "id" | "at">) {
  log = [{ ...entry, id: ++seq, at: Date.now() }, ...log].slice(0, 12);
  emit();
}

export function useRequestLog() {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => log,
    () => log,
  );
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * POST and read a newline-delimited JSON stream of ReconcileEvents.
 * Calls onEvent for every event; resolves with the final `result` upload.
 */
export async function streamApi(
  path: string,
  opts: { userId: string; body: unknown; onEvent: (e: ReconcileEvent) => void; signal?: AbortSignal },
): Promise<ApiUploadDetail> {
  const started = performance.now();
  let status: number | "error" = "error";
  try {
    const res = await fetch(path, {
      method: "POST",
      signal: opts.signal,
      headers: { "x-user-id": opts.userId, "content-type": "application/json", accept: "application/x-ndjson" },
      body: JSON.stringify(opts.body),
    });
    status = res.status;
    if (!res.ok || !res.body) {
      const payload = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new ApiError(res.status, payload?.error ?? `Request failed (${res.status})`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let result: ApiUploadDetail | null = null;
    const handle = (line: string) => {
      if (!line.trim()) return;
      const e = JSON.parse(line) as ReconcileEvent;
      opts.onEvent(e);
      if (e.type === "result") result = e.upload;
      if (e.type === "error") throw new ApiError(e.status ?? 500, e.error);
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let i: number;
      while ((i = buffer.indexOf("\n")) >= 0) {
        handle(buffer.slice(0, i));
        buffer = buffer.slice(i + 1);
      }
    }
    handle(buffer);
    if (!result) throw new ApiError(500, "The connection closed before ScopeBot finished.");
    return result;
  } finally {
    record({ method: "POST", url: `${path} (stream)`, status, clientMs: Math.round(performance.now() - started) });
  }
}

/** fetch wrapper: sends the mock-session user id, parses JSON, logs timing. */
export async function api<T>(
  path: string,
  opts: { userId?: string | null; method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const method = opts.method ?? "GET";
  const started = performance.now();
  let status: number | "error" = "error";
  let payload: unknown = null;
  try {
    const res = await fetch(path, {
      method,
      signal: opts.signal,
      headers: {
        ...(opts.userId ? { "x-user-id": opts.userId } : {}),
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    status = res.status;
    payload = await res.json().catch(() => null);
    if (!res.ok) {
      const message =
        (payload as { error?: string } | null)?.error ?? `Request failed (${res.status})`;
      throw new ApiError(res.status, message);
    }
    return payload as T;
  } finally {
    if (!opts.signal?.aborted) {
      const p = payload as {
        timing?: { queryMs?: number };
        rows?: unknown[];
        plan?: QueryPlanSummary;
      } | null;
      record({
        method,
        url: path,
        status,
        clientMs: Math.round(performance.now() - started),
        serverMs: p?.timing?.queryMs,
        rows: Array.isArray(p?.rows) ? p.rows.length : undefined,
        plan: p?.plan,
      });
    }
  }
}
