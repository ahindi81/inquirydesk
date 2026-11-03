import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { createHmac, randomBytes, scrypt as _scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
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
  if (!error) return null;
  if (error.code === "email_not_confirmed" || /not confirmed/i.test(error.message)) {
    // Send a fresh confirmation link so the person isn't stuck.
    const origin = await siteOrigin();
    await supabase.auth.resend({ type: "signup", email, options: { emailRedirectTo: origin ? `${origin}/login?confirmed=1` : undefined } });
    return "This email address isn't confirmed yet. We've sent a new confirmation link: open it, then sign in.";
  }
  if (/rate limit|too many/i.test(error.message)) return "Too many attempts. Please wait a few minutes and try again.";
  return "Email or password is incorrect.";
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
  const origin = await siteOrigin();
  const { data, error } = await supabase.auth.signUp({ email, password, options: {
    data: { full_name: fullName },
    emailRedirectTo: origin ? `${origin}/login?confirmed=1` : undefined,
  } });
  if (error) return { error: error.message };
  return { error: null, needsEmailConfirmation: !data.session };
}

/**
 * Address that emailed links should return to: SITE_URL when set, otherwise the
 * address being used right now (so the installed and online versions each work).
 * Supabase only honours it if it is in the project's allowed redirect URLs;
 * otherwise it falls back to the project's Site URL.
 */
async function siteOrigin(): Promise<string | undefined> {
  const h = await headers();
  const host = h.get("host");
  if (host && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return `http://${host}`;
  return process.env.SITE_URL ?? (host ? `${h.get("x-forwarded-proto") ?? "https"}://${host}` : undefined);
}

/** Sends a password-reset email. Always reports success so it never reveals whether an account exists. */
export async function requestPasswordReset(email: string): Promise<string | null> {
  email = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "Enter a valid email address.";
  if (driver() === "local") return "Password reset by email is not available in local development mode.";
  // Reset links use the "implicit" flow: the emailed link carries its own one-time
  // sign-in, so it works in any browser or device, not only the one that asked for it.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("Supabase URL / publishable key are not configured.");
  const supabase = createClient(url, key, { auth: { flowType: "implicit", persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const origin = await siteOrigin();
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: origin ? `${origin}/reset-password` : undefined,
  });
  if (error && /rate limit|too many/i.test(error.message))
    return "Too many emails were requested. Please wait a few minutes and try again.";
  if (error) console.error("[auth] reset email failed:", error.message);
  return null;
}

/** Completes an emailed link (password reset or email confirmation) and starts a session. */
export async function completeEmailLink(params: { code?: string | null; tokenHash?: string | null; type?: string | null }):
  Promise<string | null> {
  const supabase = await supabaseClient();
  if (params.code) {
    const { error } = await supabase.auth.exchangeCodeForSession(params.code);
    if (error) return "This link has expired or was opened in a different browser. Request a new one and open it in the same browser.";
    return null;
  }
  if (params.tokenHash && params.type) {
    const { error } = await supabase.auth.verifyOtp({ token_hash: params.tokenHash, type: params.type as "recovery" | "email" | "signup" });
    if (error) return "This link has expired or was already used. Request a new one.";
    return null;
  }
  return "This link is incomplete. Request a new one.";
}

/** Starts a session from the tokens a reset link delivers (checked by Supabase before use). */
export async function startSessionFromLinkTokens(accessToken: string, refreshToken: string): Promise<string | null> {
  if (driver() === "local") return "Not available in local development mode.";
  if (!accessToken || !refreshToken || accessToken.length > 4096 || refreshToken.length > 512) return "This link is incomplete. Request a new one.";
  const supabase = await supabaseClient();
  const { data, error } = await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
  if (error || !data.session) return "This link has expired or was already used. Request a new one.";
  return null;
}

export async function updatePassword(password: string): Promise<string | null> {
  if (password.length < 10) return "Use a password of at least 10 characters.";
  if (driver() === "local") return "Not available in local development mode.";
  const supabase = await supabaseClient();
  const { error } = await supabase.auth.updateUser({ password });
  if (!error) return null;
  if (/same|different from the old/i.test(error.message)) return "Choose a password different from your old one.";
  if (/session|not authenticated|jwt/i.test(error.message)) return "Your reset link has expired. Request a new one.";
  return error.message;
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
