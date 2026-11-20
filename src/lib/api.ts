"use client";

import { useSyncExternalStore } from "react";
import type { QueryPlanSummary } from "~/types/assessment";

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
