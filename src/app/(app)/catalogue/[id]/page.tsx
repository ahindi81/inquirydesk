import { notFound } from "next/navigation";
import { requireCtx } from "@/lib/server/auth";
import { asUser } from "@/lib/server/db";
import { Button, PageHeader, fmtQty } from "@/components/ui";
import { ProductForm } from "@/components/product-form";
import { deleteProductAction } from "@/app/actions/catalogue";

export const metadata = { title: "Edit product" };
export default async function EditProduct({ params }: PageProps<"/catalogue/[id]">) {
  const { id } = await params;
  const { user, company } = await requireCtx({ admin: true });
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const [p] = await asUser(user.id, (tx) => tx<{ id: string; sku: string; name: string; brand: string | null; category: string | null; description: string | null;
    specifications: Record<string, string>; unit: string; variants: string[]; unit_price: string | null; currency: string | null;
    lead_time_days: number | null; active: boolean; datasheet_path: string | null; default_currency: string }[]>`
    select p.*, p.unit_price::text as unit_price, c.default_currency from catalogue_products p join companies c on c.id = p.company_id
     where p.id = ${id} and p.company_id = ${company.companyId}`);
  if (!p) notFound();
  const specs = Object.entries(p.specifications).map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`).join("\n");
  return (
    <div>
      <PageHeader title={`Edit ${p.sku}`} actions={
        <form action={deleteProductAction}><input type="hidden" name="id" value={p.id} /><Button variant="danger" type="submit">Delete product</Button></form>} />
      <ProductForm defaultCurrency={p.default_currency} p={{ ...p, specifications: specs, variants: p.variants.join(", "),
        unit_price: p.unit_price === null ? null : fmtQty(p.unit_price), hasDatasheet: !!p.datasheet_path }} />
    </div>
  );
}
