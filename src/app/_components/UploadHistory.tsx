"use client";

import { useEffect, useState } from "react";
import { api } from "~/lib/api";
import type { ApiUploadSummary, UploadStatus } from "~/types/assessment";

const STATUS: Record<UploadStatus, { label: string; className: string }> = {
  received: { label: "received", className: "bg-gray-700 text-gray-200" },
  analyzing: { label: "analyzing", className: "bg-purple-900/70 text-purple-200" },
  pending_review: { label: "awaiting review", className: "bg-amber-900/70 text-amber-200" },
  applying: { label: "applying", className: "bg-purple-900/70 text-purple-200" },
  applied: { label: "applied", className: "bg-green-900/70 text-green-200" },
  partially_applied: { label: "partly applied", className: "bg-amber-900/70 text-amber-200" },
  discarded: { label: "discarded", className: "bg-gray-700 text-gray-300" },
  failed: { label: "failed", className: "bg-red-900/70 text-red-200" },
};

/** Upload times are real moments (an audit trail), so they show in the viewer's own timezone. */
const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function outcome(u: ApiUploadSummary): string {
  if (u.status === "failed" && u.appliedCount === 0 && u.failedCount === 0) return u.error ?? "Could not be read";
  if (u.status === "applied" || u.status === "partially_applied" || u.status === "failed") {
    return `${plural(u.appliedCount, "change")} applied${u.failedCount ? `, ${u.failedCount} failed` : ""}`;
  }
  if (u.status === "analyzing" || u.status === "received") return "Analysis did not finish";
  const parts = [
    u.addsCount && `${u.addsCount} new`,
    u.updatesCount && `${u.updatesCount} updated`,
    u.archivesCount && `${u.archivesCount} not in file`,
  ].filter(Boolean);
  return parts.length ? `Proposed: ${parts.join(", ")}` : "No changes proposed";
}

const INITIAL = 5;

/**
 * Every CSV upload for the selected theater, newest first: what was proposed,
 * what was applied, and by whom. A proposal still awaiting review can be
 * reopened here (for example after a page refresh).
 */
export function UploadHistory({
  userId,
  theaterId,
  canReview,
  refreshKey,
  onOpen,
  onCancelStuck,
}: {
  userId: string;
  theaterId: string;
  /** Admins can resume a pending review; everyone else gets the read-only view. */
  canReview: boolean;
  /** Bump to reload (after an upload, apply, discard or cancel). */
  refreshKey: number;
  onOpen: (upload: ApiUploadSummary) => void;
  onCancelStuck: (upload: ApiUploadSummary) => void;
}) {
  const [uploads, setUploads] = useState<ApiUploadSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    api<{ uploads: ApiUploadSummary[] }>(`/api/uploads?theaterId=${encodeURIComponent(theaterId)}`, {
      userId,
      signal: controller.signal,
    })
      .then((d) => {
        setUploads(d.uploads);
        setError(null);
      })
      .catch((e: Error) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [userId, theaterId, refreshKey]);

  const shown = showAll ? (uploads ?? []) : (uploads ?? []).slice(0, INITIAL);
  // An analysis that has sat for minutes has lost its worker; let an admin clear it.
  const stuck = (u: ApiUploadSummary) =>
    (u.status === "analyzing" || u.status === "received") && Date.now() - Date.parse(u.createdAt) > 3 * 60_000;

  return (
    <details open className="mb-6 rounded-lg border border-gray-700 bg-gray-900">
      <summary className="cursor-pointer select-none px-4 py-3 text-xs font-semibold uppercase tracking-wide text-gray-400">
        Upload history{uploads ? ` (${uploads.length}${uploads.length >= 25 ? "+" : ""})` : ""}
      </summary>
      <div className="border-t border-gray-800 px-4 py-3">
        {error && <p className="text-sm text-red-300">{error}</p>}
        {!error && uploads === null && <p className="text-sm text-gray-500">Loading…</p>}
        {!error && uploads?.length === 0 && (
          <p className="text-sm text-gray-500">No CSV uploads for this theater yet. Each one will be recorded here.</p>
        )}
        <ul className="divide-y divide-gray-800">
          {shown.map((u) => (
            <li key={u.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2 text-sm">
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${STATUS[u.status].className}`}>
                {STATUS[u.status].label}
              </span>
              <span className="font-medium text-white">{u.fileName}</span>
              <span className="text-gray-400">{outcome(u)}</span>
              <span className="ml-auto text-xs text-gray-500">
                {u.uploadedByName ?? "Unknown"} · {when(u.createdAt)}
              </span>
              {stuck(u) && canReview && (
                <button
                  onClick={() => onCancelStuck(u)}
                  className="rounded border border-gray-600 px-2.5 py-1 text-xs text-gray-200 transition hover:border-red-400 hover:text-red-300"
                >
                  Clear
                </button>
              )}
              <button
                onClick={() => onOpen(u)}
                className={`rounded px-2.5 py-1 text-xs font-medium transition ${
                  u.status === "pending_review" && canReview
                    ? "bg-purple-600 text-white hover:bg-purple-700"
                    : "border border-gray-600 text-gray-200 hover:bg-gray-800"
                }`}
              >
                {u.status === "pending_review" && canReview ? "Resume review" : "View"}
              </button>
            </li>
          ))}
        </ul>
        {(uploads?.length ?? 0) > INITIAL && (
          <button onClick={() => setShowAll((v) => !v)} className="mt-2 text-xs text-purple-300 hover:underline">
            {showAll ? "Show fewer" : `Show all ${uploads!.length}`}
          </button>
        )}
      </div>
    </details>
  );
}
