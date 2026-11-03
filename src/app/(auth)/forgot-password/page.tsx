import { ForgotPasswordForm } from "@/components/auth-forms";
import { Alert } from "@/components/ui";

export const metadata = { title: "Reset password" };
export default async function ForgotPasswordPage({ searchParams }: PageProps<"/forgot-password">) {
  const sp = await searchParams;
  return (
    <div className="space-y-4">
      {typeof sp.error === "string" && <Alert tone="error">{sp.error}</Alert>}
      <ForgotPasswordForm />
    </div>
  );
}
