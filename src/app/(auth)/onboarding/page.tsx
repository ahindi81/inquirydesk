import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUser, listMemberships } from "@/lib/server/auth";
import { CompanyForm } from "@/components/auth-forms";
import { loadDemoAction, logoutAction } from "@/app/actions/auth";
import { Button } from "@/components/ui";

export const metadata = { title: "Set up your workspace" };
export default async function OnboardingPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const memberships = await listMemberships(user.id);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Set up your company workspace</h1>
        <p className="mt-1 text-sm text-muted">Your inquiries, catalogue and quotations are private to your company.</p>
      </div>
      <CompanyForm />
      <div className="border-t border-line pt-5">
        <p className="text-sm font-medium">Just exploring?</p>
        <p className="mt-1 text-sm text-muted">Open a separate demo workspace with a fictional catalogue and sample inquiry. Demo processing uses a rule-based reader, not AI, and is kept apart from real records.</p>
        <form action={loadDemoAction} className="mt-3"><Button variant="secondary" type="submit">Open demo workspace</Button></form>
      </div>
      <div className="flex justify-between text-sm text-muted">
        {memberships.length > 0 ? <Link className="underline" href="/">Back to my workspace</Link> : <span />}
        <form action={logoutAction}><button className="underline" type="submit">Sign out</button></form>
      </div>
    </div>
  );
}
