/**
 * API smoke tests against a running instance (local dev server or the
 * deployed site). Read-only: every write it attempts is one that must be
 * refused, so it can be pointed at production safely.
 *
 *   npm run test:api                                   -> http://localhost:3000
 *   BASE_URL=https://your-app.vercel.app npm run test:api
 *
 * Assumes the demo users and theaters from src/data/assessment-data.ts.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const BASE = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const AVERY = "user-admin-avery"; // admin at Downtown, employee at Riverside
const CASEY = "user-admin-casey"; // admin at all three
const RILEY = "user-viewer-riley"; // employee at Downtown
const JORDAN = "user-viewer-jordan"; // no theaters
const DOWNTOWN = "theater-downtown";
const RIVERSIDE = "theater-riverside";
const UPTOWN = "theater-uptown";

async function call(method, path, user, body) {
  const headers = {};
  if (user) headers["x-user-id"] = user;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // non-JSON error page
  }
  return { status: res.status, json };
}
const get = (path, user) => call("GET", path, user);
const post = (path, user, body = {}) => call("POST", path, user, body);
const q = encodeURIComponent;

describe(`API smoke (${BASE})`, () => {
  it("is up and connected to the database", async () => {
    const r = await get("/api/health");
    assert.equal(r.status, 200);
    assert.equal(r.json.status, "ok");
    assert.equal(r.json.database.connected, true);
  });

  it("reports ScopeBot's configuration without leaking the key", async () => {
    const { scopebot } = (await get("/api/health")).json;
    assert.deepEqual(Object.keys(scopebot).sort(), ["aiConnected", "model", "thinkingLevel"]);
    assert.ok(["minimal", "low", "medium", "high"].includes(scopebot.thinkingLevel));
  });

  describe("who sees what", () => {
    it("requires a user", async () => assert.equal((await get("/api/showtimes")).status, 400));

    it("a user with no theaters sees nothing, even when asking for a theater by id", async () => {
      for (const path of ["/api/showtimes", `/api/showtimes?theaterId=${DOWNTOWN}`]) {
        const r = await get(path, JORDAN);
        assert.equal(r.status, 200);
        assert.deepEqual(r.json.rows, []);
      }
      assert.deepEqual((await get("/api/theaters", JORDAN)).json.theaters, []);
    });

    it("members see only their own theaters", async () => {
      const riley = await get("/api/showtimes?limit=50", RILEY);
      assert.deepEqual([...new Set(riley.json.rows.map((r) => r.theaterId))], [DOWNTOWN]);
      const avery = await get(`/api/showtimes?theaterId=${UPTOWN}`, AVERY);
      assert.deepEqual(avery.json.rows, [], "Avery is not a member of Uptown");
    });

    it("roles differ per theater for the same user", async () => {
      const r = await get("/api/theaters", AVERY);
      const role = Object.fromEntries(r.json.theaters.map((t) => [t.id, t.role]));
      assert.equal(role[DOWNTOWN], "admin");
      assert.equal(role[RIVERSIDE], "employee");
    });
  });

  describe("search and filters", () => {
    const titles = async (term) => (await get(`/api/showtimes?limit=50&q=${q(term)}`, CASEY)).json.rows.map((r) => r.movieTitle);

    it("finds titles regardless of case", async () => {
      const found = await titles("DUNE: part");
      assert.ok(found.length >= 1 && found.every((t) => t === "Dune: Part Two"));
    });

    it("finds titles regardless of punctuation and spacing", async () => {
      for (const term of ["spider man", "spiderman", "Spider-Man"]) {
        assert.ok((await titles(term)).includes("Spider-Man: Homecoming"), term);
      }
    });

    it("treats wildcard characters and SQL as plain text", async () => {
      for (const term of ["%", "_", "'; drop table hv_theater.showtimes; --"]) {
        const r = await get(`/api/showtimes?q=${q(term)}`, CASEY);
        assert.equal(r.status, 200, term);
        assert.deepEqual(r.json.rows, [], term);
      }
      assert.ok((await get("/api/showtimes", CASEY)).json.total > 0, "the table is still there");
    });

    it("filters by status, format, rating and movie status", async () => {
      for (const [field, value, key] of [["status", "archived", "status"], ["format", "IMAX", "format"], ["rating", "PG", "rating"], ["movieStatus", "flagged", "movieStatus"]]) {
        const r = await get(`/api/showtimes?limit=50&${field}=${value}`, CASEY);
        assert.equal(r.status, 200);
        assert.ok(r.json.rows.every((row) => row[key] === value), `${field}=${value}`);
      }
    });

    it("searches theaters by name or city", async () => {
      assert.deepEqual((await get(`/api/theaters?q=down`, CASEY)).json.theaters.map((t) => t.id), [DOWNTOWN]);
      assert.equal((await get(`/api/theaters?q=seattle`, CASEY)).json.theaters.length, 1);
    });

    it("rejects invalid parameters with 400, never 500", async () => {
      for (const bad of ["status=bogus", "sort=password", "limit=100000", "limit=0", "from=notadate", "cursor=garbage"]) {
        assert.equal((await get(`/api/showtimes?${bad}`, CASEY)).status, 400, bad);
      }
    });
  });

  describe("keyset pagination", () => {
    for (const sort of ["startTime", "endTime", "movieTitle", "movieStatus", "lastUpdated", "theaterName"]) {
      for (const order of ["asc", "desc"]) {
        it(`${sort} ${order}: walking every page returns each row exactly once`, async () => {
          const total = (await get("/api/showtimes?limit=1", CASEY)).json.total;
          const seen = [];
          let cursor = null;
          for (let page = 0; page < 50; page++) {
            const r = await get(`/api/showtimes?limit=4&sort=${sort}&order=${order}${cursor ? `&cursor=${q(cursor)}` : ""}`, CASEY);
            assert.equal(r.status, 200);
            seen.push(...r.json.rows.map((row) => row.id));
            cursor = r.json.nextCursor;
            if (!cursor) break;
          }
          assert.equal(new Set(seen).size, seen.length, "no row twice");
          assert.equal(seen.length, total, "no row missed");
        });
      }
    }
  });

  describe("writes are refused without the admin role at that theater", () => {
    const CSV = "theater_name,movie_title,auditorium,start_time,end_time\nDowntown Cinema 7,Dune: Part Two,Auditorium 1,2025-03-15T20:00:00Z,2025-03-15T22:46:00Z\n";
    const upload = (user, theaterId) => post("/api/uploads", user, { theaterId, fileName: "smoke.csv", csv: CSV });

    it("editing a showtime", async () => {
      const rows = (await get("/api/showtimes?limit=50", CASEY)).json.rows;
      const downtown = rows.find((r) => r.theaterId === DOWNTOWN).id;
      const riverside = rows.find((r) => r.theaterId === RIVERSIDE).id;
      assert.equal((await call("PATCH", `/api/showtimes/${downtown}`, RILEY, { status: "inactive" })).status, 403, "employee");
      assert.equal((await call("PATCH", `/api/showtimes/${riverside}`, AVERY, { status: "inactive" })).status, 403, "admin elsewhere, employee here");
      assert.equal((await call("PATCH", `/api/showtimes/${downtown}`, JORDAN, { status: "inactive" })).status, 403, "not a member");
      assert.equal((await call("PATCH", `/api/showtimes/${downtown}`, undefined, { status: "inactive" })).status, 400, "no user");
      assert.equal((await call("PATCH", `/api/showtimes/${downtown}`, AVERY, { status: "exploded" })).status, 400, "invalid value");
      assert.equal((await call("PATCH", "/api/showtimes/does-not-exist", AVERY, { status: "active" })).status, 404);
    });

    it("uploading a CSV", async () => {
      assert.equal((await upload(RILEY, DOWNTOWN)).status, 403, "employee");
      assert.equal((await upload(JORDAN, DOWNTOWN)).status, 403, "not a member");
      assert.equal((await upload(AVERY, RIVERSIDE)).status, 403, "admin elsewhere, employee here");
      assert.equal((await upload(AVERY, UPTOWN)).status, 403, "not a member of that theater");
      assert.equal((await upload(AVERY, "no-such-theater")).status, 403);
    });

    it("clearing a schedule", async () => {
      assert.equal((await post(`/api/theaters/${DOWNTOWN}/clear-schedule`, RILEY)).status, 403);
      assert.equal((await post(`/api/theaters/${UPTOWN}/clear-schedule`, AVERY)).status, 403);
    });

    it("acting on someone else's upload", async () => {
      const history = (await get(`/api/uploads?theaterId=${DOWNTOWN}`, AVERY)).json.uploads;
      assert.ok(history.length > 0, "the demo data includes an example upload");
      const id = history[0].id;
      assert.deepEqual((await get(`/api/uploads?theaterId=${DOWNTOWN}`, JORDAN)).json.uploads ?? [], [], "history is members-only");
      assert.equal((await get(`/api/uploads/${id}`, JORDAN)).status, 404, "so is an upload's detail");
      for (const action of ["apply", "retry", "discard", "cancel"]) {
        assert.equal((await post(`/api/uploads/${id}/${action}`, RILEY, { feedback: "x" })).status, 403, `employee ${action}`);
        assert.equal((await post(`/api/uploads/${id}/${action}`, JORDAN, { feedback: "x" })).status, 403, `non-member ${action}`);
      }
      assert.equal((await post("/api/uploads/nope/apply", AVERY)).status, 404);
    });
  });

  describe("upload request validation", () => {
    it("rejects malformed requests before anything is recorded", async () => {
      assert.equal((await post("/api/uploads", AVERY, "not json")).status, 400);
      assert.equal((await post("/api/uploads", AVERY, { theaterId: DOWNTOWN, fileName: "a.csv" })).status, 400, "no csv");
      assert.equal((await post("/api/uploads", AVERY, { theaterId: DOWNTOWN, fileName: "a.csv", csv: "" })).status, 400, "empty csv");
      assert.equal((await post("/api/uploads", AVERY, { theaterId: DOWNTOWN, fileName: "a.csv", csv: "x".repeat(1_100_000) })).status, 400, "over 1 MB");
      const csv = "theater_name,movie_title,auditorium,start_time,end_time\nDowntown Cinema 7,Dune: Part Two,Auditorium 1,2025-03-15T20:00:00Z,2025-03-15T22:46:00Z\n";
      assert.equal((await post("/api/uploads", AVERY, { theaterId: DOWNTOWN, fileName: "a.csv", csv, thinkingLevel: "turbo" })).status, 400, "unknown thinking level");
      assert.equal((await post("/api/uploads/any/retry", AVERY, { feedback: "x", thinkingLevel: "turbo" })).status, 400, "unknown thinking level on retry");
    });

    it("a finished upload cannot be applied, retried or discarded again", async () => {
      const history = (await get(`/api/uploads?theaterId=${DOWNTOWN}`, AVERY)).json.uploads;
      const done = history.find((u) => ["applied", "discarded", "partially_applied"].includes(u.status));
      if (!done) return; // fresh database: nothing finished yet
      assert.equal((await post(`/api/uploads/${done.id}/apply`, AVERY)).status, 409);
      assert.equal((await post(`/api/uploads/${done.id}/retry`, AVERY, { feedback: "again" })).status, 409);
      const cancel = await post(`/api/uploads/${done.id}/cancel`, AVERY);
      assert.equal(cancel.json.cancelled, false);
      assert.equal(cancel.json.upload.status, done.status, "cancel leaves a finished upload alone");
    });
  });
});
