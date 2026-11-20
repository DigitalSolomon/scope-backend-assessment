import "server-only";

import { z } from "zod";
import { normalizeKey } from "~/lib/normalize";
import type { ChangeKind, FieldDiff } from "~/types/assessment";
import type { CsvRow, InvalidRow } from "./csv";
import { similarity, tokens, type ReconcileContext, type StoredShowtime } from "./context";

// ------------------------------------------------------------------ the change set
//
// The agent (or the rule fallback) returns an AgentPlan: one decision per CSV
// row plus archive proposals. It never states field values or diffs; the
// server derives those from the database and the cleaned CSV, so a model
// cannot misreport what changes.

export const ROW_ACTIONS = ["add", "update", "unchanged", "duplicate", "invalid"] as const;

export const agentPlanSchema = z.object({
  message: z.string().min(1).max(400),
  summary: z.string().max(2000).default(""),
  rows: z.array(
    z.object({
      row: z.number().int(),
      action: z.enum(ROW_ACTIONS),
      showtimeId: z.string().nullable().optional(),
      duplicateOfRow: z.number().int().nullable().optional(),
      title: z.string().nullable().optional(),
      auditorium: z.string().nullable().optional(),
      explanation: z.string().max(600).default(""),
      confidence: z.number().min(0).max(1).default(0.8),
    }),
  ),
  archive: z
    .array(
      z.object({
        showtimeId: z.string(),
        explanation: z.string().max(600).default(""),
        confidence: z.number().min(0).max(1).default(0.8),
      }),
    )
    .default([]),
});
export type AgentPlan = z.infer<typeof agentPlanSchema>;
type RowDecision = AgentPlan["rows"][number];

/** JSON Schema handed to the model as its response format (mirrors agentPlanSchema). */
export const agentPlanJsonSchema = {
  type: "object",
  properties: {
    message: {
      type: "string",
      description:
        "What ScopeBot says to the reviewer, in character: one or two short, friendly sentences that state the number of proposed changes and ask if it looks right.",
    },
    summary: {
      type: "string",
      description: "A short plain-language overview of the reasoning, for the reviewer.",
    },
    rows: {
      type: "array",
      description: "Exactly one decision for every CSV row number provided.",
      items: {
        type: "object",
        properties: {
          row: { type: "integer", description: "The CSV row number." },
          action: { type: "string", enum: [...ROW_ACTIONS] },
          showtimeId: {
            type: ["string", "null"],
            description: "For update/unchanged: the id of the stored showtime this row is.",
          },
          duplicateOfRow: {
            type: ["integer", "null"],
            description: "For duplicate: the row number this row repeats.",
          },
          title: {
            type: ["string", "null"],
            description:
              "Canonical movie title to store. Use the stored title exactly when it is the same film; otherwise a cleaned version of the CSV title.",
          },
          auditorium: {
            type: ["string", "null"],
            description:
              "Canonical auditorium name to store. Use an existing auditorium name exactly when it is the same room; otherwise the cleaned CSV name.",
          },
          explanation: { type: "string", description: "One sentence a theater manager can act on." },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
        required: ["row", "action", "showtimeId", "duplicateOfRow", "title", "auditorium", "explanation", "confidence"],
      },
    },
    archive: {
      type: "array",
      description: "Stored showtimes (from archiveCandidates only) that should be archived.",
      items: {
        type: "object",
        properties: {
          showtimeId: { type: "string" },
          explanation: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
        required: ["showtimeId", "explanation", "confidence"],
      },
    },
  },
  required: ["message", "summary", "rows", "archive"],
} as const;

// ------------------------------------------------------------------ drafts

export interface ChangeDraft {
  kind: ChangeKind;
  csvRows: number[];
  showtimeId: string | null;
  showtimeVersion: number | null;
  movieTitle: string;
  auditorium: string;
  startTime: string;
  endTime: string;
  language: string;
  format: string;
  rating: string;
  explanation: string;
  confidence: number;
  source: "agent" | "rule";
  diffs: FieldDiff[];
}

/** Active showtimes on the file's days that no row matched: the archive candidates. */
export function archiveCandidates(ctx: ReconcileContext, matched: Set<string>): StoredShowtime[] {
  return ctx.stored.filter(
    (s) =>
      s.status === "active" &&
      s.startTime >= ctx.window.from &&
      s.startTime < ctx.window.to &&
      !matched.has(s.id),
  );
}

const FIELD_NAMES: Record<string, string> = {
  startTime: "start", endTime: "end", language: "language", format: "format", rating: "rating",
};

const sameText = (a: string, b: string) => a.trim() === b.trim();
const sameCode = (a: string, b: string) => a.trim().toUpperCase() === b.trim().toUpperCase();

function diffAgainst(s: StoredShowtime, p: Omit<ChangeDraft, "kind" | "diffs" | "csvRows" | "showtimeId" | "showtimeVersion" | "explanation" | "confidence" | "source">): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  const push = (field: string, oldValue: string, newValue: string) => diffs.push({ field, oldValue, newValue });
  if (!sameText(s.movieTitle, p.movieTitle)) push("movieTitle", s.movieTitle, p.movieTitle);
  if (!sameText(s.auditorium, p.auditorium)) push("auditorium", s.auditorium, p.auditorium);
  if (s.startTime !== p.startTime) push("startTime", s.startTime, p.startTime);
  if (s.endTime !== p.endTime) push("endTime", s.endTime, p.endTime);
  if (p.language && !sameCode(s.language, p.language)) push("language", s.language, p.language);
  if (p.format && !sameCode(s.format, p.format)) push("format", s.format, p.format);
  if (p.rating && !sameCode(s.rating, p.rating)) push("rating", s.rating, p.rating);
  return diffs;
}

/**
 * Turn decisions into verified change drafts. Anything the agent got wrong
 * (unknown id, a showtime claimed twice, a missing row) is replaced by the
 * rule-based decision for that row and reported in `issues`.
 */
export function materialize(
  ctx: ReconcileContext,
  rows: CsvRow[],
  invalid: InvalidRow[],
  plan: AgentPlan,
  source: "agent" | "rule",
  fallback: AgentPlan,
): { drafts: ChangeDraft[]; issues: string[] } {
  const issues: string[] = [];
  const byRow = new Map<number, RowDecision>();
  for (const d of plan.rows) if (!byRow.has(d.row)) byRow.set(d.row, d);
  const fallbackByRow = new Map(fallback.rows.map((d) => [d.row, d]));

  const drafts: ChangeDraft[] = [];
  const claimed = new Map<string, number>(); // showtimeId -> row that matched it
  const resolvedRow = new Map<number, ChangeDraft>(); // for duplicate references

  for (const row of rows) {
    let decision = byRow.get(row.row);
    let src: "agent" | "rule" = source;
    const replaceWithRule = (why: string) => {
      issues.push(`Row ${row.row}: ${why}; used the rule-based decision instead.`);
      decision = fallbackByRow.get(row.row);
      src = "rule";
    };
    if (!decision) replaceWithRule("no decision returned");
    const d0 = decision!;
    if ((d0.action === "update" || d0.action === "unchanged") && (!d0.showtimeId || !ctx.storedById.has(d0.showtimeId))) {
      replaceWithRule(`unknown showtime id "${d0.showtimeId ?? ""}"`);
    } else if ((d0.action === "update" || d0.action === "unchanged") && claimed.has(d0.showtimeId!)) {
      // Same showtime twice: the later row repeats the earlier one.
      decision = {
        ...d0,
        action: "duplicate",
        duplicateOfRow: claimed.get(d0.showtimeId!)!,
        explanation: d0.explanation || "Matches the same stored showtime as an earlier row.",
      };
    } else if (d0.action === "duplicate" && (!d0.duplicateOfRow || !resolvedRow.has(d0.duplicateOfRow))) {
      replaceWithRule(`duplicate of unknown row ${d0.duplicateOfRow ?? ""}`);
    }
    // A fallback decision can also claim an already-matched showtime.
    if (
      decision &&
      (decision.action === "update" || decision.action === "unchanged") &&
      decision.showtimeId &&
      claimed.has(decision.showtimeId)
    ) {
      decision = { ...decision, action: "duplicate", duplicateOfRow: claimed.get(decision.showtimeId)! };
    }
    decision ??= {
      row: row.row, action: "add", showtimeId: null, duplicateOfRow: null, title: null,
      auditorium: null, explanation: "No decision available; treated as new.", confidence: 0.5,
    };
    const d = decision;

    const base = {
      movieTitle: (d.title ?? "").trim() || row.movieTitle,
      auditorium: (d.auditorium ?? "").trim() || row.auditorium,
      startTime: row.startTime,
      endTime: row.endTime,
      language: row.language,
      format: row.format,
      rating: row.rating,
    };
    const common = {
      csvRows: [row.row],
      explanation: d.explanation,
      confidence: d.confidence,
      source: src,
    };

    if (d.action === "duplicate") {
      const of = resolvedRow.get(d.duplicateOfRow!)!;
      of.csvRows.push(row.row);
      drafts.push({ ...common, ...base, kind: "duplicate", showtimeId: of.showtimeId, showtimeVersion: null, diffs: [] });
      continue;
    }
    if (d.action === "invalid") {
      drafts.push({ ...common, ...base, kind: "invalid", showtimeId: null, showtimeVersion: null, diffs: [] });
      continue;
    }
    if (d.action === "add") {
      // Guard: an "add" that collides with an existing active showtime of the
      // same film at the same start would violate the one-active rule.
      const clash = ctx.stored.find(
        (s) => s.status === "active" && s.startTime === base.startTime && !claimed.has(s.id) &&
          normalizeKey(s.movieTitle) === normalizeKey(base.movieTitle),
      );
      if (clash) {
        issues.push(`Row ${row.row}: proposed as new, but ${clash.movieTitle} at that time already exists; treated as a match.`);
        claimed.set(clash.id, row.row);
        const diffs = diffAgainst(clash, base);
        const draft: ChangeDraft = {
          ...common, ...base, kind: diffs.length ? "update" : "unchanged",
          showtimeId: clash.id, showtimeVersion: clash.version, diffs, source: "rule",
        };
        drafts.push(draft);
        resolvedRow.set(row.row, draft);
        continue;
      }
      const draft: ChangeDraft = { ...common, ...base, kind: "add", showtimeId: null, showtimeVersion: null, diffs: [] };
      drafts.push(draft);
      resolvedRow.set(row.row, draft);
      continue;
    }

    // update / unchanged: the server decides which, from the actual diffs.
    const s = ctx.storedById.get(d.showtimeId!)!;
    claimed.set(s.id, row.row);
    const diffs = diffAgainst(s, base);

    // "unchanged" is an explicit decision to keep the stored showtime as-is
    // (e.g. the row is stale). Nothing is applied; any differences in the
    // file are still surfaced in the explanation so the reviewer sees them.
    if (d.action === "unchanged") {
      const fileDiffs = diffs.filter((x) => x.field !== "movieTitle" && x.field !== "auditorium");
      const note = fileDiffs.length
        ? ` (File differs: ${fileDiffs.map((x) => `${FIELD_NAMES[x.field] ?? x.field} ${x.newValue}`).join(", ")}; kept stored values.)`
        : "";
      // A current (non-stale) row for an archived/inactive showtime means the
      // partner is showing it again: reactivate it, keeping stored values.
      const stale = row.lastUpdated !== null && Date.parse(row.lastUpdated) < Date.parse(s.lastUpdated);
      const reactivate = s.status !== "active" && !stale;
      const draft: ChangeDraft = {
        ...common,
        explanation: `${common.explanation}${note}`,
        movieTitle: s.movieTitle, auditorium: s.auditorium, startTime: s.startTime, endTime: s.endTime,
        language: s.language, format: s.format, rating: s.rating,
        kind: reactivate ? "reactivate" : "unchanged",
        showtimeId: s.id, showtimeVersion: s.version,
        diffs: reactivate ? [{ field: "status", oldValue: s.status, newValue: "active" }] : [],
      };
      drafts.push(draft);
      resolvedRow.set(row.row, draft);
      continue;
    }

    let kind: ChangeKind = diffs.length ? "update" : "unchanged";
    if (s.status !== "active") {
      kind = "reactivate";
      diffs.push({ field: "status", oldValue: s.status, newValue: "active" });
    }
    const draft: ChangeDraft = { ...common, ...base, kind, showtimeId: s.id, showtimeVersion: s.version, diffs };
    drafts.push(draft);
    resolvedRow.set(row.row, draft);
  }

  for (const bad of invalid) {
    drafts.push({
      kind: "invalid", csvRows: [bad.row], showtimeId: null, showtimeVersion: null,
      movieTitle: bad.raw.movie_title ?? "", auditorium: bad.raw.auditorium ?? "",
      startTime: "", endTime: "", language: "", format: "", rating: "",
      explanation: `Skipped: ${bad.reason}.`, confidence: 1, source: "rule", diffs: [],
    });
  }

  // Archives: only from the candidate set, never anything a row matched.
  const candidates = new Map(archiveCandidates(ctx, new Set(claimed.keys())).map((s) => [s.id, s]));
  const seen = new Set<string>();
  for (const a of plan.archive) {
    const s = candidates.get(a.showtimeId);
    if (!s) {
      if (!ctx.storedById.has(a.showtimeId) || !claimed.has(a.showtimeId)) {
        issues.push(`Ignored archive of "${a.showtimeId}": not an archive candidate.`);
      }
      continue;
    }
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    drafts.push({
      kind: "archive", csvRows: [], showtimeId: s.id, showtimeVersion: s.version,
      movieTitle: s.movieTitle, auditorium: s.auditorium, startTime: s.startTime, endTime: s.endTime,
      language: s.language, format: s.format, rating: s.rating,
      explanation: a.explanation, confidence: a.confidence, source,
      diffs: [{ field: "status", oldValue: "active", newValue: "archived" }],
    });
  }

  return { drafts, issues };
}

// ------------------------------------------------------------------ rule fallback

/**
 * Deterministic plan: same start time + similar title => same showtime;
 * identical title + start => duplicate; unmatched active showtimes are
 * archived only when the file covers most of those days (a CSV is a patch).
 */
export function rulePlan(ctx: ReconcileContext, rows: CsvRow[]): AgentPlan {
  const decisions: RowDecision[] = [];
  const claimed = new Set<string>();
  const firstByKey = new Map<string, number>();

  for (const row of rows) {
    const key = `${tokens(row.movieTitle).join(" ")}|${row.startTime}`;
    const prior = firstByKey.get(key);
    if (prior !== undefined) {
      decisions.push({
        row: row.row, action: "duplicate", duplicateOfRow: prior, showtimeId: null,
        title: null, auditorium: null, confidence: 0.95,
        explanation: `Same film and start time as row ${prior}.`,
      });
      continue;
    }
    firstByKey.set(key, row.row);

    const best = (ctx.candidates.get(row.row) ?? []).find(
      (c) => c.sameStart && c.titleSimilarity >= 0.75 && !claimed.has(c.showtimeId),
    );
    if (best) {
      const s = ctx.storedById.get(best.showtimeId)!;
      claimed.add(s.id);
      const sameRoom = best.auditoriumSimilarity >= 0.75;
      decisions.push({
        row: row.row, action: "update", showtimeId: s.id, duplicateOfRow: null,
        title: s.movieTitle, auditorium: sameRoom ? s.auditorium : row.auditorium,
        confidence: Math.min(0.95, 0.55 + best.titleSimilarity * 0.4),
        explanation: `Same start time as the stored "${s.movieTitle}" (title match ${Math.round(best.titleSimilarity * 100)}%).`,
      });
      continue;
    }
    const knownTitle = ctx.stored.find((s) => similarity(s.movieTitle, row.movieTitle) >= 0.9)?.movieTitle;
    decisions.push({
      row: row.row, action: "add", showtimeId: null, duplicateOfRow: null,
      title: knownTitle ?? null, auditorium: null, confidence: 0.8,
      explanation: "No stored showtime of this film at this time.",
    });
  }

  const unmatched = archiveCandidates(ctx, claimed);
  const activeInWindow = ctx.stored.filter(
    (s) => s.status === "active" && s.startTime >= ctx.window.from && s.startTime < ctx.window.to,
  ).length;
  const coverage = activeInWindow ? (activeInWindow - unmatched.length) / activeInWindow : 1;
  const archive =
    coverage >= 0.5
      ? unmatched.map((s) => ({
          showtimeId: s.id,
          confidence: 0.7,
          explanation: `Not in this file, which covers most of the schedule for ${s.startTime.slice(0, 10)}.`,
        }))
      : [];

  return {
    message: "Here's what I matched up using my basic rules.",
    summary: "Rule-based matching: same start time and a similar title count as the same showtime.",
    rows: decisions,
    archive,
  };
}
