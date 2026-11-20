import { errorResponse, getUserId, HttpError } from "~/server/access";
import { cancelAnalysis } from "~/server/reconcile/service";

export const dynamic = "force-dynamic";

/**
 * POST /api/uploads/:id/cancel — stop an analysis in progress. The streaming
 * job polls the upload's status, so it stops even if it runs on another
 * instance. Returns { cancelled, upload }; cancelled is false if it had
 * already finished.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = getUserId(request);
    if (!userId) throw new HttpError(400, "x-user-id header is required");
    const { id } = await params;
    return Response.json(await cancelAnalysis(userId, id));
  } catch (error) {
    return errorResponse(error);
  }
}
