import "server-only";
import { createHash } from "node:crypto";
import { asUser, type Tx } from "./db";
import { putObject } from "./storage";
import { FileRejected, identifyFile, readFileSegments, MAX_FILES_PER_INQUIRY, textSegments, type Segment } from "./extract/read-file";
import { getProvider } from "@/lib/ai";
import { AIError, type AIProvider, type DocInput, type MatchProduct, type MatchRequirement } from "@/lib/ai/types";
import { verifyExtraction } from "@/lib/ai/verify";
import { selectCandidates, verifyMatches } from "@/lib/ai/match";
import type { Ctx } from "./auth";

export type ActionResult<T = unknown> = { ok: true; data?: T; message?: string } | { ok: false; error: string };

const AI_RUNS_PER_HOUR = Number(process.env.AI_RUNS_PER_USER_PER_HOUR ?? 30);
const UPLOADS_PER_HOUR = Number(process.env.UPLOADS_PER_USER_PER_HOUR ?? 200);
const MAX_AI_CHARS = Number(process.env.AI_MAX_INPUT_CHARS ?? 400_000);

const today = () => new Date().toISOString().slice(0, 10);
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

async function inquiryOrThrow(tx: Tx, ctx: Ctx, inquiryId: string) {
  const [inq] = await tx<{ id: string; company_id: string; is_demo: boolean; pasted_text: string | null; status: string }[]>`
    select id, company_id, is_demo, pasted_text, status from inquiries where id = ${inquiryId} and company_id = ${ctx.company.companyId}`;
  if (!inq) throw new FileRejected("Inquiry not found.");
  return inq;
}

// ---------------------------------------------------------------- documents

/** Store one uploaded file and read its text. Re-uploading the same file is a no-op. */
export async function addDocument(ctx: Ctx, inquiryId: string, name: string, data: Buffer): Promise<ActionResult<{ status: string; message: string }>> {
  try {
    const { mime, kind } = identifyFile(name, data);
    const hash = sha(data);
    const safeName = name.replace(/[^\w.\-؀-ۿ ]+/g, "_").slice(0, 120);
    const prep = await asUser(ctx.user.id, async (tx) => {
      const inq = await inquiryOrThrow(tx, ctx, inquiryId);
      const [{ n }] = await tx<{ n: number }[]>`select count(*)::int n from inquiry_documents where inquiry_id = ${inquiryId}`;
      const [{ recent }] = await tx<{ recent: number }[]>`
        select count(*)::int recent from inquiry_documents where uploaded_by = ${ctx.user.id} and created_at > now() - interval '1 hour'`;
      const [existing] = await tx<{ id: string; status: string }[]>`select id, status from inquiry_documents where inquiry_id = ${inquiryId} and sha256 = ${hash}`;
      if (existing) return { existing };
      if (n >= MAX_FILES_PER_INQUIRY) throw new FileRejected(`An inquiry can have at most ${MAX_FILES_PER_INQUIRY} files.`);
      if (recent >= UPLOADS_PER_HOUR) throw new FileRejected("Upload limit reached for this hour. Try again later.");
      // Storage key is ASCII-only (hash + extension); the original name is kept in file_name.
      const ext = (name.toLowerCase().split(".").pop() ?? "bin").replace(/[^a-z0-9]/g, "").slice(0, 5) || "bin";
      const storagePath = `${inq.company_id}/${inquiryId}/${hash.slice(0, 32)}.${ext}`;
      const [doc] = await tx<{ id: string }[]>`
        insert into inquiry_documents (company_id, inquiry_id, file_name, mime_type, size_bytes, sha256, storage_path, status, uploaded_by)
        values (${inq.company_id}, ${inquiryId}, ${safeName}, ${mime}, ${data.length}, ${hash}, ${storagePath}, 'processing', ${ctx.user.id})
        returning id`;
      return { doc, storagePath };
    });
    if ("existing" in prep && prep.existing) {
      return { ok: true, data: { status: prep.existing.status, message: `"${name}" was already uploaded to this inquiry.` } };
    }
    const { doc, storagePath } = prep as { doc: { id: string }; storagePath: string };
    try {
      await putObject(storagePath, data, mime);
    } catch (e) {
      await setDocFailed(ctx, doc.id, "The file could not be saved to storage. Please upload it again.");
      throw e;
    }
    return readAndStore(ctx, doc.id, name, kind, data);
  } catch (e) {
    if (e instanceof FileRejected) return { ok: false, error: e.message };
    console.error("addDocument failed", (e as Error).message);
    return { ok: false, error: `"${name}" could not be uploaded. Please try again.` };
  }
}

async function setDocFailed(ctx: Ctx, docId: string, msg: string) {
  await asUser(ctx.user.id, (tx) => tx`update inquiry_documents set status = 'failed', error_message = ${msg} where id = ${docId}`);
}

async function readAndStore(ctx: Ctx, docId: string, name: string, kind: ReturnType<typeof identifyFile>["kind"], data: Buffer)
  : Promise<ActionResult<{ status: string; message: string }>> {
  try {
    const r = await readFileSegments(name, kind, data);
    if (r.segments.length === 0 && r.needsVisionOcr) {
      const msg = "This file is scanned (an image of text) and OCR is not available on this server, so no text could be read. Upload a text-based PDF or the original Excel/Word file.";
      await setDocFailed(ctx, docId, msg);
      return { ok: true, data: { status: "failed", message: msg } };
    }
    const warn = r.warnings.join(" ");
    await asUser(ctx.user.id, (tx) => tx`
      update inquiry_documents set status = 'extracted', extracted_text = ${tx.json(r.segments as never)},
             ocr_used = ${r.ocrUsed}, error_message = ${warn || null}
       where id = ${docId}`);
    return { ok: true, data: { status: "extracted", message: `Read ${r.segments.length} lines${r.ocrUsed ? " (using OCR)" : ""}.${warn ? " " + warn : ""}` } };
  } catch (e) {
    const msg = e instanceof FileRejected ? e.message : `"${name}" could not be read.`;
    await setDocFailed(ctx, docId, msg);
    return { ok: true, data: { status: "failed", message: msg } };
  }
}

// ---------------------------------------------------------------- AI runs (idempotent, rate-limited)

type RunKind = "extract" | "summarize" | "match";

/**
 * Start (or reuse) an AI run. Same inputs + same provider = same idempotency key:
 * a finished run is reused without calling the provider again, and a run still in
 * progress blocks duplicates (e.g. a double-click or a retried request).
 */
async function beginRun(ctx: Ctx, inquiryId: string, kind: RunKind, provider: AIProvider, fingerprint: string) {
  const key = sha(`${kind}:${inquiryId}:${provider.name}:${provider.model}:${fingerprint}`);
  return beginRunTx(ctx, inquiryId, kind, provider, key).catch((e) => {
    // Plan limits and expired subscriptions are enforced by the database with a readable message.
    const err = e as { code?: string; message?: string };
    if (err?.code === "23514" && err.message) throw new AIError("quota", err.message);
    throw e;
  });
}

async function beginRunTx(ctx: Ctx, inquiryId: string, kind: RunKind, provider: AIProvider, key: string) {
  return asUser(ctx.user.id, async (tx) => {
    const [existing] = await tx<{ id: string; status: string; created_at: Date; output: unknown }[]>`
      select id, status, created_at, output from ai_runs where company_id = ${ctx.company.companyId} and idempotency_key = ${key} for update`;
    if (existing?.status === "succeeded") return { reuse: existing };
    if (existing?.status === "running" && Date.now() - existing.created_at.getTime() < 10 * 60_000)
      throw new AIError("rate_limited", "This step is already running. Wait for it to finish.");
    if (provider.isAI) {
      const [{ n }] = await tx<{ n: number }[]>`
        select count(*)::int n from ai_runs where started_by = ${ctx.user.id} and provider <> 'rules'
           and created_at > now() - interval '1 hour'`;
      if (n >= AI_RUNS_PER_HOUR) throw new AIError("rate_limited", `You have reached the limit of ${AI_RUNS_PER_HOUR} AI runs per hour. Try again later.`);
    }
    if (existing) {
      await tx`update ai_runs set status = 'running', error_code = null, error_message = null, created_at = now(), started_by = ${ctx.user.id}
               where id = ${existing.id}`;
      return { runId: existing.id };
    }
    const [run] = await tx<{ id: string }[]>`
      insert into ai_runs (company_id, inquiry_id, kind, idempotency_key, provider, model, status, started_by)
      values (${ctx.company.companyId}, ${inquiryId}, ${kind}, ${key}, ${provider.name}, ${provider.model}, 'running', ${ctx.user.id})
      returning id`;
    return { runId: run.id };
  });
}

async function failRun(ctx: Ctx, runId: string, e: unknown) {
  const err = e instanceof AIError ? e : new AIError("provider_error", "Processing failed unexpectedly.", true);
  await asUser(ctx.user.id, (tx) => tx`
    update ai_runs set status = 'failed', error_code = ${err.code}, error_message = ${err.message}, finished_at = now() where id = ${runId}`);
  return err;
}

async function loadDocs(tx: Tx, inquiryId: string, pasted: string | null): Promise<{ docs: DocInput[]; fingerprint: string; failed: string[] }> {
  const rows = await tx<{ id: string; file_name: string; sha256: string; status: string; extracted_text: Segment[] | null }[]>`
    select id, file_name, sha256, status, extracted_text from inquiry_documents where inquiry_id = ${inquiryId} order by created_at`;
  const docs: DocInput[] = [];
  const failed = rows.filter((r) => r.status !== "extracted").map((r) => r.file_name);
  rows.filter((r) => r.status === "extracted" && r.extracted_text).forEach((r) =>
    docs.push({ index: docs.length, documentId: r.id, name: r.file_name, segments: r.extracted_text! }));
  if (pasted?.trim()) docs.push({ index: docs.length, documentId: null, name: "Pasted text", segments: textSegments(pasted, "pasted line") });
  const fingerprint = sha(rows.filter((r) => r.status === "extracted").map((r) => r.sha256).join(",") + "|" + sha(pasted ?? ""));
  return { docs, fingerprint, failed };
}

const errorResult = (e: unknown): { ok: false; error: string } =>
  ({ ok: false, error: e instanceof AIError || e instanceof FileRejected ? e.message : "Processing failed unexpectedly. Please try again." });

// ---------------------------------------------------------------- extraction

export async function runExtraction(ctx: Ctx, inquiryId: string, opts: { replaceReviewed?: boolean } = {}): Promise<ActionResult<{ count: number }>> {
  let runId: string | undefined;
  try {
    const inq = await asUser(ctx.user.id, (tx) => inquiryOrThrow(tx, ctx, inquiryId));
    const provider = getProvider({ demo: inq.is_demo });
    const { docs, fingerprint, failed } = await asUser(ctx.user.id, (tx) => loadDocs(tx, inquiryId, inq.pasted_text));
    if (docs.length === 0) return { ok: false, error: failed.length ? "None of the documents could be read. See the Documents tab for details." : "Upload a document or paste the inquiry text first." };
    const chars = docs.reduce((n, d) => n + d.segments.reduce((m, s) => m + s.text.length, 0), 0);
    if (provider.isAI && chars > MAX_AI_CHARS) return { ok: false, error: `The documents contain ${chars.toLocaleString()} characters, more than the ${MAX_AI_CHARS.toLocaleString()} limit per run. Remove documents that are not needed.` };

    const reviewed = await asUser(ctx.user.id, (tx) => tx`
      select 1 from requirements r where r.inquiry_id = ${inquiryId}
        and (r.corrected_at is not null or r.ai_run_id is null
             or exists (select 1 from product_matches m where m.requirement_id = r.id and m.decision <> 'pending')) limit 1`);
    if (reviewed.length && !opts.replaceReviewed)
      return { ok: false, error: "Requirements have been edited or matched already. Re-running extraction would replace them. Confirm to replace." };

    const begun = await beginRun(ctx, inquiryId, "extract", provider, fingerprint);
    const run = "reuse" in begun && begun.reuse ? null : (begun as { runId: string });
    let output;
    if (run) {
      runId = run.runId;
      await asUser(ctx.user.id, (tx) => tx`update inquiries set status = 'processing', updated_at = now() where id = ${inquiryId}`);
      const res = await provider.extract(docs, { today: today() });
      output = res.output;
      await asUser(ctx.user.id, (tx) => tx`update ai_runs set output = ${tx.json(res.output as never)}, input_tokens = ${res.usage.inputTokens ?? null},
        output_tokens = ${res.usage.outputTokens ?? null} where id = ${runId!}`);
    } else {
      output = (begun as { reuse: { output: unknown; id: string } }).reuse.output;
      runId = (begun as { reuse: { id: string } }).reuse.id;
    }
    const v = verifyExtraction(output as never, docs);

    await asUser(ctx.user.id, async (tx) => {
      await tx`delete from requirements where inquiry_id = ${inquiryId}`;
      let i = 0;
      for (const it of v.items) {
        await tx`insert into requirements (company_id, inquiry_id, ai_run_id, item_no, description, quantity, unit, specifications,
                   requested_brand, attributes, delivery_location, required_delivery_date, source_document_id, source_ref, source_excerpt,
                   needs_clarification, original, sort_order)
                 values (${ctx.company.companyId}, ${inquiryId}, ${runId!}, ${it.item_no}, ${it.description}, ${it.quantity}, ${it.unit},
                   ${it.specifications}, ${it.requested_brand}, ${tx.json(it.attributes)}, ${it.delivery_location}, ${it.required_delivery_date},
                   ${it.documentId}, ${it.documentId ? it.ref : `Pasted text, ${it.ref}`}, ${it.excerpt}, ${it.needs_clarification},
                   ${tx.json({ ...it.original, removed_values: it.removed_values } as never)}, ${i++})`;
      }
      const needsClar = v.items.some((x) => x.needs_clarification.length) || v.rejected.length > 0 || v.items.length === 0;
      await tx`update inquiries set status = ${needsClar ? "needs_clarification" : "ready_for_review"},
                 quotation_deadline = coalesce(quotation_deadline, ${v.quotationDeadline?.value ?? null}::date), updated_at = now()
               where id = ${inquiryId}`;
      await tx`update ai_runs set status = 'succeeded', finished_at = coalesce(finished_at, now()),
                 output = coalesce(output, ${tx.json(output as never)}) where id = ${runId!}`;
    });
    const notes = [...v.notes, ...v.rejected.map((r) => `Not added — "${r.description.slice(0, 60)}": ${r.reason}.`)];
    if (failed.length) notes.push(`Not processed (could not be read): ${failed.join(", ")}.`);
    return { ok: true, data: { count: v.items.length }, message: notes.join("\n") || undefined };
  } catch (e) {
    if (runId) {
      const err = await failRun(ctx, runId, e);
      await asUser(ctx.user.id, (tx) => tx`update inquiries set status = case when status = 'processing' then 'new' else status end where id = ${inquiryId}`);
      return { ok: false, error: err.message };
    }
    return errorResult(e);
  }
}

// ---------------------------------------------------------------- summary

export async function runSummary(ctx: Ctx, inquiryId: string): Promise<ActionResult> {
  let runId: string | undefined;
  try {
    const { inq, docs, fingerprint, reqs } = await asUser(ctx.user.id, async (tx) => {
      const inq = await inquiryOrThrow(tx, ctx, inquiryId);
      const d = await loadDocs(tx, inquiryId, inq.pasted_text);
      const reqs = await tx`select r.item_no, r.description, r.quantity, r.unit, r.specifications, r.requested_brand, r.attributes,
          r.delivery_location, r.required_delivery_date::text, r.source_ref as ref, r.needs_clarification, r.source_document_id
        from requirements r where r.inquiry_id = ${inquiryId} order by r.sort_order`;
      return { inq, ...d, reqs };
    });
    if (reqs.length === 0) return { ok: false, error: "Extract requirements before summarising." };
    const provider = getProvider({ demo: inq.is_demo });
    const docIndex = new Map(docs.map((d) => [d.documentId, d.index]));
    const reqJson = JSON.stringify(reqs.map((r) => ({ ...r, doc: docIndex.get(r.source_document_id as string) ?? null, source_document_id: undefined })));
    const begun = await beginRun(ctx, inquiryId, "summarize", provider, sha(fingerprint + reqJson));
    let output: unknown;
    if ("reuse" in begun && begun.reuse) { output = begun.reuse.output; runId = begun.reuse.id; }
    else {
      runId = (begun as { runId: string }).runId;
      const res = await provider.summarize(docs, reqJson, { today: today() });
      output = res.output;
    }
    // Facts must cite real locations; uncited "facts" are moved to suggestions-level text.
    const valid = (refs: { doc: number; ref: string }[]) => refs.filter((r) => docs[r.doc]?.segments.some((s) => s.ref === r.ref))
      .map((r) => ({ doc: docs[r.doc].name, ref: r.ref }));
    const o = output as import("@/lib/ai/types").SummaryOutput;
    const content = {
      provider: provider.name, isAI: provider.isAI, model: provider.model,
      overview: o.overview,
      scope_of_supply: o.scope_of_supply.map((s) => ({ text: s.text, sources: valid(s.refs) })),
      deadlines: o.deadlines.map((s) => ({ text: s.text, sources: valid(s.refs) })),
      conflicts: o.conflicts.map((s) => ({ text: s.text, sources: valid(s.refs) })),
      missing_information: o.missing_information, suggested_next_actions: o.suggested_next_actions,
      clarification_questions: o.clarification_questions,
    };
    await asUser(ctx.user.id, async (tx) => {
      await tx`insert into inquiry_summaries (company_id, inquiry_id, ai_run_id, content)
               values (${ctx.company.companyId}, ${inquiryId}, ${runId!}, ${tx.json(content as never)})`;
      await tx`update ai_runs set status = 'succeeded', output = ${tx.json(output as never)}, finished_at = now() where id = ${runId!}`;
    });
    return { ok: true };
  } catch (e) {
    if (runId) return { ok: false, error: (await failRun(ctx, runId, e)).message };
    return errorResult(e);
  }
}

// ---------------------------------------------------------------- matching

export async function runMatching(ctx: Ctx, inquiryId: string): Promise<ActionResult<{ count: number }>> {
  let runId: string | undefined;
  try {
    const { inq, reqs, products } = await asUser(ctx.user.id, async (tx) => {
      const inq = await inquiryOrThrow(tx, ctx, inquiryId);
      // Only requirements without a decided match are (re)matched; approved/rejected decisions are kept.
      const reqs = await tx<{ id: string; description: string; quantity: string | null; unit: string | null; specifications: string | null;
        requested_brand: string | null; attributes: Record<string, string> }[]>`
        select r.id, r.description, r.quantity::text, r.unit, r.specifications, r.requested_brand, r.attributes from requirements r
         where r.inquiry_id = ${inquiryId}
           and not exists (select 1 from product_matches m where m.requirement_id = r.id and m.decision = 'approved')
         order by r.sort_order`;
      const products = await tx<{ id: string; sku: string; name: string; brand: string | null; category: string | null; description: string | null;
        specifications: Record<string, unknown>; unit: string; variants: string[] }[]>`
        select id, sku, name, brand, category, description, specifications, unit, variants from catalogue_products
         where company_id = ${ctx.company.companyId} and active`;
      return { inq, reqs, products };
    });
    if (reqs.length === 0) return { ok: false, error: "There are no requirements waiting for a product match." };
    if (products.length === 0) return { ok: false, error: "The product catalogue is empty. Add products before matching." };
    const provider = getProvider({ demo: inq.is_demo });
    const mreqs: MatchRequirement[] = reqs.map((r, i) => ({ key: `R${i + 1}`, description: r.description, quantity: r.quantity, unit: r.unit,
      specifications: r.specifications, requested_brand: r.requested_brand, attributes: r.attributes }));
    const keyToReq = new Map(mreqs.map((m, i) => [m.key, reqs[i].id]));
    const mprods: MatchProduct[] = products.map((p, i) => ({ key: `P${i + 1}`, sku: p.sku, name: p.name, brand: p.brand, category: p.category,
      description: p.description, specifications: p.specifications, unit: p.unit, variants: p.variants }));
    const keyToProd = new Map(mprods.map((m, i) => [m.key, products[i].id]));
    const candidates = selectCandidates(mreqs, mprods);
    const begun = await beginRun(ctx, inquiryId, "match", provider, sha(JSON.stringify([mreqs, candidates])));
    let output: unknown;
    if ("reuse" in begun && begun.reuse) { output = begun.reuse.output; runId = begun.reuse.id; }
    else {
      runId = (begun as { runId: string }).runId;
      const empties = mreqs.filter((r) => candidates[r.key].length === 0);
      const toAsk = mreqs.filter((r) => candidates[r.key].length > 0);
      const res = toAsk.length ? await provider.match(toAsk, candidates) : { output: { matches: [] } };
      output = { matches: [...res.output.matches, ...empties.map((r) => ({ requirement_key: r.key, candidates: [],
        no_match_reason: "No catalogue product shares any terms with this requirement." }))] };
    }
    const { matches } = verifyMatches(output as never, mreqs, candidates);
    await asUser(ctx.user.id, async (tx) => {
      await tx`delete from product_matches where requirement_id in ${tx(reqs.map((r) => r.id))} and decision = 'pending'`;
      for (const m of matches) {
        await tx`insert into product_matches (company_id, requirement_id, product_id, label, similarities, differences, missing_evidence, ai_run_id)
                 values (${ctx.company.companyId}, ${keyToReq.get(m.requirementKey)!}, ${m.productKey ? keyToProd.get(m.productKey)! : null},
                   ${m.label}, ${m.similarities}, ${m.differences}, ${m.missing_evidence}, ${runId!})`;
      }
      await tx`update ai_runs set status = 'succeeded', output = ${tx.json(output as never)}, finished_at = now() where id = ${runId!}`;
    });
    return { ok: true, data: { count: matches.length } };
  } catch (e) {
    if (runId) return { ok: false, error: (await failRun(ctx, runId, e)).message };
    return errorResult(e);
  }
}
