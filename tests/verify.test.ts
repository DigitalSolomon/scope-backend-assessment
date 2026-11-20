/**
 * The server-side verification step (materialize): given a plan from the
 * model or from the rule fallback, what change set comes out. No model and no
 * database: the schedule is the sample data.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { StoredShowtime } from "~/server/reconcile/context";
import { materialize, rulePlan, type AgentPlan, type ChangeDraft, type Materialized } from "~/server/reconcile/plan";
import { csv, decision, line, plan, prepare, sample } from "./fixture";

type Patch = Record<string, Partial<StoredShowtime>>;

/** Rule fallback end to end: what ScopeBot proposes with no model at all. */
function rules(text: string, patch?: Patch, catalog?: string[]): Materialized {
  const p = prepare(text, { patch, catalog });
  const fallback = rulePlan(p.ctx, p.rows);
  return materialize(p.ctx, p.rows, p.invalid, fallback, "rule", fallback);
}

/** Verify a hand-written model answer. */
function verify(text: string, answer: AgentPlan, opts: { patch?: Patch; honorDecisions?: boolean; catalog?: string[] } = {}): Materialized {
  const p = prepare(text, { patch: opts.patch, catalog: opts.catalog });
  return materialize(p.ctx, p.rows, p.invalid, answer, "agent", rulePlan(p.ctx, p.rows), { honorDecisions: opts.honorDecisions });
}

const kinds = (m: Materialized) => {
  const out: Record<string, number> = {};
  for (const d of m.drafts) out[d.kind] = (out[d.kind] ?? 0) + 1;
  return out;
};
const one = (m: Materialized, title: string, kind?: ChangeDraft["kind"]) => {
  const hits = m.drafts.filter((d) => d.movieTitle === title && (!kind || d.kind === kind));
  assert.equal(hits.length, 1, `expected one ${kind ?? "draft"} for ${title}, got ${hits.length}`);
  return hits[0]!;
};
const diff = (d: ChangeDraft) => Object.fromEntries(d.diffs.map((x) => [x.field, x.newValue]));

// Rows that restate stored Downtown showtimes (Mar 15).
const SPIDER = line("Spider-Man: Homecoming", "Auditorium 1", "2025-03-15T18:00:00Z", "2025-03-15T20:13:00Z");
const INSIDE = line("Inside Out 2", "Auditorium 2", "2025-03-15T17:30:00Z", "2025-03-15T19:20:00Z", { format: "3D", rating: "PG" });
const DUNE_8 = line("Dune: Part Two", "Auditorium 1", "2025-03-15T20:00:00Z", "2025-03-15T22:46:00Z", { format: "IMAX" });
const DUNE_LATE = line("Dune: Part Two", "Auditorium 1", "2025-03-15T22:45:00Z", "2025-03-16T01:31:00Z");
const ACTIVE: Patch = { "st-dt-005": { status: "active" }, "st-dt-006": { status: "active" } }; // Wonka + Oppenheimer showing again

describe("sample files, rule fallback only", () => {
  it("existing.csv: brings back the two archived showings and leaves the rest", () => {
    const m = rules(sample("existing.csv"));
    assert.deepEqual(kinds(m), { reactivate: 2, unchanged: 4 });
    assert.deepEqual(diff(one(m, "Wonka", "reactivate")), { status: "active" });
    assert.equal(m.issues.length, 0);
  });

  it("existing.csv: the Dune row is older than the stored one, so stored values win", () => {
    const dune = rules(sample("existing.csv")).drafts.find((d) => d.showtimeId === "st-dt-003")!;
    assert.equal(dune.kind, "unchanged");
    assert.equal(dune.format, "IMAX");
    assert.match(dune.explanation, /File differs: format IMAX → 2D; kept stored values/);
  });

  it("new-drop.csv: one new showing, one duplicate row, messy names matched to existing records", () => {
    const m = rules(sample("new-drop.csv"));
    assert.deepEqual(kinds(m), { add: 1, duplicate: 1, unchanged: 4 });
    const add = one(m, "Kung Fu Panda 4", "add");
    assert.deepEqual(add.csvRows, [5, 6]);
    // "Spider Man - Homecoming" / "Aud 1" / "Auditorium Two" / "(Laser)" are not changes.
    assert.ok(m.drafts.filter((d) => d.kind === "unchanged").every((d) => d.diffs.length === 0));
    assert.equal(one(m, "Spider-Man: Homecoming").auditorium, "Auditorium 1");
  });

  it("new-drop.csv after existing.csv was applied: the two dropped showings are suggested, not pre-selected", () => {
    const m = rules(sample("new-drop.csv"), ACTIVE);
    assert.deepEqual(kinds(m), { add: 1, duplicate: 1, unchanged: 4, archive: 2 });
    assert.deepEqual(m.preselectedArchives, []);
    assert.deepEqual(m.drafts.filter((d) => d.kind === "archive").map((d) => d.movieTitle).sort(), ["Oppenheimer", "Wonka"]);
  });
});

describe("stale data is a fact the server decides", () => {
  const moved = csv(line("Spider-Man: Homecoming", "Auditorium 4", "2025-03-15T18:00:00Z", "2025-03-15T20:13:00Z", { updated: "2025-01-01T00:00:00Z" }));
  const says = (action: "update" | "unchanged") => plan([decision(1, action, { showtimeId: "st-dt-001", auditorium: "Auditorium 4", explanation: "Room change." })]);

  it("a row older than the stored showtime changes nothing, even if the model says update", () => {
    const d = verify(moved, says("update")).drafts[0]!;
    assert.equal(d.kind, "unchanged");
    assert.equal(d.auditorium, "Auditorium 1");
    assert.match(d.explanation, /older than the stored one/);
    assert.match(d.explanation, /File differs: room Auditorium 1 → Auditorium 4/);
  });

  it("a current row that differs is an update, even if the model says unchanged", () => {
    const current = moved.replace("2025-01-01T00:00:00Z", "2025-03-14T00:00:00Z");
    const d = verify(current, says("unchanged")).drafts[0]!;
    assert.equal(d.kind, "update");
    assert.deepEqual(diff(d), { auditorium: "Auditorium 4" });
    assert.match(d.explanation, /the file changes room Auditorium 1 → Auditorium 4/);
  });

  it("a file with no last_updated column is treated as current", () => {
    const noStamp = "theater_name,movie_title,auditorium,start_time,end_time\nDowntown Cinema 7,Spider-Man: Homecoming,Auditorium 4,2025-03-15T18:00:00Z,2025-03-15T20:13:00Z\n";
    assert.equal(verify(noStamp, says("update")).drafts[0]!.kind, "update");
  });

  it("blank optional columns never wipe stored values", () => {
    const bare = "theater_name,movie_title,auditorium,start_time,end_time\nDowntown Cinema 7,Dune: Part Two,Auditorium 1,2025-03-15T20:00:00Z,2025-03-15T22:46:00Z\n";
    const d = rules(bare).drafts[0]!;
    assert.equal(d.kind, "unchanged");
    assert.equal(d.format, "IMAX");
  });

  it("an archived showtime stays archived when the row is older than the archive", () => {
    const old = csv(line("Wonka", "Auditorium 3", "2025-03-15T16:00:00Z", "2025-03-15T17:56:00Z", { rating: "PG", updated: "2025-02-01T00:00:00Z" }));
    assert.equal(rules(old).drafts[0]!.kind, "unchanged");
  });
});

describe("after reviewer feedback, the model's deliberate choices are honored", () => {
  const wonka = csv(line("Wonka", "Auditorium 3", "2025-03-15T16:00:00Z", "2025-03-15T17:56:00Z", { rating: "PG" }));
  const keep = plan([decision(1, "unchanged", { showtimeId: "st-dt-005", explanation: "Keeping Wonka archived as you asked." })]);

  it("first pass: a current row for an archived showtime reactivates it", () => {
    assert.equal(verify(wonka, keep).drafts[0]!.kind, "reactivate");
  });

  it("after 'keep it archived': it stays archived", () => {
    const d = verify(wonka, keep, { honorDecisions: true }).drafts[0]!;
    assert.equal(d.kind, "unchanged");
    assert.equal(d.diffs.length, 0);
  });

  const unchanged = (...ids: string[]) => ids.map((showtimeId, i) => decision(i + 1, "unchanged", { showtimeId }));
  const archives = (m: Materialized) => m.drafts.filter((d) => d.kind === "archive").map((d) => d.showtimeId);

  it("after feedback, a showtime the model lists to archive is proposed and pre-selected", () => {
    const answer = plan(unchanged("st-dt-001", "st-dt-002", "st-dt-003"), [{ showtimeId: "st-dt-004", explanation: "Dropping the late show as requested.", confidence: 0.9 }]);
    const m = verify(csv(SPIDER, INSIDE, DUNE_8), answer, { honorDecisions: true });
    assert.deepEqual(m.preselectedArchives, ["st-dt-004"]);
    assert.deepEqual(archives(m), ["st-dt-004"]);
    assert.match(one(m, "Dune: Part Two", "archive").explanation, /as requested/);
  });

  it("feedback about something else leaves a missing showtime as an unticked suggestion", () => {
    // The reviewer said nothing about the late Dune show, so the model lists nothing to archive.
    const m = verify(csv(SPIDER, INSIDE, DUNE_8), plan(unchanged("st-dt-001", "st-dt-002", "st-dt-003"), []), { honorDecisions: true });
    assert.deepEqual(archives(m), ["st-dt-004"], "still offered, as on the first pass");
    assert.deepEqual(m.preselectedArchives, [], "but not ticked");
  });

  it("only the showtime the reviewer asked about is ticked; other suggestions stay unticked", () => {
    const answer = plan(unchanged("st-dt-001", "st-dt-002"), [{ showtimeId: "st-dt-004", explanation: "Dropping the late show as requested.", confidence: 0.9 }]);
    const m = verify(csv(SPIDER, INSIDE), answer, { honorDecisions: true });
    assert.deepEqual(archives(m).sort(), ["st-dt-003", "st-dt-004"]);
    assert.deepEqual(m.preselectedArchives, ["st-dt-004"]);
  });
});

describe("reschedules", () => {
  it("same film, same room, 30 minutes later is one update, not add + archive", () => {
    const text = csv(INSIDE, line("Spider-Man: Homecoming", "Auditorium 1", "2025-03-15T18:30:00Z", "2025-03-15T20:43:00Z"), DUNE_8, DUNE_LATE);
    const m = rules(text);
    assert.deepEqual(kinds(m), { update: 1, unchanged: 3 });
    const d = one(m, "Spider-Man: Homecoming", "update");
    assert.equal(d.showtimeId, "st-dt-001");
    assert.deepEqual(diff(d), { startTime: "2025-03-15T18:30:00.000Z", endTime: "2025-03-15T20:43:00.000Z" });
    assert.match(d.explanation, /stored 6:00 PM showing, moved to 6:30 PM/);
  });

  it("also when the model itself calls it an add", () => {
    const text = csv(line("Spider Man Homecoming", "Aud 1", "2025-03-15T18:30:00Z", "2025-03-15T20:43:00Z"));
    const m = verify(text, plan([decision(1, "add", { title: "Spider-Man: Homecoming", auditorium: "Auditorium 1", explanation: "New showing." })]));
    assert.deepEqual(kinds(m), { update: 1 });
  });

  it("a different room or a far-off time is a genuinely new showing", () => {
    const otherRoom = rules(csv(line("Spider-Man: Homecoming", "Auditorium 4", "2025-03-15T18:30:00Z", "2025-03-15T20:43:00Z")));
    assert.deepEqual(kinds(otherRoom), { add: 1 });
    const matinee = rules(csv(line("Spider-Man: Homecoming", "Auditorium 1", "2025-03-15T13:00:00Z", "2025-03-15T15:13:00Z")));
    assert.deepEqual(kinds(matinee), { add: 1 });
  });
});

describe("retitles", () => {
  const rename = csv(line("Inside Out 3", "Auditorium 2", "2025-03-15T17:30:00Z", "2025-03-15T19:20:00Z", { format: "3D", rating: "PG", updated: "2025-03-16T09:00:00Z" }));
  const expectRename = (m: Materialized) => {
    assert.deepEqual(kinds(m), { update: 1 });
    const d = m.drafts[0]!;
    assert.equal(d.showtimeId, "st-dt-002");
    assert.deepEqual(diff(d), { movieTitle: "Inside Out 3" });
    assert.match(d.explanation, /Inside Out 3/);
    assert.equal(m.notices.length, 0, "not a double booking");
  };

  it("a title that differs only in its number, at the same time and room, is a title change (rules)", () => {
    expectRename(rules(rename));
  });

  it("the same when the model calls it a brand-new film", () => {
    expectRename(verify(rename, plan([decision(1, "add", { title: "Inside Out 3", auditorium: "Auditorium 2", explanation: "New film." })])));
  });

  it("the same when the model matches it but keeps the stored title", () => {
    expectRename(verify(rename, plan([decision(1, "unchanged", { showtimeId: "st-dt-002", title: "Inside Out 2", explanation: "Matches the stored showing." })])));
  });

  it("after feedback asking for a new showing instead, the add is kept and flagged as a double booking", () => {
    const asked = plan([decision(1, "add", { title: "Inside Out 3", auditorium: "Auditorium 2", explanation: "Adding it as a new movie, as you asked." })]);
    const m = verify(rename, asked, { honorDecisions: true });
    assert.deepEqual(kinds(m), { add: 1 });
    assert.equal(m.drafts[0]!.showtimeId, null, "the stored Inside Out 2 showing is left alone");
    assert.match(m.drafts[0]!.explanation, /^Adding it as a new movie, as you asked\. \(Heads up: this overlaps Inside Out 2/);
    assert.equal(m.notices.length, 1);
  });

  it("after feedback, a reschedule the reviewer wants as a separate showing also stays an add", () => {
    const text = csv(line("Spider-Man: Homecoming", "Auditorium 1", "2025-03-15T18:30:00Z", "2025-03-15T20:43:00Z"));
    const asked = plan([decision(1, "add", { title: "Spider-Man: Homecoming", auditorium: "Auditorium 1", explanation: "A second showing, as requested." })]);
    assert.deepEqual(kinds(verify(text, asked)), { update: 1 }, "first pass: a reschedule");
    assert.deepEqual(kinds(verify(text, asked, { honorDecisions: true })), { add: 1 }, "after feedback: the reviewer's call");
  });

  it("number words are not a rename: 'Inside Out Two' is still Inside Out 2", () => {
    const m = rules(csv(line("Inside Out Two", "Auditorium 2", "2025-03-15T17:30:00Z", "2025-03-15T19:20:00Z", { format: "3D", rating: "PG" })));
    assert.deepEqual(kinds(m), { unchanged: 1 });
  });

  it("an unrelated film in the same slot stays a new showing, flagged as a double booking", () => {
    const m = rules(csv(line("Barbie", "Auditorium 2", "2025-03-15T17:30:00Z", "2025-03-15T19:20:00Z")));
    assert.deepEqual(kinds(m), { add: 1 });
    assert.equal(m.notices.length, 1);
  });
});

describe("missing showtimes", () => {
  it("a one-row patch archives nothing", () => {
    const m = rules(csv(line("Dune: Part Two", "Auditorium 2", "2025-03-15T20:00:00Z", "2025-03-15T22:46:00Z", { format: "IMAX" })));
    assert.deepEqual(kinds(m), { update: 1 });
    assert.deepEqual(diff(m.drafts[0]!), { auditorium: "Auditorium 2" });
  });

  it("a file covering most of a day suggests the rest, unselected, whatever the model listed", () => {
    // 3 of the 4 active Mar 15 showings; the model forgot to list the fourth.
    const rows = [1, 2, 3].map((n, i) => decision(n, "unchanged", { showtimeId: ["st-dt-001", "st-dt-002", "st-dt-003"][i] }));
    const m = verify(csv(SPIDER, INSIDE, DUNE_8), plan(rows, []));
    assert.deepEqual(kinds(m), { unchanged: 3, archive: 1 });
    assert.deepEqual(m.preselectedArchives, []);
    assert.equal(one(m, "Dune: Part Two", "archive").showtimeId, "st-dt-004");
  });

  it("never archives a showtime a row matched, an inactive one, or one on a day the file does not cover", () => {
    const rows = [1, 2, 3, 4].map((n, i) => decision(n, "unchanged", { showtimeId: ["st-dt-001", "st-dt-002", "st-dt-003", "st-dt-004"][i] }));
    const bogus = ["st-dt-001", "st-dt-005", "st-dt-007", "nope"].map((showtimeId) => ({ showtimeId, explanation: "", confidence: 1 }));
    const m = verify(csv(SPIDER, INSIDE, DUNE_8, DUNE_LATE), plan(rows, bogus), { honorDecisions: true });
    assert.equal(kinds(m).archive, undefined);
    assert.ok(m.issues.some((i) => i.includes('"nope"')));
  });
});

describe("ratings belong to the film, not to one theater's upload", () => {
  it("a different rating is noted, never proposed as a change", () => {
    const text = csv(line("Dune: Part Two", "Auditorium 1", "2025-03-15T20:00:00Z", "2025-03-15T22:46:00Z", { format: "IMAX", rating: "R" }));
    const d = rules(text).drafts[0]!;
    assert.equal(d.kind, "unchanged");
    assert.equal(d.rating, "PG-13");
    assert.match(d.explanation, /file lists rating R; this film is stored as PG-13/);
  });

  it("existing.csv: Oppenheimer comes back with its stored rating", () => {
    const d = one(rules(sample("existing.csv")), "Oppenheimer", "reactivate");
    assert.deepEqual(diff(d), { status: "active" });
    assert.equal(d.rating, "R");
  });
});

describe("the model's mistakes are caught", () => {
  it("an unknown showtime id is replaced by the rule-based decision and reported", () => {
    const m = verify(csv(DUNE_8), plan([decision(1, "update", { showtimeId: "st-made-up" })]));
    assert.equal(m.drafts[0]!.showtimeId, "st-dt-003");
    assert.equal(m.drafts[0]!.source, "rule");
    assert.match(m.issues[0]!, /unknown showtime id "st-made-up"/);
  });

  it("a row the model skipped still gets a decision", () => {
    const m = verify(csv(DUNE_8, SPIDER), plan([decision(1, "unchanged", { showtimeId: "st-dt-003" })]));
    assert.deepEqual(m.drafts.filter((d) => d.csvRows.length).map((d) => d.showtimeId), ["st-dt-003", "st-dt-001"]);
    assert.match(m.issues[0]!, /Row 2: no decision returned/);
  });

  it("two rows claiming one showtime: the second is a duplicate", () => {
    const m = verify(csv(DUNE_8, DUNE_8), plan([decision(1, "unchanged", { showtimeId: "st-dt-003" }), decision(2, "update", { showtimeId: "st-dt-003" })]));
    assert.deepEqual(kinds(m), { unchanged: 1, duplicate: 1 });
  });

  it("an 'add' of a showing that already exists becomes a match", () => {
    const m = verify(csv(DUNE_8), plan([decision(1, "add", { title: "Dune: Part Two" })]));
    assert.deepEqual(kinds(m), { unchanged: 1 });
    assert.match(m.issues[0]!, /already exists/);
  });

  it("a misquoted or timezone-converted time in an explanation is rewritten from the data", () => {
    const wrong = plan([decision(1, "unchanged", { showtimeId: "st-dt-003", explanation: "Matches the stored Dune: Part Two showing at 1:00 PM." })]);
    assert.equal(verify(csv(DUNE_8), wrong).drafts[0]!.explanation, "Matches the stored Dune: Part Two showing on Mar 15, 8:00 PM in Auditorium 1.");
    const right = plan([decision(1, "unchanged", { showtimeId: "st-dt-003", explanation: "Matches the stored 8:00 PM showing." })]);
    assert.equal(verify(csv(DUNE_8), right).drafts[0]!.explanation, "Matches the stored 8:00 PM showing.");
  });
});

describe("double bookings", () => {
  it("a new showing that overlaps another in the same room is flagged", () => {
    const m = rules(csv(line("Barbie", "Aud 1", "2025-03-15T18:30:00Z", "2025-03-15T20:24:00Z")));
    assert.equal(m.drafts[0]!.kind, "add");
    assert.match(m.drafts[0]!.explanation, /Heads up: this overlaps Spider-Man: Homecoming \(6:00 PM–8:13 PM\)/);
    assert.equal(m.notices.length, 1);
  });

  it("the sample files raise no warnings (their short turnarounds are normal)", () => {
    assert.equal(rules(sample("new-drop.csv")).notices.length, 0);
    assert.equal(rules(sample("existing.csv")).notices.length, 0);
  });
});

describe("invalid rows", () => {
  it("are listed with their reason next to the usable ones", () => {
    const m = rules(csv(DUNE_8, line("Wonka", "Auditorium 3", "not a date", "2025-03-15T17:56:00Z")));
    assert.deepEqual(kinds(m), { unchanged: 1, invalid: 1 });
    assert.match(one(m, "Wonka", "invalid").explanation, /Skipped: start_time "not a date"/);
  });
});

describe("rows that repeat each other but disagree", () => {
  const panda = (room: string, updated: string, more: { format?: string } = {}) =>
    line("Kung Fu Panda 4", room, "2025-03-15T18:30:00Z", "2025-03-15T20:10:00Z", { rating: "PG", updated, ...more });
  const OLDER = "2025-03-14T12:00:00Z";
  const NEWER = "2025-03-15T09:00:00Z";

  it("the row updated most recently speaks for the showing, and the reviewer is told", () => {
    const m = rules(csv(panda("Auditorium 5", OLDER), panda("Auditorium 9", NEWER)));
    assert.deepEqual(kinds(m), { add: 1, duplicate: 1 });
    const add = one(m, "Kung Fu Panda 4", "add");
    assert.equal(add.auditorium, "Auditorium 9", "the newer row's room, not the first row's");
    assert.deepEqual([...add.csvRows].sort(), [1, 2]);
    assert.match(one(m, "Kung Fu Panda 4", "duplicate").explanation, /row 2, which was updated more recently and disagrees on room \(Auditorium 5 vs Auditorium 9\)/);
    assert.ok(m.notices.some((n) => /Rows 1 and 2 are the same showing but disagree on room .* Row 2 was updated more recently/.test(n)), m.notices.join(" | "));
  });

  it("the same when the model calls the later row a plain duplicate", () => {
    const answer = plan([decision(1, "add", { explanation: "New showing." }), decision(2, "duplicate", { duplicateOfRow: 1, explanation: "Repeats row 1." })]);
    const m = verify(csv(panda("Auditorium 5", OLDER), panda("Auditorium 9", NEWER)), answer);
    assert.equal(one(m, "Kung Fu Panda 4", "add").auditorium, "Auditorium 9");
    assert.equal(m.notices.length, 1);
  });

  it("two rows naming one stored showtime: the newer row's values are the update", () => {
    const text = csv(
      line("Dune: Part Two", "Auditorium 1", "2025-03-15T20:00:00Z", "2025-03-15T22:46:00Z", { format: "IMAX", updated: OLDER }),
      line("Dune: Part Two", "Auditorium 2", "2025-03-15T20:00:00Z", "2025-03-15T22:46:00Z", { format: "IMAX", updated: NEWER }),
    );
    const answer = plan([decision(1, "unchanged", { showtimeId: "st-dt-003" }), decision(2, "unchanged", { showtimeId: "st-dt-003" })]);
    const m = verify(text, answer);
    assert.deepEqual(kinds(m), { update: 1, duplicate: 1 });
    assert.deepEqual(diff(one(m, "Dune: Part Two", "update")), { auditorium: "Auditorium 2" });
  });

  it("when neither row is newer the first is kept, with a warning instead of silence", () => {
    const m = rules(csv(panda("Auditorium 5", OLDER), panda("Auditorium 9", OLDER)));
    assert.equal(one(m, "Kung Fu Panda 4", "add").auditorium, "Auditorium 5");
    assert.ok(m.notices.some((n) => /disagree on room .* Row 1 is used; check which is right/.test(n)), m.notices.join(" | "));
  });

  it("after feedback the model's choice of row is kept, and still flagged", () => {
    const answer = plan([decision(1, "add"), decision(2, "duplicate", { duplicateOfRow: 1 })]);
    const m = verify(csv(panda("Auditorium 5", OLDER), panda("Auditorium 9", NEWER)), answer, { honorDecisions: true });
    assert.equal(one(m, "Kung Fu Panda 4", "add").auditorium, "Auditorium 5");
    assert.equal(m.notices.length, 1);
  });

  it("identical repeats, or the same room spelled differently, raise no warning", () => {
    assert.deepEqual(rules(csv(panda("Auditorium 5", OLDER), panda("Auditorium 5", NEWER))).notices, []);
    assert.deepEqual(rules(sample("new-drop.csv")).notices, []);
  });

  it("a third copy may point at the second, and three-way disagreement settles on the newest", () => {
    const chain = plan([decision(1, "add"), decision(2, "duplicate", { duplicateOfRow: 1 }), decision(3, "duplicate", { duplicateOfRow: 2 })]);
    const same = verify(csv(panda("Auditorium 5", OLDER), panda("Auditorium 5", OLDER), panda("Auditorium 5", OLDER)), chain);
    assert.deepEqual(kinds(same), { add: 1, duplicate: 2 });
    assert.deepEqual(same.issues, [], "the chain is followed, not replaced by the rules");

    const m = verify(csv(panda("Auditorium 5", OLDER), panda("Auditorium 9", NEWER), panda("Auditorium 7", "2025-03-15T10:00:00Z")), chain);
    assert.deepEqual(kinds(m), { add: 1, duplicate: 2 });
    assert.equal(one(m, "Kung Fu Panda 4", "add").auditorium, "Auditorium 7");
  });

  it("a duplicate of a row that was itself skipped stands on its own instead of crashing", () => {
    const answer = plan([decision(1, "invalid", { explanation: "Looks wrong." }), decision(2, "duplicate", { duplicateOfRow: 1 })]);
    const m = verify(csv(panda("Auditorium 5", OLDER), line("Wonka Two", "Auditorium 5", "2025-03-15T12:00:00Z", "2025-03-15T13:50:00Z")), answer);
    assert.deepEqual(kinds(m), { invalid: 1, add: 1 });
  });
});

describe("films already in the catalog", () => {
  // A day with nothing stored at Downtown, so the schedule cannot supply the title.
  const april = (title: string) => line(title, "Auditorium 1", "2025-04-02T18:00:00Z", "2025-04-02T20:46:00Z");
  const catalog = ["Dune: Part Two", "Kung Fu Panda 4", "Hidden River 5"];

  it("a known film written another way is added under its catalog title, not as a second film", () => {
    const m = rules(csv(april("DUNE PART 2")), undefined, catalog);
    assert.deepEqual(m.drafts.map((d) => [d.kind, d.movieTitle]), [["add", "Dune: Part Two"]]);
    assert.deepEqual(m.notices, []);
  });

  it("the same when the model 'cleans' the title into a new spelling", () => {
    const m = verify(csv(april("DUNE PART 2")), plan([decision(1, "add", { title: "Dune Part 2" })]), { catalog });
    assert.equal(m.drafts[0]!.movieTitle, "Dune: Part Two");
  });

  it("a likely typo of a catalog film is flagged for the reviewer rather than guessed at", () => {
    const m = verify(csv(april("Hiden River 5")), plan([decision(1, "add", { title: "Hiden River 5", confidence: 1 })]), { catalog });
    assert.equal(m.drafts[0]!.movieTitle, "Hiden River 5");
    assert.match(m.drafts[0]!.explanation, /catalog already has "Hidden River 5"/);
    assert.ok(m.notices.some((n) => n.includes('"Hiden River 5" would be added as a new film')));
  });

  it("the model can settle it by choosing the catalog title", () => {
    const m = verify(csv(april("Hiden River 5")), plan([decision(1, "add", { title: "Hidden River 5" })]), { catalog });
    assert.equal(m.drafts[0]!.movieTitle, "Hidden River 5");
    assert.deepEqual(m.notices, []);
  });

  it("a sequel with a different number, an unrelated film, or a merely similar title is not flagged", () => {
    assert.deepEqual(rules(csv(april("Kung Fu Panda 5")), undefined, catalog).notices, []);
    assert.deepEqual(rules(csv(april("Paper Lanterns")), undefined, catalog).notices, []);
    assert.deepEqual(rules(csv(april("Glass Harbor")), undefined, ["Last Harbor"]).notices, []);
  });

  it("the same warning is given once, however many rows raise it", () => {
    const rows = [1, 2, 3].map((d) => line("Hiden River 5", "Auditorium 1", `2025-04-0${d}T18:00:00Z`, `2025-04-0${d}T20:00:00Z`));
    const m = verify(csv(...rows), plan([1, 2, 3].map((n) => decision(n, "add", { title: "Hiden River 5" }))), { catalog });
    assert.equal(m.notices.length, 1);
  });
});
