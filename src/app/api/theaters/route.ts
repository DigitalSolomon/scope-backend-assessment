import { z } from "zod";
import { errorResponse, getUserId, HttpError } from "~/server/access";
import { sql } from "~/server/db";
import type { ApiTheater } from "~/types/assessment";

export const dynamic = "force-dynamic";

const params = z.object({
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * Theaters the user belongs to, with their role at each. `q` matches name or
 * location by substring, served by the trigram indexes on theaters.
 */
export async function GET(request: Request) {
  try {
    const userId = getUserId(request);
    if (!userId) throw new HttpError(400, "x-user-id header is required");
    const parsed = params.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success) throw new HttpError(400, "Invalid query parameters");
    const { q, limit } = parsed.data;
    const like = q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;

    const theaters = await sql<ApiTheater[]>`
      select t.id, t.name, t.location, t.timezone, tm.role
      from hv_theater.theater_memberships tm
      join hv_theater.theaters t on t.id = tm.theater_id
      where tm.user_id = ${userId}
      ${like ? sql`and (t.name ilike ${like} or t.location ilike ${like})` : sql``}
      order by t.name, t.id
      limit ${limit}`;
    return Response.json({ theaters });
  } catch (error) {
    return errorResponse(error);
  }
}
