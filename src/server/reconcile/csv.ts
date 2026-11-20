import "server-only";

import { cleanText } from "~/lib/normalize";

/** A data row from the partner CSV after cleaning. `row` is 1-based (header excluded). */
export interface CsvRow {
  row: number;
  theaterName: string;
  movieTitle: string;
  auditorium: string;
  startTime: string; // ISO
  endTime: string; // ISO
  language: string;
  format: string;
  rating: string;
  lastUpdated: string | null; // ISO
  raw: Record<string, string>;
}

export interface InvalidRow {
  row: number;
  reason: string;
  raw: Record<string, string>;
}

export interface ParsedCsv {
  rows: CsvRow[];
  invalid: InvalidRow[];
  headers: string[];
  ignoredColumns: string[];
}

export class CsvError extends Error {}

export const MAX_CSV_BYTES = 1_000_000;
export const MAX_CSV_ROWS = 500;

const REQUIRED = ["theater_name", "movie_title", "auditorium", "start_time", "end_time"] as const;
const OPTIONAL = ["language", "format", "rating", "last_updated"] as const;

/** RFC 4180 parser: quoted fields, escaped quotes, commas/newlines in quotes, CRLF, BOM. */
export function parseCsvText(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"' && field === "") {
      inQuotes = true;
    } else if (ch === ",") {
      record.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else field += ch;
  }
  if (inQuotes) throw new CsvError("The file ends inside a quoted field.");
  if (field !== "" || record.length) {
    record.push(field);
    records.push(record);
  }
  // Drop fully blank lines (e.g. the trailing newline in the sample files).
  return records.filter((r) => r.some((c) => c.trim() !== ""));
}

function toIso(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  // Require an explicit date; Date.parse alone accepts too much.
  if (!/^\d{4}-\d{2}-\d{2}/.test(v)) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

const headerKey = (h: string) =>
  h.replace(/^﻿/, "").trim().toLowerCase().replace(/[\s-]+/g, "_");

export function parseShowtimeCsv(text: string): ParsedCsv {
  if (new TextEncoder().encode(text).length > MAX_CSV_BYTES) {
    throw new CsvError("The file is larger than 1 MB.");
  }
  const records = parseCsvText(text);
  if (records.length === 0) throw new CsvError("The file is empty.");
  const headers = records[0]!.map(headerKey);
  const missing = REQUIRED.filter((r) => !headers.includes(r));
  if (missing.length) {
    throw new CsvError(`Missing required column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}.`);
  }
  const known = new Set<string>([...REQUIRED, ...OPTIONAL]);
  const ignoredColumns = headers.filter((h) => !known.has(h));
  const body = records.slice(1);
  if (body.length === 0) throw new CsvError("No rows found under the header.");
  if (body.length > MAX_CSV_ROWS) throw new CsvError(`Too many rows (${body.length}); the limit is ${MAX_CSV_ROWS}.`);

  const rows: CsvRow[] = [];
  const invalid: InvalidRow[] = [];
  body.forEach((cells, i) => {
    const row = i + 1;
    const raw: Record<string, string> = {};
    headers.forEach((h, j) => (raw[h] = cells[j] ?? ""));
    const get = (k: string) => cleanText(raw[k] ?? "");

    const problems: string[] = [];
    if (!get("movie_title")) problems.push("movie_title is empty");
    if (!get("auditorium")) problems.push("auditorium is empty");
    const start = toIso(raw.start_time ?? "");
    const end = toIso(raw.end_time ?? "");
    if (!start) problems.push(`start_time "${raw.start_time ?? ""}" is not a valid date-time`);
    if (!end) problems.push(`end_time "${raw.end_time ?? ""}" is not a valid date-time`);
    if (start && end && end <= start) problems.push("end_time is not after start_time");
    if (problems.length) {
      invalid.push({ row, reason: problems.join("; "), raw });
      return;
    }
    rows.push({
      row,
      theaterName: get("theater_name"),
      movieTitle: get("movie_title"),
      auditorium: get("auditorium"),
      startTime: start!,
      endTime: end!,
      language: get("language").toUpperCase(),
      format: get("format").toUpperCase(),
      rating: get("rating").toUpperCase(),
      lastUpdated: toIso(raw.last_updated ?? ""),
      raw,
    });
  });
  return { rows, invalid, headers, ignoredColumns };
}
