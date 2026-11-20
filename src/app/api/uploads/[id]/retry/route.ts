import { z } from "zod";
import { errorResponse, getUserId, HttpError } from "~/server/access";
import { loadForAction, retryUpload } from "~/server/reconcile/service";
import { ndjson, wantsStream } from "~/server/stream";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const body = z.object({ feedback: z.string().trim().min(1).max(2000) });

/** POST /api/uploads/:id/retry — "Reject with feedback": re-run the agent with the reviewer's notes. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = getUserId(request);
    if (!userId) throw new HttpError(400, "x-user-id header is required");
    const parsed = body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "Feedback is required");
    const { id } = await params;
    if (wantsStream(request)) {
      await loadForAction(userId, id); // 404 / 403 before streaming
      return ndjson((send) => retryUpload(userId, id, parsed.data.feedback, send));
    }
    return Response.json(await retryUpload(userId, id, parsed.data.feedback));
  } catch (error) {
    return errorResponse(error);
  }
}
