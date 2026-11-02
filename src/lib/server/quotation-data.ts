import "server-only";
import type { Tx } from "./db";
import { calculateQuote } from "@/lib/quote/calculate";

// Server-only (not a server action): callers pass an RLS-scoped transaction.
/** Load a revision with everything needed to calculate it. Used by approval, the editor and exports. */
export async function loadRevision(tx: Tx, companyId: string, revisionId: string) {
  const [rev] = await tx<{ id: string; quotation_id: string; revision_no: number; status: string; quote_date: string; currency: string; tax_rate: string;
    freight: string | null; validity_days: number | null; delivery_terms: string | null; payment_terms: string | null; exclusions: string | null;
    notes: string | null; approved_fx: Record<string, string>; totals: unknown; approved_at: Date | null; approved_by_name: string | null;
    inquiry_id: string; quote_number: string }[]>`
    select r.id, r.quotation_id, r.revision_no, r.status, r.quote_date::text, r.currency, r.tax_rate::text, r.freight::text, r.validity_days,
           r.delivery_terms, r.payment_terms, r.exclusions, r.notes, r.approved_fx, r.totals, r.approved_at,
           coalesce(m.full_name, case when r.approved_by is not null then 'a team member' end) approved_by_name,
           q.inquiry_id, q.quote_number
      from quotation_revisions r join quotations q on q.id = r.quotation_id
      left join company_members m on m.company_id = r.company_id and m.user_id = r.approved_by
     where r.id = ${revisionId} and r.company_id = ${companyId}`;
  if (!rev) return null;
  const lines = await tx<{ id: string; line_no: number; requirement_id: string | null; product_id: string | null; sku: string; description: string;
    quantity: string | null; unit: string; unit_price: string | null; currency: string; price_source: string; discount_percent: string; line_approved: boolean;
    catalogue_price: string | null; catalogue_currency: string | null }[]>`
    select l.id, l.line_no, l.requirement_id, l.product_id, l.sku, l.description, l.quantity::text, l.unit, l.unit_price::text, l.currency,
           l.price_source, l.discount_percent::text, l.line_approved, p.unit_price::text catalogue_price, p.currency catalogue_currency
      from quotation_lines l left join catalogue_products p on p.id = l.product_id
     where l.revision_id = ${revisionId} order by l.line_no`;
  const reqs = await tx<{ id: string; item_no: string | null; description: string }[]>`
    select id, item_no, description from requirements where inquiry_id = ${rev.inquiry_id} order by sort_order, created_at`;
  const calc = calculateQuote({
    currency: rev.currency, taxRatePercent: rev.tax_rate, freight: rev.freight, approvedFx: rev.approved_fx,
    lines: lines.map((l) => ({ lineNo: l.line_no, sku: l.sku, description: l.description, quantity: l.quantity, unit: l.unit,
      unitPrice: l.unit_price, currency: l.currency, discountPercent: l.discount_percent, requirementId: l.requirement_id, lineApproved: l.line_approved })),
    requirementIds: reqs.map((r) => r.id),
  }, { requireApproval: true });
  return { rev, lines, reqs, calc };
}

