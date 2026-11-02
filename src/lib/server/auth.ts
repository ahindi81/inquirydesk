import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createHmac, randomBytes, scrypt as _scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { createServerClient } from "@supabase/ssr";
import { sql, asUser } from "./db";

const scrypt = promisify(_scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export type SessionUser = { id: string; email: string; name: string | null };
export type Membership = { companyId: string; companyName: string; role: "admin" | "salesperson"; isDemo: boolean };

// ---------------------------------------------------------------- driver choice
// Production: Supabase Auth. "local" exists only so the app can be developed and
// tested without a Supabase project; it refuses to run in production.
function driver(): "supabase" | "local" {
  const d = process.env.AUTH_DRIVER ?? "supabase";
  if (d === "local") {
    if (process.env.NODE_ENV === "production" && process.env.ALLOW_LOCAL_AUTH_IN_PRODUCTION !== "yes-i-understand") {
      throw new Error("AUTH_DRIVER=local is for development only and is disabled in production.");
    }
    return "local";
  }
  return "supabase";
}

// ---------------------------------------------------------------- supabase driver
export async function supabaseClient() {
  const store = await cookies();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("Supabase URL / publishable key are not configured.");
  return createServerClient(url, key, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try { list.forEach(({ name, value, options }) => store.set(name, value, options)); } catch { /* read-only in RSC */ }
      },
    },
  });
}

// ---------------------------------------------------------------- local driver
const LOCAL_COOKIE = "id_local_session";
function sessionSecret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error("SESSION_SECRET must be set (32+ characters) for local auth.");
  return s;
}
function sign(payload: string) {
  return createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
}
async function hashPassword(pw: string) {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}
async function verifyPassword(pw: string, stored: string) {
  const [, salt, key] = stored.split("$");
  const got = await scrypt(pw, Buffer.from(salt, "base64"), 64);
  const want = Buffer.from(key, "base64");
  return got.length === want.length && timingSafeEqual(got, want);
}
async function setLocalSession(userId: string) {
  const exp = Date.now() + 1000 * 60 * 60 * 12;
  const payload = `${userId}.${exp}`;
  (await cookies()).set(LOCAL_COOKIE, `${payload}.${sign(payload)}`, {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 12,
  });
}

// ---------------------------------------------------------------- public API
export async function getSessionUser(): Promise<SessionUser | null> {
  if (driver() === "local") {
    const raw = (await cookies()).get(LOCAL_COOKIE)?.value;
    if (!raw) return null;
    const [id, exp, sig] = raw.split(".");
    if (!id || !exp || !sig) return null;
    const expected = Buffer.from(sign(`${id}.${exp}`));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    if (Number(exp) < Date.now()) return null;
    const [u] = await sql<SessionUser[]>`select id, email, full_name as name from local_auth.users where id = ${id}`;
    return u ?? null;
  }
  const supabase = await supabaseClient();
  const { data, error } = await supabase.auth.getClaims(); // verifies the JWT signature
  if (error || !data?.claims?.sub) return null;
  const meta = (data.claims.user_metadata ?? {}) as { full_name?: string };
  return { id: data.claims.sub as string, email: (data.claims.email as string) ?? "", name: meta.full_name ?? null };
}

export async function signIn(email: string, password: string): Promise<string | null> {
  email = email.trim().toLowerCase();
  if (driver() === "local") {
    const [u] = await sql<{ id: string; password_hash: string }[]>`
      select id, password_hash from local_auth.users where email = ${email}`;
    if (!u || !(await verifyPassword(password, u.password_hash))) return "Email or password is incorrect.";
    await setLocalSession(u.id);
    return null;
  }
  const supabase = await supabaseClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  return error ? "Email or password is incorrect." : null;
}

export async function signUp(email: string, password: string, fullName: string):
  Promise<{ error: string | null; needsEmailConfirmation?: boolean }> {
  email = email.trim().toLowerCase();
  if (password.length < 10) return { error: "Use a password of at least 10 characters." };
  if (driver() === "local") {
    const [exists] = await sql`select 1 from local_auth.users where email = ${email}`;
    if (exists) return { error: "An account with this email already exists. Sign in instead." };
    const [u] = await sql<{ id: string }[]>`
      insert into local_auth.users (email, password_hash, full_name)
      values (${email}, ${await hashPassword(password)}, ${fullName}) returning id`;
    await setLocalSession(u.id);
    return { error: null };
  }
  const supabase = await supabaseClient();
  const { data, error } = await supabase.auth.signUp({ email, password, options: { data: { full_name: fullName } } });
  if (error) return { error: error.message };
  return { error: null, needsEmailConfirmation: !data.session };
}

export async function signOut() {
  if (driver() === "local") { (await cookies()).delete(LOCAL_COOKIE); return; }
  const supabase = await supabaseClient();
  await supabase.auth.signOut();
}

// ---------------------------------------------------------------- workspace context
const ACTIVE_COMPANY_COOKIE = "id_company";

export async function listMemberships(userId: string): Promise<Membership[]> {
  return asUser(userId, (tx) => tx<Membership[]>`
    select c.id as "companyId", c.name as "companyName", m.role, c.is_demo as "isDemo"
      from company_members m join companies c on c.id = m.company_id
     where m.user_id = ${userId}
     order by c.is_demo, c.created_at`);
}

export type Ctx = { user: SessionUser; company: Membership; memberships: Membership[] };

/** For pages and actions: the signed-in user and their active company. Redirects if missing. */
export async function requireCtx(opts: { admin?: boolean } = {}): Promise<Ctx> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const memberships = await listMemberships(user.id);
  if (memberships.length === 0) redirect("/onboarding");
  const wanted = (await cookies()).get(ACTIVE_COMPANY_COOKIE)?.value;
  const company = memberships.find((m) => m.companyId === wanted) ?? memberships.find((m) => !m.isDemo) ?? memberships[0];
  if (opts.admin && company.role !== "admin") redirect("/?error=admin-only");
  return { user, company, memberships };
}

export async function setActiveCompany(companyId: string) {
  (await cookies()).set(ACTIVE_COMPANY_COOKIE, companyId, { httpOnly: true, sameSite: "lax", path: "/" });
}
