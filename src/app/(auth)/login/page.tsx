import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/server/auth";
import { LoginForm } from "@/components/auth-forms";
import { Alert } from "@/components/ui";

export const metadata = { title: "Sign in" };
export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  if (await getSessionUser()) redirect("/");
  const sp = await searchParams;
  return (
    <div className="space-y-4">
      {sp.confirmed && <Alert tone="success">Your email is confirmed. Sign in to continue.</Alert>}
      {sp.error_description && <Alert tone="error">{String(sp.error_description)}</Alert>}
      {typeof sp.error === "string" && !sp.error_description && <Alert tone="error">{sp.error}</Alert>}
      <LoginForm />
    </div>
  );
}
