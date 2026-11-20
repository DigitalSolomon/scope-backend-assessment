import "server-only";

import type { MemberRole } from "~/types/assessment";
import { sql } from "./db";

/**
 * No authentication is required for this assessment, so the acting user is
 * identified by the x-user-id header set from the mock session selector.
 * Authorization is still enforced server-side from theater memberships.
 */
export function getUserId(request: Request): string | null {
  const id = request.headers.get("x-user-id")?.trim();
  if (!id) return null;
  return id;
}

export async function getRole(
  userId: string,
  theaterId: string,
): Promise<MemberRole | null> {
  const [row] = await sql<{ role: MemberRole }[]>`
    select role from hv_theater.theater_memberships
    where user_id = ${userId} and theater_id = ${theaterId}`;
  return row?.role ?? null;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  console.error("[api] unexpected error", error);
  return Response.json({ error: "Internal server error" }, { status: 500 });
}
