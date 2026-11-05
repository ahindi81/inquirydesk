import { requireCtx } from "@/lib/server/auth";
import { asUser } from "@/lib/server/db";
import { daysLeft, getSubscription, listPlans, subscriptionNotice, type Subscription } from "@/lib/server/billing";
import { Alert, Badge, Card, PageHeader, Table, fmtDate, fmtMoney, td, th } from "@/components/ui";

export const metadata = { title: "Subscription" };

const STATUS: Record<Subscription["status"], { label: string; tone: "green" | "amber" | "red" | "blue" }> = {
  trialing: { label: "Free trial", tone: "blue" },
  active: { label: "Active", tone: "green" },
  cancelled: { label: "Cancelled", tone: "red" },
  complimentary: { label: "Complimentary", tone: "green" },
};
const METHOD: Record<string, string> = { bank_transfer: "Bank transfer", card: "Card", cash: "Cash", cheque: "Cheque", other: "Other" };

function Meter({ label, used, max }: { label: string; used: number; max: number | null }) {
  const pct = max ? Math.min(100, Math.round((used / max) * 100)) : 0;
  return (
    <div>
      <div className="flex justify-between text-sm"><span>{label}</span><span className="tabular">{used}{max ? ` of ${max}` : " · no limit"}</span></div>
      {max !== null && (
        <div className="mt-1 h-2 rounded-full bg-canvas" role="progressbar" aria-label={label} aria-valuenow={used} aria-valuemax={max}>
          <div className={`h-2 rounded-full ${pct >= 100 ? "bg-red-600" : pct >= 80 ? "bg-amber-500" : "bg-brand-600"}`} style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

const limit = (n: number | null, what: string) => (n === null ? `Unlimited ${what}` : `${n} ${what}`);

export default async function BillingPage() {
  const ctx = await requireCtx();
  const [sub, plans] = await Promise.all([getSubscription(ctx), listPlans(ctx.user.id)]);
  const payments = ctx.company.role === "admin"
    ? await asUser(ctx.user.id, (tx) => tx<{ id: string; amount: string; currency: string; paid_on: string; method: string; reference: string | null; covers_to: string | null }[]>`
        select id, amount::text, currency, paid_on::text, method, reference, covers_to::text from payments
         where company_id = ${ctx.company.companyId} order by paid_on desc, created_at desc`)
    : [];

  if (ctx.company.isDemo || !sub || !sub.billing_enabled) {
    return (
      <div className="space-y-5">
        <PageHeader title="Subscription" />
        <Alert tone="info">{ctx.company.isDemo ? "The demo workspace is free and has no limits." : "Subscriptions are not switched on for this installation. Everything is available without limits."}</Alert>
      </div>
    );
  }
  const notice = subscriptionNotice(sub);
  const st = STATUS[sub.status];
  const trialDays = daysLeft(sub.trial_ends_at);
  const offered = plans.filter((p) => !p.is_trial && p.is_public);

  return (
    <div className="space-y-5">
      <PageHeader title="Subscription" subtitle={ctx.company.companyName} />
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Your plan">
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="text-muted">Plan</dt><dd className="font-medium">{sub.plan_name}</dd>
            <dt className="text-muted">Status</dt>
            <dd><Badge tone={sub.state === "ok" ? st.tone : "red"}>{sub.state === "trial_ended" ? "Trial ended" : sub.state === "expired" ? "Expired" : st.label}</Badge></dd>
            {sub.status === "trialing" && sub.trial_ends_at && (<>
              <dt className="text-muted">Trial ends</dt>
              <dd>{fmtDate(sub.trial_ends_at)}{trialDays !== null && trialDays > 0 ? ` (${trialDays} day${trialDays === 1 ? "" : "s"} left)` : ""}</dd>
            </>)}
            {sub.status === "active" && (<>
              <dt className="text-muted">Paid until</dt><dd>{sub.paid_until ? fmtDate(sub.paid_until) : "—"}</dd>
              {sub.billing_cycle && (<><dt className="text-muted">Billing</dt><dd>{sub.billing_cycle === "yearly" ? "Yearly" : "Monthly"}</dd></>)}
            </>)}
          </dl>
          {sub.status === "active" && <p className="mt-3 text-xs text-muted">After the paid-until date you have {sub.grace_days} grace day{sub.grace_days === 1 ? "" : "s"} to renew. Nothing is charged automatically.</p>}
        </Card>
        <Card title="Usage this month">
          <div className="space-y-4">
            <Meter label="Users (members + open invitations)" used={sub.users + sub.open_invitations} max={sub.max_users} />
            <Meter label="New inquiries" used={sub.inquiries_this_month} max={sub.max_inquiries_per_month} />
            <Meter label="AI processing runs" used={sub.ai_runs_this_month} max={sub.max_ai_runs_per_month} />
            <p className="text-xs text-muted">Monthly counts restart on the 1st. Rule-based (no-AI) processing isn&apos;t counted.</p>
          </div>
        </Card>
      </div>

      <section aria-labelledby="plans-h">
        <h2 id="plans-h" className="mb-3 text-[15px] font-semibold">Plans</h2>
        <div className="grid gap-4 md:grid-cols-3">
          {offered.map((p) => (
            <div key={p.code} className={`rounded-lg border bg-white p-4 ${p.code === sub.plan_code ? "border-brand-500 ring-2 ring-brand-100" : "border-line"}`}>
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-semibold">{p.name}</h3>
                {p.code === sub.plan_code && sub.status !== "trialing" && <Badge tone="green">Current</Badge>}
              </div>
              {p.description && <p className="mt-1 text-sm text-muted">{p.description}</p>}
              <p className="mt-3 text-lg font-semibold tabular">
                {p.price_monthly ? <>{fmtMoney(p.price_monthly, p.currency)} <span className="text-sm font-normal text-muted">/ month</span></> : "Price on request"}
              </p>
              {p.price_yearly && <p className="text-sm text-muted tabular">or {fmtMoney(p.price_yearly, p.currency)} / year</p>}
              <ul className="mt-3 space-y-1 text-sm">
                <li>{limit(p.max_users, "users")}</li>
                <li>{limit(p.max_inquiries_per_month, "new inquiries / month")}</li>
                <li>{limit(p.max_ai_runs_per_month, "AI runs / month")}</li>
              </ul>
            </div>
          ))}
        </div>
      </section>

      <Card title="Subscribe, upgrade or renew">
        <p className="whitespace-pre-line text-sm" dir="auto">{sub.billing_contact || "Contact the InquiryDesk team to subscribe or change your plan."}</p>
        <p className="mt-2 text-xs text-muted">Payment is arranged directly with us (for example by bank transfer). Your plan changes once the payment is confirmed.</p>
      </Card>

      {ctx.company.role === "admin" && (
        <Card title="Payment history">
          {payments.length === 0 ? <p className="text-sm text-muted">No payments recorded yet.</p> : (
            <Table>
              <thead><tr><th className={th}>Date</th><th className={th}>Amount</th><th className={th}>Method</th><th className={th}>Reference</th><th className={th}>Covers until</th></tr></thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={p.id}>
                    <td className={td}>{fmtDate(p.paid_on)}</td><td className={`${td} tabular`}>{fmtMoney(p.amount, p.currency)}</td>
                    <td className={td}>{METHOD[p.method] ?? p.method}</td><td className={td}>{p.reference ?? "—"}</td><td className={td}>{p.covers_to ? fmtDate(p.covers_to) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}
    </div>
  );
}
