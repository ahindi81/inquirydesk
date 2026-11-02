"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { deleteDocumentAction, deleteInquiryAction, extractAction, updateInquiryAction, uploadDocumentAction } from "@/app/actions/inquiry";
import { Badge, Button, Card, Field, Input, Select, Table, Textarea, td, th } from "../ui";
import { RunButton, Spinner } from "./run-button";

type Doc = { id: string; file_name: string; mime_type: string; size_bytes: string; status: string; error_message: string | null; ocr_used: boolean; lines: number };
type Upload = { name: string; state: "waiting" | "uploading" | "done" | "failed"; message?: string };

const ACCEPT = ".pdf,.docx,.xlsx,.csv,.txt,.eml,.png,.jpg,.jpeg,.webp,.tif,.tiff";
const MAX = 25 * 1024 * 1024;

export function DocumentsTab({ inquiry, docs, members, engineLabel, hasReqs }: {
  inquiry: { id: string; customer_name: string; project_name: string | null; reference_number: string | null; quotation_deadline: string | null;
    pasted_text: string | null; owner_id: string | null };
  docs: Doc[]; members: { id: string; name: string }[]; engineLabel: string; hasReqs: boolean;
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  async function uploadFiles(files: File[]) {
    setBusy(true);
    const list: Upload[] = files.map((f) => ({ name: f.name, state: "waiting" }));
    setUploads(list);
    const update = (i: number, u: Partial<Upload>) => setUploads((cur) => cur.map((x, j) => (j === i ? { ...x, ...u } : x)));
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (f.size > MAX) { update(i, { state: "failed", message: `${(f.size / 1048576).toFixed(1)} MB — the limit is 25 MB.` }); continue; }
      update(i, { state: "uploading" });
      const fd = new FormData(); fd.set("inquiryId", inquiry.id); fd.set("file", f);
      try {
        const r = await uploadDocumentAction(fd);
        if (!r.ok) update(i, { state: "failed", message: r.error });
        else update(i, { state: r.data?.status === "failed" ? "failed" : "done", message: r.data?.message });
      } catch {
        update(i, { state: "failed", message: "Upload did not complete. Check your connection; the file may be too large." });
      }
    }
    setBusy(false);
    if (input.current) input.current.value = "";
    router.refresh();
  }

  const readable = docs.filter((d) => d.status === "extracted").length + (inquiry.pasted_text ? 1 : 0);

  return (
    <div className="grid gap-5 xl:grid-cols-[1fr_380px]">
      <div className="space-y-5">
        <Card title="Inquiry documents">
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); if (!busy) uploadFiles([...e.dataTransfer.files]); }}
            className="rounded-lg border-2 border-dashed border-line bg-canvas/50 p-5 text-center">
            <p className="text-sm">Drag files here, or</p>
            <label className="mt-2 inline-flex cursor-pointer items-center rounded-md bg-brand-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-brand-700 focus-within:ring-2 focus-within:ring-brand-500">
              Choose files
              <input ref={input} type="file" multiple accept={ACCEPT} className="sr-only" disabled={busy}
                onChange={(e) => e.target.files && uploadFiles([...e.target.files])} />
            </label>
            <p className="mt-2 text-xs text-muted">PDF, Word (.docx), Excel (.xlsx), CSV, text or images · up to 25 MB each · English and Arabic. Scanned pages are read with OCR where available.</p>
          </div>
          {uploads.length > 0 && (
            <ul className="mt-4 space-y-1.5" aria-live="polite">
              {uploads.map((u, i) => (
                <li key={i} className="flex items-start gap-2 text-sm">
                  <span className="mt-0.5 w-20 shrink-0">
                    {u.state === "uploading" ? <span className="inline-flex items-center gap-1 text-sky-700"><Spinner /> Reading</span>
                      : u.state === "done" ? <Badge tone="green">Done</Badge> : u.state === "failed" ? <Badge tone="red">Failed</Badge> : <Badge>Waiting</Badge>}
                  </span>
                  <span className="min-w-0"><span className="font-medium" dir="auto">{u.name}</span>{u.message && <span className="block text-xs text-muted">{u.message}</span>}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-5">
            {docs.length === 0 ? <p className="text-sm text-muted">No files uploaded yet.</p> : (
              <Table>
                <thead><tr><th className={th}>File</th><th className={th}>Size</th><th className={th}>Result</th><th className={th}></th></tr></thead>
                <tbody>
                  {docs.map((d) => (
                    <tr key={d.id}>
                      <td className={td}><a className="font-medium hover:underline" dir="auto" href={`/api/files/document/${d.id}`}>{d.file_name}</a></td>
                      <td className={`${td} tabular whitespace-nowrap`}>{(Number(d.size_bytes) / 1024).toFixed(0)} KB</td>
                      <td className={td}>
                        {d.status === "extracted" && <Badge tone="green">Read · {d.lines} lines{d.ocr_used ? " · OCR" : ""}</Badge>}
                        {d.status === "failed" && <Badge tone="red">Could not read</Badge>}
                        {d.status === "processing" && <Badge tone="blue">Processing</Badge>}
                        {d.error_message && <p className={`mt-1 text-xs ${d.status === "failed" ? "text-red-700" : "text-amber-800"}`}>{d.error_message}</p>}
                      </td>
                      <td className={`${td} text-end`}>
                        <form action={deleteDocumentAction} onSubmit={(e) => { if (!confirm(`Delete "${d.file_name}"?`)) e.preventDefault(); }}>
                          <input type="hidden" name="id" value={d.id} /><input type="hidden" name="inquiryId" value={inquiry.id} />
                          <button className="text-xs text-red-700 underline" type="submit">Delete</button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </div>
        </Card>

        <Card title="Extract requirements">
          {readable === 0 ? <p className="text-sm text-muted">Upload at least one readable document or paste the inquiry text first.</p> : (
            <div className="space-y-3">
              <p className="text-sm text-muted">{readable} source(s) ready. Items will be read by {engineLabel}. Each item keeps a link to the exact place it came from; values that cannot be found in the documents are left blank and marked “Needs clarification”.</p>
              <RunButton pendingLabel="Reading documents…"
                run={(confirmed) => extractAction(inquiry.id, confirmed)}
                retryWithConfirm={(r) => (!r.ok && /Confirm to replace/.test(r.error) ? "Requirements were already edited or matched. Replace them with a fresh extraction? Your edits and match decisions will be lost." : null)}
                onDone={(r) => { if (r.ok) router.push(`/inquiries/${inquiry.id}?tab=requirements`); }}>
                {hasReqs ? "Extract again" : "Extract requirements"}
              </RunButton>
            </div>
          )}
        </Card>
      </div>

      <div className="space-y-5">
        <Card title="Inquiry details">
          <form action={async (fd) => { const r = await updateInquiryAction(fd); setSaved(r.ok ? "Saved." : r.error); router.refresh(); }} className="space-y-3">
            <input type="hidden" name="id" value={inquiry.id} />
            <Field label="Customer" htmlFor="customer_name"><Input id="customer_name" name="customer_name" defaultValue={inquiry.customer_name} required /></Field>
            <Field label="Project" htmlFor="project_name"><Input id="project_name" name="project_name" defaultValue={inquiry.project_name ?? ""} /></Field>
            <Field label="Reference" htmlFor="reference_number"><Input id="reference_number" name="reference_number" defaultValue={inquiry.reference_number ?? ""} /></Field>
            <Field label="Owner" htmlFor="owner_id">
              <Select id="owner_id" name="owner_id" defaultValue={inquiry.owner_id ?? ""}>
                <option value="">Unassigned</option>{members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </Select>
            </Field>
            <Field label="Quotation deadline" htmlFor="quotation_deadline"><Input id="quotation_deadline" name="quotation_deadline" type="date" defaultValue={inquiry.quotation_deadline ?? ""} /></Field>
            <Field label="Pasted email / inquiry text" htmlFor="pasted_text"><Textarea id="pasted_text" name="pasted_text" rows={8} defaultValue={inquiry.pasted_text ?? ""} /></Field>
            <Button type="submit" variant="secondary">Save details</Button>
            {saved && <p className="text-xs text-muted" role="status">{saved}</p>}
          </form>
        </Card>
        <Card title="Delete inquiry">
          <form action={deleteInquiryAction} className="space-y-2">
            <input type="hidden" name="id" value={inquiry.id} />
            <p className="text-sm text-muted">Permanently deletes this inquiry, its uploaded files, requirements, matches and quotations.</p>
            <Field label='Type "delete" to confirm' htmlFor="confirm"><Input id="confirm" name="confirm" autoComplete="off" /></Field>
            <Button variant="danger" type="submit">Delete inquiry</Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
