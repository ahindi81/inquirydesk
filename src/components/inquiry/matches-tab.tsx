"use client";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { decideMatchAction, manualMatchAction, matchAction } from "@/app/actions/inquiry";
import { Alert, Badge, Button, ButtonLink, Empty, fmtMoney, fmtQty } from "../ui";
import { RunButton } from "./run-button";
import type { ReqRow } from "./requirements-tab";

export type MatchRow = { id: string; requirement_id: string; product_id: string | null; label: "potential_match" | "alternative" | "no_match";
  similarities: string[]; differences: string[]; missing_evidence: string[]; is_manual: boolean; decision: "pending" | "approved" | "rejected";
  sku: string | null; product_name: string | null; brand: string | null; product_unit: string | null; unit_price: string | null; currency: string | null;
  lead_time_days: number | null; decided_by_name: string };
export type ProductOption = { id: string; sku: string; name: string; unit: string; unit_price: string | null; currency: string | null };

const LABEL = { potential_match: { t: "Potential match", tone: "green" as const }, alternative: { t: "Alternative", tone: "blue" as const }, no_match: { t: "No match", tone: "gray" as const } };

export function MatchesTab({ inquiryId, reqs, matches, products }: { inquiryId: string; reqs: ReqRow[]; matches: MatchRow[]; products: ProductOption[] }) {
  const byReq = useMemo(() => {
    const m = new Map<string, MatchRow[]>();
    for (const x of matches) m.set(x.requirement_id, [...(m.get(x.requirement_id) ?? []), x]);
    return m;
  }, [matches]);
  if (reqs.length === 0) return <Empty title="Extract requirements first" action={<ButtonLink href={`/inquiries/${inquiryId}?tab=documents`}>Go to documents</ButtonLink>} />;
  const approved = reqs.filter((r) => byReq.get(r.id)?.some((m) => m.decision === "approved")).length;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="text-sm text-muted">
          <p>{approved} of {reqs.length} item(s) have an approved product. Suggestions come only from your catalogue and need your approval.</p>
          {products.length === 0 && <p className="mt-1 text-amber-800">Your catalogue is empty — add products first.</p>}
        </div>
        <div className="flex items-start gap-2">
          <RunButton variant={matches.length ? "secondary" : "primary"} pendingLabel="Comparing with catalogue…" run={() => matchAction(inquiryId)}>
            {matches.length ? "Re-run matching for undecided items" : "Find catalogue matches"}</RunButton>
          {approved > 0 && <ButtonLink href={`/inquiries/${inquiryId}?tab=drafts`}>Next: drafts</ButtonLink>}
        </div>
      </div>
      {reqs.map((r) => <ReqMatches key={r.id} inquiryId={inquiryId} r={r} rows={byReq.get(r.id) ?? []} products={products} />)}
    </div>
  );
}

function ReqMatches({ inquiryId, r, rows, products }: { inquiryId: string; r: ReqRow; rows: MatchRow[]; products: ProductOption[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState("");
  const [showRejected, setShowRejected] = useState(false);
  const act = (fn: () => Promise<{ ok: boolean; error?: string }>) => start(async () => {
    const res = await fn(); setError(res.ok ? null : (res as { error: string }).error); router.refresh();
  });
  const visible = rows.filter((m) => showRejected || m.decision !== "rejected");
  const hasApproved = rows.some((m) => m.decision === "approved");
  return (
    <section className={`rounded-lg border bg-white ${hasApproved ? "border-brand-100" : "border-line"}`}>
      <header className="flex flex-wrap items-start justify-between gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <p className="font-medium" dir="auto">{r.item_no ? `${r.item_no} · ` : ""}{r.description}</p>
          <p className="text-xs text-muted" dir="auto">
            {r.quantity ? `${fmtQty(r.quantity)} ${r.unit ?? ""}` : "Quantity needs clarification"}{r.specifications ? ` · ${r.specifications}` : ""}
            {Object.values(r.attributes).length ? ` · ${Object.values(r.attributes).join(", ")}` : ""}
          </p>
        </div>
        {hasApproved ? <Badge tone="green">Product approved</Badge> : rows.length ? <Badge tone="amber">Awaiting decision</Badge> : <Badge>Not matched yet</Badge>}
      </header>
      <div className="space-y-3 p-4">
        {error && <Alert tone="error">{error}</Alert>}
        {visible.length === 0 && <p className="text-sm text-muted">No suggestions yet. Run matching or choose a product below.</p>}
        {visible.map((m) => (
          <div key={m.id} className={`rounded-md border p-3 ${m.decision === "approved" ? "border-brand-500 bg-brand-50/50" : m.decision === "rejected" ? "border-line opacity-60" : "border-line"}`}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={LABEL[m.label].tone}>{m.is_manual ? "Chosen manually" : LABEL[m.label].t}</Badge>
                  {m.product_id && <span className="font-medium" dir="auto">{m.product_name}</span>}
                  {m.sku && <span className="font-mono text-xs text-muted">{m.sku}</span>}
                </div>
                {m.product_id && (
                  <p className="mt-1 text-xs text-muted">
                    {m.brand ? `${m.brand} · ` : ""}Unit: {m.product_unit}
                    {r.unit && m.product_unit && r.unit.toLowerCase() !== m.product_unit.toLowerCase() ? <span className="text-amber-800"> (inquiry uses “{r.unit}”)</span> : null}
                    {" · "}Price: {m.unit_price ? fmtMoney(fmtQty(m.unit_price), m.currency ?? "") : <span className="text-amber-800">no approved price</span>}
                    {" · "}Lead time: {m.lead_time_days !== null ? `${m.lead_time_days} days` : "not confirmed"}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 gap-2">
                {m.decision === "pending" && m.product_id && <Button onClick={() => act(() => decideMatchAction(inquiryId, m.id, "approved"))} disabled={pending}>Approve</Button>}
                {m.decision === "pending" && m.product_id && <Button variant="secondary" onClick={() => act(() => decideMatchAction(inquiryId, m.id, "rejected"))} disabled={pending}>Reject</Button>}
                {m.decision !== "pending" && (
                  <>
                    <span className="self-center text-xs text-muted">{m.decision === "approved" ? "Approved" : "Rejected"} by {m.decided_by_name}</span>
                    <Button variant="ghost" onClick={() => act(() => decideMatchAction(inquiryId, m.id, "pending"))} disabled={pending}>Undo</Button>
                  </>
                )}
              </div>
            </div>
            <div className="mt-2 grid gap-3 text-xs md:grid-cols-3">
              <Reasons title="Similarities" items={m.similarities} />
              <Reasons title="Differences" items={m.differences} tone="text-amber-900" />
              <Reasons title="Missing evidence" items={m.missing_evidence} tone="text-red-800" />
            </div>
          </div>
        ))}
        {rows.some((m) => m.decision === "rejected") && (
          <button className="text-xs text-muted underline" onClick={() => setShowRejected(!showRejected)}>{showRejected ? "Hide" : "Show"} rejected suggestions</button>
        )}
        <form className="flex flex-wrap items-end gap-2 border-t border-line pt-3"
          action={() => { if (manual) act(() => manualMatchAction(inquiryId, r.id, manual)); }}>
          <div className="min-w-[260px] flex-1">
            <label htmlFor={`manual-${r.id}`} className="block text-xs font-medium">Choose a different catalogue product</label>
            <select id={`manual-${r.id}`} value={manual} onChange={(e) => setManual(e.target.value)} className="mt-1 block w-full rounded-md border border-line bg-white px-2 py-1.5 text-sm">
              <option value="">Select product…</option>
              {products.map((p) => <option key={p.id} value={p.id}>{p.sku} — {p.name} ({p.unit}{p.unit_price ? `, ${fmtQty(p.unit_price)} ${p.currency}` : ", no price"})</option>)}
            </select>
          </div>
          <Button type="submit" variant="secondary" disabled={!manual || pending}>Use this product</Button>
        </form>
      </div>
    </section>
  );
}

function Reasons({ title, items, tone = "" }: { title: string; items: string[]; tone?: string }) {
  return (
    <div>
      <p className="font-semibold text-muted">{title}</p>
      {items.length === 0 ? <p className="text-muted">—</p> : <ul className={`list-disc ps-4 ${tone}`}>{items.map((t, i) => <li key={i} dir="auto">{t}</li>)}</ul>}
    </div>
  );
}
