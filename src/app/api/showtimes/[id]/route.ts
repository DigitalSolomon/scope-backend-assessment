import { z } from "zod";
import { errorResponse, getRole, getUserId, HttpError } from "~/server/access";
import { sql } from "~/server/db";
import { MOVIE_STATUSES, SHOWTIME_STATUSES } from "~/types/assessment";

export const dynamic = "force-dynamic";

const body = z
  .object({
    status: z.enum(SHOWTIME_STATUSES as [string, ...string[]]).optional(),
    movieStatus: z.enum(MOVIE_STATUSES as [string, ...string[]]).optional(),
  })
  .refine((b) => b.status ?? b.movieStatus, "Nothing to update");

/**
 * Admin-only edits from the schedule table.
 * - status: this showtime's status.
 * - movieStatus: the status of the showtime's movie (a movie-level field,
 *   so it changes for every showtime of that film).
 * The caller must be an admin at this showtime's theater.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const userId = getUserId(request);
    if (!userId) throw new HttpError(400, "x-user-id header is required");
    const { id } = await params;
    const parsed = body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "Invalid body");

    const [showtime] = await sql<{ theater_id: string; movie_id: string }[]>`
      select theater_id, movie_id from hv_theater.showtimes where id = ${id}`;
    if (!showtime) throw new HttpError(404, "Showtime not found");

    const role = await getRole(userId, showtime.theater_id);
    if (role !== "admin") throw new HttpError(403, "Admin role at this theater is required");

    await sql.begin(async (tx) => {
      if (parsed.data.status) {
        try {
          await tx`
            update hv_theater.showtimes
            set status = ${parsed.data.status}::hv_theater.showtime_status,
                last_updated = now(), version = version + 1
            where id = ${id}`;
        } catch (e) {
          if ((e as { code?: string }).code === "23505") {
            throw new HttpError(409, "Another active showtime already exists for this movie and start time");
          }
          throw e;
        }
      }
      if (parsed.data.movieStatus) {
        await tx`
          update hv_theater.movies
          set status = ${parsed.data.movieStatus}::hv_theater.movie_status, updated_at = now()
          where id = ${showtime.movie_id}`;
      }
    });
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
