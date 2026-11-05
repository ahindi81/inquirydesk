import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { requireCtx } from "@/lib/server/auth";
import { asUser } from "@/lib/server/db";
import { isPlatformOwner, listPlans } from "@/lib/server/billing";
import { deletePaymentAction, recordPaymentAction, saveSubscriptionAction } from "@/app/actions/billing";
import { StateBadge } from "@/components/billing";
import { Alert, Button, Card, Field, Input, PageHeader, Select, Table, fmtDate, fmtMoney, td, th } from "@/components/ui";

export const metadata = { title: "Company subscription" };

type Sub = { company_name: string; admin_email: string | null; state: string; status: string; plan_code: string;
  trial_ends_at: Date | null; paid_until: Date | null; users: number; inquiries_this_month: number; ai_runs_this_month: number };
const ymd = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "");
const METHODS = [["bank_transfer", "Bank transfer"], ["card", "Card"], ["cash", "Cash"], ["cheque", "Cheque"], ["other", "Other"]] as const;

export default async function CompanySubscriptionPage({ params, searchParams }: PageProps<"/platform/companies/[id]">) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  if (!z.uuid().safeParse(id).success) notFound();
  const { user } = await requireCtx();
  if (!(await isPlatformOwner(user.id))) redirect("/?error=admin-only");
  const { c, sub, payments } = await asUser(user.id, async (tx) => {
    const [c] = await tx<Sub[]>`select * from public.platform_companies() where company_id = ${id}`;
    const [sub] = await tx<{ billing_cycle: string | null }[]>`select billing_cycle from subscriptions where company_id = ${id}`;
    const payments = await tx<{ id: string; amount: string; currency: string; paid_on: string; method: string; reference: string | null; covers_to: string | null; note: string | null }[]>`
      select id, amount::text, currency, paid_on::text, method, reference, covers_to::text, note from payments where company_id = ${id} order by paid_on desc, created_at desc`;
    return { c, sub, payments };
  });
  if (!c) notFound();
  const plans = await listPlans(user.id);
  const plan = plans.find((p) => p.code === c.plan_code);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="space-y-5">
      <PageHeader title={c.company_name} subtitle={<>Admin: {c.admin_email ?? "—"} · <Link className="underline" href="/platform">All companies</Link></>} />
      {sp.msg && <Alert tone="success">{String(sp.msg)}</Alert>}
      {sp.error && <Alert tone="error">{String(sp.error)}</Alert>}
      <p className="flex flex-wrap items-center gap-3 text-sm">
        <StateBadge state={c.state} status={c.status} />
        <span>{c.users} user{c.users === 1 ? "" : "s"} · {c.inquiries_this_month} inquiries and {c.ai_runs_this_month} AI runs this month</span>
      </p>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Subscription">
          <form action={saveSubscriptionAction} className="space-y-3">
            <input type="hidden" name="company_id" value={id} />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Plan" htmlFor="plan_code"><Select id="plan_code" name="plan_code" defaultValue={c.plan_code}>
                {plans.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</Select></Field>
              <Field label="Status" htmlFor="status"><Select id="status" name="status" defaultValue={c.status}>
                <option value="trialing">Free trial</option><option value="active">Active (paid)</option>
                <option value="complimentary">Complimentary (free, no end date)</option><option value="cancelled">Cancelled</option></Select></Field>
              <Field label="Trial ends" htmlFor="trial_ends_at"><Input id="trial_ends_at" name="trial_ends_at" type="date" defaultValue={ymd(c.trial_ends_at)} /></Field>
              <Field label="Paid until" htmlFor="paid_until"><Input id="paid_until" name="paid_until" type="date" defaultValue={ymd(c.paid_until)} /></Field>
              <Field label="Billing cycle" htmlFor="billing_cycle"><Select id="billing_cycle" name="billing_cycle" defaultValue={sub?.billing_cycle ?? ""}>
                <option value="">—</option><option value="monthly">Monthly</option><option value="yearly">Yearly</option></Select></Field>
            </div>
            <Button type="submit">Save subscription</Button>
          </form>
        </Card>

        <Card title="Record a payment you received">
          <form action={recordPaymentAction} className="space-y-3">
            <input type="hidden" name="company_id" value={id} />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Amount received" htmlFor="amount"><Input id="amount" name="amount" inputMode="decimal" required placeholder="e.g. 1500.00" /></Field>
              <Field label="Currency" htmlFor="currency"><Input id="currency" name="currency" defaultValue={plan?.currency ?? "SAR"} maxLength={3} required /></Field>
              <Field label="Received on" htmlFor="paid_on"><Input id="paid_on" name="paid_on" type="date" defaultValue={today} required /></Field>
              <Field label="Method" htmlFor="method"><Select id="method" name="method" defaultValue="bank_transfer">
                {METHODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
              <Field label="Reference (transfer no., invoice no.)" htmlFor="reference"><Input id="reference" name="reference" /></Field>
              <Field label="Covers until" htmlFor="covers_to"><Input id="covers_to" name="covers_to" type="date" /></Field>
              <Field label="Plan paid for" htmlFor="pay_plan"><Select id="pay_plan" name="plan_code" defaultValue={c.plan_code}>
                {plans.filter((p) => !p.is_trial).map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</Select></Field>
              <Field label="Note" htmlFor="note"><Input id="note" name="note" /></Field>
            </div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="extend" defaultChecked /> Make the subscription active on this plan until “Covers until”</label>
            <Button type="submit">Record payment</Button>
          </form>
        </Card>
      </div>

      <Card title="Payments">
        {payments.length === 0 ? <p className="text-sm text-muted">No payments recorded.</p> : (
          <Table>
            <thead><tr><th className={th}>Received</th><th className={th}>Amount</th><th className={th}>Method</th><th className={th}>Reference</th><th className={th}>Covers until</th><th className={th}>Note</th><th className={th}></th></tr></thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id}>
                  <td className={td}>{fmtDate(p.paid_on)}</td><td className={`${td} tabular`}>{fmtMoney(p.amount, p.currency)}</td>
                  <td className={td}>{METHODS.find(([v]) => v === p.method)?.[1] ?? p.method}</td><td className={td}>{p.reference ?? "—"}</td>
                  <td className={td}>{p.covers_to ? fmtDate(p.covers_to) : "—"}</td><td className={td} dir="auto">{p.note ?? ""}</td>
                  <td className={td}>
                    <form action={deletePaymentAction}><input type="hidden" name="company_id" value={id} /><input type="hidden" name="id" value={p.id} />
                      <button className="text-xs text-red-700 underline" type="submit">Delete entry</button></form>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
