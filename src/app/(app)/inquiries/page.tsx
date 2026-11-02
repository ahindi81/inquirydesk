import Link from "next/link";
import { requireCtx } from "@/lib/server/auth";
import { asUser } from "@/lib/server/db";
import { Alert, ButtonLink, Empty, Input, PageHeader, STATUS, Select, StatusBadge, Table, fmtDate, td, th } from "@/components/ui";

export const metadata = { title: "Inquiries" };

export default async function InquiriesPage({ searchParams }: PageProps<"/inquiries">) {
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q.trim() : "";
  const status = typeof sp.status === "string" && sp.status in STATUS ? sp.status : "";
  const { user, company } = await requireCtx();
  const rows = await asUser(user.id, (tx) => tx<{ id: string; customer_name: string; project_name: string | null; reference_number: string | null;
    status: string; quotation_deadline: string | null; created_at: Date; owner_name: string | null; docs: number; reqs: number }[]>`
    select i.id, i.customer_name, i.project_name, i.reference_number, i.status, i.quotation_deadline::text, i.created_at,
           coalesce(m.full_name, 'Unassigned') as owner_name,
           (select count(*)::int from inquiry_documents d where d.inquiry_id = i.id) docs,
           (select count(*)::int from requirements r where r.inquiry_id = i.id) reqs
      from inquiries i left join company_members m on m.company_id = i.company_id and m.user_id = i.owner_id
     where i.company_id = ${company.companyId}
       and (${status} = '' or i.status::text = ${status})
       and (${q} = '' or i.customer_name ilike ${"%" + q + "%"} or coalesce(i.project_name,'') ilike ${"%" + q + "%"}
            or coalesce(i.reference_number,'') ilike ${"%" + q + "%"})
     order by i.quotation_deadline asc nulls last, i.created_at desc limit 300`);
  const today = new Date().toISOString().slice(0, 10);
  return (
    <div>
      <PageHeader title="Inquiries" actions={<ButtonLink href="/inquiries/new">New inquiry</ButtonLink>} />
      {sp.deleted && <div className="mb-4"><Alert tone="success">Inquiry and its documents were deleted.</Alert></div>}
      <form className="mb-4 flex flex-wrap gap-2" role="search">
        <label htmlFor="q" className="sr-only">Search</label>
        <Input id="q" name="q" defaultValue={q} placeholder="Customer, project or reference…" className="max-w-xs" />
        <label htmlFor="status" className="sr-only">Status</label>
        <Select id="status" name="status" defaultValue={status} className="max-w-[220px]">
          <option value="">All statuses</option>
          {Object.entries(STATUS).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
        </Select>
        <button className="rounded-md border border-line bg-white px-3 text-sm hover:bg-canvas" type="submit">Filter</button>
      </form>
      {rows.length === 0 ? (
        <Empty title={q || status ? "No inquiries match these filters" : "No inquiries yet"}
          action={!q && !status ? <ButtonLink href="/inquiries/new">Create an inquiry</ButtonLink> : undefined}>
          {!q && !status && "Create an inquiry, upload the customer's documents, and InquiryDesk lists the requested items with their sources."}
        </Empty>
      ) : (
        <Table>
          <thead><tr><th className={th}>Customer / project</th><th className={th}>Reference</th><th className={th}>Owner</th>
            <th className={th}>Files / items</th><th className={th}>Quotation due</th><th className={th}>Status</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="hover:bg-canvas/60">
                <td className={td}><Link href={`/inquiries/${r.id}`} className="font-medium text-ink hover:underline" dir="auto">{r.customer_name}</Link>
                  <p className="text-xs text-muted" dir="auto">{r.project_name}</p></td>
                <td className={td} dir="auto">{r.reference_number}</td>
                <td className={td}>{r.owner_name}</td>
                <td className={`${td} tabular`}>{r.docs} / {r.reqs}</td>
                <td className={`${td} ${r.quotation_deadline && r.quotation_deadline < today && r.status !== "approved" ? "font-semibold text-red-700" : ""}`}>
                  {fmtDate(r.quotation_deadline) || <span className="text-muted">—</span>}</td>
                <td className={td}><StatusBadge status={r.status} /></td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
