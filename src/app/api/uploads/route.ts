import { errorResponse, getUserId, HttpError } from "~/server/access";
import { listUploads } from "~/server/uploads";

export const dynamic = "force-dynamic";

/** GET /api/uploads?theaterId=… — every upload attempt for a theater, newest first. */
export async function GET(request: Request) {
  try {
    const userId = getUserId(request);
    if (!userId) throw new HttpError(400, "x-user-id header is required");
    const theaterId = new URL(request.url).searchParams.get("theaterId");
    if (!theaterId) throw new HttpError(400, "theaterId is required");
    return Response.json({ uploads: await listUploads(userId, theaterId) });
  } catch (error) {
    return errorResponse(error);
  }
}
