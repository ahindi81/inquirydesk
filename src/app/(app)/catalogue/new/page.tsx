import { requireCtx } from "@/lib/server/auth";
import { asUser } from "@/lib/server/db";
import { PageHeader } from "@/components/ui";
import { ProductForm } from "@/components/product-form";

export const metadata = { title: "Add product" };
export default async function NewProduct() {
  const { user, company } = await requireCtx({ admin: true });
  const [c] = await asUser(user.id, (tx) => tx<{ default_currency: string }[]>`select default_currency from companies where id = ${company.companyId}`);
  return (<div><PageHeader title="Add product" /><ProductForm p={{}} defaultCurrency={c.default_currency} /></div>);
}
