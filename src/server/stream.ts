import "server-only";

import type { ApiUploadDetail, ReconcileEvent } from "~/types/assessment";
import { HttpError } from "./access";

const HEARTBEAT_MS = 3000;

/** True when the client asked for streamed progress. */
export const wantsStream = (request: Request) =>
  (request.headers.get("accept") ?? "").includes("application/x-ndjson");

/**
 * Stream a long-running job as newline-delimited JSON: progress events while
 * it runs, a heartbeat every few seconds (so neither the UI nor a proxy ever
 * sees a silent connection), then a final `result` or `error`.
 *
 * If the browser disconnects, the job keeps running; its outcome is stored
 * on the upload record either way. To stop it, call POST /api/uploads/:id/cancel
 * (the job watches the upload's status and aborts its model request).
 */
export function ndjson(job: (send: (e: ReconcileEvent) => void) => Promise<ApiUploadDetail | null>): Response {
  const encoder = new TextEncoder();
  const started = Date.now();
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: ReconcileEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(e)}\n`));
        } catch {
          closed = true; // client went away
        }
      };
      heartbeat = setInterval(() => send({ type: "ping", elapsedMs: Date.now() - started }), HEARTBEAT_MS);
      try {
        const upload = await job(send);
        if (upload) send({ type: "result", upload });
        else send({ type: "error", error: "Upload not found", status: 404 });
      } catch (e) {
        console.error("[stream] job failed", e);
        send({
          type: "error",
          error: e instanceof Error ? e.message : "Something went wrong",
          status: e instanceof HttpError ? e.status : 500,
        });
      } finally {
        clearInterval(heartbeat);
        if (!closed) {
          closed = true;
          controller.close();
        }
      }
    },
    cancel() {
      closed = true;
      clearInterval(heartbeat);
    },
  });

  return new Response(body, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
