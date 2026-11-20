import "server-only";

import type {
  ApiChange,
  ApiUploadDetail,
  ApiUploadEvent,
  ApiUploadSummary,
  FieldDiff,
  PreviewChanges,
} from "~/types/assessment";
import { sql } from "./db";

const summaryColumns = sql`
  u.id, u.theater_id as "theaterId", u.uploaded_by as "uploadedBy",
  us.name as "uploadedByName", u.file_name as "fileName", u.row_count as "rowCount",
  u.status, u.error,
  u.adds_count as "addsCount", u.updates_count as "updatesCount",
  u.archives_count as "archivesCount", u.applied_count as "appliedCount",
  u.failed_count as "failedCount",
  u.created_at as "createdAt", u.analyzed_at as "analyzedAt", u.completed_at as "completedAt"
`;

/** Upload history for a theater the user belongs to, newest first. */
export async function listUploads(userId: string, theaterId: string, limit = 25) {
  return sql<ApiUploadSummary[]>`
    select ${summaryColumns}
    from hv_theater.csv_uploads u
    join hv_theater.theater_memberships tm
      on tm.theater_id = u.theater_id and tm.user_id = ${userId}
    left join hv_theater.users us on us.id = u.uploaded_by
    where u.theater_id = ${theaterId}
    order by u.created_at desc
    limit ${limit}`;
}

type ChangeRow = {
  id: string;
  kind: ApiChange["kind"];
  csv_rows: number[];
  showtime_id: string | null;
  movie_title: string | null;
  auditorium: string | null;
  start_time: Date | null;
  end_time: Date | null;
  language: string | null;
  format: string | null;
  rating: string | null;
  explanation: string | null;
  confidence: string | null; // numeric comes back as text
  source: ApiChange["source"];
  decision: ApiChange["decision"];
  apply_error: string | null;
  applied_at: Date | null;
  diffs: FieldDiff[] | null;
};

type AnalysisDetail = {
  type?: string;
  botMessage?: string;
  source?: "agent" | "rule";
  thoughts?: string[];
  /** Showtime ids whose archive proposal starts ticked (asked for in reviewer feedback). */
  preselectedArchives?: string[];
  /** Older proposals recorded one flag for every archive. */
  archivesPreselected?: boolean;
  thinkingLevel?: string | null;
};

/** One upload with its proposed changes, ScopeBot's message and the event log. */
export async function getUpload(userId: string, uploadId: string): Promise<ApiUploadDetail | null> {
  const [upload] = await sql<
    (ApiUploadSummary & { summary: string | null; warnings: string[]; model: string | null })[]
  >`
    select ${summaryColumns}, u.summary, u.warnings, u.model
    from hv_theater.csv_uploads u
    join hv_theater.theater_memberships tm
      on tm.theater_id = u.theater_id and tm.user_id = ${userId}
    left join hv_theater.users us on us.id = u.uploaded_by
    where u.id = ${uploadId}`;
  if (!upload) return null;

  const [rows, events, analysis] = await Promise.all([
    sql<ChangeRow[]>`
      select c.id, c.kind, c.csv_rows, c.showtime_id, c.movie_title, c.auditorium, c.start_time,
             c.end_time, c.language, c.format, c.rating, c.explanation, c.confidence, c.source,
             c.decision, c.apply_error, c.applied_at,
             (select json_agg(json_build_object('field', d.field, 'oldValue', d.old_value, 'newValue', d.new_value)
                              order by d.field)
              from hv_theater.upload_change_diffs d where d.change_id = c.id) as diffs
      from hv_theater.upload_changes c
      where c.upload_id = ${uploadId}
      order by c.position`,
    sql<ApiUploadEvent[]>`
      select id::int as id, kind, status, message, actor_id as "actorId", created_at as "createdAt"
      from hv_theater.upload_events
      where upload_id = ${uploadId}
      order by created_at, id`,
    sql<{ detail: AnalysisDetail | null }[]>`
      select detail from hv_theater.upload_events
      where upload_id = ${uploadId} and kind = 'note' and detail->>'type' = 'analysis'
      order by created_at desc, id desc limit 1`,
  ]);

  const a = analysis[0]?.detail ?? {};
  // Proposals saved before archives were recorded per showtime had them all ticked.
  const ticked = (showtimeId: string | null) =>
    Array.isArray(a.preselectedArchives) ? a.preselectedArchives.includes(showtimeId ?? "") : (a.archivesPreselected ?? true);

  const iso = (d: Date | null) => d?.toISOString() ?? "";
  const items: ApiChange[] = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    csvRows: r.csv_rows ?? [],
    showtimeId: r.showtime_id,
    movieTitle: r.movie_title ?? "",
    auditorium: r.auditorium ?? "",
    startTime: iso(r.start_time),
    endTime: iso(r.end_time),
    language: r.language ?? "",
    format: r.format ?? "",
    rating: r.rating ?? "",
    explanation: r.explanation ?? "",
    confidence: r.confidence === null ? null : Number(r.confidence),
    source: r.source,
    decision: r.decision,
    preselected: r.kind === "archive" ? ticked(r.showtime_id) : true,
    diffs: r.diffs ?? [],
    applyError: r.apply_error,
    appliedAt: r.applied_at?.toISOString() ?? null,
  }));

  // PreviewChanges view (the shape the original mock modal used).
  const changes: PreviewChanges = { adds: [], updates: [], archives: [] };
  for (const i of items) {
    if (i.kind === "add") {
      changes.adds.push({
        movieTitle: i.movieTitle, auditorium: i.auditorium, startTime: i.startTime, endTime: i.endTime,
        language: i.language, format: i.format, rating: i.rating,
      });
    } else if ((i.kind === "update" || i.kind === "reactivate") && i.showtimeId) {
      changes.updates.push({
        id: i.showtimeId, movieTitle: i.movieTitle, startTime: i.startTime, endTime: i.endTime, diffs: i.diffs,
      });
    } else if (i.kind === "archive" && i.showtimeId) {
      changes.archives.push({ id: i.showtimeId, movieTitle: i.movieTitle, startTime: i.startTime, endTime: i.endTime });
    }
  }

  return {
    ...upload,
    botMessage: a.botMessage ?? null,
    source: a.source ?? (upload.model ? "agent" : "rule"),
    thoughts: a.thoughts ?? [],
    thinkingLevel: a.thinkingLevel ?? null,
    changes,
    items,
    events,
  };
}
