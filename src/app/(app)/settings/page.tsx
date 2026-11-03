import { requireCtx } from "@/lib/server/auth";
import { asUser } from "@/lib/server/db";
import { providerStatus } from "@/lib/ai";
import { Alert, Badge, Card, PageHeader } from "@/components/ui";
import { SettingsForm } from "@/components/settings-form";

export const metadata = { title: "Company settings" };
export default async function SettingsPage() {
  const { user, company } = await requireCtx();
  const [c] = await asUser(user.id, (tx) => tx<{ name: string; legal_name: string | null; address: string | null; phone: string | null; email: string | null;
    website: string | null; tax_number: string | null; default_currency: string; default_tax_rate: string; quote_prefix: string }[]>`
    select name, legal_name, address, phone, email, website, tax_number, default_currency, trim(trailing '.' from trim(trailing '0' from default_tax_rate::text)) default_tax_rate, quote_prefix
      from companies where id = ${company.companyId}`);
  const ai = providerStatus({ demo: company.isDemo });
  return (
    <div className="space-y-5">
      <PageHeader title="Company settings" />
      {company.role !== "admin" && <Alert tone="info">Only admins can change company settings.</Alert>}
      <SettingsForm c={c} admin={company.role === "admin"} />
      <Card title="Document processing engine">
        <p className="text-sm"><Badge tone={ai.isAI ? "green" : "amber"}>{ai.label}</Badge></p>
        {ai.problem && <div className="mt-2"><Alert tone="error">{ai.problem}</Alert></div>}
        <p className="mt-2 text-sm text-muted">The AI provider and its key are set on the server by whoever deploys InquiryDesk: <code>AI_PROVIDER</code> = <code>gemini</code> with <code>GEMINI_API_KEY</code> (Google AI Studio, free tier available), or <code>anthropic</code> with <code>ANTHROPIC_API_KEY</code>. Keys are never entered in the browser or stored in the database. On Gemini&apos;s free tier Google may use and review submitted content, so use sample documents only; use a paid key for real customer data.</p>
      </Card>
    </div>
  );
}
