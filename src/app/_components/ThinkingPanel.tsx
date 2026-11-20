"use client";

import { useEffect, useRef, useState } from "react";
import type { ReconcileStepKey } from "~/types/assessment";
import { ScopeBot, SpeechBubble } from "./ScopeBot";

export interface ReconcileProgress {
  steps: Partial<Record<ReconcileStepKey, { state: "active" | "done" | "warn"; label: string }>>;
  thoughts: string[];
  startedAt: number;
  lastEventAt: number;
}

export const emptyProgress = (): ReconcileProgress => ({
  steps: {},
  thoughts: [],
  startedAt: Date.now(),
  lastEventAt: Date.now(),
});

const STEP_ORDER: { key: ReconcileStepKey; pending: string }[] = [
  { key: "received", pending: "Receive the file" },
  { key: "parsed", pending: "Read and clean the rows" },
  { key: "context", pending: "Load the stored schedule" },
  { key: "model", pending: "Think it through" },
  { key: "verify", pending: "Double-check every match" },
  { key: "saved", pending: "Write up the proposal" },
];

/** Thought summaries arrive as "**Heading**\n\nBody". */
function splitThought(raw: string): { heading: string | null; body: string } {
  // The model occasionally emits escaped newlines ("\n") inside summaries.
  const t = raw.replace(/\\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  const m = /^\s*\*\*(.+?)\*\*\s*/.exec(t);
  return m ? { heading: m[1]!.trim(), body: t.slice(m[0].length).trim() } : { heading: null, body: t.trim() };
}

/** "Assessing Data Freshness" -> "Assessing data freshness…" */
const asBubble = (heading: string) => {
  const s = heading.replace(/[.:]+$/, "");
  return `${s.charAt(0)}${s.slice(1).toLowerCase()}…`;
};

function StepIcon({ state }: { state?: "active" | "done" | "warn" }) {
  if (state === "done") return <span className="text-green-400">✓</span>;
  if (state === "warn") return <span className="text-amber-400">!</span>;
  if (state === "active")
    return (
      <span className="relative flex h-2.5 w-2.5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-purple-400 opacity-75" />
        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-purple-400" />
      </span>
    );
  return <span className="h-2 w-2 rounded-full border border-gray-600" />;
}

export function ThinkingPanel({
  progress,
  fallbackLine,
  title,
  quick = false,
}: {
  progress: ReconcileProgress;
  fallbackLine: string;
  title: string;
  /** Quick mode: faster, and Gemini rarely narrates its reasoning. */
  quick?: boolean;
}) {
  const [now, setNow] = useState(Date.now());
  const feedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, []);

  // Keep the newest thought in view.
  useEffect(() => {
    const el = feedRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [progress.thoughts.length]);

  const elapsed = Math.max(0, Math.floor((now - progress.startedAt) / 1000));
  const quietFor = (now - progress.lastEventAt) / 1000;
  const thinking = progress.steps.model?.state === "active";

  const latest = progress.thoughts.length ? splitThought(progress.thoughts[progress.thoughts.length - 1]!) : null;
  const active = STEP_ORDER.map((s) => progress.steps[s.key]).filter((s) => s?.state === "active").pop();
  const bubble = thinking && latest?.heading ? asBubble(latest.heading) : (active?.label ?? fallbackLine);

  const reassurance =
    elapsed > 60
      ? "Taking longer than usual, but I'm still on it."
      : thinking && elapsed > 8
        ? quick
          ? "Quick mode usually takes about 10 seconds."
          : "Gemini usually takes 20–40 seconds on a file like this."
        : null;

  return (
    <div className="grid gap-6 md:grid-cols-[minmax(0,15rem)_1fr]">
      {/* ScopeBot + what he's doing right now */}
      <div className="flex flex-col items-center gap-2">
        <SpeechBubble text={bubble} tail="bottom" animate={false} className="w-full text-center text-sm" />
        <ScopeBot mood="thinking" size={200} />
      </div>

      <div className="flex min-w-0 flex-col gap-4">
        <div>
          <h3 className="text-lg font-semibold text-white">{title}</h3>
          <div className="mt-1 flex items-center gap-2 text-xs text-gray-400">
            <span
              className={`h-2 w-2 rounded-full ${quietFor < 6 ? "bg-green-400" : "bg-amber-400"}`}
              title={quietFor < 6 ? "Live connection" : "Waiting for the next update"}
            />
            <span className="tabular-nums">
              {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
            </span>
            <span>·</span>
            <span>{quietFor < 6 ? "live" : "waiting on Gemini…"}</span>
          </div>
        </div>

        <ol className="space-y-1.5 text-sm">
          {STEP_ORDER.map(({ key, pending }) => {
            const s = progress.steps[key];
            return (
              <li key={key} className="flex items-center gap-3">
                <span className="flex w-4 justify-center">
                  <StepIcon state={s?.state} />
                </span>
                <span
                  className={
                    s?.state === "active"
                      ? "text-white"
                      : s?.state === "warn"
                        ? "text-amber-300"
                        : s
                          ? "text-gray-300"
                          : "text-gray-600"
                  }
                >
                  {s?.label ?? pending}
                </span>
              </li>
            );
          })}
        </ol>

        <div className="rounded-lg border border-gray-800 bg-gray-950/70">
          <div className="border-b border-gray-800 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
            ScopeBot&apos;s thoughts
          </div>
          <div ref={feedRef} className="max-h-56 space-y-3 overflow-y-auto px-3 py-3" aria-live="polite">
            {progress.thoughts.length === 0 ? (
              <p className="text-sm text-gray-600">
                {quick
                  ? "Quick mode skips most of the step-by-step reasoning. Switch to Thorough to watch me think."
                  : progress.steps.model
                    ? "Warming up…"
                    : "Thoughts will appear here once I start reasoning."}
              </p>
            ) : (
              progress.thoughts.map((t, i) => {
                const { heading, body } = splitThought(t);
                const newest = i === progress.thoughts.length - 1;
                return (
                  <div
                    key={i}
                    className={`text-sm transition-opacity duration-500 ${newest ? "opacity-100" : "opacity-60"}`}
                  >
                    {heading && <div className="font-semibold text-purple-200">{heading}</div>}
                    <p className="whitespace-pre-wrap text-gray-300">{body}</p>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {reassurance && <p className="text-xs text-gray-500">{reassurance}</p>}
      </div>
    </div>
  );
}
