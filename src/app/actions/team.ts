"use server";
import { createHash, randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getSessionUser, requireCtx, setActiveCompany, siteOrigin } from "@/lib/server/auth";
import { asUser, dbErrorMessage } from "@/lib/server/db";

export type InviteState = { error?: string; link?: string; email?: string; message?: string } | undefined;

const newToken = () => {
  const token = randomBytes(24).toString("base64url");
  return { token, hash: createHash("sha256").update(token).digest("hex") };
};
export async function hashInviteToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

async function inviteLink(token: string) {
  const origin = (await siteOrigin()) ?? "";
  return `${origin}/invite/${token}`;
}

export async function createInvitationAction(_: InviteState, fd: FormData): Promise<InviteState> {
  const ctx = await requireCtx({ admin: true });
  if (ctx.company.isDemo) return { error: "Invitations are turned off in the demo workspace. Use your company workspace." };
  const p = z.object({ email: z.email("Enter a valid email address."), role: z.enum(["admin", "salesperson"]) })
    .safeParse({ email: String(fd.get("email") ?? "").trim().toLowerCase(), role: fd.get("role") });
  if (!p.success) return { error: p.error.issues[0].message };
  const { token, hash } = newToken();
  try {
    await asUser(ctx.user.id, (tx) => tx`
      insert into invitations (company_id, email, role, token_hash, invited_by)
      values (${ctx.company.companyId}, ${p.data.email}, ${p.data.role}, ${hash}, ${ctx.user.id})`);
  } catch (e) {
    const err = e as { code?: string };
    if (err.code === "23505") return { error: `${p.data.email} already has an open invitation. Use “New link” in the list below to get a fresh link.` };
    return { error: dbErrorMessage(e) };
  }
  revalidatePath("/team");
  return { link: await inviteLink(token), email: p.data.email };
}

/** Replaces an open invitation's link (the old link stops working) and extends it by 7 days. */
export async function renewInvitationAction(invitationId: string): Promise<InviteState> {
  const ctx = await requireCtx({ admin: true });
  const { token, hash } = newToken();
  try {
    const rows = await asUser(ctx.user.id, (tx) => tx<{ email: string }[]>`
      update invitations set token_hash = ${hash}, expires_at = now() + interval '7 days'
       where id = ${invitationId} and company_id = ${ctx.company.companyId} and accepted_at is null and revoked_at is null
      returning email`);
    if (!rows.length) return { error: "This invitation is no longer open." };
    revalidatePath("/team");
    return { link: await inviteLink(token), email: rows[0].email };
  } catch (e) { return { error: dbErrorMessage(e) }; }
}

export async function revokeInvitationAction(invitationId: string): Promise<InviteState> {
  const ctx = await requireCtx({ admin: true });
  try {
    await asUser(ctx.user.id, (tx) => tx`
      update invitations set revoked_at = now()
       where id = ${invitationId} and company_id = ${ctx.company.companyId} and accepted_at is null and revoked_at is null`);
  } catch (e) { return { error: dbErrorMessage(e) }; }
  revalidatePath("/team");
  return { message: "Invitation cancelled. Its link no longer works." };
}

export async function acceptInvitationAction(_: InviteState, fd: FormData): Promise<InviteState> {
  const user = await getSessionUser();
  const token = String(fd.get("token") ?? "");
  if (!user) redirect(`/login?next=${encodeURIComponent(`/invite/${token}`)}`);
  let companyId: string;
  try {
    const hash = await hashInviteToken(token);
    companyId = await asUser(user.id, async (tx) => {
      const [r] = await tx<{ id: string }[]>`select public.accept_invitation(${hash}, ${user.name}) as id`;
      return r.id;
    });
  } catch (e) { return { error: dbErrorMessage(e) }; }
  await setActiveCompany(companyId);
  redirect("/?joined=1");
}
