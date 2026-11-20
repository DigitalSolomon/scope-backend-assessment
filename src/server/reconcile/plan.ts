import "server-only";

import { z } from "zod";
import { normalizeKey } from "~/lib/normalize";
import type { ChangeKind, FieldDiff } from "~/types/assessment";
import type { CsvRow, InvalidRow } from "./csv";
import { clockTimesIn, formatClock, formatDay, formatWhen } from "~/lib/format";
import { differsByNumber, sameFilm, sameRoom, similarity, tokens, type ReconcileContext, type StoredShowtime } from "./context";

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
  movieTitle: "title", auditorium: "room", startTime: "start", endTime: "end",
  language: "language", format: "format", status: "status",
};

/** A same-film, same-room row within this window of a stored showtime is that showtime, rescheduled. */
export const SHIFT_WINDOW_MS = 90 * 60_000;
/** At the same start time in the same room, a title at least this similar is the stored showing, retitled. */
export const RETITLE_SIMILARITY = 0.75;
/** Missing showtimes are suggested for archiving only on days where the file accounts for at least this share. */
export const ARCHIVE_COVERAGE = 0.5;
/** Shorter overlaps are normal turnaround in the sample data (trailers, cleaning). */
export const OVERLAP_NOTICE_MS = 15 * 60_000;

const sameText = (a: string, b: string) => a.trim() === b.trim();
const sameCode = (a: string, b: string) => a.trim().toUpperCase() === b.trim().toUpperCase();

type Values = Pick<ChangeDraft, "movieTitle" | "auditorium" | "startTime" | "endTime" | "language" | "format" | "rating">;

/**
 * Field differences between a stored showtime and a CSV row. Rating is left
 * out on purpose: it belongs to the film, which every theater shares, so one
 * theater's upload must not change it (see ratingNote).
 */
function diffAgainst(s: StoredShowtime, p: Values): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  const push = (field: string, oldValue: string, newValue: string) => diffs.push({ field, oldValue, newValue });
  if (!sameText(s.movieTitle, p.movieTitle)) push("movieTitle", s.movieTitle, p.movieTitle);
  if (!sameText(s.auditorium, p.auditorium)) push("auditorium", s.auditorium, p.auditorium);
  if (s.startTime !== p.startTime) push("startTime", s.startTime, p.startTime);
  if (s.endTime !== p.endTime) push("endTime", s.endTime, p.endTime);
  if (p.language && !sameCode(s.language, p.language)) push("language", s.language, p.language);
  if (p.format && !sameCode(s.format, p.format)) push("format", s.format, p.format);
  return diffs;
}

const showValue = (field: string, v: string) => (field === "startTime" || field === "endTime" ? formatWhen(v) : v || "—");
const describeDiffs = (diffs: FieldDiff[]) =>
  diffs.map((x) => `${FIELD_NAMES[x.field] ?? x.field} ${showValue(x.field, x.oldValue)} → ${showValue(x.field, x.newValue)}`).join(", ");

const ratingNote = (s: StoredShowtime, fileRating: string) =>
  fileRating && !sameCode(s.rating, fileRating)
    ? ` (The file lists rating ${fileRating}; this film is stored as ${s.rating || "unrated"}. Ratings belong to the film at every theater, so an upload does not change them.)`
    : "";

export const isStale = (row: CsvRow, s: StoredShowtime) =>
  row.lastUpdated !== null && Date.parse(row.lastUpdated) < Date.parse(s.lastUpdated);

export interface MaterializeOptions {
  /**
   * After reviewer feedback the model's choices are deliberate, so they are
   * honored: "unchanged" keeps a showtime as it is (even archived), "update"
   * applies even to a stale row, "add" stays a new showing even in an
   * occupied slot, and its archive list is used and pre-selected.
   * On a first pass the server decides those from facts instead.
   */
  honorDecisions?: boolean;
}

export interface Materialized {
  drafts: ChangeDraft[];
  /** Places where the server overrode the model. */
  issues: string[];
  /** Things the reviewer should know (double-booked rooms). */
  notices: string[];
  /** Whether archive proposals start ticked in the review. */
  archivesPreselected: boolean;
}

/**
 * Turn decisions into verified change drafts. The model picks identities
 * (which stored showtime a row is, which film, which room); everything that
 * is a fact is decided here: field diffs, staleness, reschedules, which
 * missing showtimes may be archived, double bookings, and that every time
 * quoted in an explanation really is that showtime's. Anything the agent got
 * wrong is replaced by the rule-based decision and reported in `issues`.
 */
export function materialize(
  ctx: ReconcileContext,
  rows: CsvRow[],
  invalid: InvalidRow[],
  plan: AgentPlan,
  source: "agent" | "rule",
  fallback: AgentPlan,
  opts: MaterializeOptions = {},
): Materialized {
  const honor = Boolean(opts.honorDecisions);
  const issues: string[] = [];
  const notices: string[] = [];
  const byRow = new Map<number, RowDecision>();
  for (const d of plan.rows) if (!byRow.has(d.row)) byRow.set(d.row, d);
  const fallbackByRow = new Map(fallback.rows.map((d) => [d.row, d]));
  const rowByNumber = new Map(rows.map((r) => [r.row, r]));

  const drafts: ChangeDraft[] = [];
  const notes = new Map<ChangeDraft, string[]>(); // server-written additions, appended after the time check
  const claimed = new Map<string, number>(); // showtimeId -> row that matched it
  const resolvedRow = new Map<number, ChangeDraft>(); // for duplicate references

  type Common = Pick<ChangeDraft, "csvRows" | "explanation" | "confidence" | "source">;

  /** A row that is a stored showtime: decide keep / update / reactivate from facts. */
  const matched = (s: StoredShowtime, row: CsvRow, base: Values, common: Common, action: "update" | "unchanged"): ChangeDraft => {
    const diffs = diffAgainst(s, base);
    const wouldChange = diffs.length > 0 || s.status !== "active";
    const stale = isStale(row, s);
    const keepStored = honor ? action === "unchanged" : stale;
    const extra: string[] = [];

    if (!wouldChange || keepStored) {
      let explanation = common.explanation;
      if (wouldChange) {
        if (diffs.length) extra.push(` (File differs: ${describeDiffs(diffs)}; kept stored values.)`);
        // The model wanted a change but the row is older than what is stored.
        if (action === "update" && !honor) {
          explanation =
            s.status === "active"
              ? `The file's copy of this ${s.movieTitle} showing is older than the stored one, so the stored values are kept.`
              : `The file's copy of this ${s.movieTitle} showing is older than the stored one, so it stays ${s.status}.`;
        }
      }
      extra.push(ratingNote(s, base.rating));
      const draft: ChangeDraft = {
        ...common, explanation,
        movieTitle: s.movieTitle, auditorium: s.auditorium, startTime: s.startTime, endTime: s.endTime,
        language: s.language, format: s.format, rating: s.rating,
        kind: "unchanged", showtimeId: s.id, showtimeVersion: s.version, diffs: [],
      };
      notes.set(draft, extra);
      return draft;
    }

    let explanation = common.explanation;
    if (action === "unchanged") {
      // The model saw nothing to change, but the row is current and differs.
      explanation = diffs.length
        ? `Matches the stored ${s.movieTitle} showing; the file changes ${describeDiffs(diffs)}.`
        : `Brings back the ${s.status} ${s.movieTitle} showing.`;
    } else {
      const said = explanation.toLowerCase();
      const unmentioned = diffs.filter((x) => ["language", "format", "movieTitle"].includes(x.field) && !said.includes(x.newValue.toLowerCase()));
      if (unmentioned.length) extra.push(` (Also changes ${describeDiffs(unmentioned)}.)`);
    }
    const kind: ChangeKind = s.status !== "active" ? "reactivate" : "update";
    if (s.status !== "active") diffs.push({ field: "status", oldValue: s.status, newValue: "active" });
    extra.push(ratingNote(s, base.rating));
    const draft: ChangeDraft = {
      ...common, ...base, rating: s.rating, explanation,
      kind, showtimeId: s.id, showtimeVersion: s.version, diffs,
    };
    notes.set(draft, extra);
    return draft;
  };

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

    const base: Values = {
      movieTitle: (d.title ?? "").trim() || row.movieTitle,
      auditorium: (d.auditorium ?? "").trim() || row.auditorium,
      startTime: row.startTime,
      endTime: row.endTime,
      language: row.language,
      format: row.format,
      rating: row.rating,
    };
    const common: Common = { csvRows: [row.row], explanation: d.explanation, confidence: d.confidence, source: src };

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
        const draft = matched(clash, row, base, { ...common, source: "rule" }, "update");
        drafts.push(draft);
        resolvedRow.set(row.row, draft);
        continue;
      }
      const draft: ChangeDraft = { ...common, ...base, kind: "add", showtimeId: null, showtimeVersion: null, diffs: [] };
      drafts.push(draft);
      resolvedRow.set(row.row, draft);
      continue;
    }

    // update / unchanged: the model names the showtime, the server decides what changes.
    const s = ctx.storedById.get(d.showtimeId!)!;
    claimed.set(s.id, row.row);
    // The model may keep the stored title, reading the file's as a spelling of
    // it. A different number is a different title, so that is a title change.
    if (!honor && sameText(base.movieTitle, s.movieTitle) && differsByNumber(row.movieTitle, s.movieTitle)) {
      base.movieTitle = row.movieTitle;
    }
    const draft = matched(s, row, base, common, d.action);
    drafts.push(draft);
    resolvedRow.set(row.row, draft);
  }

  // A "new" showing that is really an existing one, changed. A room shows one
  // film at a time, so an add is folded into an active stored showtime that
  // nothing else matched when it is either:
  //  - a reschedule: the same film in the same room, up to 90 minutes away; or
  //  - a retitle: the same room and start time, with a similar title
  //    ("Inside Out 3" where "Inside Out 2" is stored).
  // Either way the result is one update, not an add plus an archive.
  // Not after reviewer feedback: an "add" is then a deliberate choice ("add it
  // as a new movie instead"), so it stays an add and any double booking is
  // flagged below for the reviewer.
  for (const draft of honor ? [] : drafts) {
    if (draft.kind !== "add") continue;
    const row = rowByNumber.get(draft.csvRows[0]!);
    if (!row) continue;
    const t = Date.parse(draft.startTime);
    const gap = (s: StoredShowtime) => Math.abs(Date.parse(s.startTime) - t);
    const near = ctx.stored
      .filter(
        (s) =>
          s.status === "active" && !claimed.has(s.id) && sameRoom(s.auditorium, draft.auditorium) &&
          (gap(s) === 0
            ? similarity(s.movieTitle, draft.movieTitle) >= RETITLE_SIMILARITY
            : gap(s) <= SHIFT_WINDOW_MS && sameFilm(s.movieTitle, draft.movieTitle)),
      )
      .sort((a, b) => gap(a) - gap(b))[0];
    if (!near) continue;
    claimed.set(near.id, row.row);
    const retitled = gap(near) === 0 && !sameFilm(near.movieTitle, draft.movieTitle);
    const moved = matched(
      near, row,
      {
        movieTitle: retitled ? draft.movieTitle : near.movieTitle, auditorium: near.auditorium,
        startTime: draft.startTime, endTime: draft.endTime, language: draft.language, format: draft.format, rating: draft.rating,
      },
      {
        csvRows: draft.csvRows, confidence: Math.min(draft.confidence, 0.85), source: draft.source,
        explanation: retitled
          ? `Same room and start time as the stored ${near.movieTitle} showing; the file names it ${draft.movieTitle}.`
          : gap(near) === 0
            ? `Matches the stored ${near.movieTitle} showing at ${formatClock(near.startTime)}.`
            : `Same film in the same room as the stored ${formatClock(near.startTime)} showing, moved to ${formatClock(draft.startTime)}.`,
      },
      "update",
    );
    notes.set(draft, notes.get(moved) ?? []);
    Object.assign(draft, moved);
  }

  for (const bad of invalid) {
    drafts.push({
      kind: "invalid", csvRows: [bad.row], showtimeId: null, showtimeVersion: null,
      movieTitle: bad.raw.movie_title ?? "", auditorium: bad.raw.auditorium ?? "",
      startTime: "", endTime: "", language: "", format: "", rating: "",
      explanation: `Skipped: ${bad.reason}.`, confidence: 1, source: "rule", diffs: [],
    });
  }

  // Missing showtimes. Only active showtimes on the file's days that no row
  // matched can be archived, and only on days where the file accounts for
  // most of the schedule (otherwise it is a patch, and absence means nothing).
  const candidates = new Map(archiveCandidates(ctx, new Set(claimed.keys())).map((s) => [s.id, s]));
  const coverage = dayCoverage(ctx, new Set(claimed.keys()));
  const coveredDays = new Set(coverage.filter((c) => c.activeStored > 0 && c.coverage >= ARCHIVE_COVERAGE).map((c) => c.day));
  const modelArchive = new Map(plan.archive.map((a) => [a.showtimeId, a]));
  for (const a of plan.archive) {
    if (!ctx.storedById.has(a.showtimeId)) issues.push(`Ignored archive of "${a.showtimeId}": not a stored showtime.`);
  }
  const toArchive = honor
    ? [...candidates.values()].filter((s) => modelArchive.has(s.id))
    : [...candidates.values()].filter((s) => coveredDays.has(s.startTime.slice(0, 10)));
  for (const s of toArchive) {
    const a = modelArchive.get(s.id);
    drafts.push({
      kind: "archive", csvRows: [], showtimeId: s.id, showtimeVersion: s.version,
      movieTitle: s.movieTitle, auditorium: s.auditorium, startTime: s.startTime, endTime: s.endTime,
      language: s.language, format: s.format, rating: s.rating,
      explanation: a?.explanation.trim() ? a.explanation : `Not in this file, which covers most of the ${formatDay(s.startTime)} schedule.`,
      confidence: a?.confidence ?? 0.7, source: a ? source : "rule",
      diffs: [{ field: "status", oldValue: "active", newValue: "archived" }],
    });
  }

  // Every clock time quoted in an explanation must be one of that showtime's
  // own times; a model can misquote or convert time zones. If it does, the
  // sentence is replaced with one written from the data.
  for (const draft of drafts) {
    const s = draft.showtimeId ? ctx.storedById.get(draft.showtimeId) : undefined;
    const allowed = new Set(
      [draft.startTime, draft.endTime, s?.startTime, s?.endTime, ...draft.csvRows.flatMap((n) => [rowByNumber.get(n)?.startTime, rowByNumber.get(n)?.endTime])]
        .filter((v): v is string => Boolean(v))
        .map(formatClock),
    );
    if (clockTimesIn(draft.explanation).some((t) => !allowed.has(t))) draft.explanation = describeDraft(draft, s);
  }

  // Double bookings introduced by this proposal: a new or moved showing that
  // overlaps another one in the same room.
  const occupancy = [
    ...ctx.stored
      .filter((s) => s.status === "active" && !drafts.some((d) => d.showtimeId === s.id && (d.kind === "update" || d.kind === "reactivate")))
      .map((s) => ({ id: s.id, title: s.movieTitle, room: s.auditorium, start: s.startTime, end: s.endTime })),
    ...drafts
      .filter((d) => d.kind === "add" || d.kind === "update" || d.kind === "reactivate")
      .map((d) => ({ id: d.showtimeId ?? `row-${d.csvRows[0]}`, title: d.movieTitle, room: d.auditorium, start: d.startTime, end: d.endTime })),
  ];
  for (const draft of drafts) {
    const introduces =
      draft.kind === "add" || draft.kind === "reactivate" ||
      (draft.kind === "update" && draft.diffs.some((x) => ["startTime", "endTime", "auditorium"].includes(x.field)));
    if (!introduces) continue;
    const self = draft.showtimeId ?? `row-${draft.csvRows[0]}`;
    const clash = occupancy.find(
      (o) =>
        o.id !== self && sameRoom(o.room, draft.auditorium) &&
        Math.min(Date.parse(o.end), Date.parse(draft.endTime)) - Math.max(Date.parse(o.start), Date.parse(draft.startTime)) >= OVERLAP_NOTICE_MS,
    );
    if (!clash) continue;
    const where = `${clash.title} (${formatClock(clash.start)}–${formatClock(clash.end)}) in ${draft.auditorium}`;
    notes.set(draft, [...(notes.get(draft) ?? []), ` (Heads up: this overlaps ${where}.)`]);
    notices.push(`${draft.movieTitle} at ${formatClock(draft.startTime)} overlaps ${where}.`);
  }

  for (const draft of drafts) draft.explanation += (notes.get(draft) ?? []).join("");
  return { drafts, issues, notices, archivesPreselected: honor };
}

/** A sentence written from the data, used when the model's own sentence fails a check. */
function describeDraft(d: ChangeDraft, s?: StoredShowtime): string {
  const at = `${formatWhen(d.startTime)} in ${d.auditorium}`;
  switch (d.kind) {
    case "add": return `New showing of ${d.movieTitle} on ${at}.`;
    case "update": return `Matches the stored ${d.movieTitle} showing; the file changes ${describeDiffs(d.diffs)}.`;
    case "reactivate": return `Brings back the ${s?.status ?? "archived"} ${d.movieTitle} showing on ${at}.`;
    case "archive": return `${d.movieTitle} on ${at} is not in this file.`;
    case "unchanged": return `Matches the stored ${d.movieTitle} showing on ${at}.`;
    case "duplicate": return `Repeats an earlier row for ${d.movieTitle} on ${at}.`;
    default: return d.explanation.replace(/\b\d{1,2}:\d{2}\s*[AaPp]\.?\s?[Mm]\b/g, "that time");
  }
}

/** Per UTC day: how much of the active stored schedule the file accounts for. */
export function dayCoverage(ctx: ReconcileContext, matched: Set<string>) {
  return ctx.window.days.map((day) => {
    const active = ctx.stored.filter((s) => s.status === "active" && s.startTime.startsWith(day));
    const covered = active.filter((s) => matched.has(s.id)).length;
    return {
      day,
      activeStored: active.length,
      matchedByFile: covered,
      coverage: active.length ? Math.round((covered / active.length) * 100) / 100 : 1,
    };
  });
}

// ------------------------------------------------------------------ rule fallback

/**
 * Deterministic plan: same start time + similar title => same showtime;
 * identical title + start => duplicate. Reschedules, staleness and which
 * missing showtimes may be archived are decided in materialize(), the same
 * way for the model and for these rules.
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
      const room = sameRoom(row.auditorium, s.auditorium);
      decisions.push({
        row: row.row, action: "update", showtimeId: s.id, duplicateOfRow: null,
        // A different number is a different title ("Inside Out 3"), not a spelling of the stored one.
        title: differsByNumber(row.movieTitle, s.movieTitle) ? row.movieTitle : s.movieTitle,
        auditorium: room ? s.auditorium : row.auditorium,
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

  // materialize() applies the per-day coverage rule; this list only matters
  // when a reviewer's feedback run falls back to rules.
  const covered = new Set(dayCoverage(ctx, claimed).filter((c) => c.activeStored > 0 && c.coverage >= ARCHIVE_COVERAGE).map((c) => c.day));
  const archive = archiveCandidates(ctx, claimed)
    .filter((s) => covered.has(s.startTime.slice(0, 10)))
    .map((s) => ({
      showtimeId: s.id,
      confidence: 0.7,
      explanation: `Not in this file, which covers most of the ${formatDay(s.startTime)} schedule.`,
    }));

  return {
    message: "Here's what I matched up using my basic rules.",
    summary: "Rule-based matching: same start time and a similar title count as the same showtime.",
    rows: decisions,
    archive,
  };
}
