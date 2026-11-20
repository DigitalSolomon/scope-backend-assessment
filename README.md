# Theater Showtimes Manager

A theater management console backed by Postgres: per-theater roles, indexed search and filtering that stays fast at hundreds of thousands of showtimes, and a schema that records every CSV upload ("patching event") and the changes it proposes.

**Stack:** Next.js 15 (App Router) route handlers in TypeScript · Postgres on Supabase via [`postgres`](https://github.com/porsager/postgres) · Vercel.

> Status: the database layer, search API and UI are live. CSV upload still opens the original mock preview; the AI-powered reconciliation flow replaces it next.

## Setup

```bash
npm install
cp .env.example .env        # set DATABASE_URL (Supabase transaction pooler, see below)
npm run db:migrate          # create/upgrade the hv_theater schema (idempotent)
npm run db:seed             # load src/data/assessment-data.ts
npm run dev                 # http://localhost:3000
```

| Script          | What it does                                                                                                                                                                 |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `db:migrate`    | Applies `db/schema.sql` and refreshes planner statistics. Safe to re-run.                                                                                                    |
| `db:seed`       | Upserts the sample theaters, users, memberships, showtimes and an example upload.                                                                                            |
| `db:seed:scale` | Adds a synthetic dataset for performance testing. Size via `SCALE_THEATERS`, `SCALE_MOVIES`, `SCALE_SHOWTIMES_PER_THEATER`. `-- --remove` deletes it and reclaims the space. |
| `db:reset`      | Drops the `hv_theater` schema, then migrates and seeds.                                                                                                                      |

**Connection string.** Use the Supabase _transaction pooler_ (`aws-…pooler.supabase.com:6543`, user `postgres.<project-ref>`). The direct `db.<ref>.supabase.co` host is IPv6-only and unreachable from Vercel. The client disables prepared statements and holds one connection per serverless instance, as the pooler requires (`src/server/db.ts`).

## Key decisions

- **Own Postgres schema (`hv_theater`).** The provided database is shared, so every table lives in a dedicated schema.
- **Roles are per theater.** `theater_memberships(user_id, theater_id, role)` lets the same person be `admin` at one theater and `employee` at another. Every query joins through memberships, so access control is part of the query, not a filter applied afterwards. Edits re-check the role at that showtime's theater on the server.
- **Normalized, with one deliberate denormalization.** Showtimes reference movies and auditoriums, and also carry `theater_id`: every query is scoped by theater, so it leads the hot indexes. A composite foreign key guarantees the auditorium belongs to the same theater.
- **Status at two levels.** `movies.status` (approved / draft / flagged / needs-review) and `showtimes.status` (active / inactive / archived). Seed data that gave one film two statuses keeps the more cautious one.
- **Business rule in the database.** A partial unique index enforces at most one _active_ showtime per movie + start time per theater.
- **No auth.** The mock session selector sends `x-user-id`; the server authorizes from memberships.

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
| `GET /api/health`                                     | Database connectivity and latency.                                                                                                                                                                                                   |
| `GET /api/users`                                      | Users with theater and admin counts.                                                                                                                                                                                                 |
| `GET /api/theaters?q=`                                | The user's theaters with their role at each; substring search on name or city.                                                                                                                                                       |
| `GET /api/showtimes`                                  | Search (`q`), filters (`theaterId`, `status`, `format`, `language`, `rating`, `auditorium`, `movieStatus`, `from`, `to`), sort (`sort`, `order`), keyset pagination (`limit`, `cursor`). `explain=1` adds the Postgres plan summary. |
| `GET /api/showtimes/facets?theaterId=`                | Distinct filter values in scope.                                                                                                                                                                                                     |
| `PATCH /api/showtimes/:id`                            | Admin at that theater: `status` and/or `movieStatus`.                                                                                                                                                                                |
| `POST /api/theaters/:id/clear-schedule`               | Admin: archive every showtime at the theater.                                                                                                                                                                                        |
| `GET /api/uploads?theaterId=`, `GET /api/uploads/:id` | Upload history; one upload with its changes and event log.                                                                                                                                                                           |

The UI's **Query inspector** panel lists every API call with its timing. With **Explain** ticked, it also shows which indexes each search used.

## Performance

### Approach

- **Every sort has an index that matches it.** Per-theater indexes lead with `theater_id` (`(theater_id, start_time, id)` …). Global indexes (`(start_time, id)`, `(end_time, id)`, `(last_updated, id)`, `movies(title, id)`, `movies(status, id)`) serve users who belong to many theaters. Postgres walks the index in order, checks membership and filters per row, and stops at the page limit.
- **Keyset pagination.** The cursor holds the last row's sort key plus `id`, and the next page starts at `(sort_key, id) > (cursor)`. Page 1000 costs the same as page 1; `OFFSET` would scan every skipped row.
- **Trigram indexes** (`pg_trgm` GIN) on movie titles and theater names/locations for substring search.
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

After the second round of indexes, no query plan uses a sequential scan. End-to-end API latency from a local dev server is about 50–60 ms, almost all of it the network round trip to the database. Keyset pagination was verified for every sort field and direction: walking all pages returns every row exactly once.

The full synthetic dataset took ~185 MB with indexes. The shared database now holds a small development set instead (1,000 theaters, 10,000 showtimes). To reproduce these numbers, recreate the full set with `npm run db:seed:scale -- --remove && npm run db:seed:scale` (about 35 s).

## Project layout

```
db/schema.sql            schema, indexes, rationale
scripts/db.mjs           migrate / seed / seed-scale / reset
src/server/              db client, access control, search, uploads (server-only)
src/app/api/             route handlers
src/app/_components/     table, filters, theater picker, query inspector, preview modal
src/lib/normalize.ts     title/auditorium identity keys (unicode dashes, case, punctuation)
```
