import { errorResponse, getRole, getUserId, HttpError } from "~/server/access";
import { sql } from "~/server/db";

export const dynamic = "force-dynamic";

/** Archive every non-archived showtime at a theater. Admin at that theater only. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const userId = getUserId(request);
    if (!userId) throw new HttpError(400, "x-user-id header is required");
    const { id } = await params;
    if ((await getRole(userId, id)) !== "admin") {
      throw new HttpError(403, "Admin role at this theater is required");
    }
    const result = await sql`
      update hv_theater.showtimes
      set status = 'archived', last_updated = now(), version = version + 1
      where theater_id = ${id} and status <> 'archived'`;
    return Response.json({ archived: result.count });
  } catch (error) {
    return errorResponse(error);
  }
}
