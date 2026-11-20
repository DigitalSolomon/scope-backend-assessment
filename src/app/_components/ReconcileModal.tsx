"use client";

import { formatShowtime } from "~/lib/format";
import { useEffect, useMemo, useState } from "react";
import type { ApiChange, ApiUploadDetail } from "~/types/assessment";
import { ScopeBot, SpeechBubble } from "./ScopeBot";
import { ThinkingPanel, type ReconcileProgress } from "./ThinkingPanel";

/** "view" is a read-only look at a past upload, opened from the upload history. */
export type ReconcilePhase = "thinking" | "review" | "feedback" | "applying" | "done" | "error" | "view";

interface ReconcileModalProps {
  open: boolean;
  phase: ReconcilePhase;
  fileName: string;
  theaterName: string;
  upload: ApiUploadDetail | null;
  error: string | null;
  /** Live, streamed progress while ScopeBot works. */
  progress: ReconcileProgress;
  /** The reviewer chose Quick mode (less reasoning, faster). */
  quick: boolean;
  onCancel: () => void;
  /** Stop an analysis in progress (thinking phase). */
  onStopAnalysis: () => void;
  onConfirm: (rejectedChangeIds: string[]) => void;
  onRequestFeedback: () => void;
  onRetry: (feedback: string) => void;
  onCloseFeedback: () => void;
  onClose: () => void;
}

const ACTIONABLE = new Set(["add", "update", "reactivate", "archive"]);

const formatDateTime = formatShowtime;

const FIELD_LABELS: Record<string, string> = {
  movieTitle: "title",
  auditorium: "auditorium",
  startTime: "start",
  endTime: "end",
  language: "language",
  format: "format",
  rating: "rating",
  status: "status",
};
const formatValue = (field: string, v: string) => (field === "startTime" || field === "endTime" ? formatDateTime(v) : v);

function thinkingLines(fileName: string, theaterName: string, retry: boolean) {
  return retry
    ? ["Got it, taking another look…", "Re-reading the file with your notes…", "Re-checking my matches…", "Almost there…"]
    : [
        `Reading ${fileName}…`,
        `Comparing it with ${theaterName}'s schedule…`,
        "Untangling titles and auditorium names…",
        "Double-checking for duplicates…",
        "Writing up what I found…",
      ];
}

function ConfidenceChip({ value }: { value: number | null }) {
  if (value === null) return null;
  const pct = Math.round(value * 100);
  const tone =
    pct >= 85 ? "bg-green-900/60 text-green-200" : pct >= 60 ? "bg-amber-900/60 text-amber-200" : "bg-red-900/60 text-red-200";
  return <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${tone}`}>{pct}% sure</span>;
}

/** What happened to a change, for the read-only view of a past upload. */
function outcomeOf(item: ApiChange): { label: string; className: string } {
  if (item.applyError) return { label: "failed", className: "bg-red-900/70 text-red-200" };
  if (item.appliedAt) return { label: "applied", className: "bg-green-900/70 text-green-200" };
  if (item.decision === "rejected") return { label: "not selected", className: "bg-gray-700 text-gray-300" };
  return { label: "not applied", className: "bg-gray-700 text-gray-300" };
}

function ChangeCard({
  item,
  tone,
  rejected,
  onToggle,
  readOnly = false,
}: {
  item: ApiChange;
  tone: "green" | "yellow" | "red";
  rejected: boolean;
  onToggle: () => void;
  readOnly?: boolean;
}) {
  const tones = {
    green: "border-green-900 bg-green-950/40",
    yellow: "border-yellow-900 bg-yellow-950/40",
    red: "border-red-900 bg-red-950/40",
  };
  return (
    <div className={`rounded-lg border p-4 transition-opacity ${tones[tone]} ${rejected && !readOnly ? "opacity-40" : ""}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-semibold text-white">
            {item.movieTitle}
            {item.kind === "reactivate" && (
              <span className="ml-2 rounded bg-blue-900/70 px-1.5 py-0.5 text-[10px] uppercase text-blue-200">
                reactivate
              </span>
            )}
          </div>
          <div className="mt-1 text-sm text-gray-300">
            {formatDateTime(item.startTime)} – {formatDateTime(item.endTime)}
          </div>
        </div>
        {readOnly ? (
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${outcomeOf(item).className}`}>
            {outcomeOf(item).label}
          </span>
        ) : (
          <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-gray-400">
            <input type="checkbox" checked={!rejected} onChange={onToggle} className="accent-purple-500" />
            apply
          </label>
        )}
      </div>
      {item.kind === "add" && (
        <div className="mt-2 flex flex-wrap gap-2 text-xs text-gray-400">
          <span>{item.auditorium}</span>•<span>{item.language || "—"}</span>•<span>{item.format || "—"}</span>•
          <span>{item.rating || "—"}</span>
        </div>
      )}
      {item.diffs.length > 0 && item.kind !== "archive" && (
        <div className="mt-2 space-y-1">
          {item.diffs.map((d) => (
            <div key={d.field} className="text-sm">
              <span className="text-gray-400">{FIELD_LABELS[d.field] ?? d.field}:</span>{" "}
              <span className="text-red-400 line-through">{formatValue(d.field, d.oldValue)}</span> →{" "}
              <span className="text-green-400">{formatValue(d.field, d.newValue)}</span>
            </div>
          ))}
        </div>
      )}
      {item.explanation && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-gray-300">
          <span className="font-[family-name:var(--font-typewriter)] italic">ScopeBot: {item.explanation}</span>
          <ConfidenceChip value={item.confidence} />
          {item.source === "rule" && (
            <span className="rounded-full bg-gray-700 px-2 py-0.5 text-[10px] text-gray-300">rule-based</span>
          )}
        </div>
      )}
      {item.applyError && <div className="mt-2 text-xs text-red-300">Failed: {item.applyError}</div>}
    </div>
  );
}

function Section({ title, color, items, note, children }: { title: string; color: string; items: number; note?: string; children: React.ReactNode }) {
  if (!items) return null;
  return (
    <div>
      <h3 className={`mb-3 flex items-center text-lg font-semibold ${color}`}>
        <span className="mr-2 flex h-6 w-6 items-center justify-center rounded-full bg-white/10 text-xs">{items}</span>
        {title}
      </h3>
      {note && <p className="-mt-1 mb-3 text-sm text-gray-400">{note}</p>}
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function InfoList({ title, items }: { title: string; items: ApiChange[] }) {
  if (!items.length) return null;
  return (
    <details className="rounded-lg border border-gray-800 bg-gray-950/50 p-3 text-sm text-gray-400">
      <summary className="cursor-pointer select-none font-medium text-gray-300">
        {title} ({items.length})
      </summary>
      <ul className="mt-2 space-y-1">
        {items.map((i) => (
          <li key={i.id}>
            <span className="text-gray-500">row {i.csvRows.join(", ")}:</span> {i.movieTitle || "—"}
            {i.startTime && <span className="text-gray-500"> · {formatDateTime(i.startTime)}</span>}
            {i.explanation && <span className="text-gray-500"> — {i.explanation}</span>}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function ReconcileModal(props: ReconcileModalProps) {
  const { open, phase, fileName, theaterName, upload, error } = props;
  const [lineIndex, setLineIndex] = useState(0);
  const [feedback, setFeedback] = useState("");
  const [rejected, setRejected] = useState<Set<string>>(new Set());
  const isRetry = (upload?.events ?? []).some((e) => e.kind === "feedback");

  // Rotate the thinking lines while the agent works.
  useEffect(() => {
    if (!open || (phase !== "thinking" && phase !== "applying")) return;
    setLineIndex(0);
    const id = window.setInterval(() => setLineIndex((i) => i + 1), 2600);
    return () => window.clearInterval(id);
  }, [open, phase]);

  // Fresh proposal => default selection again. Showings that are merely
  // missing from the file start unticked: the file may be a patch, so
  // archiving them is the reviewer's call.
  useEffect(() => {
    const suggestions = (upload?.items ?? []).filter((i) => !i.preselected).map((i) => i.id);
    setRejected(new Set(suggestions));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upload?.id, upload?.analyzedAt]);
  // A read-only view has nothing to lose, so Escape closes it.
  const { onClose } = props;
  useEffect(() => {
    if (!open || phase !== "view") return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, phase, onClose]);
  useEffect(() => {
    if (phase === "feedback") setFeedback("");
  }, [phase]);

  const groups = useMemo(() => {
    const items = upload?.items ?? [];
    return {
      adds: items.filter((i) => i.kind === "add"),
      updates: items.filter((i) => i.kind === "update" || i.kind === "reactivate"),
      // Asked for by the reviewer (ticked) vs. merely missing from the file (suggestions).
      archives: items.filter((i) => i.kind === "archive" && i.preselected),
      missing: items.filter((i) => i.kind === "archive" && !i.preselected),
      unchanged: items.filter((i) => i.kind === "unchanged"),
      duplicates: items.filter((i) => i.kind === "duplicate"),
      invalid: items.filter((i) => i.kind === "invalid"),
    };
  }, [upload]);

  if (!open) return null;

  const actionable = (upload?.items ?? []).filter((i) => ACTIONABLE.has(i.kind));
  const selectedCount = actionable.filter((i) => !rejected.has(i.id)).length;
  const toggle = (id: string) =>
    setRejected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const lines = phase === "applying" ? ["Applying your changes…", "Saving everything…"] : thinkingLines(fileName, theaterName, isRetry);
  const line = lines[Math.min(lineIndex, lines.length - 1)]!;

  // ----------------------------------------------------------- live analysis
  if (phase === "thinking") {
    // A fresh upload has no record on screen yet; a retry re-analyzes the one shown.
    const retrying = upload !== null;
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-2 sm:p-4">
        <div className="max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-xl bg-gray-900 p-5 shadow-2xl sm:p-6">
          <ThinkingPanel
            progress={props.progress}
            fallbackLine={line}
            title={retrying ? "Taking another look with your feedback" : `Analyzing ${fileName}`}
            quick={props.quick}
          />
          <div className="mt-5 flex items-center justify-end gap-3 border-t border-gray-800 pt-4">
            <span className="text-xs text-gray-500">
              {retrying ? "Cancelling keeps my previous proposal." : "Nothing changes in your schedule until you confirm."}
            </span>
            <button
              type="button"
              onClick={props.onStopAnalysis}
              className="rounded-lg border border-gray-600 px-4 py-2 text-sm text-gray-200 transition hover:border-red-400 hover:text-red-300"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ----------------------------------------------------------- centered states
  if (phase === "applying" || phase === "done" || phase === "error") {
    const doneText =
      upload?.status === "applied"
        ? `All set! I applied ${upload.appliedCount} change${upload.appliedCount === 1 ? "" : "s"} to ${theaterName}.`
        : upload?.status === "partially_applied"
          ? `I applied ${upload.appliedCount}, but ${upload.failedCount} couldn't be saved. The details are in the upload history.`
          : upload?.status === "failed"
            ? "None of the changes could be saved. The reasons are in the upload history."
            : upload?.status === "discarded"
              ? "Okay, nothing was applied."
              : "Done.";
    const text =
      phase === "error"
        ? error ?? upload?.error ?? "Something went wrong."
        : phase === "done"
          ? doneText
          : line;
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
        <div className="flex w-full max-w-lg flex-col items-center gap-2 rounded-xl bg-gray-900 px-6 pt-8 pb-6 shadow-2xl">
          <SpeechBubble text={text} tail="bottom" className="max-w-md" animate={phase !== "applying"} />
          <ScopeBot mood={phase === "applying" ? "thinking" : "idle"} size={220} />
          {(phase === "done" || phase === "error") && (
            <button
              onClick={props.onClose}
              className="mt-2 rounded-lg bg-purple-600 px-8 py-2 font-medium text-white transition hover:bg-purple-700"
            >
              {phase === "done" ? "Close" : "OK"}
            </button>
          )}
        </div>
      </div>
    );
  }

  // ----------------------------------------------------------- review (+ feedback overlay)
  const readOnly = phase === "view";
  const total = groups.adds.length + groups.updates.length + groups.archives.length;
  const plural = (n: number) => `${n} change${n === 1 ? "" : "s"}`;
  const pastText =
    upload?.status === "applied"
      ? `I applied ${plural(upload.appliedCount)} from this file.`
      : upload?.status === "partially_applied"
        ? `I applied ${plural(upload.appliedCount)}; ${upload.failedCount} couldn't be saved.`
        : upload?.status === "discarded"
          ? "This proposal was discarded. Nothing was applied."
          : upload?.status === "failed"
            ? `This upload failed: ${upload.error ?? "unknown error"}`
            : upload?.status === "analyzing" || upload?.status === "received"
              ? "This upload never finished analyzing."
              : null;
  const botText =
    (readOnly ? pastText : null) ??
    upload?.botMessage ??
    (total ? `I see ${plural(total)}. Does this look right?` : "Everything already matches. Nothing to change!");
  const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-2 sm:p-4">
      <div className="relative flex max-h-[92vh] w-full max-w-4xl flex-col rounded-xl bg-gray-900 shadow-2xl">
        {/* Header with ScopeBot top-right, per the wireframe */}
        <div className="relative z-10 border-b border-gray-700 px-6 pt-5 pb-4">
          <h2 className="text-2xl font-bold text-white">
            {readOnly ? "Upload Details" : "Preview Changes"}
            <span className="ml-2 text-sm text-gray-400">
              {readOnly ? `(${upload?.status.replace("_", " ")})` : `(${total} total)`}
            </span>
          </h2>
          <p className="mt-1 text-xs text-gray-500">
            {fileName} → {theaterName}
            {upload?.model && (
              <>
                {" "}
                · analyzed by {upload.model}
                {upload.thinkingLevel && ` (${upload.thinkingLevel === "low" || upload.thinkingLevel === "minimal" ? "quick" : "thorough"})`}
              </>
            )}
            {readOnly && upload && <> · uploaded by {upload.uploadedByName ?? "unknown"}, {when(upload.createdAt)}</>}
          </p>
          <div className="absolute top-2 right-2 flex items-start gap-2 sm:right-4">
            <SpeechBubble text={botText} tail="right" className="mt-6 hidden max-w-sm sm:block" />
            <ScopeBot mood="idle" size={124} className="-mb-10" />
          </div>
        </div>

        <div className="flex-1 space-y-6 overflow-y-auto p-6">
          {/* Mobile: bubble below the header */}
          <SpeechBubble text={botText} tail="none" className="sm:hidden" />

          {upload?.source === "rule" && (
            <div className="rounded-lg border border-amber-800 bg-amber-950/40 p-3 text-sm text-amber-200">
              The AI step didn&apos;t run, so these are rule-based suggestions. Review them carefully.
            </div>
          )}
          {(upload?.warnings ?? []).length > 0 && (
            <ul className="space-y-1 rounded-lg border border-amber-900 bg-amber-950/20 p-3 text-sm text-amber-200">
              {upload!.warnings.map((w, i) => (
                <li key={i}>⚠ {w}</li>
              ))}
            </ul>
          )}

          {total === 0 && groups.missing.length === 0 && !readOnly && (
            <p className="text-center text-gray-400">No changes needed. The schedule already matches this file.</p>
          )}

          <Section title="New Showtimes" color="text-green-400" items={groups.adds.length}>
            {groups.adds.map((i) => (
              <ChangeCard key={i.id} item={i} tone="green" rejected={rejected.has(i.id)} onToggle={() => toggle(i.id)} readOnly={readOnly} />
            ))}
          </Section>
          <Section title="Updated Showtimes" color="text-yellow-400" items={groups.updates.length}>
            {groups.updates.map((i) => (
              <ChangeCard key={i.id} item={i} tone="yellow" rejected={rejected.has(i.id)} onToggle={() => toggle(i.id)} readOnly={readOnly} />
            ))}
          </Section>
          <Section title="Archived Showtimes" color="text-red-400" items={groups.archives.length}>
            {groups.archives.map((i) => (
              <ChangeCard key={i.id} item={i} tone="red" rejected={rejected.has(i.id)} onToggle={() => toggle(i.id)} readOnly={readOnly} />
            ))}
          </Section>
          <Section
            title="Not in This File"
            color="text-red-400"
            items={groups.missing.length}
            note={
              readOnly
                ? undefined
                : "These active showings are on days this file covers but aren't in it. If the file is the full schedule for those days, tick the ones to archive; if it's a partial update, leave them."
            }
          >
            {groups.missing.map((i) => (
              <ChangeCard key={i.id} item={i} tone="red" rejected={rejected.has(i.id)} onToggle={() => toggle(i.id)} readOnly={readOnly} />
            ))}
          </Section>

          <div className="space-y-2">
            <InfoList title="Already up to date" items={groups.unchanged} />
            <InfoList title="Duplicate rows (ignored)" items={groups.duplicates} />
            <InfoList title="Skipped rows" items={groups.invalid} />
            {(Boolean(upload?.summary) || (upload?.thoughts.length ?? 0) > 0) && (
              <details className="rounded-lg border border-gray-800 bg-gray-950/50 p-3 text-sm text-gray-400">
                <summary className="cursor-pointer select-none font-medium text-gray-300">How ScopeBot decided</summary>
                {upload?.summary && <p className="mt-2 text-gray-300">{upload.summary}</p>}
                {upload?.thoughts.map((t, i) => (
                  <p key={i} className="mt-2 whitespace-pre-wrap font-[family-name:var(--font-typewriter)] text-xs text-gray-400">
                    {t}
                  </p>
                ))}
              </details>
            )}
            {readOnly && (upload?.events.length ?? 0) > 0 && (
              <details open className="rounded-lg border border-gray-800 bg-gray-950/50 p-3 text-sm text-gray-400">
                <summary className="cursor-pointer select-none font-medium text-gray-300">Activity log</summary>
                <ul className="mt-2 space-y-1">
                  {upload!.events.map((e) => (
                    <li key={e.id}>
                      <span className="text-gray-500">{when(e.createdAt)}</span>{" "}
                      <span className={e.kind === "error" ? "text-red-300" : e.kind === "feedback" ? "text-purple-300" : "text-gray-300"}>
                        {e.kind === "feedback" ? `Feedback: “${e.message}”` : (e.message ?? e.status)}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        </div>

        {readOnly ? (
          <div className="flex justify-end border-t border-gray-700 px-6 py-4">
            <button
              onClick={props.onClose}
              className="rounded-lg bg-purple-600 px-8 py-2 font-medium text-white transition hover:bg-purple-700"
            >
              Close
            </button>
          </div>
        ) : (
        <div className="flex flex-wrap justify-end gap-3 border-t border-gray-700 px-6 py-4">
          <button
            onClick={props.onCancel}
            className="rounded-lg border border-gray-500 px-6 py-2 font-medium text-white transition hover:bg-gray-800"
          >
            Cancel
          </button>
          <button
            onClick={props.onRequestFeedback}
            className="rounded-lg bg-[#b85441] px-5 py-2 font-medium text-white transition hover:bg-[#a04636]"
          >
            Reject w/ Feedback
          </button>
          <button
            onClick={() => props.onConfirm([...rejected])}
            disabled={selectedCount === 0}
            className="rounded-lg bg-purple-600 px-6 py-2 font-medium text-white transition hover:bg-purple-700 disabled:opacity-50"
          >
            Confirm {selectedCount !== actionable.length ? `${selectedCount} of ${actionable.length}` : "Changes"}
          </button>
        </div>
        )}

        {/* Feedback overlay */}
        {phase === "feedback" && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center rounded-xl bg-black/75 p-4">
            <div className="w-full max-w-3xl rounded-3xl bg-white p-6 shadow-2xl sm:p-8">
              <h3 className="mb-5 font-[family-name:var(--font-typewriter)] text-2xl text-gray-900 sm:text-4xl">
                &ldquo;How should I apply these changes?&rdquo;
              </h3>
              <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
                <textarea
                  autoFocus
                  value={feedback}
                  onChange={(e) => setFeedback(e.target.value)}
                  placeholder="Enter your feedback here."
                  rows={7}
                  className="min-h-40 flex-1 resize-none bg-gray-200 p-4 font-[family-name:var(--font-typewriter)] text-gray-900 placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-purple-500"
                />
                <div className="flex flex-col gap-3 sm:w-72">
                  <button
                    onClick={() => props.onRetry(feedback.trim())}
                    disabled={!feedback.trim()}
                    className="rounded-xl bg-[#6aa368] py-3 text-lg font-medium text-white transition hover:bg-[#5b9159] disabled:opacity-50"
                  >
                    Try Again
                  </button>
                  <button
                    onClick={props.onCloseFeedback}
                    className="rounded-xl bg-[#b85441] py-3 text-lg font-medium text-white transition hover:bg-[#a04636]"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
            <ScopeBot mood="idle" size={220} className="-mt-2" />
          </div>
        )}
      </div>
    </div>
  );
}
