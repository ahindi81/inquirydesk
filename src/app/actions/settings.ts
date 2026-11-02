"use server";
import { revalidatePath } from "next/cache";
import { requireCtx } from "@/lib/server/auth";
import { asUser, dbErrorMessage } from "@/lib/server/db";

export type SettingsState = { error?: string; message?: string } | undefined;

export async function saveCompanyAction(_: SettingsState, fd: FormData): Promise<SettingsState> {
  const ctx = await requireCtx({ admin: true });
  const s = (k: string) => String(fd.get(k) ?? "").trim() || null;
  const name = s("name");
  if (!name) return { error: "Company name is required." };
  const cur = (s("default_currency") ?? "").toUpperCase();
  if (!/^[A-Z]{3}$/.test(cur)) return { error: "Default currency must be a 3-letter code such as SAR." };
  const tax = Number(s("default_tax_rate") ?? "");
  if (!(tax >= 0 && tax <= 100)) return { error: "Default tax rate must be between 0 and 100." };
  const prefix = s("quote_prefix") ?? "Q";
  if (!/^[A-Za-z0-9-]{1,12}$/.test(prefix)) return { error: "Quotation prefix may use letters, digits and dashes (max 12)." };
  try {
    await asUser(ctx.user.id, (tx) => tx`update companies set name = ${name}, legal_name = ${s("legal_name")}, address = ${s("address")},
      phone = ${s("phone")}, email = ${s("email")}, website = ${s("website")}, tax_number = ${s("tax_number")},
      default_currency = ${cur}, default_tax_rate = ${String(tax)}, quote_prefix = ${prefix} where id = ${ctx.company.companyId}`);
  } catch (e) { return { error: dbErrorMessage(e) }; }
  revalidatePath("/", "layout");
  return { message: "Company settings saved. New quotations will use them." };
}

export async function updateMemberAction(fd: FormData) {
  const ctx = await requireCtx({ admin: true });
  const userId = String(fd.get("userId"));
  const op = String(fd.get("op"));
  await asUser(ctx.user.id, async (tx) => {
    const [{ admins }] = await tx<{ admins: number }[]>`select count(*)::int admins from company_members where company_id = ${ctx.company.companyId} and role = 'admin'`;
    const [target] = await tx<{ role: string }[]>`select role from company_members where company_id = ${ctx.company.companyId} and user_id = ${userId}`;
    if (!target) return;
    const removingLastAdmin = target.role === "admin" && admins <= 1 && (op === "remove" || op === "salesperson");
    if (removingLastAdmin) return; // a workspace always keeps at least one admin
    if (op === "remove") await tx`delete from company_members where company_id = ${ctx.company.companyId} and user_id = ${userId}`;
    else if (op === "admin" || op === "salesperson") await tx`update company_members set role = ${op} where company_id = ${ctx.company.companyId} and user_id = ${userId}`;
    else if (op === "name") await tx`update company_members set full_name = ${String(fd.get("full_name") ?? "").trim() || null} where company_id = ${ctx.company.companyId} and user_id = ${userId}`;
  });
  revalidatePath("/team");
}
