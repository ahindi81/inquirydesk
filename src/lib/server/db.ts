import "server-only";
import postgres from "postgres";

// One connection pool per server process. In production DATABASE_URL points at
// Supabase's connection pooler (transaction mode), so prepared statements are off.
const globalForDb = globalThis as unknown as { __sql?: postgres.Sql };

function createPool() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set. See README → Configuration.");
  return postgres(url, {
    max: Number(process.env.DATABASE_POOL_SIZE ?? 5),
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
    types: { bigint: postgres.BigInt },
    transform: { undefined: null },
  });
}

export const sql: postgres.Sql = globalForDb.__sql ?? (globalForDb.__sql = createPool());
export type Tx = postgres.TransactionSql;

/**
 * Run queries as a signed-in user. Every statement inside `fn` executes with
 * the `authenticated` role and the user's id in the JWT claims, so the
 * database's row-level security policies decide what is visible. There is no
 * code path that queries tenant tables without this.
 */
export async function asUser<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new Error("Invalid user id");
  return sql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: "authenticated" })}, true)`;
    await tx`set local role authenticated`;
    return fn(tx);
  }) as Promise<T>;
}

/** Postgres error → message safe to show a user. */
export function dbErrorMessage(e: unknown): string {
  const err = e as { code?: string; message?: string };
  // Our own rule violations (raised in triggers/functions) carry readable messages.
  if (err?.code && ["23514", "42501", "P0002", "23505"].includes(err.code) && err.message) {
    if (err.code === "23505" && /duplicate key/.test(err.message)) return "This record already exists.";
    if (err.code === "42501" && /row-level security/.test(err.message)) return "You don't have permission to do that.";
    return err.message;
  }
  return "Something went wrong while saving. Please try again.";
}
