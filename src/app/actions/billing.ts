"use server";
// Platform-owner actions: plans, prices, settings, each company's subscription and payments.
// Every write also passes the database's row-level security (platform owners only).
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getSessionUser } from "@/lib/server/auth";
import { isPlatformOwner } from "@/lib/server/billing";
import { asUser, dbErrorMessage } from "@/lib/server/db";

async function requireOwner() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (!(await isPlatformOwner(user.id))) redirect("/?error=admin-only");
  return user;
}

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const optInt = z.union([z.literal("").transform(() => null), z.coerce.number().int().min(1).max(1_000_000)]);
const money = z.union([z.literal("").transform(() => null), z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, "Prices must be numbers like 199 or 199.50.")]);
const currency = z.string().regex(/^[A-Z]{3}$/, "Currency must be a 3-letter code such as SAR.");
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const optDate = z.union([z.literal("").transform(() => null), date]);

function back(target: string, msg: string, error = false): never {
  const [path, hash] = target.split("#");
  redirect(`${path}${path.includes("?") ? "&" : "?"}${error ? "error" : "msg"}=${encodeURIComponent(msg)}${hash ? `#${hash}` : ""}`);
}

export async function saveSettingsAction(fd: FormData) {
  const user = await requireOwner();
  const p = z.object({
    trial: z.coerce.number().int().min(1).max(90), grace: z.coerce.number().int().min(0).max(30), contact: z.string().max(2000),
  }).safeParse({ trial: str(fd, "trial_days"), grace: str(fd, "grace_days"), contact: str(fd, "billing_contact") });
  if (!p.success) back("/platform", "Trial days must be 1–90 and grace days 0–30.", true);
  try {
    await asUser(user.id, (tx) => tx`
      update platform_settings set billing_enabled = ${fd.get("billing_enabled") === "on"}, trial_days = ${p.data.trial},
        grace_days = ${p.data.grace}, billing_contact = ${p.data.contact || null}, updated_at = now()`);
  } catch (e) { back("/platform", dbErrorMessage(e), true); }
  revalidatePath("/", "layout");
  back("/platform", "Settings saved.");
}

export async function savePlanAction(fd: FormData) {
  const user = await requireOwner();
  const p = z.object({
    code: z.string().min(1), name: z.string().min(1, "Plan name is required.").max(60), description: z.string().max(300),
    max_users: optInt, max_inq: optInt, max_ai: optInt, pm: money, py: money, currency,
  }).safeParse({
    code: str(fd, "code"), name: str(fd, "name"), description: str(fd, "description"),
    max_users: str(fd, "max_users"), max_inq: str(fd, "max_inquiries"), max_ai: str(fd, "max_ai_runs"),
    pm: str(fd, "price_monthly"), py: str(fd, "price_yearly"), currency: str(fd, "currency").toUpperCase(),
  });
  if (!p.success) back("/platform#plans", p.error.issues[0].message, true);
  const d = p.data;
  try {
    await asUser(user.id, (tx) => tx`
      update plans set name = ${d.name}, description = ${d.description || null}, max_users = ${d.max_users},
        max_inquiries_per_month = ${d.max_inq}, max_ai_runs_per_month = ${d.max_ai}, price_monthly = ${d.pm},
        price_yearly = ${d.py}, currency = ${d.currency}, is_public = ${fd.get("is_public") === "on"}
      where code = ${d.code}`);
  } catch (e) { back("/platform#plans", dbErrorMessage(e), true); }
  revalidatePath("/", "layout");
  back("/platform#plans", `Plan “${d.name}” saved.`);
}

const endOfDay = (d: string) => `${d}T23:59:59Z`;

export async function saveSubscriptionAction(fd: FormData) {
  const user = await requireOwner();
  const companyId = z.uuid().parse(fd.get("company_id"));
  const path = `/platform/companies/${companyId}`;
  const p = z.object({
    plan: z.string().min(1), status: z.enum(["trialing", "active", "cancelled", "complimentary"]),
    trial: optDate, paid: optDate, cycle: z.union([z.literal("").transform(() => null), z.enum(["monthly", "yearly"])]),
  }).safeParse({ plan: str(fd, "plan_code"), status: str(fd, "status"), trial: str(fd, "trial_ends_at"), paid: str(fd, "paid_until"), cycle: str(fd, "billing_cycle") });
  if (!p.success) back(path, "Check the plan, status and dates.", true);
  const d = p.data;
  if (d.status === "trialing" && !d.trial) back(path, "Set the trial end date for a trial.", true);
  if (d.status === "active" && !d.paid) back(path, "Set “Paid until” for an active subscription.", true);
  try {
    await asUser(user.id, (tx) => tx`
      update subscriptions set plan_code = ${d.plan}, status = ${d.status},
        trial_ends_at = ${d.trial ? endOfDay(d.trial) : null}, paid_until = ${d.paid ? endOfDay(d.paid) : null},
        billing_cycle = ${d.cycle}, updated_at = now(), updated_by = ${user.id}
      where company_id = ${companyId}`);
  } catch (e) { back(path, dbErrorMessage(e), true); }
  revalidatePath("/", "layout");
  back(path, "Subscription saved.");
}

export async function recordPaymentAction(fd: FormData) {
  const user = await requireOwner();
  const companyId = z.uuid().parse(fd.get("company_id"));
  const path = `/platform/companies/${companyId}`;
  const p = z.object({
    amount: z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, "Enter the amount received, e.g. 1500 or 1500.50.")
      .refine((v) => Number(v) > 0, "The amount must be more than zero."),
    currency, paid_on: date, method: z.enum(["bank_transfer", "card", "cash", "cheque", "other"]),
    reference: z.string().max(120), covers_to: optDate, note: z.string().max(500),
  }).safeParse({
    amount: str(fd, "amount"), currency: str(fd, "currency").toUpperCase(), paid_on: str(fd, "paid_on"), method: str(fd, "method"),
    reference: str(fd, "reference"), covers_to: str(fd, "covers_to"), note: str(fd, "note"),
  });
  if (!p.success) back(path, p.error.issues[0].message, true);
  const d = p.data;
  const extend = fd.get("extend") === "on";
  if (extend && !d.covers_to) back(path, "Enter “Covers until” to extend the subscription.", true);
  try {
    await asUser(user.id, async (tx) => {
      await tx`insert into payments (company_id, amount, currency, paid_on, method, reference, covers_to, note, recorded_by)
               values (${companyId}, ${d.amount}, ${d.currency}, ${d.paid_on}, ${d.method}, ${d.reference || null},
                       ${d.covers_to}, ${d.note || null}, ${user.id})`;
      if (extend && d.covers_to) {
        const plan = str(fd, "plan_code");
        await tx`update subscriptions set status = 'active', paid_until = ${endOfDay(d.covers_to)},
                   plan_code = coalesce(${plan || null}, plan_code), updated_at = now(), updated_by = ${user.id}
                 where company_id = ${companyId}`;
      }
    });
  } catch (e) { back(path, dbErrorMessage(e), true); }
  revalidatePath("/", "layout");
  back(path, extend ? `Payment recorded. Subscription active until ${d.covers_to}.` : "Payment recorded.");
}

export async function deletePaymentAction(fd: FormData) {
  const user = await requireOwner();
  const companyId = z.uuid().parse(fd.get("company_id"));
  const id = z.uuid().parse(fd.get("id"));
  const path = `/platform/companies/${companyId}`;
  try {
    await asUser(user.id, (tx) => tx`delete from payments where id = ${id} and company_id = ${companyId}`);
  } catch (e) { back(path, dbErrorMessage(e), true); }
  back(path, "Payment entry deleted. The subscription dates were not changed.");
}
