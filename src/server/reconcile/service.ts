import "server-only";

import { createHash } from "node:crypto";
import type postgres from "postgres";
import { normalizeKey } from "~/lib/normalize";
import type { ReconcileEvent } from "~/types/assessment";
import { getRole, HttpError } from "../access";
import { sql } from "../db";
import { getUpload } from "../uploads";
import { runAgent } from "./agent";
import type { ThinkingLevel } from "./gemini";
import { CancelledError, watchCancel } from "./cancel";
import { loadContext } from "./context";
import { CsvError, parseShowtimeCsv } from "./csv";
import type { ChangeDraft } from "./plan";

type Tx = postgres.TransactionSql;
/** Receives live progress for streaming to the browser. */
export type Progress = (e: ReconcileEvent) => void;
/** Per-upload choices made by the reviewer. */
export interface AnalyzeOptions {
  /** Quick ("low") or Thorough ("medium"); omitted means the server default. */
  thinkingLevel?: ThinkingLevel;
}

async function requireAdmin(userId: string, theaterId: string) {
  if ((await getRole(userId, theaterId)) !== "admin") {
    throw new HttpError(403, "Admin role at this theater is required");
  }
}

async function event(
  uploadId: string,
  kind: "status" | "error" | "feedback" | "note",
  fields: { status?: string; message?: string; actorId?: string | null; detail?: unknown } = {},
) {
  await sql`
    insert into hv_theater.upload_events (upload_id, kind, status, message, actor_id, detail)
    values (${uploadId}, ${kind}, ${fields.status ?? null}, ${fields.message ?? null},
            ${fields.actorId ?? null}, ${fields.detail === undefined ? null : sql.json(fields.detail as never)})`;
}

async function setStatus(uploadId: string, status: string, message: string, extra: { error?: string | null } = {}) {
  const terminal = ["applied", "partially_applied", "discarded", "failed"].includes(status);
  await sql`
    update hv_theater.csv_uploads set
      status = ${status}::hv_theater.upload_status,
      error = ${extra.error ?? null},
      analyzed_at = case when ${status} = 'pending_review' then now() else analyzed_at end,
      completed_at = case when ${terminal} then now() else completed_at end,
      updated_at = now()
    where id = ${uploadId}`;
  await event(uploadId, "status", { status, message });
}

/**
 * Store the proposal and move the upload to pending_review in one transaction.
 * The row lock serializes with a concurrent cancel: if the reviewer cancelled
 * first, nothing is written (a retry keeps its previous proposal intact).
 */
async function saveProposal(
  uploadId: string,
  drafts: ChangeDraft[],
  meta: { summary: string; warnings: string[]; model: string | null },
) {
  await sql.begin(async (tx) => {
    const [u] = await tx<{ status: string }[]>`
      select status from hv_theater.csv_uploads where id = ${uploadId} for update`;
    if (u?.status !== "analyzing") throw new CancelledError();
    await tx`delete from hv_theater.upload_changes where upload_id = ${uploadId}`;
    // Display order: actionable first, then informational.
    const order = ["add", "update", "reactivate", "archive", "duplicate", "unchanged", "invalid"];
    const sorted = [...drafts].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
    for (const [i, d] of sorted.entries()) {
      const [c] = await tx<{ id: string }[]>`
        insert into hv_theater.upload_changes
          (upload_id, position, kind, showtime_id, showtime_version, csv_rows, movie_title, auditorium,
           start_time, end_time, language, format, rating, explanation, confidence, source)
        values
          (${uploadId}, ${i + 1}, ${d.kind}::hv_theater.change_kind, ${d.showtimeId}, ${d.showtimeVersion},
           ${d.csvRows}, ${d.movieTitle}, ${d.auditorium}, ${d.startTime || null}, ${d.endTime || null},
           ${d.language}, ${d.format}, ${d.rating}, ${d.explanation}, ${d.confidence},
           ${d.source}::hv_theater.change_source)
        returning id`;
      for (const diff of d.diffs) {
        await tx`
          insert into hv_theater.upload_change_diffs (change_id, field, old_value, new_value)
          values (${c!.id}, ${diff.field}, ${diff.oldValue}, ${diff.newValue})
          on conflict do nothing`;
      }
    }
    const n = (k: string) => drafts.filter((d) => d.kind === k).length;
    await tx`
      update hv_theater.csv_uploads set
        adds_count = ${n("add")}, updates_count = ${n("update") + n("reactivate")},
        archives_count = ${n("archive")}, applied_count = 0, failed_count = 0,
        summary = ${meta.summary}, warnings = ${meta.warnings}, model = ${meta.model},
        status = 'pending_review', error = null, analyzed_at = now(), updated_at = now()
      where id = ${uploadId}`;
  });
}

async function analyze(
  uploadId: string,
  theaterId: string,
  csv: string,
  actorId: string,
  feedback?: string,
  progress: Progress = () => undefined,
  options: AnalyzeOptions = {},
) {
  await setStatus(uploadId, "analyzing", feedback ? "Re-analyzing with reviewer feedback" : "Parsing and matching rows");
  const watch = watchCancel(uploadId);
  try {
    await analyzeRows(uploadId, theaterId, csv, actorId, feedback, progress, watch, options);
  } finally {
    watch.stop();
  }
}

async function analyzeRows(
  uploadId: string,
  theaterId: string,
  csv: string,
  actorId: string,
  feedback: string | undefined,
  progress: Progress,
  watch: ReturnType<typeof watchCancel>,
  options: AnalyzeOptions,
) {
  progress({ type: "step", key: "parsed", state: "active", label: "Reading the file…" });
  let parsed;
  try {
    parsed = parseShowtimeCsv(csv);
  } catch (e) {
    const msg = e instanceof CsvError ? e.message : "Could not read the CSV.";
    progress({ type: "step", key: "parsed", state: "warn", label: msg });
    await setStatus(uploadId, "failed", msg, { error: msg });
    await event(uploadId, "error", { message: msg });
    return;
  }
  await sql`update hv_theater.csv_uploads set row_count = ${parsed.rows.length + parsed.invalid.length} where id = ${uploadId}`;
  const n = parsed.rows.length;
  progress({
    type: "step",
    key: "parsed",
    state: parsed.invalid.length ? "warn" : "done",
    label: `Read ${n} row${n === 1 ? "" : "s"}${parsed.invalid.length ? `, ${parsed.invalid.length} skipped as invalid` : ""}`,
  });

  try {
    progress({ type: "step", key: "context", state: "active", label: "Pulling up the stored schedule…" });
    const ctx = await loadContext(theaterId, parsed.rows);
    watch.check();
    const days = ctx.window.days.map((d) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }));
    progress({
      type: "step",
      key: "context",
      state: "done",
      label: `Compared against ${ctx.stored.length} stored showtime${ctx.stored.length === 1 ? "" : "s"}${days.length ? ` on ${days.join(", ")}` : ""}`,
    });
    let previous: unknown = null;
    if (feedback) {
      previous = await sql`
        select kind, csv_rows as rows, showtime_id as "showtimeId", movie_title as title,
               auditorium, explanation
        from hv_theater.upload_changes where upload_id = ${uploadId} order by position`;
    }
    const outcome = await runAgent(
      ctx,
      parsed.rows,
      parsed.invalid,
      feedback ? { text: feedback, previous } : undefined,
      progress,
      watch.signal,
      options,
    );
    watch.check();
    if (parsed.ignoredColumns.length) outcome.warnings.push(`Ignored extra columns: ${parsed.ignoredColumns.join(", ")}.`);

    progress({ type: "step", key: "saved", state: "active", label: "Writing up the proposal…" });
    await saveProposal(uploadId, outcome.drafts, outcome);
    await event(uploadId, "note", {
      message: outcome.message,
      actorId,
      detail: {
        type: "analysis",
        botMessage: outcome.message,
        source: outcome.source,
        thoughts: outcome.thoughts,
        agentError: outcome.error,
        archivesPreselected: outcome.archivesPreselected,
        thinkingLevel: outcome.thinkingLevel,
      },
    });
    if (outcome.error) await event(uploadId, "error", { message: `AI unavailable, used rules: ${outcome.error}` });
    await event(uploadId, "status", {
      status: "pending_review",
      message: `${outcome.drafts.length} items proposed (${outcome.source})`,
    });
    progress({ type: "step", key: "saved", state: "done", label: "Proposal ready for your review" });
  } catch (e) {
    if (e instanceof CancelledError || watch.signal.aborted) {
      // The cancel endpoint already recorded the status and event.
      progress({ type: "step", key: "saved", state: "warn", label: "Cancelled" });
      return;
    }
    const msg = e instanceof Error ? e.message : "Analysis failed";
    progress({ type: "step", key: "saved", state: "warn", label: `Something went wrong: ${msg}` });
    console.error("[upload] analysis failed", e);
    await setStatus(uploadId, "failed", msg, { error: msg });
    await event(uploadId, "error", { message: msg });
  }
}

/** Throws unless the user may upload to this theater (checked before streaming starts). */
export const assertCanUpload = requireAdmin;

/** Record the upload first (so failed attempts are visible), then analyze it. */
export async function createUpload(
  userId: string,
  theaterId: string,
  fileName: string,
  csv: string,
  progress: Progress = () => undefined,
  options: AnalyzeOptions = {},
) {
  await requireAdmin(userId, theaterId);
  const sha = createHash("sha256").update(csv).digest("hex");
  // Postgres text cannot hold NUL bytes. A binary file (image, spreadsheet) is
  // still recorded as a failed attempt, without its unusable contents.
  const binary = csv.includes("\u0000");
  fileName = fileName.replace(/\u0000/g, "").slice(0, 200) || "upload.csv";
  const [u] = await sql<{ id: string }[]>`
    insert into hv_theater.csv_uploads (theater_id, uploaded_by, file_name, file_size, file_sha256, raw_csv)
    values (${theaterId}, ${userId}, ${fileName}, ${Buffer.byteLength(csv)}, ${sha}, ${binary ? null : csv})
    returning id`;
  await event(u!.id, "status", { status: "received", message: `Received ${fileName}`, actorId: userId });
  progress({ type: "started", uploadId: u!.id });
  const kb = Math.max(1, Math.round(Buffer.byteLength(csv) / 1024));
  progress({ type: "step", key: "received", state: "done", label: `Got ${fileName} (${kb} KB)` });
  await analyze(u!.id, theaterId, csv, userId, undefined, progress, options);
  return getUpload(userId, u!.id);
}

/** Load an upload and check the user may act on it (checked before streaming starts). */
export async function loadForAction(userId: string, uploadId: string) {
  const [u] = await sql<{ theater_id: string; status: string; raw_csv: string | null }[]>`
    select theater_id, status, raw_csv from hv_theater.csv_uploads where id = ${uploadId}`;
  if (!u) throw new HttpError(404, "Upload not found");
  await requireAdmin(userId, u.theater_id);
  return u;
}

/** "Reject with feedback": log the feedback and re-run the agent with it. */
export async function retryUpload(
  userId: string,
  uploadId: string,
  feedback: string,
  progress: Progress = () => undefined,
  options: AnalyzeOptions = {},
) {
  const u = await loadForAction(userId, uploadId);
  if (u.status !== "pending_review") throw new HttpError(409, `Upload is ${u.status}, not awaiting review`);
  if (!u.raw_csv) throw new HttpError(409, "Original CSV is not stored for this upload");
  await event(uploadId, "feedback", { message: feedback, actorId: userId });
  progress({ type: "started", uploadId });
  progress({ type: "step", key: "received", state: "done", label: "Got your feedback" });
  await analyze(uploadId, u.theater_id, u.raw_csv, userId, feedback, progress, options);
  return getUpload(userId, uploadId);
}

export async function discardUpload(userId: string, uploadId: string) {
  const u = await loadForAction(userId, uploadId);
  if (u.status !== "pending_review" && u.status !== "failed") {
    throw new HttpError(409, `Upload is ${u.status}`);
  }
  await setStatus(uploadId, "discarded", "Reviewer cancelled");
  return getUpload(userId, uploadId);
}

/**
 * Cancel an analysis in progress. A first-time upload becomes discarded; a
 * retry goes back to pending_review with its previous proposal. The running
 * job notices within ~2s, aborts its Gemini request and writes nothing.
 * Idempotent: if the analysis already finished, nothing changes.
 */
export async function cancelAnalysis(userId: string, uploadId: string) {
  await loadForAction(userId, uploadId);
  const [row] = await sql<{ status: string }[]>`
    update hv_theater.csv_uploads set
      status = (case when analyzed_at is null then 'discarded' else 'pending_review' end)::hv_theater.upload_status,
      completed_at = case when analyzed_at is null then now() else completed_at end,
      updated_at = now()
    where id = ${uploadId} and status in ('received', 'analyzing')
    returning status`;
  if (row) {
    await event(uploadId, "status", {
      status: row.status,
      actorId: userId,
      message:
        row.status === "discarded" ? "Cancelled during analysis" : "Re-analysis cancelled; kept the previous proposal",
    });
  }
  return { cancelled: Boolean(row), upload: await getUpload(userId, uploadId) };
}

// ------------------------------------------------------------------ apply

async function ensureMovie(tx: Tx, title: string, rating: string) {
  const key = normalizeKey(title);
  const [found] = await tx<{ id: string }[]>`select id from hv_theater.movies where title_key = ${key}`;
  if (found) return found.id;
  const [created] = await tx<{ id: string }[]>`
    insert into hv_theater.movies (title, title_key, rating, status)
    values (${title}, ${key}, ${rating || null}, 'needs-review') returning id`;
  return created!.id;
}

async function ensureAuditorium(tx: Tx, theaterId: string, name: string) {
  const key = normalizeKey(name);
  const [found] = await tx<{ id: string }[]>`
    select id from hv_theater.auditoriums where theater_id = ${theaterId} and name_key = ${key}`;
  if (found) return found.id;
  const [created] = await tx<{ id: string }[]>`
    insert into hv_theater.auditoriums (theater_id, name, name_key)
    values (${theaterId}, ${name}, ${key}) returning id`;
  return created!.id;
}

type ChangeRow = {
  id: string; kind: string; csv_rows: number[]; showtime_id: string | null; showtime_version: number | null;
  movie_title: string; auditorium: string; start_time: Date | null; end_time: Date | null;
  language: string; format: string; rating: string; diff_fields: string[] | null;
};

/**
 * `sourceUpdated` is the CSV row's own last_updated. A showtime written from a
 * file is stamped with the file's timestamp, not "now", so the next, newer
 * file from the partner is still newer than what is stored. Without it (the
 * file has no last_updated, or the change is an archive) the stamp is now().
 */
async function applyChange(tx: Tx, theaterId: string, c: ChangeRow, sourceUpdated: string | null) {
  if (c.kind === "add") {
    const movieId = await ensureMovie(tx, c.movie_title, c.rating);
    const audId = await ensureAuditorium(tx, theaterId, c.auditorium);
    await tx`
      insert into hv_theater.showtimes
        (theater_id, movie_id, auditorium_id, start_time, end_time, language, format, status, last_updated)
      values (${theaterId}, ${movieId}, ${audId}, ${c.start_time}, ${c.end_time},
              ${c.language || "EN"}, ${c.format || "2D"}, 'active', coalesce(${sourceUpdated}::timestamptz, now()))`;
    return;
  }
  const [s] = await tx<{ version: number; movie_id: string }[]>`
    select version, movie_id from hv_theater.showtimes
    where id = ${c.showtime_id} and theater_id = ${theaterId} for update`;
  if (!s) throw new Error("The showtime no longer exists.");
  if (c.showtime_version !== null && s.version !== c.showtime_version) {
    throw new Error("The showtime changed after this proposal was made; re-run the upload.");
  }
  if (c.kind === "archive") {
    await tx`
      update hv_theater.showtimes set status = 'archived', last_updated = now(), version = version + 1
      where id = ${c.showtime_id}`;
    return;
  }
  // update / reactivate: write the proposed snapshot.
  const fields = new Set(c.diff_fields ?? []);
  const movieId = fields.has("movieTitle") ? await ensureMovie(tx, c.movie_title, c.rating) : s.movie_id;
  const audId = await ensureAuditorium(tx, theaterId, c.auditorium);
  await tx`
    update hv_theater.showtimes set
      movie_id = ${movieId}, auditorium_id = ${audId},
      start_time = ${c.start_time}, end_time = ${c.end_time},
      language = coalesce(nullif(${c.language}, ''), language),
      format = coalesce(nullif(${c.format}, ''), format),
      status = 'active',
      last_updated = greatest(last_updated, coalesce(${sourceUpdated}::timestamptz, now())),
      version = version + 1
    where id = ${c.showtime_id}`;
  // Ratings are not written: a film is shared by every theater, so one
  // theater's upload must not change it for the others.
}

const describeError = (e: unknown) =>
  (e as { code?: string }).code === "23505"
    ? "Another active showtime already exists for this film and start time."
    : e instanceof Error
      ? e.message
      : "Failed to apply";

/**
 * Apply every accepted actionable change in one transaction. Each change runs
 * in its own savepoint, so one failure is recorded on that change and the
 * rest still apply (status partially_applied).
 */
export async function applyUpload(userId: string, uploadId: string, rejectedIds: string[] = []) {
  const u = await loadForAction(userId, uploadId);
  if (u.status !== "pending_review") throw new HttpError(409, `Upload is ${u.status}, not awaiting review`);

  // Each CSV row's own last_updated, to stamp the showtimes it changes.
  const rowUpdated = new Map<number, string>();
  try {
    for (const r of u.raw_csv ? parseShowtimeCsv(u.raw_csv).rows : []) if (r.lastUpdated) rowUpdated.set(r.row, r.lastUpdated);
  } catch {
    // An unreadable file has no proposal to apply; nothing to stamp.
  }

  const result = await sql.begin(async (tx) => {
    const [locked] = await tx<{ status: string }[]>`
      update hv_theater.csv_uploads set status = 'applying', reviewed_at = now(), updated_at = now()
      where id = ${uploadId} and status = 'pending_review' returning status`;
    if (!locked) throw new HttpError(409, "Upload is already being applied");

    await tx`
      update hv_theater.upload_changes
      set decision = case when id = any(${rejectedIds}::text[]) then 'rejected' else 'accepted' end::hv_theater.change_decision,
          decided_at = now()
      where upload_id = ${uploadId} and kind in ('add', 'update', 'reactivate', 'archive')`;

    const changes = await tx<ChangeRow[]>`
      select c.id, c.kind, c.csv_rows, c.showtime_id, c.showtime_version, c.movie_title, c.auditorium,
             c.start_time, c.end_time, c.language, c.format, c.rating,
             (select array_agg(field) from hv_theater.upload_change_diffs d where d.change_id = c.id) as diff_fields
      from hv_theater.upload_changes c
      where c.upload_id = ${uploadId} and c.decision = 'accepted'
      order by case c.kind when 'archive' then 0 else 1 end, c.position`; // archive first frees the one-active slot

    let applied = 0;
    let failed = 0;
    for (const c of changes) {
      try {
        await tx.savepoint(async (sp) => applyChange(sp, u.theater_id, c, rowUpdated.get(c.csv_rows[0] ?? -1) ?? null));
        await tx`update hv_theater.upload_changes set applied_at = now(), apply_error = null where id = ${c.id}`;
        applied++;
      } catch (e) {
        failed++;
        await tx`update hv_theater.upload_changes set apply_error = ${describeError(e)} where id = ${c.id}`;
      }
    }
    // Confirming with every change unticked applies nothing: that is a discard.
    const status = changes.length === 0 ? "discarded" : failed === 0 ? "applied" : applied === 0 ? "failed" : "partially_applied";
    await tx`
      update hv_theater.csv_uploads set
        status = ${status}::hv_theater.upload_status, applied_count = ${applied}, failed_count = ${failed},
        error = ${failed ? `${failed} change(s) failed to apply` : null},
        completed_at = now(), updated_at = now()
      where id = ${uploadId}`;
    return { status, applied, failed };
  });

  await event(uploadId, "status", {
    status: result.status,
    message:
      result.status === "discarded"
        ? "Reviewer confirmed with nothing selected; no changes applied"
        : `Applied ${result.applied} change(s)${result.failed ? `, ${result.failed} failed` : ""}`,
    actorId: userId,
  });
  return getUpload(userId, uploadId);
}
