import "server-only";

import { z } from "zod";
import {
  MOVIE_STATUSES,
  SHOWTIME_STATUSES,
  type ApiShowtime,
  type QueryPlanSummary,
  type ShowtimeFacets,
  type ShowtimeSearchResponse,
  type ShowtimeSortField,
} from "~/types/assessment";
import { normalizeKey } from "~/lib/normalize";
import { HttpError } from "./access";
import { sql } from "./db";

const SORT_FIELDS = [
  "startTime",
  "endTime",
  "lastUpdated",
  "movieTitle",
  "theaterName",
  "movieStatus",
] as const satisfies readonly ShowtimeSortField[];

const optionalText = z
  .string()
  .trim()
  .transform((v) => (v === "" ? undefined : v))
  .optional();

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()
  .or(z.literal("").transform(() => undefined));

export const searchParamsSchema = z.object({
  theaterId: optionalText,
  q: optionalText,
  status: z.enum(SHOWTIME_STATUSES as [string, ...string[]]).optional().or(z.literal("").transform(() => undefined)),
  format: optionalText,
  language: optionalText,
  rating: optionalText,
  auditorium: optionalText,
  movieStatus: z.enum(MOVIE_STATUSES as [string, ...string[]]).optional().or(z.literal("").transform(() => undefined)),
  from: isoDate,
  to: isoDate,
  sort: z.enum(SORT_FIELDS).default("startTime"),
  order: z.enum(["asc", "desc"]).default("asc"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: optionalText,
  explain: z
    .enum(["0", "1", "true", "false"])
    .optional()
    .transform((v) => v === "1" || v === "true"),
});
export type SearchParams = z.infer<typeof searchParamsSchema>;

type Row = {
  id: string;
  theater_id: string;
  theater_name: string;
  movie_id: string;
  movie_title: string;
  movie_status: ApiShowtime["movieStatus"];
  rating: string | null;
  auditorium: string;
  start_time: Date;
  end_time: Date;
  language: string;
  format: string;
  status: ApiShowtime["status"];
  last_updated: Date;
  role: ApiShowtime["role"];
};

/** Sort column, plus how to read its value off a row and cast it back for keyset paging. */
function sortSpec(field: ShowtimeSortField) {
  type Key = { expr: ReturnType<typeof sql>; cast: ReturnType<typeof sql>; value: (r: Row) => string };
  const keys = ((): Key[] => {
    switch (field) {
      case "startTime":
        return [{ expr: sql`s.start_time`, cast: sql`::timestamptz`, value: (r) => r.start_time.toISOString() }];
      case "endTime":
        return [{ expr: sql`s.end_time`, cast: sql`::timestamptz`, value: (r) => r.end_time.toISOString() }];
      case "lastUpdated":
        return [{ expr: sql`s.last_updated`, cast: sql`::timestamptz`, value: (r) => r.last_updated.toISOString() }];
      case "movieTitle":
        return [{ expr: sql`m.title`, cast: sql`::text`, value: (r) => r.movie_title }];
      case "theaterName":
        return [{ expr: sql`t.name`, cast: sql`::text`, value: (r) => r.theater_name }];
      case "movieStatus":
        // Enum order equals alphabetical order (see schema.sql). Ties break by
        // movie, so the planner can walk movies_status_order and fetch each
        // movie's showtimes by index instead of sorting every row.
        return [
          { expr: sql`m.status`, cast: sql`::hv_theater.movie_status`, value: (r) => r.movie_status },
          { expr: sql`m.id`, cast: sql`::text`, value: (r) => r.movie_id },
        ];
    }
  })();
  // s.id is always the final tie-breaker, so keyset pagination is exact.
  keys.push({ expr: sql`s.id`, cast: sql`::text`, value: (r) => r.id });
  return keys;
}

/** Joins fragments with commas: `a, b, c`. */
function list(fragments: ReturnType<typeof sql>[]) {
  return fragments.reduce((acc, f, i) => (i === 0 ? sql`${f}` : sql`${acc}, ${f}`), sql``);
}

const encodeCursor = (values: string[]) => Buffer.from(JSON.stringify(values)).toString("base64url");

/** A cursor that does not decode for this sort is a client error, not "start again from page 1". */
export function decodeCursor(cursor: string, length: number): string[] {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (Array.isArray(parsed) && parsed.length === length && parsed.every((p) => typeof p === "string")) {
      return parsed;
    }
  } catch {
    // fall through
  }
  throw new HttpError(400, "Invalid cursor for this sort; request the first page again");
}

/**
 * Title search matches the text as typed, or ignoring punctuation and
 * spacing, so "spider man" and "spiderman" both find "Spider-Man: Homecoming".
 */
export function titleSearchTerms(q: string): { like: string; squashed: string | null } {
  const squashed = normalizeKey(q).replace(/ /g, "");
  return { like: `%${escapeLike(q)}%`, squashed: squashed.length >= 2 ? `%${squashed}%` : null };
}

function titleFilter(q: string) {
  const { like, squashed } = titleSearchTerms(q);
  return squashed
    ? sql`and (m.title ilike ${like} or replace(m.title_key, ' ', '') like ${squashed})`
    : sql`and m.title ilike ${like}`;
}

const COUNT_CAP = 10_000;

const escapeLike = (v: string) => v.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * The WHERE clause shared by the page query, the count query and EXPLAIN.
 * Every filter is a parameter; nothing user-supplied is interpolated as SQL.
 */
function filters(p: SearchParams) {
  const next = (d: string) => {
    const date = new Date(`${d}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + 1);
    return date.toISOString();
  };
  return sql`
    ${p.theaterId ? sql`and s.theater_id = ${p.theaterId}` : sql``}
    ${p.q ? titleFilter(p.q) : sql``}
    ${p.status ? sql`and s.status = ${p.status}::hv_theater.showtime_status` : sql``}
    ${p.format ? sql`and s.format = ${p.format}` : sql``}
    ${p.language ? sql`and s.language = ${p.language}` : sql``}
    ${p.rating ? sql`and m.rating = ${p.rating}` : sql``}
    ${p.auditorium ? sql`and a.name = ${p.auditorium}` : sql``}
    ${p.movieStatus ? sql`and m.status = ${p.movieStatus}::hv_theater.movie_status` : sql``}
    ${p.from ? sql`and s.start_time >= ${`${p.from}T00:00:00Z`}::timestamptz` : sql``}
    ${p.to ? sql`and s.start_time < ${next(p.to)}::timestamptz` : sql``}
  `;
}

/**
 * The membership join does the access control: a user only ever sees
 * showtimes at theaters they belong to, and gets their role there per row.
 */
const fromClause = (userId: string) => sql`
  from hv_theater.showtimes s
  join hv_theater.theater_memberships tm
    on tm.theater_id = s.theater_id and tm.user_id = ${userId}
  join hv_theater.theaters t on t.id = s.theater_id
  join hv_theater.movies m on m.id = s.movie_id
  join hv_theater.auditoriums a on a.id = s.auditorium_id
`;

function pageQuery(userId: string, p: SearchParams) {
  const keys = sortSpec(p.sort);
  const dir = p.order === "desc" ? sql`desc` : sql`asc`;
  const cursor = p.cursor ? decodeCursor(p.cursor, keys.length) : null;
  // Row-value comparison: (k1, k2, s.id) > ($1, $2, $3) continues exactly
  // after the last row of the previous page.
  const keyset = cursor
    ? sql`and (${list(keys.map((k) => k.expr))}) ${p.order === "desc" ? sql`<` : sql`>`} (${list(
        keys.map((k, i) => sql`${cursor[i]!}${k.cast}`),
      )})`
    : sql``;
  const orderBy = list(keys.map((k) => sql`${k.expr} ${dir}`));

  return sql`
    select
      s.id, s.theater_id, t.name as theater_name,
      m.id as movie_id, m.title as movie_title, m.status as movie_status, m.rating,
      a.name as auditorium,
      s.start_time, s.end_time, s.language, s.format, s.status, s.last_updated,
      tm.role
    ${fromClause(userId)}
    where true ${filters(p)} ${keyset}
    order by ${orderBy}
    limit ${p.limit + 1}
  `;
}

type PlanNode = {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Actual Rows"?: number;
  Plans?: PlanNode[];
};

function summarizePlan(raw: unknown): QueryPlanSummary {
  const root = (raw as { Plan: PlanNode; "Planning Time": number; "Execution Time": number }[])[0]!;
  const scans: QueryPlanSummary["scans"] = [];
  const walk = (node: PlanNode) => {
    if (node["Relation Name"] || node["Index Name"]) {
      scans.push({
        node: node["Node Type"],
        relation: node["Relation Name"],
        index: node["Index Name"],
        rows: node["Actual Rows"],
      });
    }
    node.Plans?.forEach(walk);
  };
  walk(root.Plan);
  return {
    planningMs: root["Planning Time"],
    executionMs: root["Execution Time"],
    scans,
    usesSeqScan: scans.some((s) => s.node === "Seq Scan"),
  };
}

export async function searchShowtimes(
  userId: string,
  p: SearchParams,
): Promise<ShowtimeSearchResponse> {
  const t0 = performance.now();
  const rows = await pageQuery(userId, p).then((r) => r as unknown as Row[]);
  const queryMs = performance.now() - t0;

  // Exact totals over hundreds of thousands of rows cost more than the page
  // itself, so counting stops at COUNT_CAP and the UI shows "10,000+".
  let total: number | null = null;
  let totalCapped = false;
  let countMs: number | null = null;
  if (!p.cursor) {
    const t1 = performance.now();
    const [c] = await sql<{ n: number }[]>`
      select count(*)::int as n from (
        select 1 ${fromClause(userId)} where true ${filters(p)}
        limit ${COUNT_CAP + 1}
      ) capped`;
    const n = c?.n ?? 0;
    totalCapped = n > COUNT_CAP;
    total = totalCapped ? COUNT_CAP : n;
    countMs = performance.now() - t1;
  }

  let plan: QueryPlanSummary | undefined;
  if (p.explain) {
    const [explained] = await sql<{ "QUERY PLAN": unknown }[]>`
      explain (analyze, format json) ${pageQuery(userId, p)}`;
    plan = summarizePlan(explained?.["QUERY PLAN"]);
  }

  const hasMore = rows.length > p.limit;
  const page = hasMore ? rows.slice(0, p.limit) : rows;
  const last = page[page.length - 1];
  const keys = sortSpec(p.sort);

  return {
    rows: page.map((r) => ({
      id: r.id,
      theaterId: r.theater_id,
      theaterName: r.theater_name,
      movieId: r.movie_id,
      movieTitle: r.movie_title,
      movieStatus: r.movie_status,
      rating: r.rating ?? "",
      auditorium: r.auditorium,
      startTime: r.start_time.toISOString(),
      endTime: r.end_time.toISOString(),
      language: r.language,
      format: r.format,
      status: r.status,
      lastUpdated: r.last_updated.toISOString(),
      role: r.role,
    })),
    nextCursor: hasMore && last ? encodeCursor(keys.map((k) => k.value(last))) : null,
    total,
    totalCapped,
    timing: { queryMs: Math.round(queryMs), countMs: countMs === null ? null : Math.round(countMs) },
    plan,
  };
}

// Facets across every accessible theater mean a distinct over all of a
// user's showtimes (~0.9s for a user in 20k theaters). Option lists change
// rarely, so that scope is cached briefly per server instance. Single-theater
// facets are index-backed and always computed fresh.
const FACET_TTL_MS = 60_000;
const facetCache = new Map<string, { at: number; value: ShowtimeFacets }>();

/** Distinct filter values within the user's scope, for the filter dropdowns. */
export async function getFacets(userId: string, theaterId?: string): Promise<ShowtimeFacets> {
  if (theaterId) return computeFacets(userId, theaterId);
  const hit = facetCache.get(userId);
  if (hit && Date.now() - hit.at < FACET_TTL_MS) return hit.value;
  const value = await computeFacets(userId);
  facetCache.set(userId, { at: Date.now(), value });
  return value;
}

async function computeFacets(userId: string, theaterId?: string): Promise<ShowtimeFacets> {
  // One pass over the scoped showtimes; GROUPING SETS yields the distinct
  // values of every facet from a single hash aggregate.
  const [row] = await sql<
    { formats: string[]; languages: string[]; ratings: string[]; auditoriums: string[]; movie_statuses: string[] }[]
  >`
    with g as (
      select s.format, s.language, m.rating, a.name as auditorium, m.status::text as movie_status,
             grouping(s.format, s.language, m.rating, a.name, m.status::text) as gid
      from hv_theater.showtimes s
      join hv_theater.theater_memberships tm
        on tm.theater_id = s.theater_id and tm.user_id = ${userId}
      join hv_theater.movies m on m.id = s.movie_id
      join hv_theater.auditoriums a on a.id = s.auditorium_id
      ${theaterId ? sql`where s.theater_id = ${theaterId}` : sql``}
      group by grouping sets ((s.format), (s.language), (m.rating), (a.name), (m.status::text))
    )
    select
      coalesce(array_agg(format order by format) filter (where gid = 15), '{}') as formats,
      coalesce(array_agg(language order by language) filter (where gid = 23), '{}') as languages,
      coalesce(array_agg(rating order by rating) filter (where gid = 27 and rating is not null), '{}') as ratings,
      coalesce(array_agg(auditorium order by auditorium) filter (where gid = 29), '{}') as auditoriums,
      coalesce(array_agg(movie_status order by movie_status) filter (where gid = 30), '{}') as movie_statuses
    from g
  `;
  return {
    formats: row?.formats ?? [],
    languages: row?.languages ?? [],
    ratings: row?.ratings ?? [],
    auditoriums: row?.auditoriums ?? [],
    movieStatuses: row?.movie_statuses ?? [],
  };
}
