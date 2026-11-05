import Link from "next/link";
import { redirect } from "next/navigation";
import { requireCtx } from "@/lib/server/auth";
import { asUser } from "@/lib/server/db";
import { isPlatformOwner, listPlans } from "@/lib/server/billing";
import { savePlanAction, saveSettingsAction } from "@/app/actions/billing";
import { StateBadge } from "@/components/billing";
import { Alert, Button, Card, Field, Input, PageHeader, Table, Textarea, fmtDate, td, th } from "@/components/ui";

export const metadata = { title: "Platform" };

type Row = { company_id: string; company_name: string; created_at: Date; state: string; status: string; plan_name: string;
  trial_ends_at: Date | null; paid_until: Date | null; users: number; inquiries_this_month: number; ai_runs_this_month: number;
  admin_email: string | null; last_payment: string | null };

const n = (v: number | null) => (v === null ? "" : String(v));
const small = "w-24 rounded-md border border-line px-2 py-1 text-sm";

export default async function PlatformPage({ searchParams }: PageProps<"/platform">) {
  const sp = await searchParams;
  const { user } = await requireCtx();
  if (!(await isPlatformOwner(user.id))) redirect("/?error=admin-only");
  const [settings] = await asUser(user.id, (tx) => tx<{ billing_enabled: boolean; trial_days: number; grace_days: number; billing_contact: string | null }[]>`
    select billing_enabled, trial_days, grace_days, billing_contact from platform_settings`);
  const plans = await listPlans(user.id);
  const companies = await asUser(user.id, (tx) => tx<Row[]>`select *, last_payment::text from public.platform_companies()`);

  return (
    <div className="space-y-6">
      <PageHeader title="Platform (owner)" subtitle="Your customers' subscriptions. Only you see this page; customers' inquiries, catalogues and quotations stay private to them." />
      {sp.msg && <Alert tone="success">{String(sp.msg)}</Alert>}
      {sp.error && <Alert tone="error">{String(sp.error)}</Alert>}

      <Card title={`Companies (${companies.length})`}>
        {companies.length === 0 ? <p className="text-sm text-muted">No customer companies yet.</p> : (
          <Table>
            <thead><tr>
              <th className={th}>Company</th><th className={th}>Plan</th><th className={th}>Status</th><th className={th}>Trial ends / paid until</th>
              <th className={th}>Users</th><th className={th}>Inquiries (month)</th><th className={th}>AI runs (month)</th><th className={th}>Last payment</th>
            </tr></thead>
            <tbody>
              {companies.map((c) => (
                <tr key={c.company_id}>
                  <td className={td}>
                    <Link className="font-medium underline" href={`/platform/companies/${c.company_id}`} dir="auto">{c.company_name}</Link>
                    <p className="text-xs text-muted">{c.admin_email ?? "—"} · since {fmtDate(c.created_at)}</p>
                  </td>
                  <td className={td}>{c.plan_name}</td>
                  <td className={td}><StateBadge state={c.state} status={c.status} /></td>
                  <td className={td}>{c.status === "trialing" ? fmtDate(c.trial_ends_at) : c.status === "active" ? fmtDate(c.paid_until) : "—"}</td>
                  <td className={`${td} tabular`}>{c.users}</td><td className={`${td} tabular`}>{c.inquiries_this_month}</td>
                  <td className={`${td} tabular`}>{c.ai_runs_this_month}</td><td className={td}>{c.last_payment ? fmtDate(c.last_payment) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card title="Plans and prices">
        <div id="plans" className="space-y-3">
          <p className="text-sm text-muted">Leave a limit empty for “unlimited”. Leave a price empty to show “Price on request”. Changes apply immediately to every company on that plan.</p>
          {plans.map((p) => (
            <form key={p.code} action={savePlanAction} className="rounded-md border border-line p-3" aria-label={`Plan ${p.name}`}>
              <input type="hidden" name="code" value={p.code} />
              <div className="flex flex-wrap items-end gap-3">
                <Field label={p.is_trial ? "Name (free trial)" : "Name"} htmlFor={`name-${p.code}`}><Input id={`name-${p.code}`} name="name" defaultValue={p.name} className="w-44" /></Field>
                <Field label="Users" htmlFor={`u-${p.code}`}><input id={`u-${p.code}`} name="max_users" inputMode="numeric" defaultValue={n(p.max_users)} className={small} /></Field>
                <Field label="Inquiries / month" htmlFor={`i-${p.code}`}><input id={`i-${p.code}`} name="max_inquiries" inputMode="numeric" defaultValue={n(p.max_inquiries_per_month)} className={small} /></Field>
                <Field label="AI runs / month" htmlFor={`a-${p.code}`}><input id={`a-${p.code}`} name="max_ai_runs" inputMode="numeric" defaultValue={n(p.max_ai_runs_per_month)} className={small} /></Field>
                {!p.is_trial && (<>
                  <Field label="Price / month" htmlFor={`pm-${p.code}`}><input id={`pm-${p.code}`} name="price_monthly" inputMode="decimal" defaultValue={p.price_monthly ?? ""} className={small} /></Field>
                  <Field label="Price / year" htmlFor={`py-${p.code}`}><input id={`py-${p.code}`} name="price_yearly" inputMode="decimal" defaultValue={p.price_yearly ?? ""} className={small} /></Field>
                </>)}
                <Field label="Currency" htmlFor={`c-${p.code}`}><input id={`c-${p.code}`} name="currency" defaultValue={p.currency} maxLength={3} className="w-16 rounded-md border border-line px-2 py-1 text-sm uppercase" /></Field>
                {!p.is_trial && <label className="flex items-center gap-1.5 pb-1.5 text-sm"><input type="checkbox" name="is_public" defaultChecked={p.is_public} /> Shown to customers</label>}
                {p.is_trial && <input type="hidden" name="is_public" value="on" />}
                <Button type="submit" variant="secondary">Save</Button>
              </div>
              <div className="mt-2"><label className="sr-only" htmlFor={`d-${p.code}`}>Description</label>
                <input id={`d-${p.code}`} name="description" defaultValue={p.description ?? ""} placeholder="Short description shown to customers" className="w-full rounded-md border border-line px-2 py-1 text-sm" dir="auto" /></div>
            </form>
          ))}
        </div>
      </Card>

      <Card title="Settings">
        <form action={saveSettingsAction} className="space-y-4">
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="billing_enabled" defaultChecked={settings.billing_enabled} className="mt-0.5" />
            <span><strong>Subscriptions switched on.</strong> When off, no company is limited (for example while testing).</span>
          </label>
          <div className="flex flex-wrap gap-4">
            <Field label="Free trial length (days)" htmlFor="trial_days" hint="For companies created from now on."><Input id="trial_days" name="trial_days" type="number" min={1} max={90} defaultValue={settings.trial_days} className="w-28" /></Field>
            <Field label="Grace days after paid-until" htmlFor="grace_days"><Input id="grace_days" name="grace_days" type="number" min={0} max={30} defaultValue={settings.grace_days} className="w-28" /></Field>
          </div>
          <Field label="How customers pay you (shown on their Subscription page)" htmlFor="billing_contact" hint="For example: bank name, IBAN, account name, and the email or WhatsApp number to send the transfer receipt to.">
            <Textarea id="billing_contact" name="billing_contact" rows={4} defaultValue={settings.billing_contact ?? ""} />
          </Field>
          <Button type="submit">Save settings</Button>
        </form>
      </Card>
    </div>
  );
}
