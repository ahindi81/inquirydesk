import Link from "next/link";
import { getSessionUser } from "@/lib/server/auth";
import { ResetPasswordForm } from "@/components/auth-forms";
import { RecoveryLanding } from "@/components/recovery-landing";

export const metadata = { title: "Choose a new password" };
export default async function ResetPasswordPage() {
  const user = await getSessionUser();
  if (!user) return <RecoveryLanding />;
  return (
    <div className="space-y-4">
      <ResetPasswordForm email={user.email} />
      <p className="text-center text-sm text-muted"><Link className="underline" href="/">Skip and go to InquiryDesk</Link></p>
    </div>
  );
}
