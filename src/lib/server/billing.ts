import "server-only";
import { asUser } from "./db";
import type { Ctx } from "./auth";

export type Subscription = {
  billing_enabled: boolean;
  state: "ok" | "trial_ended" | "expired" | "cancelled";
  status: "trialing" | "active" | "cancelled" | "complimentary";
  plan_code: string;
  plan_name: string;
  max_users: number | null;
  max_inquiries_per_month: number | null;
  max_ai_runs_per_month: number | null;
  trial_ends_at: Date | null;
  paid_until: Date | null;
  billing_cycle: "monthly" | "yearly" | null;
  grace_days: number;
  users: number;
  open_invitations: number;
  inquiries_this_month: number;
  ai_runs_this_month: number;
  billing_contact: string | null;
};

export type Plan = {
  code: string; name: string; description: string | null;
  max_users: number | null; max_inquiries_per_month: number | null; max_ai_runs_per_month: number | null;
  price_monthly: string | null; price_yearly: string | null; currency: string;
  is_trial: boolean; is_public: boolean; sort: number;
};

export async function getSubscription(ctx: Ctx): Promise<Subscription | null> {
  const [s] = await asUser(ctx.user.id, (tx) => tx<Subscription[]>`select * from public.company_subscription(${ctx.company.companyId})`);
  return s ?? null;
}

export async function listPlans(userId: string): Promise<Plan[]> {
  return asUser(userId, (tx) => tx<Plan[]>`select * from plans order by sort, code`);
}

export async function isPlatformOwner(userId: string): Promise<boolean> {
  const rows = await asUser(userId, (tx) => tx`select 1 from platform_admins where user_id = ${userId}`);
  return rows.length > 0;
}

const DAY = 86_400_000;
export const daysLeft = (d: Date | null) => (d ? Math.ceil((d.getTime() - Date.now()) / DAY) : null);

/** Banner shown at the top of every page when something needs attention. */
export function subscriptionNotice(s: Subscription | null): { tone: "warning" | "error"; text: string } | null {
  if (!s || !s.billing_enabled) return null;
  const blocked = "You can still view, edit and export your work, but you can't add inquiries, run processing or add team members.";
  if (s.state === "trial_ended") return { tone: "error", text: `Your free trial has ended. ${blocked}` };
  if (s.state === "expired") return { tone: "error", text: `Your subscription has expired. ${blocked}` };
  if (s.state === "cancelled") return { tone: "error", text: `This subscription is cancelled. ${blocked}` };
  if (s.status === "trialing") {
    const d = daysLeft(s.trial_ends_at);
    if (d !== null && d <= 5) return { tone: "warning", text: `Free trial: ${d <= 1 ? "ends today" : `${d} days left`}.` };
  }
  if (s.status === "active" && s.paid_until && s.paid_until.getTime() < Date.now())
    return { tone: "warning", text: "Your subscription period has ended. Renew within the grace period to keep adding work." };
  if (s.status === "active") {
    const d = daysLeft(s.paid_until);
    if (d !== null && d <= 5) return { tone: "warning", text: `Your paid period ends in ${d} day${d === 1 ? "" : "s"}. Renew to avoid interruption (see Subscription).` };
  }
  return null;
}
