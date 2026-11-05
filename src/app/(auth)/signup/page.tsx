import { SignupForm } from "@/components/auth-forms";
import { safeNext } from "@/lib/server/auth";

export const metadata = { title: "Create account" };
export default async function SignupPage({ searchParams }: PageProps<"/signup">) {
  const sp = await searchParams;
  return <SignupForm next={safeNext(sp.next) ?? undefined} email={typeof sp.email === "string" ? sp.email : undefined} />;
}
