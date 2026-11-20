import { errorResponse, getUserId, HttpError } from "~/server/access";
import { discardUpload } from "~/server/reconcile/service";

export const dynamic = "force-dynamic";

/** POST /api/uploads/:id/discard — reviewer cancelled; nothing is applied. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = getUserId(request);
    if (!userId) throw new HttpError(400, "x-user-id header is required");
    const { id } = await params;
    return Response.json(await discardUpload(userId, id));
  } catch (error) {
    return errorResponse(error);
  }
}
