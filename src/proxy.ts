import { NextResponse, type NextRequest } from "next/server";

// If Supabase sends an emailed link to the site's home page (which happens when the
// exact return address isn't in its allowed list), finish the link via /auth/callback
// instead of losing the one-time code on the way to the sign-in page.
export function proxy(request: NextRequest) {
  const url = request.nextUrl;
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  if (!code && !tokenHash) return NextResponse.next();
  const target = new URL("/auth/callback", request.url);
  url.searchParams.forEach((v, k) => target.searchParams.set(k, v));
  // Password-reset links carry type=recovery; for PKCE codes we can't tell, so offer the reset page,
  // which simply lets a signed-in person choose a new password.
  const isConfirmation = url.searchParams.get("type") === "signup" || url.searchParams.has("confirmed");
  target.searchParams.set("next", isConfirmation ? "/" : "/reset-password");
  return NextResponse.redirect(target);
}

export const config = { matcher: ["/", "/login"] };
