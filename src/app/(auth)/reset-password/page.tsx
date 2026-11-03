import Link from "next/link";
import { getSessionUser } from "@/lib/server/auth";
import { ResetPasswordForm } from "@/components/auth-forms";
import { Alert } from "@/components/ui";

export const metadata = { title: "Choose a new password" };
export default async function ResetPasswordPage() {
  const user = await getSessionUser();
  if (!user) {
    return (
      <div className="space-y-4">
        <Alert tone="error">Your reset link has expired or was opened in a different browser.</Alert>
        <Link className="font-medium text-brand-700 underline" href="/forgot-password">Request a new reset link</Link>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <ResetPasswordForm email={user.email} />
      <p className="text-center text-sm text-muted"><Link className="underline" href="/">Skip and go to InquiryDesk</Link></p>
    </div>
  );
}
