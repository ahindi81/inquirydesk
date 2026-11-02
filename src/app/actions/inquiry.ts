"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireCtx } from "@/lib/server/auth";
import { asUser, dbErrorMessage } from "@/lib/server/db";
import { deleteObjects } from "@/lib/server/storage";
import { addDocument, runExtraction, runMatching, runSummary, type ActionResult } from "@/lib/server/inquiry-service";
import { CLARIFY_FIELDS } from "@/lib/ai/verify";

const uuid = z.uuid();
const path = (id: string, tab?: string) => `/inquiries/${id}${tab ? `?tab=${tab}` : ""}`;

// ---------------------------------------------------------------- inquiry

export type InquiryFormState = { error?: string } | undefined;

export async function createInquiryAction(_: InquiryFormState, fd: FormData): Promise<InquiryFormState> {
  const ctx = await requireCtx();
  const customer = String(fd.get("customer_name") ?? "").trim();
  if (!customer) return { error: "Enter the customer name." };
  const owner = String(fd.get("owner_id") ?? "") || ctx.user.id;
  const deadline = String(fd.get("quotation_deadline") ?? "") || null;
  let id: string;
  try {
    id = await asUser(ctx.user.id, async (tx) => {
      const [r] = await tx<{ id: string }[]>`
        insert into inquiries (company_id, customer_name, project_name, reference_number, owner_id, quotation_deadline, pasted_text, is_demo, created_by)
        values (${ctx.company.companyId}, ${customer}, ${String(fd.get("project_name") ?? "").trim() || null},
                ${String(fd.get("reference_number") ?? "").trim() || null}, ${owner}, ${deadline},
                ${String(fd.get("pasted_text") ?? "").trim() || null}, ${ctx.company.isDemo}, ${ctx.user.id})
        returning id`;
      return r.id;
    });
  } catch (e) { return { error: dbErrorMessage(e) }; }
  redirect(path(id, "documents"));
}

export async function updateInquiryAction(fd: FormData): Promise<ActionResult> {
  const ctx = await requireCtx();
  const id = uuid.parse(fd.get("id"));
  try {
    await asUser(ctx.user.id, (tx) => tx`
      update inquiries set customer_name = ${String(fd.get("customer_name") ?? "").trim()},
        project_name = ${String(fd.get("project_name") ?? "").trim() || null},
        reference_number = ${String(fd.get("reference_number") ?? "").trim() || null},
        owner_id = ${String(fd.get("owner_id") ?? "") || null},
        quotation_deadline = ${String(fd.get("quotation_deadline") ?? "") || null},
        pasted_text = ${String(fd.get("pasted_text") ?? "").trim() || null}, updated_at = now()
      where id = ${id} and company_id = ${ctx.company.companyId}`);
  } catch (e) { return { ok: false, error: dbErrorMessage(e) }; }
  revalidatePath(path(id));
  return { ok: true, message: "Saved." };
}

export async function deleteInquiryAction(fd: FormData) {
  const ctx = await requireCtx();
  const id = uuid.parse(fd.get("id"));
  if (fd.get("confirm") !== "delete") redirect(path(id, "documents") + "&error=confirm-delete");
  const keys = await asUser(ctx.user.id, async (tx) => {
    const docs = await tx<{ storage_path: string }[]>`select storage_path from inquiry_documents where inquiry_id = ${id}`;
    await tx`delete from inquiries where id = ${id} and company_id = ${ctx.company.companyId}`;
    return docs.map((d) => d.storage_path);
  });
  await deleteObjects(keys);
  redirect("/inquiries?deleted=1");
}

// ---------------------------------------------------------------- documents

export async function uploadDocumentAction(fd: FormData): Promise<ActionResult<{ status: string; message: string }>> {
  const ctx = await requireCtx();
  const id = uuid.safeParse(fd.get("inquiryId"));
  const file = fd.get("file");
  if (!id.success || !(file instanceof File)) return { ok: false, error: "Invalid upload." };
  const res = await addDocument(ctx, id.data, file.name, Buffer.from(await file.arrayBuffer()));
  revalidatePath(path(id.data));
  return res;
}

export async function deleteDocumentAction(fd: FormData) {
  const ctx = await requireCtx();
  const id = uuid.parse(fd.get("id"));
  const inquiryId = uuid.parse(fd.get("inquiryId"));
  const key = await asUser(ctx.user.id, async (tx) => {
    const [d] = await tx<{ storage_path: string }[]>`delete from inquiry_documents where id = ${id} and company_id = ${ctx.company.companyId} returning storage_path`;
    return d?.storage_path;
  });
  if (key) await deleteObjects([key]);
  revalidatePath(path(inquiryId));
}

// ---------------------------------------------------------------- processing steps

export async function extractAction(inquiryId: string, replaceReviewed = false) {
  const ctx = await requireCtx();
  const res = await runExtraction(ctx, uuid.parse(inquiryId), { replaceReviewed });
  revalidatePath(path(inquiryId));
  return res;
}
export async function summarizeAction(inquiryId: string) {
  const ctx = await requireCtx();
  const res = await runSummary(ctx, uuid.parse(inquiryId));
  revalidatePath(path(inquiryId));
  return res;
}
export async function matchAction(inquiryId: string) {
  const ctx = await requireCtx();
  const res = await runMatching(ctx, uuid.parse(inquiryId));
  revalidatePath(path(inquiryId));
  return res;
}

// ---------------------------------------------------------------- requirements (salesperson corrections)

const ReqEdit = z.object({
  item_no: z.string().trim().max(40),
  description: z.string().trim().min(1, "Description is required."),
  quantity: z.string().trim(),
  unit: z.string().trim().max(30),
  specifications: z.string().trim(),
  requested_brand: z.string().trim(),
  finish: z.string().trim(), colour: z.string().trim(), dimensions: z.string().trim(),
  delivery_location: z.string().trim(),
  required_delivery_date: z.string().trim(),
});

export async function saveRequirementAction(inquiryId: string, reqId: string | null, values: Record<string, string>): Promise<ActionResult> {
  const ctx = await requireCtx();
  const p = ReqEdit.safeParse(values);
  if (!p.success) return { ok: false, error: p.error.issues[0].message };
  const v = p.data;
  const qty = v.quantity.replace(/,/g, "");
  if (qty && !/^\d+(\.\d{1,4})?$/.test(qty)) return { ok: false, error: "Quantity must be a number greater than zero (up to 4 decimals)." };
  if (qty && Number(qty) <= 0) return { ok: false, error: "Quantity must be greater than zero." };
  if (v.required_delivery_date && !/^\d{4}-\d{2}-\d{2}$/.test(v.required_delivery_date)) return { ok: false, error: "Use a valid delivery date." };
  const row = {
    item_no: v.item_no || null, description: v.description, quantity: qty || null, unit: v.unit || null,
    specifications: v.specifications || null, requested_brand: v.requested_brand || null,
    delivery_location: v.delivery_location || null, required_delivery_date: v.required_delivery_date || null,
  };
  const attributes = Object.fromEntries((["finish", "colour", "dimensions"] as const).filter((k) => v[k]).map((k) => [k, v[k]]));
  const clar = CLARIFY_FIELDS.filter((f) => !row[f]);
  try {
    await asUser(ctx.user.id, async (tx) => {
      if (reqId) {
        const [r] = await tx`update requirements set ${tx(row)}, attributes = ${tx.json(attributes)}, needs_clarification = ${clar},
            corrected_by = ${ctx.user.id}, corrected_at = now()
          where id = ${reqId} and inquiry_id = ${inquiryId} and company_id = ${ctx.company.companyId} returning id`;
        if (!r) throw new Error("Requirement not found");
        // A changed requirement invalidates matches that were decided on the old values.
        await tx`update product_matches set decision = 'pending', decided_by = null, decided_at = null
                 where requirement_id = ${reqId} and decision = 'approved'`;
      } else {
        const [{ n }] = await tx<{ n: number }[]>`select coalesce(max(sort_order), -1)::int + 1 n from requirements where inquiry_id = ${inquiryId}`;
        await tx`insert into requirements ${tx({ ...row, company_id: ctx.company.companyId, inquiry_id: inquiryId, sort_order: n,
            corrected_by: ctx.user.id, source_ref: "Added manually" })}`;
        const [last] = await tx<{ id: string }[]>`select id from requirements where inquiry_id = ${inquiryId} order by created_at desc limit 1`;
        await tx`update requirements set attributes = ${tx.json(attributes)}, needs_clarification = ${clar}, corrected_at = now() where id = ${last.id}`;
      }
      await refreshInquiryStatus(tx, inquiryId);
    });
  } catch (e) { return { ok: false, error: dbErrorMessage(e) }; }
  revalidatePath(path(inquiryId));
  return { ok: true };
}

export async function deleteRequirementAction(inquiryId: string, reqId: string): Promise<ActionResult> {
  const ctx = await requireCtx();
  try {
    await asUser(ctx.user.id, async (tx) => {
      await tx`delete from requirements where id = ${reqId} and inquiry_id = ${inquiryId} and company_id = ${ctx.company.companyId}`;
      await refreshInquiryStatus(tx, inquiryId);
    });
  } catch (e) { return { ok: false, error: dbErrorMessage(e) }; }
  revalidatePath(path(inquiryId));
  return { ok: true };
}

async function refreshInquiryStatus(tx: Parameters<Parameters<typeof asUser>[1]>[0], inquiryId: string) {
  // Only moves between the review states; quotation states are set by the quotation flow.
  await tx`update inquiries set status = case
      when exists (select 1 from requirements where inquiry_id = ${inquiryId} and cardinality(needs_clarification) > 0) then 'needs_clarification'::inquiry_status
      else 'ready_for_review'::inquiry_status end, updated_at = now()
    where id = ${inquiryId} and status in ('new', 'needs_clarification', 'ready_for_review')
      and exists (select 1 from requirements where inquiry_id = ${inquiryId})`;
}

// ---------------------------------------------------------------- matches

export async function decideMatchAction(inquiryId: string, matchId: string, decision: "approved" | "rejected" | "pending"): Promise<ActionResult> {
  const ctx = await requireCtx();
  try {
    await asUser(ctx.user.id, async (tx) => {
      const [m] = await tx<{ requirement_id: string; label: string }[]>`
        select requirement_id, label from product_matches where id = ${matchId} and company_id = ${ctx.company.companyId}`;
      if (!m) throw new Error("Match not found");
      if (decision === "approved" && m.label === "no_match") throw Object.assign(new Error("Choose a product to approve."), { code: "23514" });
      if (decision === "approved") {
        await tx`update product_matches set decision = 'rejected', decided_by = ${ctx.user.id}, decided_at = now()
                 where requirement_id = ${m.requirement_id} and decision = 'approved' and id <> ${matchId}`;
      }
      await tx`update product_matches set decision = ${decision}, decided_by = ${decision === "pending" ? null : ctx.user.id},
                 decided_at = ${decision === "pending" ? null : new Date()} where id = ${matchId}`;
    });
  } catch (e) { return { ok: false, error: dbErrorMessage(e) }; }
  revalidatePath(path(inquiryId));
  return { ok: true };
}

/** Salesperson picks a catalogue product themselves; it is approved immediately because a person chose it. */
export async function manualMatchAction(inquiryId: string, requirementId: string, productId: string): Promise<ActionResult> {
  const ctx = await requireCtx();
  try {
    await asUser(ctx.user.id, async (tx) => {
      await tx`update product_matches set decision = 'rejected', decided_by = ${ctx.user.id}, decided_at = now()
               where requirement_id = ${requirementId} and decision = 'approved'`;
      await tx`insert into product_matches (company_id, requirement_id, product_id, label, is_manual, decision, decided_by, decided_at,
                 similarities, missing_evidence)
               values (${ctx.company.companyId}, ${requirementId}, ${productId}, 'potential_match', true, 'approved', ${ctx.user.id}, now(),
                 ${["Selected manually by salesperson"]}, ${["Not compared automatically — verify specifications."]})`;
    });
  } catch (e) { return { ok: false, error: dbErrorMessage(e) }; }
  revalidatePath(path(inquiryId));
  return { ok: true };
}

// ---------------------------------------------------------------- clarification email

export async function saveClarificationAction(inquiryId: string, text: string): Promise<ActionResult> {
  const ctx = await requireCtx();
  try {
    await asUser(ctx.user.id, (tx) => tx`update inquiries set clarification_draft = ${text}, clarification_updated_by = ${ctx.user.id},
      clarification_updated_at = now() where id = ${inquiryId} and company_id = ${ctx.company.companyId}`);
  } catch (e) { return { ok: false, error: dbErrorMessage(e) }; }
  revalidatePath(path(inquiryId));
  return { ok: true, message: "Draft saved. It has not been sent." };
}
