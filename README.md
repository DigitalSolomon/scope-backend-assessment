# Theater Showtimes Manager

A theater management console with **ScopeBot**, an AI agent that reconciles partner CSV uploads against the stored schedule. It matches messy titles and rooms, finds new, changed, missing and duplicate showtimes, explains each proposal, and applies nothing until a reviewer confirms. Every upload and its outcome is recorded.

**Live:** https://scope-backend-assessment-ebon.vercel.app (no login) · **Stack:** Next.js 15 + TypeScript · Postgres (Supabase) · Gemini · Vercel

## Try it

1. Top right, keep **Avery Admin**. Set **Theater scope** to **Downtown Cinema 7**.
2. **Upload CSV** → `sample-data/existing.csv`. ScopeBot shows its progress, then a proposal.
   - Expect 2 changes: the archived Wonka and Oppenheimer showings come back.
   - The Dune 8 PM row is older than the stored one, so it is left alone and says why.
3. Review it. Untick a change, **Confirm**, **Cancel**, or **Reject w/ Feedback** (try "Keep Oppenheimer archived").
4. Upload `sample-data/new-drop.csv`.
   - Expect 1 new showing (Kung Fu Panda 4), 1 duplicate row ignored, and "Spider Man - Homecoming", "Aud 1", "Auditorium Two" matched to existing records.
   - If you confirmed step 2, Wonka and Oppenheimer also appear under **Not in This File**, unticked: the file may be a partial update, so archiving them is your call.
5. Scroll to **Upload history** under the table to see every attempt and reopen any of them.

More to try:

| Try this                                           | What should happen                                                                                                                                         |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The **Quick / Thorough** switch next to Upload CSV | Quick answers in about 10 s; Thorough takes about 25 s and shows its reasoning.                                                                            |
| **Cancel** while ScopeBot is thinking              | It stops within a couple of seconds and nothing is saved.                                                                                                  |
| Refresh the page during a review                   | The proposal is in Upload history with **Resume review**.                                                                                                  |
| Edit a sample CSV: move a showing 30 minutes       | One update with the old and new time, not an add plus an archive.                                                                                          |
| Upload `sample-data/rename-inside-out-3.csv`       | One title change (Inside Out 2 → Inside Out 3). Reject it with "add it as a new movie instead" and it becomes a new showing with a double-booking warning. |
| Upload an image or a spreadsheet instead of a CSV  | A plain message; the attempt is recorded as failed.                                                                                                        |
| Switch the user to **Riley Viewer** (an employee)  | Upload and edit controls are disabled; the server refuses writes too.                                                                                      |
| Switch to **Sam Scale** (20,000 theaters)          | Search, sort and **Load more** stay fast; open **Query inspector** to see why.                                                                             |

Confirmed changes are real. `npm run db:seed` puts the sample showtimes back.

## Run it locally

```bash
npm install
cp .env.example .env    # set DATABASE_URL and GEMINI_API_KEY
npm run db:migrate      # create or upgrade the schema (safe to re-run)
npm run db:seed         # load the sample data
npm run dev             # http://localhost:3000
```

- **`DATABASE_URL`:** the Supabase _transaction pooler_ (`aws-…pooler.supabase.com:6543`, user `postgres.<project-ref>`). The direct host is IPv6-only and unreachable from Vercel.
- **`GEMINI_API_KEY`:** a free key from [Google AI Studio](https://aistudio.google.com/apikey). It stays on the server. Without it ScopeBot still works, in a labelled rule-based mode.
- **Optional:** `GEMINI_MODEL`, `GEMINI_THINKING_LEVEL`, `GEMINI_FALLBACK_MODEL` (defaults in `.env.example`).
- **On Vercel:** set the same variables in the project's environment settings and redeploy.

| Command                 | What it does                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------- |
| `npm test`              | Unit tests. No network or database; under a second.                                            |
| `npm run test:api`      | Read-only API checks against a running instance (`BASE_URL=https://…` to target a deployment). |
| `npm run evals`         | ScopeBot graded on real Gemini calls. Needs `GEMINI_API_KEY`.                                  |
| `npm run check`         | Lint, type check and unit tests.                                                               |
| `npm run db:reset`      | Drop the schema, then migrate and load the sample data.                                        |
| `npm run db:seed:scale` | Add the synthetic performance dataset (`-- --remove` deletes it).                              |

## How ScopeBot works

1. **Record and parse.** The upload is saved first, so failed attempts are visible. The parser accepts comma, semicolon or tab delimiters and forgiving headers, and reports each invalid row with its reason.
2. **Gather context.** Code loads the stored showtimes for the file's days and up to 5 likely matches per row.
3. **The model decides identity.** Gemini returns a schema-constrained plan: is each row an existing showtime (which one), a new one or a duplicate, and what are the canonical film and room. It writes one sentence of explanation per decision. CSV cells are data, never instructions.
4. **Code decides the facts** (`src/server/reconcile/plan.ts`), and overrides the model where they disagree:
   - **Field changes** are computed from the database and the file.
   - **Stale rows** (older than the stored showtime) change nothing.
   - **Reschedules and retitles:** the same film in the same room within 90 minutes, or a similar title in the same room and time slot, is one update.
   - **Missing showtimes** are suggested only when the file covers at least half of that day, and start unticked.
   - **Other theaters' rows** are skipped, **double-booked rooms** are flagged, and a **time quoted** in an explanation must belong to that showtime.
   - If Gemini is unavailable, the same rules produce the whole proposal, labelled as rule-based.
5. **Review.** The reviewer unticks changes, confirms, cancels, or rejects with feedback, which re-runs the model with their notes.
6. **Apply.** One transaction with a savepoint per change. A change that conflicts is recorded as failed and the rest still apply.

Progress streams to the browser as it happens (steps, the model's reasoning, a heartbeat), and analysis can be cancelled at any point.

### Quick or Thorough

The switch next to Upload CSV sets how hard Gemini thinks for that upload. Both settings are scored by the evals below.

| Switch                 | Gemini thinking level | Evals passed | Typical / slowest | Time allowed per attempt |
| ---------------------- | --------------------- | ------------ | ----------------- | ------------------------ |
| **Quick**              | `low`                 | 28 / 28      | 8 s / 38 s        | 35 s + 0.15 s per row    |
| **Thorough** (default) | `medium`              | 28 / 28      | 20 s / 68 s       | 65 s + 0.25 s per row    |

`GEMINI_THINKING_LEVEL` sets the default; the switch overrides it per upload. If a call is slow, stalls (30 s of silence) or is rate limited, ScopeBot steps down instead of hanging: the same model at `low`, then `GEMINI_FALLBACK_MODEL`, then the rules. All attempts share a 100 s budget, inside the 120 s function limit, and the review says when a lighter pass produced the proposal.

## Testing and evals

| Suite              | What it covers                                                                                                                                 | Result                          |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `npm test`         | **85 unit tests:** CSV parsing, title and room matching, every rule in step 4, and the Gemini client's time limits and retries (fake network). | 85 / 85                         |
| `npm run test:api` | **30 API checks:** who sees what, every write refused for the wrong role, search, filters, paging through every sort, input validation.        | 30 / 30                         |
| `npm run evals`    | **28 ScopeBot scenarios** through the real pipeline with real Gemini calls, graded automatically.                                              | 28 / 28 Thorough, 28 / 28 Quick |

### Evals

Unit tests cannot tell whether the model decides well, so the evals do. Each case in [`evals/cases/`](evals/cases) is a CSV plus what a correct proposal must contain. It runs against the sample schedule in `src/data/assessment-data.ts`, so it needs no database, writes nothing and is repeatable.

| The task asks for            | Cases                                                                                                                                         |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Title and auditorium matches | messy sample file, typos and odd spellings, a room not used before                                                                            |
| New records                  | new day, new showing, a different film at an existing start time                                                                              |
| Changed records              | room change, 30-minute reschedule, format change, a retitle ("Inside Out 2" to "Inside Out 3"), an archived showing returning in another room |
| Missing records              | full-day file (suggested, unticked), one-row patch (nothing archived)                                                                         |
| Duplicate records            | exact repeats, repeats with a different spelling                                                                                              |
| Leaving things alone         | stale file, rating differences, blank optional columns, a show that crosses midnight                                                          |
| Bad input                    | another theater's rows, the wrong theater's file, instructions hidden in a cell, broken rows, semicolons                                      |
| Review with feedback         | keep one archived, drop one change, add as a new showing instead of renaming, feedback that tries to override the rules                       |
| Warnings and timing          | double-booked room flagged, a 40-row file inside the time budget                                                                              |

Every proposal must also be answered by the model (not the fallback), give each row a decision, state a change count that matches, never mention an internal ID, never claim anything was applied, and only quote times that belong to that showtime.

**Results:** [Thorough](evals/results/gemini-3.8-flash__medium.md) 28 / 28 and [Quick](evals/results/gemini-3.8-flash__low.md) 28 / 28, one run per case (the free tier has a daily quota). Models vary between runs; `EVAL_RUNS=3` gives a pass rate per case.

**What the evals changed.** Quick first scored 24 / 26: it added another theater's rows, and once said "All set" before any review. Both rules lived only in the prompt; they are now enforced in code with unit tests, so they hold at either setting.

**Editing or adding a case.** A case is one JSON file:

```jsonc
{
  "title": "A showing starts 30 minutes later",
  "checks": "A reschedule is one update, not add + archive",
  "rows": [
    "Downtown Cinema 7,Spider-Man: Homecoming,Auditorium 1,2025-03-15T18:30:00Z,2025-03-15T20:43:00Z,EN,2D,PG-13,2025-03-14T12:00:00Z",
  ],
  "expect": {
    "counts": { "update": 1, "add": 0, "archive": 0 },
    "changes": [
      {
        "kind": "update",
        "title": "Spider-Man: Homecoming",
        "sets": { "startTime": "2025-03-15T18:30:00.000Z" },
      },
    ],
  },
}
```

- **Input:** `rows` (under the standard header), `csv` (full text, line by line) or `csvFile` (a path).
- **Starting state:** `schedule` patches the sample schedule, e.g. `{ "st-dt-005": { "status": "active" } }`.
- **Feedback:** `feedback` sends reviewer feedback after the first proposal and grades the second.
- **Expectations:** `counts`, `changes` and `absent` (by `kind`, `title`, `room`, `sets`, `explains`), `warnings`, `message`, `messageNot`.

```bash
npm run evals                               # every case; saves the scorecard for this setting
npm run evals -- shift fuzzy                # only matching cases
EVAL_RUNS=3 npm run evals                   # each case three times
GEMINI_THINKING_LEVEL=low npm run evals     # score Quick
GEMINI_MODEL=gemini-3.5-flash-lite npm run evals
```

The run exits non-zero below `EVAL_MIN_PASS` (default 0.9), so it can gate a deploy.

**Not automated:** the apply transaction and the UI. Apply was verified with scripted runs (partial apply, a hand edit between proposal and confirm, two proposals adding the same showing, a double-clicked Confirm); the UI was checked by hand in Chrome.

## Key decisions

- **Own Postgres schema (`hv_theater`).** The provided database is shared, so every table lives in a dedicated schema.
- **Roles are per theater.** `theater_memberships(user_id, theater_id, role)` lets the same person be `admin` at one theater and `employee` at another. Every query joins through memberships, so access control is part of the query, not a filter applied afterwards. Edits re-check the role at that showtime's theater on the server.
- **Normalized, with one deliberate denormalization.** Showtimes reference movies and auditoriums, and also carry `theater_id`: every query is scoped by theater, so it leads the hot indexes. A composite foreign key guarantees the auditorium belongs to the same theater.
- **Status at two levels.** `movies.status` (approved / draft / flagged / needs-review) and `showtimes.status` (active / inactive / archived). Seed data that gave one film two statuses keeps the more cautious one.
- **Business rule in the database.** A partial unique index enforces at most one _active_ showtime per movie + start time per theater.
- **No auth.** The mock session selector sends `x-user-id`; the server authorizes from memberships.
- **The model proposes, code verifies.** Anything that is a fact (diffs, staleness, what may be archived) is computed, so a model cannot misreport a change, and results do not hinge on the model or thinking level.
- **Showtimes display as stored.** The sample times are schedule times (16:00 is a 4 PM matinee), so the table, the review cards and ScopeBot's sentences all show them unconverted, the same in every timezone.
- **Ratings are not changed by uploads.** A film is shared by every theater, so one theater's file noting a different rating is shown to the reviewer, not written.
- **A file's own timestamp is kept.** A showtime written from a CSV is stamped with that row's `last_updated`, so the partner's next, newer file is still newer. Manual edits stamp "now".

## Data model

```
theaters ─┬─< auditoriums
          ├─< theater_memberships >── users        (role per theater)
          └─< showtimes >── movies                  (status on both)

csv_uploads ─┬─< upload_changes ──< upload_change_diffs
             └─< upload_events
```

| Table                                      | Purpose                                                                                                                                                                                                                          |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `theaters`, `users`, `theater_memberships` | Who can see and edit which theater.                                                                                                                                                                                              |
| `movies`                                   | Title, normalized `title_key` (unique), rating, movie status.                                                                                                                                                                    |
| `auditoriums`                              | Per-theater rooms, with a normalized `name_key`.                                                                                                                                                                                 |
| `showtimes`                                | Movie + auditorium + time window, language, format, status, `version` for optimistic concurrency.                                                                                                                                |
| `csv_uploads`                              | One row per upload attempt, written before any processing. Status (`received → analyzing → pending_review → applying → applied`, or `partially_applied` / `discarded` / `failed`), raw CSV, counts, error, lifecycle timestamps. |
| `upload_changes`                           | Each proposed action (`add`, `update`, `archive`, `reactivate`, `unchanged`, `duplicate`, `invalid`) with explanation, confidence, reviewer decision and apply outcome. Matches the `PreviewChanges` shape.                      |
| `upload_change_diffs`                      | Field-level `old → new` for updates.                                                                                                                                                                                             |
| `upload_events`                            | Append-only log of status changes, errors and reviewer feedback.                                                                                                                                                                 |

Full DDL and index rationale: [`db/schema.sql`](db/schema.sql).

## API

All routes take the acting user in the `x-user-id` header.

| Route                                                 |                                                                                                                                                                                                                                      |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/health`                                     | Database connectivity, and whether the AI is connected.                                                                                                                                                                              |
| `GET /api/users`                                      | Users with theater and admin counts.                                                                                                                                                                                                 |
| `GET /api/theaters?q=`                                | The user's theaters with their role at each; substring search on name or city.                                                                                                                                                       |
| `GET /api/showtimes`                                  | Search (`q`), filters (`theaterId`, `status`, `format`, `language`, `rating`, `auditorium`, `movieStatus`, `from`, `to`), sort (`sort`, `order`), keyset pagination (`limit`, `cursor`). `explain=1` adds the Postgres plan summary. |
| `GET /api/showtimes/facets?theaterId=`                | Distinct filter values in scope.                                                                                                                                                                                                     |
| `PATCH /api/showtimes/:id`                            | Admin at that theater: `status` and/or `movieStatus`.                                                                                                                                                                                |
| `POST /api/theaters/:id/clear-schedule`               | Admin: archive every showtime at the theater.                                                                                                                                                                                        |
| `GET /api/uploads?theaterId=`, `GET /api/uploads/:id` | Upload history; one upload with its changes and event log.                                                                                                                                                                           |
| `POST /api/uploads`                                   | Admin: `{ theaterId, fileName, csv, thinkingLevel? }`. Records the upload and runs ScopeBot. With `Accept: application/x-ndjson`, streams progress and ends with the proposal.                                                       |
| `POST /api/uploads/:id/retry`                         | Reject with feedback: `{ feedback }`. Re-runs the agent (streams like above).                                                                                                                                                        |
| `POST /api/uploads/:id/cancel`                        | Stop an analysis in progress.                                                                                                                                                                                                        |
| `POST /api/uploads/:id/apply`                         | Apply the proposal, minus `{ rejectedChangeIds }`.                                                                                                                                                                                   |
| `POST /api/uploads/:id/discard`                       | Reviewer cancelled; nothing is applied.                                                                                                                                                                                              |

The UI's **Query inspector** panel lists every API call with its timing. With **Explain** ticked, it also shows which indexes each search used.

## Performance

### Approach

- **Every sort has an index that matches it.** Per-theater indexes lead with `theater_id` (`(theater_id, start_time, id)` …). Global indexes (`(start_time, id)`, `(end_time, id)`, `(last_updated, id)`, `movies(title, id)`, `movies(status, id)`) serve users who belong to many theaters. Postgres walks the index in order, checks membership and filters per row, and stops at the page limit.
- **Keyset pagination.** The cursor holds the last row's sort key plus `id`, and the next page starts at `(sort_key, id) > (cursor)`. Page 1000 costs the same as page 1; `OFFSET` would scan every skipped row.
- **Trigram indexes** (`pg_trgm` GIN) on movie titles and theater names/locations for substring search. Title search also matches with punctuation and spacing removed ("spiderman" finds "Spider-Man"), backed by a second trigram index on the squashed title key.
- **Capped counts.** The "N matching" total stops counting at 10,000 and the UI shows "10,000+", so counting never costs more than the page.
- **Facets in one pass** with `GROUPING SETS`. The all-theaters scope is cached for 60 s per server instance.

### Complexity

_N_ = showtimes in the table, _k_ = page size (50), _s_ = fraction of rows matching the filters, _M_ = showtimes the user can access, _C_ = count cap (10,000).

| Operation                                    | Cost                                                                              |
| -------------------------------------------- | --------------------------------------------------------------------------------- |
| Page of results, any indexed sort, any depth | O(log N + k / s): one index descent, then walk until _k_ matches                  |
| Single-theater page                          | O(log N + k): the theater-led index is already narrowed to one theater            |
| "N matching" count                           | O(min(M, C))                                                                      |
| Next page                                    | O(log N + k / s), independent of how deep you are (OFFSET would be O(offset + k)) |
| Theater / title substring search             | Roughly proportional to the number of trigram matches, not to table size          |
| Facets                                       | O(M) for one scope, then O(1) from cache for 60 s                                 |
| Edit a showtime                              | O(log N) lookups plus O(1) index maintenance                                      |

A very selective filter (small _s_) on a global sort is the worst case: the walk visits more rows per match. The single-theater indexes bound this whenever a theater is selected.

### Measured

Synthetic dataset: **20,003 theaters · 3,014 movies · 200,015 showtimes · 160k auditoriums**. The user tested belongs to all 20,000 theaters, which is the hardest access pattern. Postgres execution times are from `EXPLAIN ANALYZE` on the Supabase free tier (us-east-1).

| Query                                                    | Before global indexes     | After                              | Plan starts with                      |
| -------------------------------------------------------- | ------------------------- | ---------------------------------- | ------------------------------------- |
| All theaters, sort by start time                         | 306 ms (seq scans + sort) | **1.5 ms**                         | `showtimes_start`                     |
| All theaters, sort by end / last updated                 | ~320 ms                   | **1.5–1.6 ms**                     | `showtimes_end` / `showtimes_updated` |
| All theaters, sort by movie title                        | 320 ms                    | **2.0 ms**                         | `movies_title_sort`                   |
| All theaters, sort by movie status                       | 326 ms                    | **2.0 ms**                         | `movies_status_order`                 |
| All theaters, sort by theater name                       | 1.1 ms                    | **1.0 ms**                         | `theaters_name_sort` (index-only)     |
| Filter: status / format + language / movie status / date | 30–70 ms                  | **1.4–3.9 ms**                     | `showtimes_start`                     |
| Title search `crimson` (10,000 matches)                  | 47 ms                     | **6.0 ms**                         | `showtimes_start`                     |
| Single theater                                           | 0.2 ms                    | **0.3 ms**                         | `showtimes_theater_start`             |
| Next page (keyset)                                       | n/a                       | **~2 ms**                          | same as page 1                        |
| "N matching" count, broad                                | 236 ms (exact)            | **70–160 ms** (capped)             |                                       |
| Facets, all 20k theaters                                 | 1.1 s                     | **0.9 s** cold / **0.23 s** cached |                                       |

After the second round of indexes, the only sequential scan left is on the small movies table (3,000 rows, about 5 ms) when a title search matches few or no films. End-to-end API latency from a local dev server is about 50–60 ms, almost all of it the network round trip to the database. Keyset pagination was verified for every sort field and direction: walking all pages returns every row exactly once.

The full synthetic dataset takes about 240 MB with indexes and is currently loaded in the shared database (the "Sam Scale" user belongs to all 20,000 of its theaters, which makes the scale visible in the UI). Remove it with `npm run db:seed:scale -- --remove`; recreate it with `npm run db:seed:scale` (about 35 s).

## Project layout

```
db/schema.sql            schema, indexes, rationale
scripts/db.mjs           migrate / seed / seed-scale / reset
src/server/              db client, access control, search, uploads, streaming (server-only)
src/server/reconcile/    ScopeBot: CSV parsing, context, Gemini client, agent prompt, verification, apply
src/app/api/             route handlers
src/app/_components/     table, filters, theater picker, query inspector, ScopeBot, review modal, upload history, Quick / Thorough switch
public/scopebot/         ScopeBot as transparent video (WebM for Chrome, HEVC for Safari), idle and thinking loops
src/lib/normalize.ts     title/auditorium identity keys (unicode dashes, case, punctuation)
src/lib/format.ts        how showtimes are displayed (as stored, in every timezone)
tests/                   unit tests (node:test via tsx), shared fixture schedule, tests/api/smoke.mjs
evals/                   ScopeBot eval cases (JSON), runner, saved scorecards
```
