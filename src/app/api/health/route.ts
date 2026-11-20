import { NextResponse } from "next/server";
import { env } from "~/env";
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
      // No secrets: whether the AI is connected and its defaults (the UI's Quick / Thorough toggle starts here).
      scopebot: {
        aiConnected: Boolean(env.GEMINI_API_KEY),
        model: env.GEMINI_MODEL,
        thinkingLevel: env.GEMINI_THINKING_LEVEL,
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
