import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCtx } from "@/lib/server/auth";
import { asUser } from "@/lib/server/db";
import { providerStatus } from "@/lib/ai";
import { Alert, Badge, StatusBadge, cx, fmtDate } from "@/components/ui";
import { DocumentsTab } from "@/components/inquiry/documents-tab";
import { RequirementsTab, type ReqRow } from "@/components/inquiry/requirements-tab";
import { SummaryTab, type SummaryContent } from "@/components/inquiry/summary-tab";
import { MatchesTab, type MatchRow, type ProductOption } from "@/components/inquiry/matches-tab";
import { DraftsTab } from "@/components/inquiry/drafts-tab";
import { buildClarificationEmail } from "@/lib/clarification";

const TABS = [
  { key: "documents", label: "1. Documents" },
  { key: "requirements", label: "2. Requirements" },
  { key: "summary", label: "3. Summary" },
  { key: "matches", label: "4. Matches" },
  { key: "drafts", label: "5. Drafts" },
] as const;

export async function generateMetadata() { return { title: "Inquiry" }; }

export default async function InquiryPage({ params, searchParams }: PageProps<"/inquiries/[id]">) {
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const tab = (TABS.find((t) => t.key === sp.tab)?.key ?? "documents") as (typeof TABS)[number]["key"];
  const ctx = await requireCtx();
  const d = await asUser(ctx.user.id, async (tx) => {
    const [inq] = await tx<{ id: string; customer_name: string; project_name: string | null; reference_number: string | null; status: string;
      quotation_deadline: string | null; pasted_text: string | null; owner_id: string | null; is_demo: boolean; clarification_draft: string | null;
      clarification_updated_at: Date | null }[]>`
      select id, customer_name, project_name, reference_number, status, quotation_deadline::text, pasted_text, owner_id, is_demo,
             clarification_draft, clarification_updated_at
        from inquiries where id = ${id} and company_id = ${ctx.company.companyId}`;
    if (!inq) return null;
    const docs = await tx<{ id: string; file_name: string; mime_type: string; size_bytes: string; status: string; error_message: string | null;
      ocr_used: boolean; lines: number; created_at: Date }[]>`
      select id, file_name, mime_type, size_bytes::text, status, error_message, ocr_used,
             coalesce(jsonb_array_length(extracted_text), 0) lines, created_at
        from inquiry_documents where inquiry_id = ${id} order by created_at`;
    const reqs = await tx<ReqRow[]>`
      select r.id, r.item_no, r.description, r.quantity::text, r.unit, r.specifications, r.requested_brand, r.attributes,
             r.delivery_location, r.required_delivery_date::text, r.source_ref, r.source_excerpt, r.needs_clarification,
             r.original, r.corrected_at is not null as corrected, r.ai_run_id is not null as from_ai, d.file_name as source_file, d.id as source_doc_id
        from requirements r left join inquiry_documents d on d.id = r.source_document_id
       where r.inquiry_id = ${id} order by r.sort_order, r.created_at`;
    const [summary] = await tx<{ content: SummaryContent; created_at: Date }[]>`
      select content, created_at from inquiry_summaries where inquiry_id = ${id} order by created_at desc limit 1`;
    const matches = await tx<MatchRow[]>`
      select m.id, m.requirement_id, m.product_id, m.label, m.similarities, m.differences, m.missing_evidence, m.is_manual, m.decision,
             p.sku, p.name as product_name, p.brand, p.unit as product_unit, p.unit_price::text, p.currency, p.lead_time_days,
             coalesce(cm.full_name, 'a team member') as decided_by_name
        from product_matches m join requirements r on r.id = m.requirement_id
        left join catalogue_products p on p.id = m.product_id
        left join company_members cm on cm.company_id = m.company_id and cm.user_id = m.decided_by
       where r.inquiry_id = ${id}
       order by m.decision = 'approved' desc, m.label, m.created_at`;
    const products = await tx<ProductOption[]>`
      select id, sku, name, unit, unit_price::text, currency from catalogue_products
       where company_id = ${ctx.company.companyId} and active order by name`;
    const quotes = await tx<{ id: string; quote_number: string; revision_no: number; status: string; revision_id: string }[]>`
      select q.id, q.quote_number, r.revision_no, r.status, r.id as revision_id from quotations q
        join lateral (select * from quotation_revisions r where r.quotation_id = q.id order by revision_no desc limit 1) r on true
       where q.inquiry_id = ${id} order by q.created_at`;
    const members = await tx<{ id: string; name: string }[]>`
      select user_id as id, coalesce(full_name, 'Team member') as name from company_members where company_id = ${ctx.company.companyId}`;
    const [lastRun] = await tx<{ kind: string; status: string; error_message: string | null; provider: string; finished_at: Date | null }[]>`
      select kind, status, error_message, provider, finished_at from ai_runs where inquiry_id = ${id} order by created_at desc limit 1`;
    return { inq, docs, reqs, summary, matches, products, quotes, members, lastRun };
  });
  if (!d) notFound();
  const { inq } = d;
  const engine = providerStatus({ demo: inq.is_demo });
  const counts = {
    documents: d.docs.length, requirements: d.reqs.length, summary: d.summary ? 1 : 0,
    matches: new Set(d.matches.filter((m) => m.decision === "approved").map((m) => m.requirement_id)).size, drafts: d.quotes.length,
  };
  const defaultEmail = buildClarificationEmail({ customer: inq.customer_name, project: inq.project_name, reference: inq.reference_number,
    reqs: d.reqs, questions: d.summary?.content.clarification_questions ?? [] });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs text-muted"><Link href="/inquiries" className="hover:underline">Inquiries</Link> / {inq.reference_number ?? "No reference"}</p>
          <h1 className="mt-1 text-xl font-semibold" dir="auto">{inq.customer_name}</h1>
          <p className="text-sm text-muted" dir="auto">{inq.project_name}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {inq.quotation_deadline && <Badge tone="navy">Quotation due {fmtDate(inq.quotation_deadline)}</Badge>}
          <StatusBadge status={inq.status} />
          <Badge tone={engine.isAI ? "green" : "amber"}>{engine.isAI ? engine.label : "Rule-based reader (no AI)"}</Badge>
        </div>
      </div>
      {d.lastRun?.status === "failed" && (
        <Alert tone="error" title={`The last ${d.lastRun.kind === "extract" ? "extraction" : d.lastRun.kind === "summarize" ? "summary" : "matching"} run failed`}>
          {d.lastRun.error_message} Nothing was changed. You can try again.
        </Alert>
      )}
      <nav aria-label="Inquiry steps" className="no-print flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map((t) => (
          <Link key={t.key} href={`/inquiries/${id}?tab=${t.key}`} aria-current={tab === t.key ? "page" : undefined}
            className={cx("whitespace-nowrap border-b-2 px-3 py-2 text-sm", tab === t.key ? "border-brand-600 font-semibold text-ink" : "border-transparent text-muted hover:text-ink")}>
            {t.label} <span className="ms-1 rounded-full bg-canvas px-1.5 text-xs tabular">{counts[t.key]}</span>
          </Link>
        ))}
      </nav>

      {tab === "documents" && <DocumentsTab inquiry={inq} docs={d.docs} members={d.members} engineLabel={engine.isAI ? engine.label : "the rule-based reader (no AI)"} hasReqs={d.reqs.length > 0} />}
      {tab === "requirements" && <RequirementsTab inquiryId={id} reqs={d.reqs} engineIsAI={engine.isAI} />}
      {tab === "summary" && <SummaryTab inquiryId={id} summary={d.summary ?? null} hasReqs={d.reqs.length > 0} />}
      {tab === "matches" && <MatchesTab inquiryId={id} reqs={d.reqs} matches={d.matches} products={d.products} />}
      {tab === "drafts" && <DraftsTab inquiryId={id} reqs={d.reqs} matches={d.matches} quotes={d.quotes}
        draft={inq.clarification_draft} draftUpdatedAt={inq.clarification_updated_at} defaultEmail={defaultEmail} />}
    </div>
  );
}
