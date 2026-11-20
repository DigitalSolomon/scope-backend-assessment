#!/usr/bin/env node
/**
 * Database tasks. Run with Node 22+:
 *
 *   npm run db:migrate      create/upgrade the hv_theater schema (idempotent)
 *   npm run db:seed         load src/data/assessment-data.ts (idempotent upsert)
 *   npm run db:seed:scale   add a synthetic large dataset for index testing
 *   npm run db:reset        DROP the hv_theater schema, then migrate + seed
 *
 * Scale sizes can be tuned with SCALE_THEATERS, SCALE_MOVIES and
 * SCALE_SHOWTIMES_PER_THEATER.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { assessmentData } from "../src/data/assessment-data.ts";
import { cleanText, normalizeKey } from "../src/lib/normalize.ts";

const SCHEMA = "hv_theater";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Run with --env-file=.env");
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL, {
  prepare: false,
  max: 1,
  ssl: "require",
  onnotice: () => {},
});

async function trgmSchema() {
  const [row] = await sql`
    select extnamespace::regnamespace::text as schema
    from pg_extension where extname = 'pg_trgm'`;
  if (row) return row.schema;
  await sql`create extension if not exists pg_trgm with schema extensions`;
  return "extensions";
}

async function migrate() {
  const trgm = await trgmSchema();
  const ddl = fs
    .readFileSync(path.join(root, "db/schema.sql"), "utf8")
    .replaceAll("{{trgm}}", trgm);
  await sql.unsafe(ddl);
  // Fresh statistics so the planner knows about new (expression) indexes.
  await sql.unsafe(
    "analyze hv_theater.theaters, hv_theater.users, hv_theater.theater_memberships, " +
      "hv_theater.movies, hv_theater.auditoriums, hv_theater.showtimes",
  );
  console.log(`migrate: schema ${SCHEMA} is up to date (pg_trgm in ${trgm})`);
}

// Most cautious status wins when the seed has the same film with different statuses.
const STATUS_PRIORITY = ["flagged", "needs-review", "draft", "approved"];

async function seed() {
  const { theaters, users, showtimes } = assessmentData;

  const movies = new Map();
  for (const st of showtimes) {
    const key = normalizeKey(st.movieTitle);
    const prev = movies.get(key);
    if (!prev) {
      movies.set(key, {
        id: `movie-${key.replace(/\s+/g, "-")}`,
        title: cleanText(st.movieTitle),
        title_key: key,
        rating: st.rating,
        status: st.movieStatus,
      });
    } else if (
      STATUS_PRIORITY.indexOf(st.movieStatus) < STATUS_PRIORITY.indexOf(prev.status)
    ) {
      prev.status = st.movieStatus;
    }
  }

  const auditoriums = new Map();
  for (const st of showtimes) {
    const nameKey = normalizeKey(st.auditorium);
    const k = `${st.theaterId}|${nameKey}`;
    if (!auditoriums.has(k)) {
      auditoriums.set(k, {
        id: `aud-${st.theaterId.replace(/^theater-/, "")}-${nameKey.replace(/\s+/g, "-")}`,
        theater_id: st.theaterId,
        name: cleanText(st.auditorium),
        name_key: nameKey,
      });
    }
  }

  await sql.begin(async (tx) => {
    await tx`
      insert into hv_theater.theaters ${tx(theaters, "id", "name", "location", "timezone")}
      on conflict (id) do update set
        name = excluded.name, location = excluded.location, timezone = excluded.timezone`;

    await tx`
      insert into hv_theater.users ${tx(users.map(({ id, name, email }) => ({ id, name, email })), "id", "name", "email")}
      on conflict (id) do update set name = excluded.name, email = excluded.email`;

    const memberships = users.flatMap((u) =>
      u.memberships.map((m) => ({ user_id: u.id, theater_id: m.theaterId, role: m.role })),
    );
    await tx`delete from hv_theater.theater_memberships where user_id in ${tx(users.map((u) => u.id))}`;
    if (memberships.length) {
      await tx`insert into hv_theater.theater_memberships ${tx(memberships, "user_id", "theater_id", "role")}`;
    }

    await tx`
      insert into hv_theater.movies ${tx([...movies.values()], "id", "title", "title_key", "rating", "status")}
      on conflict (title_key) do update set
        title = excluded.title, rating = excluded.rating, status = excluded.status, updated_at = now()`;

    await tx`
      insert into hv_theater.auditoriums ${tx([...auditoriums.values()], "id", "theater_id", "name", "name_key")}
      on conflict (theater_id, name_key) do update set name = excluded.name`;

    const rows = showtimes.map((st) => ({
      id: st.id,
      theater_id: st.theaterId,
      movie_id: movies.get(normalizeKey(st.movieTitle)).id,
      auditorium_id: auditoriums.get(`${st.theaterId}|${normalizeKey(st.auditorium)}`).id,
      start_time: st.startTime,
      end_time: st.endTime,
      language: st.language,
      format: st.format,
      status: st.status,
      last_updated: st.lastUpdated,
    }));
    await tx`
      insert into hv_theater.showtimes ${tx(rows, "id", "theater_id", "movie_id", "auditorium_id", "start_time", "end_time", "language", "format", "status", "last_updated")}
      on conflict (id) do update set
        movie_id = excluded.movie_id, auditorium_id = excluded.auditorium_id,
        start_time = excluded.start_time, end_time = excluded.end_time,
        language = excluded.language, format = excluded.format,
        status = excluded.status, last_updated = excluded.last_updated,
        version = hv_theater.showtimes.version + 1`;
    // The mock PreviewChanges become example upload records, so the stored
    // shape (upload -> changes -> diffs, plus its event log) is visible.
    const byId = new Map(showtimes.map((st) => [st.id, st]));
    for (const [theaterId, preview] of Object.entries(assessmentData.previewChangesByTheater)) {
      const total = preview.adds.length + preview.updates.length + preview.archives.length;
      if (!total) continue;
      const uploadId = `upload-example-${theaterId.replace(/^theater-/, "")}`;
      await tx`delete from hv_theater.csv_uploads where id = ${uploadId}`;
      await tx`
        insert into hv_theater.csv_uploads
          (id, theater_id, uploaded_by, file_name, row_count, status, summary,
           adds_count, updates_count, archives_count, created_at, analyzed_at)
        values
          (${uploadId}, ${theaterId}, ${"user-admin-avery"}, ${"new-drop.csv"}, ${total},
           'pending_review', ${"Example proposal carried over from the original mock data."},
           ${preview.adds.length}, ${preview.updates.length}, ${preview.archives.length},
           now() - interval '5 minutes', now() - interval '4 minutes')`;

      let position = 0;
      const changes = [];
      const diffs = [];
      for (const a of preview.adds) {
        changes.push({
          id: `${uploadId}-c${++position}`, upload_id: uploadId, position, kind: "add",
          showtime_id: null, movie_title: a.movieTitle, auditorium: a.auditorium,
          start_time: a.startTime, end_time: a.endTime, language: a.language,
          format: a.format, rating: a.rating, explanation: "New showtime not in the stored schedule.",
        });
      }
      for (const u of preview.updates) {
        const st = byId.get(u.id);
        const id = `${uploadId}-c${++position}`;
        changes.push({
          id, upload_id: uploadId, position, kind: "update", showtime_id: u.id,
          movie_title: u.movieTitle, auditorium: st?.auditorium ?? null,
          start_time: u.startTime, end_time: u.endTime, language: st?.language ?? null,
          format: st?.format ?? null, rating: st?.rating ?? null,
          explanation: "Same showtime with minor differences.",
        });
        for (const d of u.diffs) {
          diffs.push({ change_id: id, field: d.field, old_value: d.oldValue, new_value: d.newValue });
        }
      }
      for (const a of preview.archives) {
        const st = byId.get(a.id);
        changes.push({
          id: `${uploadId}-c${++position}`, upload_id: uploadId, position, kind: "archive",
          showtime_id: a.id, movie_title: a.movieTitle, auditorium: st?.auditorium ?? null,
          start_time: a.startTime, end_time: a.endTime, language: st?.language ?? null,
          format: st?.format ?? null, rating: st?.rating ?? null,
          explanation: "Not present in new drop.",
        });
      }
      const cols = ["id", "upload_id", "position", "kind", "showtime_id", "movie_title", "auditorium",
        "start_time", "end_time", "language", "format", "rating", "explanation"];
      await tx`insert into hv_theater.upload_changes ${tx(changes, ...cols)}`;
      if (diffs.length) {
        await tx`insert into hv_theater.upload_change_diffs ${tx(diffs, "change_id", "field", "old_value", "new_value")}`;
      }
      await tx`
        insert into hv_theater.upload_events (upload_id, kind, status, message, actor_id, created_at)
        values
          (${uploadId}, 'status', 'received', 'File received', 'user-admin-avery', now() - interval '5 minutes'),
          (${uploadId}, 'status', 'analyzing', 'Matching rows against the stored schedule', null, now() - interval '5 minutes'),
          (${uploadId}, 'status', 'pending_review', ${`${total} changes proposed`}, null, now() - interval '4 minutes')`;
    }
  });

  console.log(
    `seed: ${theaters.length} theaters, ${users.length} users, ${movies.size} movies, ` +
      `${auditoriums.size} auditoriums, ${showtimes.length} showtimes, example uploads`,
  );
}

/**
 * Synthetic data, generated server-side with generate_series so nothing large
 * crosses the network. Everything is prefixed "scale-" and can be removed
 * with `npm run db:seed:scale -- --remove`.
 */
async function seedScale() {
  const theaters = Number(process.env.SCALE_THEATERS ?? 20000);
  const movies = Number(process.env.SCALE_MOVIES ?? 3000);
  const perTheater = Number(process.env.SCALE_SHOWTIMES_PER_THEATER ?? 10);
  const audsPerTheater = 8;

  if (process.argv.includes("--remove")) {
    await sql.begin(async (tx) => {
      await tx`delete from hv_theater.showtimes where id like 'scale-%'`;
      await tx`delete from hv_theater.auditoriums where id like 'scale-%'`;
      await tx`delete from hv_theater.movies where id like 'scale-%'`;
      await tx`delete from hv_theater.theater_memberships where user_id = 'user-scale-sam'`;
      await tx`delete from hv_theater.users where id = 'user-scale-sam'`;
      await tx`delete from hv_theater.theaters where id like 'scale-%'`;
    });
    // DELETE leaves dead tuples; VACUUM FULL rewrites the tables so the
    // space is actually returned to the (shared) database.
    await sql.unsafe(
      "vacuum (full, analyze) hv_theater.showtimes, hv_theater.auditoriums, hv_theater.movies, " +
        "hv_theater.theater_memberships, hv_theater.users, hv_theater.theaters",
    );
    const [{ size }] = await sql`
      select pg_size_pretty(sum(pg_total_relation_size(c.oid))) as size
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = ${SCHEMA} and c.relkind = 'r'`;
    console.log(`seed:scale removed synthetic data; ${SCHEMA} is now ${size}`);
    return;
  }

  const t0 = Date.now();
  await sql.begin(async (tx) => {
    await tx`
      insert into hv_theater.theaters (id, name, location, timezone)
      select
        'scale-t' || g,
        (array['Grand','Regal','Starlight','Majestic','Paramount','Liberty','Vista','Orpheum','Rialto','Odeon',
               'Crown','Bijou','Galaxy','Palace','Empire','Lyric','Strand','Capitol','Rex','Aurora'])[1 + g % 20]
          || ' ' ||
        (array['Cinema','Theater','Multiplex','Cineplex','Picture House','Screens','Film Hall','Movies'])[1 + (g / 20) % 8]
          || ' ' || g,
        (array['Seattle, WA','Portland, OR','San Francisco, CA','Los Angeles, CA','Denver, CO','Austin, TX',
               'Chicago, IL','Boston, MA','New York, NY','Atlanta, GA','Miami, FL','Phoenix, AZ','Minneapolis, MN',
               'Nashville, TN','Detroit, MI','Salt Lake City, UT','Kansas City, MO','Raleigh, NC','Columbus, OH',
               'San Diego, CA'])[1 + (g * 7) % 20],
        (array['America/Los_Angeles','America/Denver','America/Chicago','America/New_York'])[1 + g % 4]
      from generate_series(1, ${theaters}) g
      on conflict (id) do nothing`;

    await tx`
      insert into hv_theater.movies (id, title, title_key, rating, status)
      select 'scale-m' || g, title, lower(title), rating, status
      from (
        select g,
          (array['The','A','Last','Silent','Midnight','Hidden','Electric','Broken','Golden','Wild',
                 'Lost','Crimson','Final','Distant','Neon','Iron','Velvet','Hollow','Burning','Frozen'])[1 + g % 20]
            || ' ' ||
          (array['River','Signal','Empire','Garden','Horizon','Protocol','Kingdom','Echo','Harbor','Frontier',
                 'Orbit','Mirror','Storm','Canyon','Lantern','Archive','Voyage','Circuit','Meadow','Citadel'])[1 + (g / 20) % 20]
            || case when g > 400 then ' ' || (g / 400 + 1)::text else '' end as title,
          (array['G','PG','PG-13','R','NR'])[1 + g % 5] as rating,
          (array['approved','approved','approved','draft','needs-review','flagged'])[1 + g % 6]::hv_theater.movie_status as status
        from generate_series(1, ${movies}) g
      ) m
      on conflict do nothing`;

    await tx`
      insert into hv_theater.auditoriums (id, theater_id, name, name_key)
      select 'scale-a' || t || '-' || a, 'scale-t' || t, 'Auditorium ' || a, 'auditorium ' || a
      from generate_series(1, ${theaters}) t, generate_series(1, ${audsPerTheater}) a
      on conflict do nothing`;

    await tx`
      insert into hv_theater.showtimes
        (id, theater_id, movie_id, auditorium_id, start_time, end_time, language, format, status, last_updated)
      select
        'scale-s' || t || '-' || n,
        'scale-t' || t,
        'scale-m' || (1 + (t * 31 + n * 17) % ${movies}),
        'scale-a' || t || '-' || (1 + n % ${audsPerTheater}),
        start_at,
        start_at + make_interval(mins => 90 + (t + n) % 80),
        (array['EN','EN','EN','EN','ES','FR','KO','JA'])[1 + (t + n) % 8],
        (array['2D','2D','2D','3D','IMAX','4DX'])[1 + (t * 3 + n) % 6],
        (array['active','active','active','active','active','active','active','active','archived','inactive'])[1 + (t + n * 3) % 10]::hv_theater.showtime_status,
        timestamptz '2025-02-15' + make_interval(hours => (t * 13 + n * 7) % (24 * 28))
      from generate_series(1, ${theaters}) t,
           generate_series(1, ${perTheater}) n,
           lateral (select timestamptz '2025-03-01 15:00Z'
                      + make_interval(days => (t + n * 5) % 31, mins => 15 * ((t * 7 + n * 11) % 36)) as start_at) s
      on conflict do nothing`;

    // One user who belongs to every synthetic theater, to exercise
    // "all accessible theaters" queries at scale. Admin at even ids,
    // employee at odd ids, so per-theater roles are visible.
    await tx`
      insert into hv_theater.users (id, name, email)
      values ('user-scale-sam', 'Sam Scale', 'sam.scale@example.com')
      on conflict (id) do nothing`;
    await tx`
      insert into hv_theater.theater_memberships (user_id, theater_id, role)
      select 'user-scale-sam', 'scale-t' || g,
             (case when g % 2 = 0 then 'admin' else 'employee' end)::hv_theater.member_role
      from generate_series(1, ${theaters}) g
      on conflict do nothing`;
  });

  for (const t of ["theaters", "movies", "auditoriums", "showtimes", "theater_memberships", "users"]) {
    await sql.unsafe(`analyze hv_theater.${t}`);
  }
  const [counts] = await sql`
    select
      (select count(*) from hv_theater.theaters)::int as theaters,
      (select count(*) from hv_theater.movies)::int as movies,
      (select count(*) from hv_theater.showtimes)::int as showtimes,
      pg_size_pretty(sum(pg_total_relation_size(c.oid))) as size
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ${SCHEMA} and c.relkind = 'r'`;
  console.log(`seed:scale done in ${((Date.now() - t0) / 1000).toFixed(1)}s`, counts);
}

async function reset() {
  await sql.unsafe(`drop schema if exists ${SCHEMA} cascade`);
  console.log(`reset: dropped schema ${SCHEMA}`);
  await migrate();
  await seed();
}

const tasks = { migrate, seed, "seed-scale": seedScale, reset };
const task = tasks[process.argv[2]];
if (!task) {
  console.error(`usage: db.mjs <${Object.keys(tasks).join("|")}>`);
  process.exit(1);
}
try {
  await task();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
