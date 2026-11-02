"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireCtx } from "@/lib/server/auth";
import { asUser, dbErrorMessage, type Tx } from "@/lib/server/db";
import { loadRevision } from "@/lib/server/quotation-data";
import { Dec } from "@/lib/quote/decimal";
import type { ActionResult } from "@/lib/server/inquiry-service";

const uuid = z.uuid();
const qpath = (id: string) => `/quotations/${id}`;

/** Creates a quotation (revision 0) from the inquiry's approved product matches. */
export async function createQuotationAction(inquiryId: string): Promise<ActionResult<{ quotationId: string }>> {
  const ctx = await requireCtx();
  try {
    const quotationId = await asUser(ctx.user.id, async (tx) => {
      const [inq] = await tx<{ id: string }[]>`select id from inquiries where id = ${uuid.parse(inquiryId)} and company_id = ${ctx.company.companyId}`;
      if (!inq) throw Object.assign(new Error("Inquiry not found."), { code: "P0002" });
      const [open] = await tx<{ id: string }[]>`
        select q.id from quotations q join quotation_revisions r on r.quotation_id = q.id
         where q.inquiry_id = ${inquiryId} and r.status = 'draft' limit 1`;
      if (open) return open.id; // idempotent: reuse the existing draft
      const lines = await tx<{ requirement_id: string; match_id: string; product_id: string; sku: string; name: string; description: string | null;
        quantity: string | null; unit: string; unit_price: string | null; currency: string | null }[]>`
        select r.id requirement_id, m.id match_id, p.id product_id, p.sku, p.name, p.description, r.quantity::text, p.unit,
               p.unit_price::text, p.currency
          from requirements r join product_matches m on m.requirement_id = r.id and m.decision = 'approved'
          join catalogue_products p on p.id = m.product_id
         where r.inquiry_id = ${inquiryId} order by r.sort_order, r.created_at`;
      if (lines.length === 0) throw Object.assign(new Error("Approve at least one product match before preparing a quotation."), { code: "23514" });
      const [co] = await tx<{ default_currency: string; default_tax_rate: string }[]>`
        select default_currency, default_tax_rate::text from companies where id = ${ctx.company.companyId}`;
      const [{ n }] = await tx<{ n: string }[]>`select public.next_quote_number(${ctx.company.companyId}) n`;
      const [q] = await tx<{ id: string }[]>`insert into quotations (company_id, inquiry_id, quote_number, created_by)
        values (${ctx.company.companyId}, ${inquiryId}, ${n}, ${ctx.user.id}) returning id`;
      const [rev] = await tx<{ id: string }[]>`
        insert into quotation_revisions (company_id, quotation_id, revision_no, currency, tax_rate, validity_days, payment_terms, delivery_terms, exclusions, created_by)
        values (${ctx.company.companyId}, ${q.id}, 0, ${co.default_currency}, ${co.default_tax_rate}, 30,
                'To be agreed', 'Ex-works unless stated otherwise. Lead times subject to confirmation at order.',
                'Installation, unloading and items not listed above.', ${ctx.user.id})
        returning id`;
      let i = 1;
      for (const l of lines) {
        // A missing quantity stays blank (never a placeholder); the line can't be approved until it is entered.
        await tx`insert into quotation_lines (company_id, revision_id, line_no, requirement_id, match_id, product_id, sku, description,
                   quantity, unit, unit_price, currency, price_source)
                 values (${ctx.company.companyId}, ${rev.id}, ${i++}, ${l.requirement_id}, ${l.match_id}, ${l.product_id}, ${l.sku},
                   ${l.name + (l.description ? ` — ${l.description}` : "")}, ${l.quantity}, ${l.unit}, ${l.unit_price},
                   ${l.currency ?? co.default_currency}, 'catalogue')`;
      }
      await tx`update inquiries set status = 'draft_prepared', updated_at = now() where id = ${inquiryId} and status <> 'approved'`;
      return q.id;
    });
    revalidatePath(`/inquiries/${inquiryId}`);
    return { ok: true, data: { quotationId } };
  } catch (e) { return { ok: false, error: dbErrorMessage(e) }; }
}

async function draftRevision(tx: Tx, companyId: string, revisionId: string) {
  const [r] = await tx<{ id: string; quotation_id: string; status: string }[]>`
    select id, quotation_id, status from quotation_revisions where id = ${revisionId} and company_id = ${companyId}`;
  if (!r) throw Object.assign(new Error("Quotation revision not found."), { code: "P0002" });
  if (r.status !== "draft") throw Object.assign(new Error("This revision is approved and locked. Create a new revision to make changes."), { code: "42501" });
  return r;
}

const money = (label: string) => z.string().trim().transform((s, c) => {
  if (s === "") return null;
  try { const d = Dec.from(s.replace(/,/g, "")); if (d.isNeg()) throw 0; return d.toString(); }
  catch { c.addIssue({ code: "custom", message: `${label} must be a number of zero or more.` }); return z.NEVER; }
});

const LineEdit = z.object({
  description: z.string().trim().min(1, "Description is required."),
  quantity: money("Quantity"), unit: z.string().trim().min(1, "Unit is required."),
  unit_price: money("Unit price"), discount_percent: money("Discount"),
});

export async function updateLineAction(revisionId: string, lineId: string, values: Record<string, string>): Promise<ActionResult> {
  const ctx = await requireCtx();
  const p = LineEdit.safeParse(values);
  if (!p.success) return { ok: false, error: p.error.issues[0].message };
  const v = p.data;
  if (!v.quantity || Number(v.quantity) <= 0) return { ok: false, error: "Quantity must be greater than zero." };
  if (v.discount_percent && Number(v.discount_percent) > 100) return { ok: false, error: "Discount cannot exceed 100%." };
  try {
    const qid = await asUser(ctx.user.id, async (tx) => {
      const r = await draftRevision(tx, ctx.company.companyId, revisionId);
      const [old] = await tx<{ unit_price: string | null; product_price: string | null }[]>`
        select l.unit_price::text, p.unit_price::text product_price from quotation_lines l left join catalogue_products p on p.id = l.product_id
         where l.id = ${lineId} and l.revision_id = ${revisionId}`;
      if (!old) throw Object.assign(new Error("Line not found."), { code: "P0002" });
      const priceChanged = (old.unit_price === null ? null : Dec.from(old.unit_price).toString()) !== v.unit_price;
      const source = !priceChanged ? undefined : v.unit_price !== null && old.product_price !== null && Dec.from(old.product_price).toString() === v.unit_price ? "catalogue" : "user_edit";
      await tx`update quotation_lines set description = ${v.description}, quantity = ${v.quantity}, unit = ${v.unit}, unit_price = ${v.unit_price},
                 discount_percent = ${v.discount_percent ?? "0"}
                 ${source ? tx`, price_source = ${source}` : tx``}
               where id = ${lineId} and revision_id = ${revisionId}`;
      return r.quotation_id;
    });
    revalidatePath(qpath(qid));
    return { ok: true };
  } catch (e) { return { ok: false, error: dbErrorMessage(e) }; }
}

export async function setLineApprovalAction(revisionId: string, lineId: string, approved: boolean): Promise<ActionResult> {
  const ctx = await requireCtx();
  try {
    const qid = await asUser(ctx.user.id, async (tx) => {
      const r = await draftRevision(tx, ctx.company.companyId, revisionId);
      if (approved) {
        const [l] = await tx<{ unit_price: string | null; quantity: string | null }[]>`
          select unit_price::text, quantity::text from quotation_lines where id = ${lineId} and revision_id = ${revisionId}`;
        if (l?.unit_price === null) throw Object.assign(new Error("Enter a unit price before approving this line."), { code: "23514" });
        if (l && l.quantity === null) throw Object.assign(new Error("Enter the quantity before approving this line."), { code: "23514" });
      }
      await tx`update quotation_lines set line_approved = ${approved} where id = ${lineId} and revision_id = ${revisionId}`;
      return r.quotation_id;
    });
    revalidatePath(qpath(qid));
    return { ok: true };
  } catch (e) { return { ok: false, error: dbErrorMessage(e) }; }
}

export async function removeLineAction(revisionId: string, lineId: string): Promise<ActionResult> {
  const ctx = await requireCtx();
  try {
    const qid = await asUser(ctx.user.id, async (tx) => {
      const r = await draftRevision(tx, ctx.company.companyId, revisionId);
      await tx`delete from quotation_lines where id = ${lineId} and revision_id = ${revisionId}`;
      return r.quotation_id;
    });
    revalidatePath(qpath(qid));
    return { ok: true };
  } catch (e) { return { ok: false, error: dbErrorMessage(e) }; }
}

/** Add a catalogue product as an extra line (e.g. an inquiry item omitted earlier). */
export async function addLineAction(revisionId: string, productId: string, requirementId: string | null): Promise<ActionResult> {
  const ctx = await requireCtx();
  try {
    const qid = await asUser(ctx.user.id, async (tx) => {
      const r = await draftRevision(tx, ctx.company.companyId, revisionId);
      const [p] = await tx<{ id: string; sku: string; name: string; unit: string; unit_price: string | null; currency: string | null }[]>`
        select id, sku, name, unit, unit_price::text, currency from catalogue_products where id = ${productId} and company_id = ${ctx.company.companyId}`;
      if (!p) throw Object.assign(new Error("Product not found in your catalogue."), { code: "P0002" });
      let qty: string | null = null;
      if (requirementId) [{ qty }] = await tx<{ qty: string | null }[]>`select quantity::text qty from requirements where id = ${requirementId}`;
      const [{ n }] = await tx<{ n: number }[]>`select coalesce(max(line_no), 0)::int + 1 n from quotation_lines where revision_id = ${revisionId}`;
      const [{ cur }] = await tx<{ cur: string }[]>`select currency cur from quotation_revisions where id = ${revisionId}`;
      await tx`insert into quotation_lines (company_id, revision_id, line_no, requirement_id, product_id, sku, description, quantity, unit,
                 unit_price, currency, price_source)
               values (${ctx.company.companyId}, ${revisionId}, ${n}, ${requirementId}, ${p.id}, ${p.sku}, ${p.name}, ${qty}, ${p.unit},
                 ${p.unit_price}, ${p.currency ?? cur}, 'catalogue')`;
      return r.quotation_id;
    });
    revalidatePath(qpath(qid));
    return { ok: true };
  } catch (e) { return { ok: false, error: dbErrorMessage(e) }; }
}

const Terms = z.object({
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, "Currency must be a 3-letter code."),
  tax_rate: money("Tax rate"), freight: money("Freight"),
  validity_days: z.string().trim(), delivery_terms: z.string(), payment_terms: z.string(), exclusions: z.string(), notes: z.string(),
});

export async function updateTermsAction(revisionId: string, values: Record<string, string>): Promise<ActionResult> {
  const ctx = await requireCtx();
  const p = Terms.safeParse(values);
  if (!p.success) return { ok: false, error: p.error.issues[0].message };
  const v = p.data;
  if (v.tax_rate === null || Number(v.tax_rate) > 100) return { ok: false, error: "Tax rate must be between 0 and 100." };
  const validity = v.validity_days ? Number(v.validity_days) : null;
  if (validity !== null && (!Number.isInteger(validity) || validity <= 0)) return { ok: false, error: "Validity must be a whole number of days." };
  try {
    const qid = await asUser(ctx.user.id, async (tx) => {
      const r = await draftRevision(tx, ctx.company.companyId, revisionId);
      await tx`update quotation_revisions set currency = ${v.currency}, tax_rate = ${v.tax_rate}, freight = ${v.freight}, validity_days = ${validity},
                 delivery_terms = ${v.delivery_terms || null}, payment_terms = ${v.payment_terms || null}, exclusions = ${v.exclusions || null},
                 notes = ${v.notes || null}
               where id = ${revisionId}`;
      // Commercial terms changed: line approvals must be given again.
      await tx`update quotation_lines set line_approved = false where revision_id = ${revisionId}`;
      return r.quotation_id;
    });
    revalidatePath(qpath(qid));
    return { ok: true, message: "Terms saved. Line approvals were reset because commercial terms changed." };
  } catch (e) { return { ok: false, error: dbErrorMessage(e) }; }
}

/** The user explicitly approves an exchange rate (1 unit of `currency` = `rate` quote currency). */
export async function setFxAction(revisionId: string, currency: string, rate: string): Promise<ActionResult> {
  const ctx = await requireCtx();
  const cur = currency.toUpperCase();
  if (!/^[A-Z]{3}$/.test(cur)) return { ok: false, error: "Invalid currency." };
  let value: string | null = null;
  if (rate.trim()) {
    try { const d = Dec.from(rate.trim()); if (d.cmp(Dec.zero) <= 0) throw 0; value = d.toString(); }
    catch { return { ok: false, error: "Exchange rate must be a number greater than zero." }; }
  }
  try {
    const qid = await asUser(ctx.user.id, async (tx) => {
      const r = await draftRevision(tx, ctx.company.companyId, revisionId);
      if (value) await tx`update quotation_revisions set approved_fx = approved_fx || ${tx.json({ [cur]: value })} where id = ${revisionId}`;
      else await tx`update quotation_revisions set approved_fx = approved_fx - ${cur} where id = ${revisionId}`;
      await tx`update quotation_lines set line_approved = false where revision_id = ${revisionId} and currency = ${cur}`;
      return r.quotation_id;
    });
    revalidatePath(qpath(qid));
    return { ok: true };
  } catch (e) { return { ok: false, error: dbErrorMessage(e) }; }
}

export async function approveQuotationAction(revisionId: string): Promise<ActionResult> {
  const ctx = await requireCtx();
  try {
    const qid = await asUser(ctx.user.id, async (tx) => {
      const r = await draftRevision(tx, ctx.company.companyId, revisionId);
      const data = (await loadRevision(tx, ctx.company.companyId, revisionId))!;
      const blocking = data.calc.issues.filter((i) => i.blocking);
      if (blocking.length) throw Object.assign(new Error(blocking.map((i) => i.message).join("\n")), { code: "23514" });
      // Totals are frozen exactly as calculated by application code.
      await tx`select public.approve_revision(${revisionId}, ${tx.json(data.calc as never)})`;
      await tx`update inquiries set status = 'approved', updated_at = now() where id = ${data.rev.inquiry_id}`;
      return r.quotation_id;
    });
    revalidatePath(qpath(qid));
    return { ok: true, message: "Quotation approved and locked. It has not been sent — export it and send it yourself." };
  } catch (e) { return { ok: false, error: dbErrorMessage(e) }; }
}

export async function reviseQuotationAction(revisionId: string): Promise<ActionResult> {
  const ctx = await requireCtx();
  try {
    const qid = await asUser(ctx.user.id, async (tx) => {
      const [r] = await tx<{ quotation_id: string; inquiry_id: string }[]>`
        select r.quotation_id, q.inquiry_id from quotation_revisions r join quotations q on q.id = r.quotation_id
         where r.id = ${revisionId} and r.company_id = ${ctx.company.companyId}`;
      if (!r) throw Object.assign(new Error("Revision not found."), { code: "P0002" });
      await tx`select public.revise_quotation(${revisionId})`;
      await tx`update inquiries set status = 'draft_prepared', updated_at = now() where id = ${r.inquiry_id}`;
      return r.quotation_id;
    });
    revalidatePath(qpath(qid));
    return { ok: true, message: "A new draft revision was created. Lines need to be approved again." };
  } catch (e) { return { ok: false, error: dbErrorMessage(e) }; }
}
