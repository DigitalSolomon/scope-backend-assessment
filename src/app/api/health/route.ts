import { NextResponse } from "next/server";
import { sql } from "~/server/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const started = Date.now();
  try {
    const [row] = await sql<{ ok: number; now: Date }[]>`
      select 1 as ok, now() as now
    `;
    return NextResponse.json({
      status: "ok",
      database: {
        connected: row?.ok === 1,
        serverTime: row?.now,
        latencyMs: Date.now() - started,
      },
    });
  } catch (error) {
    // Log details server-side only; never echo connection info to the client.
    console.error("[health] database check failed", error);
    return NextResponse.json(
      {
        status: "error",
        database: {
          connected: false,
          error: error instanceof Error ? error.message : "Unknown error",
          latencyMs: Date.now() - started,
        },
      },
      { status: 503 },
    );
  }
}
