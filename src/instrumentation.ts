// Runs once when the server starts. Logs whether the database settings work and
// that the app's login can act as a signed-in user, so problems show up in the
// hosting logs immediately instead of on a customer's first click.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || !process.env.DATABASE_URL) return;
  // Not during `next build`.
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  try {
    const { default: postgres } = await import("postgres");
    const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1, connect_timeout: 15 });
    const [r] = await sql.begin(async (tx) => {
      await tx`set local role authenticated`;
      return tx`select current_user as role, to_regclass('public.companies') is not null as ready`;
    });
    await sql.end();
    console.log(`[startup] Database connection OK (acting as ${r.role}, schema ${r.ready ? "ready" : "MISSING"}).`);
  } catch (e) {
    const m = (e as Error).message ?? String(e);
    console.error(`[startup] Database connection FAILED: ${m.replace(/postgres(ql)?:\/\/[^@\s]+@/g, "postgres://***@")}`);
  }
}
