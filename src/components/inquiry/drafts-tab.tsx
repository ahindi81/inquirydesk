"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { saveClarificationAction } from "@/app/actions/inquiry";
import { createQuotationAction } from "@/app/actions/quotation";
import { Alert, Badge, Button, Card, Textarea, fmtDate } from "../ui";
import type { ReqRow } from "./requirements-tab";
import type { MatchRow } from "./matches-tab";

export function DraftsTab({ inquiryId, reqs, matches, quotes, draft, draftUpdatedAt, defaultEmail }: {
  inquiryId: string; reqs: ReqRow[]; matches: MatchRow[]; quotes: { id: string; quote_number: string; revision_no: number; status: string }[];
  draft: string | null; draftUpdatedAt: Date | null; defaultEmail: string;
}) {
  const router = useRouter();
  const [text, setText] = useState(draft ?? defaultEmail);
  const [note, setNote] = useState<{ tone: "success" | "error"; msg: string } | null>(null);
  const [pending, start] = useTransition();
  const approvedReqIds = new Set(matches.filter((m) => m.decision === "approved").map((m) => m.requirement_id));
  const omitted = reqs.filter((r) => !approvedReqIds.has(r.id));
  const flagged = reqs.filter((r) => r.needs_clarification.length).length;

  const save = () => start(async () => {
    const r = await saveClarificationAction(inquiryId, text);
    setNote(r.ok ? { tone: "success", msg: r.message ?? "Saved." } : { tone: "error", msg: r.error });
    router.refresh();
  });
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setNote({ tone: "success", msg: "Copied. Paste it into your email — nothing has been sent." }); }
    catch { setNote({ tone: "error", msg: "Copy failed. Select the text and copy it manually." }); }
  };
  const prepare = () => start(async () => {
    const r = await createQuotationAction(inquiryId);
    if (!r.ok) { setNote({ tone: "error", msg: r.error }); return; }
    router.push(`/quotations/${r.data!.quotationId}`);
  });

  return (
    <div className="grid gap-5 xl:grid-cols-2">
      <Card title="A. Clarification email" actions={<Badge tone="gray">Never sent automatically</Badge>}>
        <div className="space-y-3">
          <p className="text-sm text-muted">{flagged ? `Built from ${flagged} item(s) needing clarification and the summary's questions.` : "No items are flagged. Edit or skip this email."}
            {draftUpdatedAt && ` Last saved ${fmtDate(draftUpdatedAt)}.`}</p>
          <label htmlFor="clar" className="sr-only">Clarification email</label>
          <Textarea id="clar" rows={18} value={text} onChange={(e) => setText(e.target.value)} className="font-mono text-[13px]" />
          <div className="flex flex-wrap gap-2">
            <Button onClick={save} disabled={pending}>Save draft</Button>
            <Button variant="secondary" onClick={copy}>Copy text</Button>
            <Button variant="ghost" onClick={() => { if (confirm("Replace your edits with a freshly generated draft?")) setText(defaultEmail); }}>Regenerate from current data</Button>
          </div>
          {note && <Alert tone={note.tone}>{note.msg}</Alert>}
        </div>
      </Card>

      <Card title="B. Quotation">
        <div className="space-y-4">
          {quotes.length > 0 && (
            <ul className="divide-y divide-line rounded-md border border-line">
              {quotes.map((q) => (
                <li key={q.id} className="flex items-center justify-between px-3 py-2 text-sm">
                  <Link href={`/quotations/${q.id}`} className="font-medium hover:underline">{q.quote_number} · Rev {q.revision_no}</Link>
                  <Badge tone={q.status === "approved" ? "green" : q.status === "draft" ? "blue" : "gray"}>{q.status === "draft" ? "Draft" : q.status === "approved" ? "Approved" : "Superseded"}</Badge>
                </li>
              ))}
            </ul>
          )}
          <p className="text-sm">{approvedReqIds.size} of {reqs.length} item(s) have an approved product and will be included.</p>
          {omitted.length > 0 && (
            <Alert tone="warning" title={`${omitted.length} inquiry item(s) will not be in the quotation`}>
              {omitted.slice(0, 10).map((r) => `• ${r.item_no ? r.item_no + " " : ""}${r.description}`).join("\n")}{omitted.length > 10 ? `\n…and ${omitted.length - 10} more` : ""}
              {"\n"}Approve a product on the Matches tab, or add lines later in the quotation editor.
            </Alert>
          )}
          {quotes.some((q) => q.status === "draft")
            ? <p className="text-sm text-muted">A draft is already open — continue in the quotation editor.</p>
            : <Button onClick={prepare} disabled={pending || approvedReqIds.size === 0}>{pending ? "Preparing…" : "Prepare quotation from approved items"}</Button>}
          {approvedReqIds.size === 0 && <p className="text-xs text-muted">Approve at least one product on the Matches tab first.</p>}
          <p className="text-xs text-muted">Prices are taken from your approved catalogue prices. Missing prices and quantities stay blank until you enter them; totals are calculated by the application, not by AI.</p>
        </div>
      </Card>
    </div>
  );
}
