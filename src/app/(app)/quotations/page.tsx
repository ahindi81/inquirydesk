import Link from "next/link";
import { requireCtx } from "@/lib/server/auth";
import { asUser } from "@/lib/server/db";
import { Badge, Empty, PageHeader, Table, fmtDate, fmtMoney, td, th } from "@/components/ui";

export const metadata = { title: "Quotations" };

export default async function QuotationsPage() {
  const { user, company } = await requireCtx();
  const rows = await asUser(user.id, (tx) => tx<{ id: string; quote_number: string; customer_name: string; project_name: string | null;
    revision_no: number; status: string; currency: string; total: string | null; created_at: Date; revisions: number }[]>`
    select q.id, q.quote_number, i.customer_name, i.project_name, r.revision_no, r.status, r.currency, r.totals ->> 'total' as total, r.created_at,
           (select count(*)::int from quotation_revisions x where x.quotation_id = q.id) revisions
      from quotations q join inquiries i on i.id = q.inquiry_id
      join lateral (select * from quotation_revisions r where r.quotation_id = q.id order by revision_no desc limit 1) r on true
     where q.company_id = ${company.companyId} order by r.created_at desc limit 300`);
  return (
    <div>
      <PageHeader title="Quotations" subtitle="Latest revision of each quotation. Open one to see its full revision history." />
      {rows.length === 0 ? <Empty title="No quotations yet">Prepare a quotation from an inquiry&apos;s Drafts tab once products are approved.</Empty> : (
        <Table>
          <thead><tr><th className={th}>Quotation</th><th className={th}>Customer / project</th><th className={th}>Latest revision</th>
            <th className={`${th} text-end`}>Approved total</th><th className={th}>Updated</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className={td}><Link className="font-medium hover:underline" href={`/quotations/${r.id}`}>{r.quote_number}</Link></td>
                <td className={td}><span dir="auto">{r.customer_name}</span><p className="text-xs text-muted" dir="auto">{r.project_name}</p></td>
                <td className={td}>Rev {r.revision_no} of {r.revisions} · <Badge tone={r.status === "approved" ? "green" : r.status === "draft" ? "blue" : "gray"}>
                  {r.status === "draft" ? "Draft" : r.status === "approved" ? "Approved" : "Superseded"}</Badge></td>
                <td className={`${td} tabular text-end`}>{r.status === "approved" ? fmtMoney(r.total, r.currency) : <span className="text-muted">Not approved</span>}</td>
                <td className={`${td} text-muted`}>{fmtDate(r.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
