/**
 * A schedule to test against without a database: the sample data the app's
 * demo theaters start from (src/data/assessment-data.ts). Unit tests and
 * evals both build their reconcile context from it, so they are repeatable
 * anywhere.
 */
import { readFileSync } from "node:fs";
import { assessmentData } from "~/data/assessment-data";
import { buildContext, type ReconcileContext, type StoredShowtime } from "~/server/reconcile/context";
import { parseShowtimeCsv, type CsvRow, type InvalidRow } from "~/server/reconcile/csv";
import type { AgentPlan } from "~/server/reconcile/plan";

export const DOWNTOWN = "theater-downtown";
export const HEADER = "theater_name,movie_title,auditorium,start_time,end_time,language,format,rating,last_updated";

/** Stored showtimes for a theater, optionally patched per id (e.g. to un-archive one). */
export function schedule(theaterId = DOWNTOWN, patch: Record<string, Partial<StoredShowtime>> = {}): StoredShowtime[] {
  return assessmentData.showtimes
    .filter((s) => s.theaterId === theaterId)
    .map((s) => ({
      id: s.id,
      movieId: `movie-${s.movieTitle}`,
      movieTitle: s.movieTitle,
      movieStatus: s.movieStatus,
      auditoriumId: `aud-${s.auditorium}`,
      auditorium: s.auditorium,
      startTime: new Date(s.startTime).toISOString(),
      endTime: new Date(s.endTime).toISOString(),
      language: s.language,
      format: s.format,
      rating: s.rating,
      status: s.status,
      lastUpdated: new Date(s.lastUpdated).toISOString(),
      version: 1,
      ...patch[s.id],
    }));
}

export interface Prepared {
  ctx: ReconcileContext;
  rows: CsvRow[];
  invalid: InvalidRow[];
}

/** Parse a CSV and build the context exactly as an upload would, from the fixture schedule. */
export function prepare(
  csv: string,
  opts: { theaterId?: string; patch?: Record<string, Partial<StoredShowtime>> } = {},
): Prepared {
  const theaterId = opts.theaterId ?? DOWNTOWN;
  const theater = assessmentData.theaters.find((t) => t.id === theaterId)!;
  const stored = schedule(theaterId, opts.patch);
  const { rows, invalid } = parseShowtimeCsv(csv);
  const auditoriums = [...new Set(stored.map((s) => s.auditorium))].sort().map((name) => ({ id: `aud-${name}`, name }));
  return {
    ctx: buildContext({ id: theater.id, name: theater.name, timezone: theater.timezone }, stored, auditoriums, rows),
    rows,
    invalid,
  };
}

export const sample = (name: "existing.csv" | "new-drop.csv") =>
  readFileSync(new URL(`../sample-data/${name}`, import.meta.url), "utf8");

/** One CSV line for Downtown; `more` overrides language, format, rating, last_updated, theater. */
export function line(
  title: string,
  auditorium: string,
  start: string,
  end: string,
  more: { language?: string; format?: string; rating?: string; updated?: string; theater?: string } = {},
): string {
  const q = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [
    more.theater ?? "Downtown Cinema 7", title, auditorium, start, end,
    more.language ?? "EN", more.format ?? "2D", more.rating ?? "PG-13", more.updated ?? "2025-03-14T12:00:00Z",
  ].map(q).join(",");
}

export const csv = (...lines: string[]) => [HEADER, ...lines].join("\n") + "\n";

/** A hand-written model answer, for testing how the server verifies one. */
export function plan(rows: AgentPlan["rows"], archive: AgentPlan["archive"] = []): AgentPlan {
  return { message: "I found 1 proposed change. Does this look right?", summary: "", rows, archive };
}

export const decision = (
  row: number,
  action: AgentPlan["rows"][number]["action"],
  more: Partial<AgentPlan["rows"][number]> = {},
): AgentPlan["rows"][number] => ({
  row, action, showtimeId: null, duplicateOfRow: null, title: null, auditorium: null, explanation: "", confidence: 0.9, ...more,
});
