import { z } from "zod";
import { errorResponse, getUserId, HttpError } from "~/server/access";
import { applyUpload } from "~/server/reconcile/service";

export const dynamic = "force-dynamic";

const body = z.object({ rejectedChangeIds: z.array(z.string()).max(1000).default([]) }).default({});

/** POST /api/uploads/:id/apply — apply the reviewed proposal in one transaction. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = getUserId(request);
    if (!userId) throw new HttpError(400, "x-user-id header is required");
    const parsed = body.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) throw new HttpError(400, "Invalid body");
    const { id } = await params;
    return Response.json(await applyUpload(userId, id, parsed.data.rejectedChangeIds));
  } catch (error) {
    return errorResponse(error);
  }
}
