import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/server/auth";
import { LoginForm } from "@/components/auth-forms";

export const metadata = { title: "Sign in" };
export default async function LoginPage() {
  if (await getSessionUser()) redirect("/");
  return <LoginForm />;
}
