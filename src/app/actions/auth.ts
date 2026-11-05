"use server";
import { redirect } from "next/navigation";
import { z } from "zod";
import { signIn, signOut, signUp, getSessionUser, setActiveCompany, listMemberships, requestPasswordReset, updatePassword, startSessionFromLinkTokens, safeNext } from "@/lib/server/auth";
import { asUser } from "@/lib/server/db";
import { createDemoWorkspace } from "@/lib/server/demo";

export type FormState = { error?: string; message?: string } | undefined;

export async function loginAction(_: FormState, fd: FormData): Promise<FormState> {
  const email = String(fd.get("email") ?? "");
  const password = String(fd.get("password") ?? "");
  if (!email || !password) return { error: "Enter your email and password." };
  const err = await signIn(email, password);
  if (err) return { error: err };
  redirect(safeNext(fd.get("next")) ?? "/");
}

export async function signupAction(_: FormState, fd: FormData): Promise<FormState> {
  const parsed = z.object({
    fullName: z.string().trim().min(2, "Enter your name."),
    email: z.email("Enter a valid email address."),
    password: z.string().min(10, "Use a password of at least 10 characters."),
  }).safeParse({ fullName: fd.get("fullName"), email: fd.get("email"), password: fd.get("password") });
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const next = safeNext(fd.get("next"));
  const res = await signUp(parsed.data.email, parsed.data.password, parsed.data.fullName, next);
  if (res.error) return { error: res.error };
  if (res.needsEmailConfirmation) return { message: "Check your email to confirm your account, then sign in." };
  redirect(next ?? "/onboarding");
}

export async function logoutAction() {
  await signOut();
  redirect("/login");
}

export async function createCompanyAction(_: FormState, fd: FormData): Promise<FormState> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const name = String(fd.get("name") ?? "").trim();
  if (name.length < 2) return { error: "Enter your company name." };
  const companyId = await asUser(user.id, async (tx) => {
    const [{ id }] = await tx<{ id: string }[]>`select public.create_company(${name}) as id`;
    await tx`update company_members set full_name = ${String(fd.get("fullName") ?? "").trim() || user.name || null} where company_id = ${id} and user_id = ${user.id}`;
    return id;
  });
  await setActiveCompany(companyId);
  redirect("/catalogue");
}

export async function loadDemoAction() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const existing = (await listMemberships(user.id)).find((m) => m.isDemo);
  const companyId = existing?.companyId ?? (await createDemoWorkspace(user.id, user.name));
  await setActiveCompany(companyId);
  redirect("/");
}

export async function switchCompanyAction(fd: FormData) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const id = String(fd.get("companyId") ?? "");
  if ((await listMemberships(user.id)).some((m) => m.companyId === id)) await setActiveCompany(id);
  redirect("/");
}

export async function forgotPasswordAction(_: FormState, fd: FormData): Promise<FormState> {
  const err = await requestPasswordReset(String(fd.get("email") ?? ""));
  if (err) return { error: err };
  return { message: "If an account exists for this email, we've sent a link to reset your password. Check your inbox (and spam folder), then click the link in the email." };
}

export async function resetPasswordAction(_: FormState, fd: FormData): Promise<FormState> {
  if (!(await getSessionUser())) return { error: "Your reset link has expired. Request a new one." };
  const password = String(fd.get("password") ?? "");
  if (password !== String(fd.get("confirm") ?? "")) return { error: "The two passwords don't match." };
  const err = await updatePassword(password);
  if (err) return { error: err };
  redirect("/?password=updated");
}

export async function startRecoveryAction(accessToken: string, refreshToken: string): Promise<{ error?: string }> {
  const err = await startSessionFromLinkTokens(String(accessToken), String(refreshToken));
  return err ? { error: err } : {};
}
