import { errorResponse, getUserId, HttpError } from "~/server/access";
import { getFacets } from "~/server/showtimes";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const userId = getUserId(request);
    if (!userId) throw new HttpError(400, "x-user-id header is required");
    const raw = new URL(request.url).searchParams.get("theaterId")?.trim();
    const theaterId = raw && raw.length > 0 ? raw : undefined;
    return Response.json(await getFacets(userId, theaterId));
  } catch (error) {
    return errorResponse(error);
  }
}
