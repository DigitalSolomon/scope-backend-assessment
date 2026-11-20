import "server-only";

import type {
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
  kind: string;
  showtime_id: string | null;
  movie_title: string | null;
  auditorium: string | null;
  start_time: Date | null;
  end_time: Date | null;
  language: string | null;
  format: string | null;
  rating: string | null;
  diffs: FieldDiff[] | null;
};

/** One upload with its proposed changes (as PreviewChanges) and event log. */
export async function getUpload(userId: string, uploadId: string): Promise<ApiUploadDetail | null> {
  const [upload] = await sql<(ApiUploadSummary & { summary: string | null; warnings: string[] })[]>`
    select ${summaryColumns}, u.summary, u.warnings
    from hv_theater.csv_uploads u
    join hv_theater.theater_memberships tm
      on tm.theater_id = u.theater_id and tm.user_id = ${userId}
    left join hv_theater.users us on us.id = u.uploaded_by
    where u.id = ${uploadId}`;
  if (!upload) return null;

  const [rows, events] = await Promise.all([
    sql<ChangeRow[]>`
      select c.id, c.kind, c.showtime_id, c.movie_title, c.auditorium, c.start_time,
             c.end_time, c.language, c.format, c.rating,
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
  ]);

  const iso = (d: Date | null) => d?.toISOString() ?? "";
  const changes: PreviewChanges = { adds: [], updates: [], archives: [] };
  for (const r of rows) {
    if (r.kind === "add") {
      changes.adds.push({
        movieTitle: r.movie_title ?? "",
        auditorium: r.auditorium ?? "",
        startTime: iso(r.start_time),
        endTime: iso(r.end_time),
        language: r.language ?? "",
        format: r.format ?? "",
        rating: r.rating ?? "",
      });
    } else if (r.kind === "update" && r.showtime_id) {
      changes.updates.push({
        id: r.showtime_id,
        movieTitle: r.movie_title ?? "",
        startTime: iso(r.start_time),
        endTime: iso(r.end_time),
        diffs: r.diffs ?? [],
      });
    } else if (r.kind === "archive" && r.showtime_id) {
      changes.archives.push({
        id: r.showtime_id,
        movieTitle: r.movie_title ?? "",
        startTime: iso(r.start_time),
        endTime: iso(r.end_time),
      });
    }
  }

  return { ...upload, changes, events };
}
