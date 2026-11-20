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

/**
 * Same room? Numbers must agree and the words of one name must contain the
 * other's: "Aud 1" = "Auditorium One" = "Auditorium 1 (Laser)", but
 * "Auditorium 1" is not "Auditorium 2" (edit distance alone would say 91%).
 */
export function sameRoom(a: string, b: string): boolean {
  const split = (v: string) => {
    const t = tokens(v);
    return { nums: t.filter((x) => /^\d+$/.test(x)).sort().join(","), words: new Set(t.filter((x) => !/^\d+$/.test(x))) };
  };
  const x = split(a);
  const y = split(b);
  if (x.nums !== y.nums) return false;
  if (!x.nums && !x.words.size && !y.words.size) return false;
  const [small, big] = x.words.size <= y.words.size ? [x.words, y.words] : [y.words, x.words];
  return [...small].every((w) => big.has(w));
}

/**
 * Does a row's theater_name mean this theater? Blank counts as yes (the
 * upload already targets one theater); so do a close spelling or a shorter
 * or longer form ("Downtown Cinema" / "Downtown Cinema 7").
 */
export function sameTheater(fileName: string, theaterName: string): boolean {
  if (!fileName.trim()) return true;
  if (similarity(fileName, theaterName) >= 0.6) return true;
  const a = new Set(tokens(fileName));
  const b = new Set(tokens(theaterName));
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  return small.size > 0 && [...small].every((t) => big.has(t));
}

const numbersIn = (v: string) => tokens(v).filter((t) => /^\d+$/.test(t)).sort().join(",");

/**
 * Titles whose numbers differ are different titles, however close the rest
 * is: "Inside Out 3" is not a spelling of "Inside Out 2". ("Two", "II" and
 * "2" count as the same number.)
 */
export const differsByNumber = (a: string, b: string) => numbersIn(a) !== numbersIn(b);

/** Same film, allowing spelling noise ("Spider Man - Homecoming") but not a different number. */
export const sameFilm = (a: string, b: string) =>
  normalizeKey(a) === normalizeKey(b) || (!differsByNumber(a, b) && similarity(a, b) >= 0.9);

// ------------------------------------------------------------ loading

const MARGIN_MS = 3 * 3600_000;

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

  return buildContext(theater, stored, auditoriums, rows);
}

/**
 * Pure part of context building: the window the file covers and, per CSV row,
 * the stored showtimes it could plausibly be. No database access, so tests
 * and evals can run it on fixture schedules.
 */
export function buildContext(
  theater: ReconcileContext["theater"],
  stored: StoredShowtime[],
  auditoriums: { id: string; name: string }[],
  rows: CsvRow[],
): ReconcileContext {
  const window = rows.length ? windowFor(rows) : { from: "", to: "", days: [] as string[] };
  // Same 3h margin the loader's query uses, so fixture schedules behave like the database.
  const lo = Date.parse(window.from) - MARGIN_MS;
  const hi = Date.parse(window.to) + MARGIN_MS;
  stored = rows.length ? stored.filter((s) => Date.parse(s.startTime) >= lo && Date.parse(s.startTime) < hi) : [];

  // Candidates: same start time (any title), or a similar title within 3h.
  const candidates = new Map<number, Candidate[]>();
  for (const row of rows) {
    const t = Date.parse(row.startTime);
    const list: Candidate[] = [];
    for (const s of stored) {
      const sameStart = s.startTime === row.startTime;
      const near = Math.abs(Date.parse(s.startTime) - t) <= MARGIN_MS;
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
