import Link from "next/link";
import { requireCtx } from "@/lib/server/auth";
import { asUser } from "@/lib/server/db";
import { Alert, ButtonLink, Card, Empty, STATUS, StatusBadge, Table, fmtDate, td, th } from "@/components/ui";

export const metadata = { title: "Dashboard" };

export default async function Dashboard({ searchParams }: PageProps<"/">) {
  const sp = await searchParams;
  const { user, company } = await requireCtx();
  const data = await asUser(user.id, async (tx) => {
    const counts = await tx<{ status: string; n: number }[]>`
      select status, count(*)::int n from inquiries where company_id = ${company.companyId} group by status`;
    const deadlines = await tx<{ id: string; customer_name: string; project_name: string | null; quotation_deadline: string; status: string }[]>`
      select id, customer_name, project_name, quotation_deadline::text, status from inquiries
       where company_id = ${company.companyId} and quotation_deadline is not null and status <> 'approved'
         and quotation_deadline <= current_date + 14
       order by quotation_deadline limit 10`;
    const [{ products }] = await tx<{ products: number }[]>`select count(*)::int products from catalogue_products where company_id = ${company.companyId}`;
    const [{ drafts }] = await tx<{ drafts: number }[]>`select count(*)::int drafts from quotation_revisions where company_id = ${company.companyId} and status = 'draft'`;
    const recent = await tx<{ id: string; customer_name: string; project_name: string | null; status: string; updated_at: Date }[]>`
      select id, customer_name, project_name, status, updated_at from inquiries where company_id = ${company.companyId}
       order by updated_at desc limit 6`;
    return { counts: Object.fromEntries(counts.map((c) => [c.status, c.n])), deadlines, products, drafts, recent };
  });
  const total = Object.values(data.counts).reduce((a, b) => a + b, 0);
  const todayStr = new Date().toISOString().slice(0, 10);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Dashboard</h1>
          <p className="mt-1 text-sm text-muted">{total} inquir{total === 1 ? "y" : "ies"} · {data.products} catalogue product{data.products === 1 ? "" : "s"} · {data.drafts} draft quotation{data.drafts === 1 ? "" : "s"}</p>
        </div>
        <ButtonLink href="/inquiries/new">New inquiry</ButtonLink>
      </div>
      {sp.password === "updated" && <Alert tone="success">Your password has been changed.</Alert>}
      {sp.error === "admin-only" && <Alert tone="warning">That page is available to workspace admins only.</Alert>}

      {data.products === 0 && (
        <Alert tone="info" title="Start by adding your product catalogue">
          Product matching only suggests products from your own catalogue. <Link className="underline" href="/catalogue/import">Import a CSV or Excel file</Link> or <Link className="underline" href="/catalogue/new">add products manually</Link>.
        </Alert>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {Object.entries(STATUS).map(([k, s]) => (
          <Link key={k} href={`/inquiries?status=${k}`} className="rounded-lg border border-line bg-white p-3 hover:border-navy-200">
            <p className="text-2xl font-semibold tabular">{data.counts[k] ?? 0}</p>
            <p className="mt-1 text-xs text-muted">{s.label}</p>
          </Link>
        ))}
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card title="Quotation deadlines (next 14 days and overdue)">
          {data.deadlines.length === 0 ? <p className="text-sm text-muted">No open inquiries with a deadline in the next 14 days.</p> : (
            <ul className="divide-y divide-line">
              {data.deadlines.map((d) => (
                <li key={d.id} className="flex items-center justify-between gap-3 py-2">
                  <Link href={`/inquiries/${d.id}`} className="min-w-0">
                    <p className="truncate font-medium" dir="auto">{d.customer_name}</p>
                    <p className="truncate text-xs text-muted" dir="auto">{d.project_name}</p>
                  </Link>
                  <div className="text-end">
                    <p className={d.quotation_deadline < todayStr ? "font-semibold text-red-700" : "font-medium"}>
                      {d.quotation_deadline < todayStr ? "Overdue · " : ""}{fmtDate(d.quotation_deadline)}
                    </p>
                    <StatusBadge status={d.status} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Recently updated">
          {data.recent.length === 0 ? (
            <Empty title="No inquiries yet" action={<ButtonLink href="/inquiries/new">Create your first inquiry</ButtonLink>} />
          ) : (
            <Table>
              <thead><tr><th className={th}>Customer / project</th><th className={th}>Status</th><th className={th}>Updated</th></tr></thead>
              <tbody>
                {data.recent.map((r) => (
                  <tr key={r.id}>
                    <td className={td}><Link href={`/inquiries/${r.id}`} className="font-medium hover:underline" dir="auto">{r.customer_name}</Link>
                      <p className="text-xs text-muted" dir="auto">{r.project_name}</p></td>
                    <td className={td}><StatusBadge status={r.status} /></td>
                    <td className={`${td} text-muted`}>{fmtDate(r.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>
    </div>
  );
}
