import "server-only";

import postgres from "postgres";
import { env } from "~/env";

/**
 * One Postgres client per server instance.
 *
 * - `prepare: false` keeps us compatible with Supabase's transaction-mode
 *   pooler (port 6543), which does not support prepared statements.
 * - `max: 1` suits serverless: each function instance holds one connection
 *   and the pooler does the multiplexing.
 * - Cached on globalThis so Next.js hot reloads in dev don't leak connections.
 */
const globalForDb = globalThis as unknown as {
  sql: ReturnType<typeof postgres> | undefined;
};

export const sql =
  globalForDb.sql ??
  postgres(env.DATABASE_URL, {
    prepare: false,
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
    ssl: "require",
  });

if (env.NODE_ENV !== "production") globalForDb.sql = sql;
