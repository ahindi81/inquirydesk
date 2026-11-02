"use client";
import { Fragment, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { deleteRequirementAction, saveRequirementAction } from "@/app/actions/inquiry";
import { Alert, Badge, Button, ButtonLink, Empty, Input, Textarea, fmtDate, fmtQty, td, th } from "../ui";

export type ReqRow = {
  id: string; item_no: string | null; description: string; quantity: string | null; unit: string | null; specifications: string | null;
  requested_brand: string | null; attributes: Record<string, string>; delivery_location: string | null; required_delivery_date: string | null;
  source_ref: string | null; source_excerpt: string | null; needs_clarification: string[]; original: Record<string, unknown> | null;
  corrected: boolean; from_ai: boolean; source_file: string | null; source_doc_id: string | null;
};

const NC = () => <Badge tone="amber">Needs clarification</Badge>;
const FIELDS: [keyof Omit<ReqRow, "attributes">, string][] = [["item_no", "Item no."], ["description", "Description"], ["quantity", "Quantity"],
  ["unit", "Unit"], ["specifications", "Specifications"], ["requested_brand", "Brand / model"], ["delivery_location", "Delivery location"],
  ["required_delivery_date", "Required delivery date"]];

export function RequirementsTab({ inquiryId, reqs, engineIsAI }: { inquiryId: string; reqs: ReqRow[]; engineIsAI: boolean }) {
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [showSource, setShowSource] = useState<Set<string>>(new Set());
  const flagged = reqs.filter((r) => r.needs_clarification.length).length;

  if (reqs.length === 0 && editing !== "new") {
    return <Empty title="No requirements yet" action={<div className="flex gap-2"><ButtonLink href={`/inquiries/${inquiryId}?tab=documents`}>Go to documents</ButtonLink>
      <Button variant="secondary" onClick={() => setEditing("new")}>Add a requirement manually</Button></div>}>
      Upload documents and run extraction, or add items yourself.</Empty>;
  }
  const toggle = (id: string) => setShowSource((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">{reqs.length} item(s){flagged ? ` · ${flagged} need clarification` : ""} · extracted by {engineIsAI ? "AI" : "the rule-based reader"}, verified against the source text. Click “Source” to see the evidence.</p>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setEditing("new")}>Add item</Button>
          <ButtonLink href={`/inquiries/${inquiryId}?tab=summary`}>Next: summary</ButtonLink>
        </div>
      </div>
      <div className="overflow-x-auto rounded-lg border border-line bg-white">
        <table className="w-full min-w-[900px] border-collapse text-sm">
          <thead><tr>
            <th className={th}>Item</th><th className={th}>Requested product / service</th><th className={`${th} text-end`}>Qty</th><th className={th}>Unit</th>
            <th className={th}>Delivery</th><th className={th}>Source</th><th className={th}></th>
          </tr></thead>
          <tbody>
            {editing === "new" && <tr><td colSpan={7} className="border-b border-line bg-brand-50/40 p-3"><ReqEditor inquiryId={inquiryId} onDone={() => setEditing(null)} /></td></tr>}
            {reqs.map((r) => (
              <Fragment key={r.id}>
                <tr className={editing === r.id ? "bg-brand-50/40" : ""}>
                  <td className={`${td} whitespace-nowrap`} dir="auto">{r.item_no ?? <span className="text-muted">—</span>}</td>
                  <td className={td}>
                    <p className="font-medium" dir="auto">{r.description}</p>
                    <div className="mt-1 space-y-0.5 text-xs text-muted">
                      {r.specifications && <p dir="auto">Spec: {r.specifications}</p>}
                      {r.requested_brand && <p dir="auto">Brand/model: {r.requested_brand}</p>}
                      {Object.entries(r.attributes).map(([k, v]) => <p key={k} dir="auto">{k[0].toUpperCase() + k.slice(1)}: {v}</p>)}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {r.corrected && <Badge tone="blue">Edited by salesperson</Badge>}
                      {!r.from_ai && <Badge>Added manually</Badge>}
                    </div>
                  </td>
                  <td className={`${td} tabular text-end`}>{r.quantity ? fmtQty(r.quantity) : <NC />}</td>
                  <td className={td} dir="auto">{r.unit ?? <NC />}</td>
                  <td className={`${td} text-xs`}>
                    <p dir="auto">{r.delivery_location ?? <NC />}</p>
                    <p className="mt-1">{r.required_delivery_date ? fmtDate(r.required_delivery_date) : <NC />}</p>
                  </td>
                  <td className={`${td} text-xs`}>
                    {r.source_ref ? (
                      <button type="button" onClick={() => toggle(r.id)} className="text-start text-brand-700 underline" aria-expanded={showSource.has(r.id)}>
                        {r.source_file ?? "Pasted text"} · {r.source_ref}
                      </button>
                    ) : <span className="text-muted">Manual</span>}
                  </td>
                  <td className={`${td} whitespace-nowrap text-end`}>
                    <button className="text-xs text-brand-700 underline" onClick={() => setEditing(editing === r.id ? null : r.id)}>{editing === r.id ? "Close" : "Edit"}</button>
                  </td>
                </tr>
                {showSource.has(r.id) && (
                  <tr><td colSpan={7} className="border-b border-line bg-canvas px-4 py-3 text-xs">
                    <p className="font-semibold">Source evidence {r.source_doc_id && <Link className="ms-2 font-normal underline" href={`/api/files/document/${r.source_doc_id}`}>open file</Link>}</p>
                    <blockquote className="mt-1 whitespace-pre-wrap rounded border-s-4 border-navy-200 bg-white px-3 py-2" dir="auto">{r.source_excerpt}</blockquote>
                    {r.original && (
                      <details className="mt-2">
                        <summary className="cursor-pointer">Original extraction{r.corrected ? " (before your edits)" : ""}</summary>
                        <dl className="mt-1 grid grid-cols-[160px_1fr] gap-x-3 gap-y-0.5">
                          {["item_no", "description", "quantity", "unit", "specifications", "requested_brand", "finish", "colour", "dimensions", "delivery_location", "required_delivery_date"].map((k) => (
                            <Fragment key={k}><dt className="text-muted">{k.replace(/_/g, " ")}</dt><dd dir="auto">{String(r.original![k] ?? "—")}</dd></Fragment>
                          ))}
                        </dl>
                        {Array.isArray(r.original.removed_values) && r.original.removed_values.length > 0 && (
                          <p className="mt-1 text-amber-800">Blanked because they were not found in the source text: {(r.original.removed_values as string[]).join(", ")}.</p>
                        )}
                      </details>
                    )}
                  </td></tr>
                )}
                {editing === r.id && <tr><td colSpan={7} className="border-b border-line bg-brand-50/40 p-3"><ReqEditor inquiryId={inquiryId} r={r} onDone={() => setEditing(null)} /></td></tr>}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ReqEditor({ inquiryId, r, onDone }: { inquiryId: string; r?: ReqRow; onDone: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const v = (k: string) => (r ? String((k in r.attributes ? r.attributes[k] : (r as unknown as Record<string, unknown>)[k]) ?? "") : "");
  const submit = (fd: FormData) => start(async () => {
    const values = Object.fromEntries([...FIELDS.map(([k]) => k), "finish", "colour", "dimensions"].map((k) => [k, String(fd.get(k) ?? "")]));
    const res = await saveRequirementAction(inquiryId, r?.id ?? null, values);
    if (!res.ok) { setError(res.error); return; }
    onDone(); router.refresh();
  });
  const del = () => start(async () => {
    if (!r || !confirm("Delete this requirement?")) return;
    const res = await deleteRequirementAction(inquiryId, r.id);
    if (!res.ok) { setError(res.error); return; }
    onDone(); router.refresh();
  });
  return (
    <form action={submit} className="space-y-3">
      {error && <Alert tone="error">{error}</Alert>}
      {r && <p className="text-xs text-muted">Saving keeps the original extraction for reference. Changing an item resets its approved product match.</p>}
      <div className="grid gap-3 md:grid-cols-4">
        {FIELDS.map(([k, label]) => (
          <div key={k} className={k === "description" || k === "specifications" ? "md:col-span-2" : ""}>
            <label htmlFor={`f-${k}`} className="block text-xs font-medium">{label}{k === "description" ? " *" : ""}</label>
            {k === "specifications" || k === "description"
              ? <Textarea id={`f-${k}`} name={k} rows={2} defaultValue={v(k)} required={k === "description"} />
              : <Input id={`f-${k}`} name={k} defaultValue={k === "quantity" ? fmtQty(v(k)) : v(k)} type={k === "required_delivery_date" ? "date" : "text"}
                  inputMode={k === "quantity" ? "decimal" : undefined} />}
          </div>
        ))}
        {(["finish", "colour", "dimensions"] as const).map((k) => (
          <div key={k}><label htmlFor={`f-${k}`} className="block text-xs font-medium">{k[0].toUpperCase() + k.slice(1)}</label><Input id={`f-${k}`} name={k} defaultValue={v(k)} /></div>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending}>{pending ? "Saving…" : r ? "Save changes" : "Add item"}</Button>
        <Button type="button" variant="secondary" onClick={onDone}>Cancel</Button>
        {r && <Button type="button" variant="danger" onClick={del} disabled={pending}>Delete item</Button>}
      </div>
    </form>
  );
}
