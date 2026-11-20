import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clockTimesIn, formatClock, formatShowtime, formatWhen } from "~/lib/format";
import { normalizeKey } from "~/lib/normalize";
import { HttpError } from "~/server/access";
import { sameFilm, sameRoom, sameTheater, similarity } from "~/server/reconcile/context";
import { decodeCursor, titleSearchTerms } from "~/server/showtimes";

describe("identity keys", () => {
  it("ignores case, punctuation and unicode dash variants", () => {
    const key = normalizeKey("Spider-Man: Homecoming");
    for (const v of ["spider man homecoming", "SPIDER‑MAN – HOMECOMING", "Spider—Man:  Homecoming!"]) {
      assert.equal(normalizeKey(v), key, v);
    }
  });

  it("treats spelling noise as the same film, different films as different", () => {
    assert.ok(sameFilm("Spider Man - Homecoming", "Spider-Man: Homecoming"));
    assert.ok(sameFilm("Oppenheimmer", "Oppenheimer"));
    // Heavier typos score lower and are left to the model (or to same-start matching in the rules).
    assert.ok(similarity("Opennheimer", "Oppenheimer") >= 0.75);
    assert.ok(similarity("Inside Out Two", "Inside Out 2") >= 0.9, "number words fold to numerals");
    assert.ok(!sameFilm("Dune: Part Two", "Dune"));
    // 90% similar by spelling, but a different number is a different film.
    assert.ok(!sameFilm("Inside Out 3", "Inside Out 2"));
    assert.ok(sameFilm("Inside Out II", "Inside Out 2"), "II, Two and 2 are the same number");
    assert.ok(!sameFilm("Wonka", "Barbie"));
  });

  it("knows which room names are the same room", () => {
    for (const [a, b] of [["Aud 1", "Auditorium 1"], ["Auditorium One", "Auditorium 1"], ["Auditorium 1 (Laser)", "Auditorium 1"], ["aud. a", "Auditorium A"]]) {
      assert.ok(sameRoom(a!, b!), `${a} = ${b}`);
    }
    // Edit distance alone scores "Auditorium 1" vs "Auditorium 2" at 91%.
    for (const [a, b] of [["Auditorium 1", "Auditorium 2"], ["Auditorium A", "Auditorium B"], ["Screen 1", "Auditorium 1"], ["Auditorium 1", "Auditorium 11"]]) {
      assert.ok(!sameRoom(a!, b!), `${a} ≠ ${b}`);
    }
  });
});

describe("which theater a row is for", () => {
  it("accepts this theater's name in its usual variations, and a blank", () => {
    for (const name of ["Downtown Cinema 7", "downtown cinema 7", "Downtown Cinema", "Downtown Cinema 7 (Seattle)", "Downtwn Cinema 7", ""]) {
      assert.ok(sameTheater(name, "Downtown Cinema 7"), name);
    }
  });

  it("rejects another theater's name", () => {
    for (const name of ["Riverside Multiplex", "Uptown Arts Theater", "Cinema City"]) {
      assert.ok(!sameTheater(name, "Downtown Cinema 7"), name);
    }
  });

  it("a different number is a different theater, however close the rest of the name is", () => {
    for (const name of ["Downtown Cinema 8", "Downtown Cinema 17", "Downtown Cinema Eight"]) {
      assert.ok(!sameTheater(name, "Downtown Cinema 7"), name);
    }
    assert.ok(!sameTheater("Empire Picture House 10015", "Empire Picture House 10014"));
    assert.ok(sameTheater("Downtown Cinema Seven", "Downtown Cinema 7"), "the same number in words");
  });
});

describe("time display", () => {
  it("shows schedule times as stored, in any viewer timezone", () => {
    // 16:00Z is a 4 PM matinee, not 9 AM Pacific or noon Eastern.
    assert.equal(formatShowtime("2025-03-15T16:00:00.000Z"), "Mar 15, 04:00 PM");
    assert.equal(formatClock("2025-03-15T16:00:00.000Z"), "4:00 PM");
    assert.equal(formatWhen("2025-03-16T01:31:00.000Z"), "Mar 16, 1:31 AM");
    assert.equal(formatShowtime(""), "");
  });

  it("finds clock times written in a sentence", () => {
    assert.deepEqual(clockTimesIn("Moved from 6:00 PM to 06:30 pm, ends 8:43p.m."), ["6:00 PM", "6:30 PM", "8:43 PM"]);
    assert.deepEqual(clockTimesIn("Auditorium 1 on March 15"), []);
  });
});

describe("search and paging inputs", () => {
  it("searches titles as typed and with punctuation and spacing removed", () => {
    assert.deepEqual(titleSearchTerms("spider man"), { like: "%spider man%", squashed: "%spiderman%" });
    assert.equal(titleSearchTerms("Spider-Man: Home").squashed, "%spidermanhome%");
  });

  it("treats % and _ as literal characters, never wildcards", () => {
    assert.deepEqual(titleSearchTerms("%"), { like: "%\\%%", squashed: null });
    assert.equal(titleSearchTerms("100%_real").like, "%100\\%\\_real%");
  });

  it("rejects a cursor that was not issued for this sort", () => {
    const good = Buffer.from(JSON.stringify(["2025-03-15T18:00:00.000Z", "st-dt-001"])).toString("base64url");
    assert.deepEqual(decodeCursor(good, 2), ["2025-03-15T18:00:00.000Z", "st-dt-001"]);
    for (const bad of ["garbage", good.slice(0, 8), Buffer.from('["only-one"]').toString("base64url"), Buffer.from("[1,2]").toString("base64url")]) {
      assert.throws(() => decodeCursor(bad, 2), (e) => e instanceof HttpError && e.status === 400, bad);
    }
  });
});
