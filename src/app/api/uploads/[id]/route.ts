import { errorResponse, getUserId, HttpError } from "~/server/access";
import { getUpload } from "~/server/uploads";

export const dynamic = "force-dynamic";

/** GET /api/uploads/:id — one upload with its proposed changes and event log. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const userId = getUserId(request);
    if (!userId) throw new HttpError(400, "x-user-id header is required");
    const { id } = await params;
    const upload = await getUpload(userId, id);
    if (!upload) throw new HttpError(404, "Upload not found");
    return Response.json(upload);
  } catch (error) {
    return errorResponse(error);
  }
}
