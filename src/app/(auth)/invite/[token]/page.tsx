import Link from "next/link";
import { createHash } from "node:crypto";
import { getSessionUser, listMemberships } from "@/lib/server/auth";
import { asAnon } from "@/lib/server/db";
import { logoutAction } from "@/app/actions/auth";
import { AcceptInviteForm } from "@/components/accept-invite";
import { Alert, ButtonLink, fmtDate } from "@/components/ui";

export const metadata = { title: "Team invitation" };

type Preview = { company_name: string; email: string; role: "admin" | "salesperson"; status: string; expires_at: Date };

export default async function InvitePage({ params }: PageProps<"/invite/[token]">) {
  const { token } = await params;
  const valid = /^[A-Za-z0-9_-]{20,64}$/.test(token);
  const hash = createHash("sha256").update(token).digest("hex");
  const [inv] = valid ? await asAnon((tx) => tx<Preview[]>`select * from public.invitation_preview(${hash})`) : [];
  if (!inv) return <Alert tone="error" title="Invitation not found">This invitation link is not valid. Check you copied the whole link, or ask the admin for a new one.</Alert>;

  const roleLabel = inv.role === "admin" ? "an Admin" : "a Salesperson";
  const back = `/invite/${token}`;
  if (inv.status !== "valid") {
    const why = { accepted: "This invitation has already been used.", revoked: "This invitation was cancelled by the company admin.",
      expired: `This invitation expired on ${fmtDate(inv.expires_at)}.` }[inv.status] ?? "This invitation can't be used.";
    return (
      <div className="space-y-4">
        <Alert tone="warning" title={`Invitation to ${inv.company_name}`}>{why} Ask the admin for a new link if you still need access.</Alert>
        <Link className="font-medium text-brand-700 underline" href="/login">Go to sign in</Link>
      </div>
    );
  }

  const user = await getSessionUser();
  const header = (
    <div>
      <h1 className="text-lg font-semibold">Join {inv.company_name}</h1>
      <p className="mt-1 text-sm text-muted">You&apos;ve been invited to join <strong dir="auto">{inv.company_name}</strong> on InquiryDesk as {roleLabel}. This invitation is for <strong>{inv.email}</strong> and expires on {fmtDate(inv.expires_at)}.</p>
    </div>
  );
  if (!user) {
    return (
      <div className="space-y-4">
        {header}
        <ButtonLink className="w-full" href={`/signup?next=${encodeURIComponent(back)}&email=${encodeURIComponent(inv.email)}`}>Create an account with {inv.email}</ButtonLink>
        <ButtonLink variant="secondary" className="w-full" href={`/login?next=${encodeURIComponent(back)}&email=${encodeURIComponent(inv.email)}`}>I already have an account — sign in</ButtonLink>
      </div>
    );
  }
  if (user.email.toLowerCase() !== inv.email) {
    return (
      <div className="space-y-4">
        {header}
        <Alert tone="warning">You&apos;re signed in as <strong>{user.email}</strong>. Sign out, then sign in or create an account with <strong>{inv.email}</strong>.</Alert>
        <form action={logoutAction}><button type="submit" className="w-full rounded-md bg-brand-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-brand-700">Sign out</button></form>
      </div>
    );
  }
  const already = (await listMemberships(user.id)).some((m) => m.companyName === inv.company_name && !m.isDemo);
  return (
    <div className="space-y-4">
      {header}
      {already && <Alert tone="info">You may already be a member of a workspace with this name. Joining is still safe.</Alert>}
      <AcceptInviteForm token={token} companyName={inv.company_name} />
    </div>
  );
}
