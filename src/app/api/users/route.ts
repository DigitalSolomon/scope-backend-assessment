import { errorResponse } from "~/server/access";
import { sql } from "~/server/db";
import type { ApiUser } from "~/types/assessment";

export const dynamic = "force-dynamic";

/** Users for the mock session selector, with membership counts (not lists: some users belong to thousands of theaters). */
export async function GET() {
  try {
    const users = await sql<ApiUser[]>`
      select u.id, u.name, u.email,
        count(tm.theater_id)::int as "theaterCount",
        (count(*) filter (where tm.role = 'admin'))::int as "adminCount"
      from hv_theater.users u
      left join hv_theater.theater_memberships tm on tm.user_id = u.id
      group by u.id
      order by u.name`;
    return Response.json({ users });
  } catch (error) {
    return errorResponse(error);
  }
}
