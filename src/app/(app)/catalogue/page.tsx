import Link from "next/link";
import { requireCtx } from "@/lib/server/auth";
import { asUser } from "@/lib/server/db";
import { Alert, Badge, ButtonLink, Empty, Input, PageHeader, Table, fmtMoney, td, th } from "@/components/ui";

export const metadata = { title: "Catalogue" };

export default async function CataloguePage({ searchParams }: PageProps<"/catalogue">) {
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q.trim() : "";
  const { user, company } = await requireCtx();
  const products = await asUser(user.id, (tx) => tx<{ id: string; sku: string; name: string; brand: string | null; category: string | null;
    unit: string; unit_price: string | null; currency: string | null; lead_time_days: number | null; active: boolean; datasheet_path: string | null }[]>`
    select id, sku, name, brand, category, unit, unit_price::text, currency, lead_time_days, active, datasheet_path
      from catalogue_products where company_id = ${company.companyId}
       and (${q} = '' or sku ilike ${"%" + q + "%"} or name ilike ${"%" + q + "%"} or coalesce(brand,'') ilike ${"%" + q + "%"}
            or coalesce(category,'') ilike ${"%" + q + "%"} or coalesce(description,'') ilike ${"%" + q + "%"})
     order by active desc, category nulls last, name limit 500`);
  const admin = company.role === "admin";
  return (
    <div>
      <PageHeader title="Product catalogue" subtitle="Product matching only ever suggests products from this list. Prices here are the approved selling prices used in quotations."
        actions={admin && <><ButtonLink variant="secondary" href="/catalogue/import">Import CSV / Excel</ButtonLink><ButtonLink href="/catalogue/new">Add product</ButtonLink></>} />
      {sp.saved && <div className="mb-4"><Alert tone="success">Product saved.</Alert></div>}
      {sp.deleted && <div className="mb-4"><Alert tone="success">Product deleted.</Alert></div>}
      {sp.deactivated && <div className="mb-4"><Alert tone="info">This product is used in existing matches or quotations, so it was deactivated instead of deleted. It will no longer be suggested.</Alert></div>}
      {!admin && <div className="mb-4"><Alert tone="info">Only workspace admins can change products and prices.</Alert></div>}
      <form className="mb-4 flex max-w-md gap-2" role="search">
        <label htmlFor="q" className="sr-only">Search products</label>
        <Input id="q" name="q" defaultValue={q} placeholder="Search SKU, name, brand, category…" />
        <button className="rounded-md border border-line bg-white px-3 text-sm hover:bg-canvas" type="submit">Search</button>
      </form>
      {products.length === 0 ? (
        <Empty title={q ? "No products match your search" : "Your catalogue is empty"}>
          {!q && admin && <p>Import your product list from a spreadsheet, or add products one by one.</p>}
        </Empty>
      ) : (
        <Table>
          <thead><tr>
            <th className={th}>SKU</th><th className={th}>Product</th><th className={th}>Category</th><th className={th}>Unit</th>
            <th className={`${th} text-end`}>Approved price</th><th className={th}>Lead time</th><th className={th}></th>
          </tr></thead>
          <tbody>
            {products.map((p) => (
              <tr key={p.id} className={p.active ? "" : "opacity-60"}>
                <td className={`${td} font-mono text-xs`}>{p.sku}</td>
                <td className={td}>
                  {admin ? <Link href={`/catalogue/${p.id}`} className="font-medium hover:underline" dir="auto">{p.name}</Link> : <span className="font-medium" dir="auto">{p.name}</span>}
                  <p className="text-xs text-muted" dir="auto">{p.brand}</p>
                </td>
                <td className={td} dir="auto">{p.category}</td>
                <td className={td}>{p.unit}</td>
                <td className={`${td} tabular text-end`}>{p.unit_price === null ? <Badge tone="amber">No price</Badge> : fmtMoney(p.unit_price.replace(/(\.\d\d)0+$/, "$1"), p.currency ?? "")}</td>
                <td className={td}>{p.lead_time_days === null ? <span className="text-muted">—</span> : `${p.lead_time_days} days`}</td>
                <td className={`${td} whitespace-nowrap text-end`}>
                  {!p.active && <Badge>Inactive</Badge>}{" "}
                  {p.datasheet_path && <a className="text-xs text-brand-700 underline" href={`/api/files/datasheet/${p.id}`}>Datasheet</a>}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
