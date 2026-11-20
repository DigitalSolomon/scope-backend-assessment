import { z } from "zod";
import { errorResponse, getUserId, HttpError } from "~/server/access";
import { THINKING_LEVELS } from "~/server/reconcile/gemini";
import { loadForAction, retryUpload } from "~/server/reconcile/service";
import { jsonKeepAlive, ndjson, wantsStream } from "~/server/stream";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const body = z.object({
  feedback: z.string().trim().min(1).max(2000),
  thinkingLevel: z.enum(THINKING_LEVELS).optional(),
});

/** POST /api/uploads/:id/retry — "Reject with feedback": re-run the agent with the reviewer's notes. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = getUserId(request);
    if (!userId) throw new HttpError(400, "x-user-id header is required");
    const parsed = body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "Expected { feedback, thinkingLevel? }");
    const { id } = await params;
    const u = await loadForAction(userId, id); // 404 / 403 / 409 before the response starts
    if (u.status !== "pending_review") throw new HttpError(409, `Upload is ${u.status}, not awaiting review`);
    const run = (send?: Parameters<typeof retryUpload>[3]) => retryUpload(userId, id, parsed.data.feedback, send, { thinkingLevel: parsed.data.thinkingLevel });
    if (wantsStream(request)) return ndjson((send) => run(send));
    return jsonKeepAlive(() => run());
  } catch (error) {
    return errorResponse(error);
  }
}
