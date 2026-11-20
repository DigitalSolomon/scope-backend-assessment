import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CsvError, detectDelimiter, parseCsvText, parseShowtimeCsv, toIso } from "~/server/reconcile/csv";
import { csv, HEADER, line, sample } from "./fixture";

const DUNE = line("Dune: Part Two", "Auditorium 1", "2025-03-15T20:00:00Z", "2025-03-15T22:46:00Z", { format: "IMAX" });

describe("CSV parsing", () => {
  it("reads both sample files", () => {
    assert.equal(parseShowtimeCsv(sample("existing.csv")).rows.length, 6);
    const drop = parseShowtimeCsv(sample("new-drop.csv"));
    assert.equal(drop.rows.length, 6);
    assert.equal(drop.invalid.length, 0);
  });

  it("folds unicode dashes and odd spaces in cells", () => {
    // The sample file uses U+2011 (non-breaking hyphen) in "Spider‑Man".
    const { rows } = parseShowtimeCsv(sample("existing.csv"));
    assert.equal(rows[0]!.movieTitle, "Spider-Man: Homecoming");
  });

  it("handles BOM, CRLF, quoted commas, escaped quotes, blank lines", () => {
    const text =
      "﻿" + HEADER + "\r\n" +
      'Downtown Cinema 7,"Wonka ""Sing-Along"", the late show",Auditorium 3,2025-03-15T23:30:00Z,2025-03-16T01:26:00Z,EN,2D,PG,\r\n\r\n';
    const { rows } = parseShowtimeCsv(text);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.movieTitle, 'Wonka "Sing-Along", the late show');
    assert.equal(rows[0]!.lastUpdated, null);
  });

  it("accepts headers in any order, case and spacing, and reports extra columns", () => {
    const text =
      "Start Time,END-TIME,Movie Title,Auditorium,Theater Name,price\n" +
      "2025-03-15T20:00:00Z,2025-03-15T22:46:00Z,Dune: Part Two,Auditorium 1,Downtown Cinema 7,12.50\n";
    const parsed = parseShowtimeCsv(text);
    assert.equal(parsed.rows[0]!.movieTitle, "Dune: Part Two");
    assert.deepEqual(parsed.ignoredColumns, ["price"]);
  });

  it("detects semicolon and tab delimiters", () => {
    assert.equal(detectDelimiter("a;b;c\n1;2;3"), ";");
    assert.equal(detectDelimiter("a\tb\tc\n"), "\t");
    assert.equal(detectDelimiter('a,"x;y;z",c\n'), ",");
    for (const d of [";", "\t"]) {
      const { rows } = parseShowtimeCsv(csv(DUNE).replaceAll(",", d));
      assert.equal(rows.length, 1, `delimiter ${JSON.stringify(d)}`);
      assert.equal(rows[0]!.auditorium, "Auditorium 1");
    }
  });

  it("keeps good rows and explains bad ones", () => {
    const { rows, invalid } = parseShowtimeCsv(
      csv(
        DUNE,
        line("Wonka", "Auditorium 3", "not a date", "2025-03-15T17:56:00Z"),
        line("", "Auditorium 3", "2025-03-15T16:00:00Z", "2025-03-15T17:56:00Z"),
        line("Backwards", "Auditorium 3", "2025-03-15T18:00:00Z", "2025-03-15T17:00:00Z"),
        line("US Dates", "Auditorium 3", "3/15/2025 8:00 PM", "3/15/2025 10:00 PM"),
      ),
    );
    assert.equal(rows.length, 1);
    assert.deepEqual(invalid.map((i) => i.row), [2, 3, 4, 5]);
    assert.match(invalid[0]!.reason, /start_time "not a date"/);
    assert.match(invalid[1]!.reason, /movie_title is empty/);
    assert.match(invalid[2]!.reason, /end_time is not after start_time/);
  });

  it("never reads a loose date as a year-2001 showtime", () => {
    const { invalid } = parseShowtimeCsv(csv(DUNE, line("Wonka", "Auditorium 3", "Mar 15 5:30 PM", "Mar 15 7:20 PM")));
    assert.equal(invalid.length, 1);
  });

  describe("date-times", () => {
    const times = (start: string, end: string) => parseShowtimeCsv(csv(DUNE, line("Wonka", "Auditorium 3", start, end)));
    const second = (start: string, end: string) => times(start, end).rows[1];
    const reason = (start: string, end: string) => times(start, end).invalid[0]?.reason ?? "";

    it("a time with no zone is read as written, whatever timezone the server runs in", () => {
      const before = process.env.TZ;
      try {
        for (const tz of ["UTC", "America/Los_Angeles", "Asia/Tokyo"]) {
          process.env.TZ = tz;
          assert.equal(second("2025-03-17 15:45", "2025-03-17 17:32")!.startTime, "2025-03-17T15:45:00.000Z", tz);
          assert.equal(second("2025-03-17T15:45:00", "2025-03-17T17:32:00")!.endTime, "2025-03-17T17:32:00.000Z", tz);
        }
      } finally {
        if (before === undefined) delete process.env.TZ;
        else process.env.TZ = before;
      }
    });

    it("an explicit zone or offset is honored", () => {
      assert.equal(toIso("2025-03-12T22:00:00Z"), "2025-03-12T22:00:00.000Z");
      assert.equal(toIso("2025-03-12T17:00:00-05:00"), "2025-03-12T22:00:00.000Z");
      assert.equal(toIso("2025-03-12 17:00-0500"), "2025-03-12T22:00:00.000Z");
      assert.equal(toIso("2025-03-13T03:30:00.250+05:30"), "2025-03-12T22:00:00.250Z");
    });

    it("an impossible date is refused, not rolled into the next month", () => {
      assert.match(reason("2025-02-30T10:00:00Z", "2025-02-30T12:00:00Z"), /start_time "2025-02-30T10:00:00Z" is not a valid date-time/);
      assert.equal(toIso("2025-13-01T10:00:00Z"), null);
      assert.equal(toIso("2025-03-17T24:30:00Z"), null);
      assert.equal(toIso("0025-03-17T15:45:00Z"), null, "a mistyped year");
    });

    it("a showtime needs a time of day; last_updated may be just a date", () => {
      assert.match(reason("2025-03-17", "2025-03-18"), /start_time "2025-03-17" has a date but no time/);
      const { rows } = parseShowtimeCsv(csv(line("Wonka", "Auditorium 3", "2025-03-15T16:00:00Z", "2025-03-15T17:56:00Z", { updated: "2025-03-14" })));
      assert.equal(rows[0]!.lastUpdated, "2025-03-14T00:00:00.000Z");
    });

    it("a showing more than a day long is a typo, not a film", () => {
      assert.match(reason("2025-03-17T15:45:00Z", "2025-03-18T21:45:00Z"), /more than 24 hours after start_time/);
      assert.ok(second("2025-03-15T22:45:00Z", "2025-03-16T01:31:00Z"), "crossing midnight is fine");
    });
  });

  it("uppercases codes so 'imax' and 'IMAX' are the same", () => {
    const { rows } = parseShowtimeCsv(csv(line("Dune: Part Two", "Auditorium 1", "2025-03-15T20:00:00Z", "2025-03-15T22:46:00Z", { format: "imax", rating: "pg-13" })));
    assert.equal(rows[0]!.format, "IMAX");
    assert.equal(rows[0]!.rating, "PG-13");
  });

  describe("files that must fail with a clear message", () => {
    const fails = (name: string, text: string, pattern: RegExp) =>
      it(name, () => assert.throws(() => parseShowtimeCsv(text), (e) => e instanceof CsvError && pattern.test(e.message)));

    fails("empty file", "  \n\n ", /empty/i);
    fails("headers only", HEADER + "\n", /No rows/);
    fails("wrong columns", "name,price\nPopcorn,5\n", /Missing required columns: theater_name, movie_title/);
    fails("JSON instead of CSV", '[{"movie_title":"Dune"}]', /Missing required column/);
    fails("unterminated quote", HEADER + '\nDowntown Cinema 7,"Dune,Auditorium 1,2025-03-15T20:00:00Z,2025-03-15T22:46:00Z\n', /quoted field/);
    fails("more than 500 rows", csv(...Array.from({ length: 501 }, () => DUNE)), /Too many rows \(501\)/);
    fails("binary content (image or spreadsheet)", "PK\u0003\u0004\u0000\u0000binary\u0000", /doesn't look like a CSV text file/);
    fails(
      "no usable rows at all",
      csv(line("Wonka", "Auditorium 3", "tomorrow", "later"), line("", "Auditorium 3", "2025-03-15T16:00:00Z", "2025-03-15T17:56:00Z")),
      /None of the 2 rows could be used \(row 1: start_time "tomorrow"/,
    );
  });

  it("parseCsvText drops blank lines but keeps empty cells", () => {
    assert.deepEqual(parseCsvText("a,b\n\n1,\n"), [["a", "b"], ["1", ""]]);
  });
});
