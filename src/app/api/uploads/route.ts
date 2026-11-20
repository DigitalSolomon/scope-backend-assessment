import { z } from "zod";
import { errorResponse, getUserId, HttpError } from "~/server/access";
import { MAX_CSV_BYTES } from "~/server/reconcile/csv";
import { assertCanUpload, createUpload } from "~/server/reconcile/service";
import { ndjson, wantsStream } from "~/server/stream";
import { listUploads } from "~/server/uploads";

export const dynamic = "force-dynamic";
// The reconciliation agent can take tens of seconds.
export const maxDuration = 120;

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

const body = z.object({
  theaterId: z.string().min(1),
  fileName: z.string().min(1).max(200),
  csv: z.string().min(1).max(MAX_CSV_BYTES),
});

/**
 * POST /api/uploads — record the upload, run the reconciliation agent, and
 * return the proposal for review. Nothing in the schedule changes yet.
 * With `Accept: application/x-ndjson`, progress and ScopeBot's thoughts are
 * streamed while it works, ending with a `result` event.
 */
export async function POST(request: Request) {
  try {
    const userId = getUserId(request);
    if (!userId) throw new HttpError(400, "x-user-id header is required");
    const parsed = body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "Expected { theaterId, fileName, csv } (CSV up to 1 MB)");
    const { theaterId, fileName, csv } = parsed.data;
    if (wantsStream(request)) {
      await assertCanUpload(userId, theaterId); // fail fast with a normal 403 before streaming
      return ndjson((send) => createUpload(userId, theaterId, fileName, csv, send));
    }
    return Response.json(await createUpload(userId, theaterId, fileName, csv));
  } catch (error) {
    return errorResponse(error);
  }
}
