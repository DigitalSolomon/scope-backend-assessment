import "server-only";

import { normalizeKey } from "~/lib/normalize";
import type { MovieStatus, ShowtimeStatus } from "~/types/assessment";
import { sql } from "../db";
import type { CsvRow } from "./csv";

export interface StoredShowtime {
  id: string;
  movieId: string;
  movieTitle: string;
  movieStatus: MovieStatus;
  auditoriumId: string;
  auditorium: string;
  startTime: string;
  endTime: string;
  language: string;
  format: string;
  rating: string;
  status: ShowtimeStatus;
  lastUpdated: string;
  version: number;
}

export interface Candidate {
  showtimeId: string;
  titleSimilarity: number;
  auditoriumSimilarity: number;
  sameStart: boolean;
}

export interface ReconcileContext {
  theater: { id: string; name: string; timezone: string };
  window: { from: string; to: string; days: string[] };
  stored: StoredShowtime[];
  storedById: Map<string, StoredShowtime>;
  auditoriums: { id: string; name: string }[];
  candidates: Map<number, Candidate[]>; // by CSV row
}

// ------------------------------------------------------------ similarity

const NUMBER_WORDS: Record<string, string> = {
  one: "1", two: "2", three: "3", four: "4", five: "5", six: "6",
  seven: "7", eight: "8", nine: "9", ten: "10",
  ii: "2", iii: "3", iv: "4", vi: "6", vii: "7", viii: "8", ix: "9",
  pt: "part", aud: "auditorium", theatre: "theater", scr: "screen",
};

/** Tokens after normalization, with number words / numerals / common abbreviations folded. */
export function tokens(value: string): string[] {
  return normalizeKey(value)
    .split(" ")
    .filter(Boolean)
    .map((t) => NUMBER_WORDS[t] ?? t);
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

/** 0..1. Token overlap, plus edit distance on the joined tokens ("spiderman" vs "spider man"). */
export function similarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.length || !tb.length) return 0;
  const sa = new Set(ta);
  const sb = new Set(tb);
  const inter = [...sa].filter((t) => sb.has(t)).length;
  const jaccard = inter / new Set([...ta, ...tb]).size;
  const ca = ta.join("");
  const cb = tb.join("");
  const edit = 1 - levenshtein(ca, cb) / Math.max(ca.length, cb.length);
  return Math.round(Math.max(jaccard, edit) * 100) / 100;
}

// ------------------------------------------------------------ loading

/** UTC calendar days the file touches, and the [from, to) window covering them. */
function windowFor(rows: CsvRow[]) {
  const days = [...new Set(rows.map((r) => r.startTime.slice(0, 10)))].sort();
  const from = `${days[0]}T00:00:00.000Z`;
  const last = new Date(`${days[days.length - 1]}T00:00:00.000Z`);
  last.setUTCDate(last.getUTCDate() + 1);
  return { from, to: last.toISOString(), days };
}

export async function loadContext(theaterId: string, rows: CsvRow[]): Promise<ReconcileContext> {
  const [theater] = await sql<{ id: string; name: string; timezone: string }[]>`
    select id, name, timezone from hv_theater.theaters where id = ${theaterId}`;
  if (!theater) throw new Error("Theater not found");

  const window = rows.length ? windowFor(rows) : { from: "", to: "", days: [] as string[] };

  type Row = {
    id: string; movie_id: string; movie_title: string; movie_status: MovieStatus;
    auditorium_id: string; auditorium: string; start_time: Date; end_time: Date;
    language: string; format: string; rating: string | null; status: ShowtimeStatus;
    last_updated: Date; version: number;
  };
  // Stored showtimes on the days the file covers (any status, so archived
  // ones can be reactivated), plus a 3h margin so moved showtimes are seen.
  const storedRows = rows.length
    ? await sql<Row[]>`
        select s.id, s.movie_id, m.title as movie_title, m.status as movie_status,
               s.auditorium_id, a.name as auditorium, s.start_time, s.end_time,
               s.language, s.format, m.rating, s.status, s.last_updated, s.version
        from hv_theater.showtimes s
        join hv_theater.movies m on m.id = s.movie_id
        join hv_theater.auditoriums a on a.id = s.auditorium_id
        where s.theater_id = ${theaterId}
          and s.start_time >= ${window.from}::timestamptz - interval '3 hours'
          and s.start_time <  ${window.to}::timestamptz + interval '3 hours'
        order by s.start_time, s.id
        limit 2000`
    : [];

  const stored: StoredShowtime[] = storedRows.map((r) => ({
    id: r.id,
    movieId: r.movie_id,
    movieTitle: r.movie_title,
    movieStatus: r.movie_status,
    auditoriumId: r.auditorium_id,
    auditorium: r.auditorium,
    startTime: r.start_time.toISOString(),
    endTime: r.end_time.toISOString(),
    language: r.language,
    format: r.format,
    rating: r.rating ?? "",
    status: r.status,
    lastUpdated: r.last_updated.toISOString(),
    version: r.version,
  }));

  const auditoriums = await sql<{ id: string; name: string }[]>`
    select id, name from hv_theater.auditoriums where theater_id = ${theaterId} order by name`;

  // Candidates: same start time (any title), or a similar title within 3h.
  const candidates = new Map<number, Candidate[]>();
  for (const row of rows) {
    const t = Date.parse(row.startTime);
    const list: Candidate[] = [];
    for (const s of stored) {
      const sameStart = s.startTime === row.startTime;
      const near = Math.abs(Date.parse(s.startTime) - t) <= 3 * 3600_000;
      if (!sameStart && !near) continue;
      const titleSimilarity = similarity(row.movieTitle, s.movieTitle);
      if (!sameStart && titleSimilarity < 0.6) continue;
      list.push({
        showtimeId: s.id,
        titleSimilarity,
        auditoriumSimilarity: similarity(row.auditorium, s.auditorium),
        sameStart,
      });
    }
    list.sort((a, b) => Number(b.sameStart) - Number(a.sameStart) || b.titleSimilarity - a.titleSimilarity);
    candidates.set(row.row, list.slice(0, 5));
  }

  return {
    theater,
    window,
    stored,
    storedById: new Map(stored.map((s) => [s.id, s])),
    auditoriums,
    candidates,
  };
}
