import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCtx } from "@/lib/server/auth";
import { asUser } from "@/lib/server/db";
import { loadRevision } from "@/lib/server/quotation-data";
import { Badge, fmtDate } from "@/components/ui";
import { QuotationEditor } from "@/components/quotation-editor";

export const metadata = { title: "Quotation" };

export default async function QuotationPage({ params, searchParams }: PageProps<"/quotations/[id]">) {
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const { user, company } = await requireCtx();
  const data = await asUser(user.id, async (tx) => {
    const revisions = await tx<{ id: string; revision_no: number; status: string; created_at: Date; approved_at: Date | null; created_by_name: string | null }[]>`
      select r.id, r.revision_no, r.status, r.created_at, r.approved_at, m.full_name created_by_name
        from quotation_revisions r left join company_members m on m.company_id = r.company_id and m.user_id = r.created_by
       where r.quotation_id = ${id} and r.company_id = ${company.companyId} order by r.revision_no desc`;
    if (revisions.length === 0) return null;
    const revId = typeof sp.rev === "string" && revisions.some((r) => r.id === sp.rev) ? sp.rev : revisions[0].id;
    const loaded = (await loadRevision(tx, company.companyId, revId))!;
    const [inq] = await tx<{ id: string; customer_name: string; project_name: string | null; reference_number: string | null }[]>`
      select id, customer_name, project_name, reference_number from inquiries where id = ${loaded.rev.inquiry_id}`;
    const products = await tx<{ id: string; sku: string; name: string; unit: string; unit_price: string | null; currency: string | null }[]>`
      select id, sku, name, unit, unit_price::text, currency from catalogue_products where company_id = ${company.companyId} and active order by name`;
    return { revisions, ...loaded, inq, products };
  });
  if (!data) notFound();
  const { rev, inq } = data;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs text-muted"><Link href="/quotations" className="hover:underline">Quotations</Link> / <Link href={`/inquiries/${inq.id}?tab=drafts`} className="hover:underline" dir="auto">{inq.customer_name}</Link></p>
          <h1 className="mt-1 text-xl font-semibold">{rev.quote_number} <span className="text-muted">· Revision {rev.revision_no}</span></h1>
          <p className="text-sm text-muted" dir="auto">{inq.project_name}{inq.reference_number ? ` · Customer ref. ${inq.reference_number}` : ""}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={rev.status === "approved" ? "green" : rev.status === "draft" ? "blue" : "gray"}>
            {rev.status === "approved" ? `Approved ${fmtDate(rev.approved_at)}${rev.approved_by_name ? ` by ${rev.approved_by_name}` : ""}` : rev.status === "draft" ? "Draft — editable" : "Superseded"}
          </Badge>
          <a className="rounded-md border border-line bg-white px-3 py-1.5 text-sm hover:bg-canvas" href={`/api/quotations/${rev.id}/export?format=pdf`}>PDF</a>
          <a className="rounded-md border border-line bg-white px-3 py-1.5 text-sm hover:bg-canvas" href={`/api/quotations/${rev.id}/export?format=xlsx`}>Excel</a>
          <a className="rounded-md border border-line bg-white px-3 py-1.5 text-sm hover:bg-canvas" href={`/api/quotations/${rev.id}/export?format=csv`}>CSV</a>
        </div>
      </div>
      <div className="grid gap-5 xl:grid-cols-[1fr_260px]">
        <div className="min-w-0"><QuotationEditor rev={JSON.parse(JSON.stringify(rev))} lines={data.lines} calc={data.calc} reqs={data.reqs} products={data.products} /></div>
        <aside className="space-y-2">
          <h2 className="text-sm font-semibold">Revision history</h2>
          <ul className="space-y-1">
            {data.revisions.map((r) => (
              <li key={r.id}>
                <Link href={`/quotations/${id}?rev=${r.id}`} aria-current={r.id === rev.id ? "page" : undefined}
                  className={`block rounded-md border px-3 py-2 text-sm ${r.id === rev.id ? "border-brand-500 bg-brand-50" : "border-line bg-white hover:bg-canvas"}`}>
                  <span className="font-medium">Rev {r.revision_no}</span> · {r.status === "draft" ? "Draft" : r.status === "approved" ? "Approved" : "Superseded"}
                  <span className="block text-xs text-muted">Created {fmtDate(r.created_at)}{r.created_by_name ? ` by ${r.created_by_name}` : ""}</span>
                </Link>
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </div>
  );
}
