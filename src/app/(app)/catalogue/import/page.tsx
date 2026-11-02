import { requireCtx } from "@/lib/server/auth";
import { PageHeader } from "@/components/ui";
import { CatalogueImport } from "@/components/catalogue-import";

export const metadata = { title: "Import catalogue" };
export default async function ImportPage() {
  await requireCtx({ admin: true });
  return (<div><PageHeader title="Import catalogue" subtitle="Upload your product list, match its columns, and review problems before anything is saved." /><CatalogueImport /></div>);
}
