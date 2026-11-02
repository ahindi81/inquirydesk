// Checks that the database settings in .env.local work. Used by the start script.
import { readFileSync } from "node:fs";
import postgres from "postgres";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8").split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);
const sql = postgres(env.DATABASE_URL, { prepare: false, connect_timeout: 15, max: 1 });
try {
  const [r] = await sql`select to_regclass('public.companies') is not null as ready`;
  if (!r.ready) { console.log("Database is reachable but not set up."); await sql.end(); process.exit(1); }
  console.log("Database connection OK.");
  await sql.end();
  process.exit(0);
} catch (e) {
  const m = String(e.message || e);
  if (/password authentication failed|SASL/i.test(m)) console.log("WRONG_PASSWORD");
  else if (/relation .* does not exist/i.test(m)) console.log("Database is reachable but not set up.");
  else console.log("Could not reach the database: " + m);
  process.exit(1);
}
