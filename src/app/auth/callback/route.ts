import { NextResponse } from "next/server";
import { completeEmailLink } from "@/lib/server/auth";

// Landing point for links in Supabase emails (password reset, email confirmation).
// Exchanges the one-time code for a session, then continues to a page on this site.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const next = url.searchParams.get("next") ?? "/";
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/";
  const base = process.env.SITE_URL && !/^(localhost|127\.0\.0\.1)/.test(url.host) ? process.env.SITE_URL : url.origin;
  const err = await completeEmailLink({
    code: url.searchParams.get("code"),
    tokenHash: url.searchParams.get("token_hash"),
    type: url.searchParams.get("type"),
  });
  if (err) {
    const target = safeNext === "/reset-password" ? "/forgot-password" : "/login";
    return NextResponse.redirect(new URL(`${target}?error=${encodeURIComponent(err)}`, base));
  }
  return NextResponse.redirect(new URL(safeNext, base));
}
