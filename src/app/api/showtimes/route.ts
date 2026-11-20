import { errorResponse, getUserId, HttpError } from "~/server/access";
import { searchParamsSchema, searchShowtimes } from "~/server/showtimes";

export const dynamic = "force-dynamic";

/**
 * Search, filter, sort and keyset-paginate showtimes the user can see.
 * Add `explain=1` to get the Postgres plan summary for the page query.
 */
export async function GET(request: Request) {
  try {
    const userId = getUserId(request);
    if (!userId) throw new HttpError(400, "x-user-id header is required");
    const parsed = searchParamsSchema.safeParse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    if (!parsed.success) {
      throw new HttpError(400, `Invalid query: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
    }
    return Response.json(await searchShowtimes(userId, parsed.data));
  } catch (error) {
    return errorResponse(error);
  }
}
