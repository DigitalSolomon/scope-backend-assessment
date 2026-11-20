-- Theater showtimes schema.
--
-- Everything lives in its own Postgres schema (hv_theater) because the
-- database is shared with other projects. The migration script substitutes
-- {{trgm}} with the schema that holds the pg_trgm extension.
--
-- Normal form, in short:
--   theaters ─┬─< auditoriums ─┐
--             ├─< theater_memberships >── users     (role is per theater)
--             └─< showtimes >─────────────┘── movies  (status on both)
--
-- showtimes.theater_id is kept alongside auditorium_id on purpose: every
-- query is scoped by theater, so it leads the hot indexes. A composite
-- foreign key guarantees the auditorium belongs to that same theater.

create schema if not exists hv_theater;

do $$ begin
  create type hv_theater.member_role as enum ('admin', 'employee');
exception when duplicate_object then null; end $$;

do $$ begin
  create type hv_theater.movie_status as enum ('approved', 'draft', 'flagged', 'needs-review');
exception when duplicate_object then null; end $$;

do $$ begin
  create type hv_theater.showtime_status as enum ('active', 'inactive', 'archived');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------- theaters
create table if not exists hv_theater.theaters (
  id          text primary key default gen_random_uuid()::text,
  name        text not null,
  location    text not null default '',
  timezone    text not null default 'UTC',
  created_at  timestamptz not null default now()
);
-- Substring / fuzzy search on name and location ("riverside", "portland").
create index if not exists theaters_name_trgm
  on hv_theater.theaters using gin (name {{trgm}}.gin_trgm_ops);
create index if not exists theaters_location_trgm
  on hv_theater.theaters using gin (location {{trgm}}.gin_trgm_ops);
-- Ordered listing by name.
create index if not exists theaters_name_sort
  on hv_theater.theaters (name, id);

-- ------------------------------------------------------------------- users
create table if not exists hv_theater.users (
  id          text primary key default gen_random_uuid()::text,
  name        text not null,
  email       text not null,
  created_at  timestamptz not null default now()
);
create unique index if not exists users_email_unique
  on hv_theater.users (lower(email));

-- ----------------------------------------------------- theater_memberships
-- A user's role is per theater: admin at one, employee at another.
create table if not exists hv_theater.theater_memberships (
  user_id     text not null references hv_theater.users (id) on delete cascade,
  theater_id  text not null references hv_theater.theaters (id) on delete cascade,
  role        hv_theater.member_role not null default 'employee',
  created_at  timestamptz not null default now(),
  primary key (user_id, theater_id)          -- "which theaters can this user see"
);
create index if not exists memberships_theater
  on hv_theater.theater_memberships (theater_id, role);  -- "who works here"

-- ------------------------------------------------------------------ movies
create table if not exists hv_theater.movies (
  id          text primary key default gen_random_uuid()::text,
  title       text not null,
  -- Normalized title used for identity (case, punctuation, unicode dashes
  -- folded). Computed in application code.
  title_key   text not null,
  rating      text,
  status      hv_theater.movie_status not null default 'needs-review',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists movies_title_key_unique
  on hv_theater.movies (title_key);
create index if not exists movies_title_trgm
  on hv_theater.movies using gin (title {{trgm}}.gin_trgm_ops);
-- Punctuation-insensitive title search ("spiderman" finds "Spider-Man").
create index if not exists movies_title_squashed_trgm
  on hv_theater.movies using gin ((replace(title_key, ' ', '')) {{trgm}}.gin_trgm_ops);
create index if not exists movies_status
  on hv_theater.movies (status);
-- Sorting showtimes by movie title / status walks movies in order.
create index if not exists movies_title_sort
  on hv_theater.movies (title, id);
-- movie_status enum values are declared alphabetically, so ordering by the
-- enum column matches the text order shown in the UI.
drop index if exists hv_theater.movies_status_sort;  -- superseded by movies_status_order
create index if not exists movies_status_order
  on hv_theater.movies (status, id);
create index if not exists movies_rating
  on hv_theater.movies (rating);

-- ------------------------------------------------------------- auditoriums
create table if not exists hv_theater.auditoriums (
  id          text primary key default gen_random_uuid()::text,
  theater_id  text not null references hv_theater.theaters (id) on delete cascade,
  name        text not null,
  name_key    text not null,
  created_at  timestamptz not null default now(),
  unique (theater_id, name_key),
  unique (id, theater_id)                     -- target of the composite FK below
);

-- --------------------------------------------------------------- showtimes
create table if not exists hv_theater.showtimes (
  id             text primary key default gen_random_uuid()::text,
  theater_id     text not null references hv_theater.theaters (id) on delete cascade,
  movie_id       text not null references hv_theater.movies (id),
  auditorium_id  text not null,
  start_time     timestamptz not null,
  end_time       timestamptz not null,
  language       text not null,
  format         text not null,
  status         hv_theater.showtime_status not null default 'active',
  last_updated   timestamptz not null default now(),
  version        integer not null default 1,  -- optimistic concurrency for imports
  created_at     timestamptz not null default now(),
  foreign key (auditorium_id, theater_id)
    references hv_theater.auditoriums (id, theater_id),
  check (end_time > start_time)
);

-- Business rule: at most one ACTIVE showtime per movie + start time per theater.
create unique index if not exists showtimes_one_active
  on hv_theater.showtimes (theater_id, movie_id, start_time)
  where status = 'active';

-- Scope by theater, then range/sort by time. The trailing id makes keyset
-- pagination (ORDER BY start_time, id) an index-only walk.
create index if not exists showtimes_theater_start
  on hv_theater.showtimes (theater_id, start_time, id);
create index if not exists showtimes_theater_status_start
  on hv_theater.showtimes (theater_id, status, start_time);
create index if not exists showtimes_theater_end
  on hv_theater.showtimes (theater_id, end_time, id);
create index if not exists showtimes_theater_updated
  on hv_theater.showtimes (theater_id, last_updated, id);
-- Global orderings, for users who belong to many theaters: the planner walks
-- these in sort order, checks membership per row, and stops at the page
-- limit instead of sorting every accessible showtime.
create index if not exists showtimes_start
  on hv_theater.showtimes (start_time, id);
create index if not exists showtimes_end
  on hv_theater.showtimes (end_time, id);
create index if not exists showtimes_updated
  on hv_theater.showtimes (last_updated, id);
-- Title search resolves movie ids first, then fans out to their showtimes.
create index if not exists showtimes_movie_start
  on hv_theater.showtimes (movie_id, start_time);
create index if not exists showtimes_auditorium
  on hv_theater.showtimes (auditorium_id);
-- language / format are low-cardinality; they are applied as residual
-- filters on top of the theater-scoped index scans above rather than
-- given standalone indexes the planner would rarely choose.

-- ===================================================================
-- CSV uploads ("patching events")
--
--   csv_uploads ─┬─< upload_changes ──< upload_change_diffs
--                └─< upload_events
--
-- One csv_uploads row is written the moment a file arrives, before any
-- parsing, so failed and half-finished attempts are always visible.
-- upload_changes holds the proposed reconciliation (the PreviewChanges
-- shape: adds, updates with field diffs, archives, plus duplicates and
-- invalid rows). upload_events is an append-only log of status changes,
-- errors and reviewer feedback.
-- ===================================================================

do $$ begin
  create type hv_theater.upload_status as enum (
    'received',          -- file stored, nothing processed yet
    'analyzing',         -- parsing / matching / agent running
    'pending_review',    -- proposal ready, waiting for a person
    'applying',          -- confirmed, transaction in progress
    'applied',           -- every accepted change written
    'partially_applied', -- some accepted changes failed (see upload_changes.apply_error)
    'discarded',         -- reviewer cancelled
    'failed'             -- processing stopped with an error (see csv_uploads.error)
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type hv_theater.change_kind as enum (
    'add', 'update', 'archive', 'reactivate', 'unchanged', 'duplicate', 'invalid'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type hv_theater.change_decision as enum ('pending', 'accepted', 'rejected');
exception when duplicate_object then null; end $$;

do $$ begin
  create type hv_theater.change_source as enum ('agent', 'rule');
exception when duplicate_object then null; end $$;

do $$ begin
  create type hv_theater.upload_event_kind as enum ('status', 'error', 'feedback', 'note');
exception when duplicate_object then null; end $$;

-- ------------------------------------------------------------ csv_uploads
create table if not exists hv_theater.csv_uploads (
  id              text primary key default gen_random_uuid()::text,
  theater_id      text not null references hv_theater.theaters (id) on delete cascade,
  uploaded_by     text references hv_theater.users (id) on delete set null,
  file_name       text not null,
  file_size       integer,
  file_sha256     text,                 -- spot re-uploads of the same file
  raw_csv         text,                 -- original bytes, for audit and re-runs
  row_count       integer,
  status          hv_theater.upload_status not null default 'received',
  summary         text,                 -- agent's plain-language overview
  warnings        text[] not null default '{}',
  model           text,                 -- which LLM produced the proposal, if any
  error           text,                 -- last fatal error, when status = 'failed'
  -- Counts, filled in as the run progresses.
  adds_count      integer not null default 0,
  updates_count   integer not null default 0,
  archives_count  integer not null default 0,
  applied_count   integer not null default 0,
  failed_count    integer not null default 0,
  -- Lifecycle timestamps.
  created_at      timestamptz not null default now(),
  analyzed_at     timestamptz,
  reviewed_at     timestamptz,
  completed_at    timestamptz,          -- applied / partially_applied / discarded / failed
  updated_at      timestamptz not null default now()
);
create index if not exists uploads_theater_created
  on hv_theater.csv_uploads (theater_id, created_at desc);   -- import history per theater
create index if not exists uploads_status_created
  on hv_theater.csv_uploads (status, created_at desc);       -- "what is stuck / failed"
create index if not exists uploads_uploaded_by
  on hv_theater.csv_uploads (uploaded_by, created_at desc);
create index if not exists uploads_sha
  on hv_theater.csv_uploads (theater_id, file_sha256);

-- --------------------------------------------------------- upload_changes
-- One proposed action. Field columns mirror ShowtimeAdd so an 'add' needs
-- no JSON; 'update' / 'archive' / 'reactivate' reference the showtime and
-- record the version seen at proposal time for optimistic concurrency.
create table if not exists hv_theater.upload_changes (
  id                text primary key default gen_random_uuid()::text,
  upload_id         text not null references hv_theater.csv_uploads (id) on delete cascade,
  position          integer not null,          -- display order within the upload
  kind              hv_theater.change_kind not null,
  showtime_id       text references hv_theater.showtimes (id) on delete set null,
  showtime_version  integer,
  csv_rows          integer[] not null default '{}',  -- 1-based data rows this came from
  -- Snapshot of the showtime as proposed (add) or as it stands (update/archive).
  movie_title       text,
  auditorium        text,
  start_time        timestamptz,
  end_time          timestamptz,
  language          text,
  format            text,
  rating            text,
  -- Why, how sure, and who decided.
  explanation       text,
  confidence        numeric(4, 3) check (confidence between 0 and 1),
  source            hv_theater.change_source not null default 'rule',
  decision          hv_theater.change_decision not null default 'pending',
  decided_at        timestamptz,
  -- Outcome when applied.
  applied_at        timestamptz,
  apply_error       text,
  created_at        timestamptz not null default now(),
  unique (upload_id, position)
);
create index if not exists changes_upload_kind
  on hv_theater.upload_changes (upload_id, kind, position);
create index if not exists changes_showtime
  on hv_theater.upload_changes (showtime_id) where showtime_id is not null;  -- a showtime's change history

-- ---------------------------------------------------- upload_change_diffs
-- FieldDiff rows for an 'update' (field: old -> new).
create table if not exists hv_theater.upload_change_diffs (
  change_id  text not null references hv_theater.upload_changes (id) on delete cascade,
  field      text not null,
  old_value  text,
  new_value  text,
  primary key (change_id, field)
);

-- ---------------------------------------------------------- upload_events
create table if not exists hv_theater.upload_events (
  id          bigint generated always as identity primary key,
  upload_id   text not null references hv_theater.csv_uploads (id) on delete cascade,
  kind        hv_theater.upload_event_kind not null,
  status      hv_theater.upload_status,    -- new status, for kind = 'status'
  message     text,
  actor_id    text references hv_theater.users (id) on delete set null,
  detail      jsonb,                       -- structured context (stack, counts, ...)
  created_at  timestamptz not null default now()
);
create index if not exists events_upload_created
  on hv_theater.upload_events (upload_id, created_at);
