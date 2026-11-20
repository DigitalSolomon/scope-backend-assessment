import "server-only";

import { sql } from "../db";

/** Thrown when the reviewer cancelled an analysis; never triggers the rule fallback. */
export class CancelledError extends Error {
  constructor() {
    super("Cancelled by the reviewer");
  }
}

const POLL_MS = 2000;

/**
 * Watch an analyzing upload for cancellation. Cancel is an explicit API call
 * that moves the upload out of `analyzing` in the database, so this works even
 * when the cancel request lands on a different serverless instance (browser
 * disconnects are not a reliable signal on Vercel).
 */
export function watchCancel(uploadId: string) {
  const controller = new AbortController();
  const timer = setInterval(() => {
    sql<{ status: string }[]>`select status from hv_theater.csv_uploads where id = ${uploadId}`
      .then(([u]) => {
        if (u?.status !== "analyzing") controller.abort(new CancelledError());
      })
      .catch(() => undefined); // a failed poll just waits for the next one
  }, POLL_MS);
  return {
    signal: controller.signal,
    stop: () => clearInterval(timer),
    check: () => {
      if (controller.signal.aborted) throw new CancelledError();
    },
  };
}
