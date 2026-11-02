"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { addLineAction, approveQuotationAction, removeLineAction, reviseQuotationAction, setFxAction, setLineApprovalAction,
  updateLineAction, updateTermsAction } from "@/app/actions/quotation";
import type { QuoteResult } from "@/lib/quote/calculate";
import { Alert, Badge, Button, Card, Input, Textarea, fmtMoney, fmtQty, th } from "./ui";

type Rev = { id: string; status: string; currency: string; tax_rate: string; freight: string | null; validity_days: number | null;
  delivery_terms: string | null; payment_terms: string | null; exclusions: string | null; notes: string | null; approved_fx: Record<string, string>; quote_date: string };
type Line = { id: string; line_no: number; requirement_id: string | null; sku: string; description: string; quantity: string | null; unit: string;
  unit_price: string | null; currency: string; price_source: string; discount_percent: string; line_approved: boolean; catalogue_price: string | null; catalogue_currency: string | null };
type Product = { id: string; sku: string; name: string; unit: string; unit_price: string | null; currency: string | null };

export function QuotationEditor({ rev, lines, calc, reqs, products }: { rev: Rev; lines: Line[]; calc: QuoteResult;
  reqs: { id: string; item_no: string | null; description: string }[]; products: Product[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ tone: "error" | "success" | "warning"; text: string } | null>(null);
  const draft = rev.status === "draft";
  const run = (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>, okText?: string) => start(async () => {
    try {
      const r = await fn();
      setMsg(r.ok ? (r.message || okText ? { tone: "success", text: r.message ?? okText! } : null) : { tone: "error", text: r.error! });
    } catch { setMsg({ tone: "error", text: "The request did not complete. Please try again." }); }
    router.refresh();
  });
  const byLine = new Map(calc.lines.map((l) => [l.lineNo, l]));
  const lineIssues = (n: number) => calc.issues.filter((i) => i.lineNo === n && i.code !== "line_not_approved");
  const omitted = calc.issues.filter((i) => i.code === "omitted_requirement").map((i) => reqs.find((r) => r.id === i.requirementId)).filter(Boolean) as typeof reqs;
  const foreign = [...new Set(lines.map((l) => l.currency).filter((c) => c !== rev.currency))];
  const blocking = calc.issues.filter((i) => i.blocking);
  const allApproved = lines.length > 0 && lines.every((l) => l.line_approved);

  return (
    <div className="space-y-5">
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      {!draft && (
        <Alert tone="info" title={rev.status === "approved" ? "This revision is approved and locked" : "This revision was superseded"}>
          Any change to products, quantities, prices or terms is made in a new draft revision, which must be approved again.
          {rev.status === "approved" && <div className="mt-2"><Button variant="secondary" disabled={pending} onClick={() => run(() => reviseQuotationAction(rev.id))}>Create new revision to edit</Button></div>}
        </Alert>
      )}

      <Card title="Line items" actions={draft ? <Badge tone={allApproved ? "green" : "amber"}>{lines.filter((l) => l.line_approved).length}/{lines.length} lines approved</Badge> : undefined}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[920px] border-collapse text-sm">
            <thead><tr>
              <th className={th}>#</th><th className={th}>Code / description</th><th className={`${th} text-end`}>Qty</th><th className={th}>Unit</th>
              <th className={`${th} text-end`}>Unit price</th><th className={`${th} text-end`}>Disc. %</th><th className={`${th} text-end`}>Net ({rev.currency})</th>
              <th className={th}>{draft ? "Approve" : "Approved"}</th>
            </tr></thead>
            <tbody>
              {lines.map((l) => <LineRow key={l.id} l={l} draft={draft} revId={rev.id} net={byLine.get(l.line_no)?.net ?? null}
                issues={lineIssues(l.line_no).map((i) => i.message)} pending={pending} run={run} quoteCurrency={rev.currency} />)}
            </tbody>
          </table>
        </div>
        {lines.length === 0 && <p className="py-4 text-sm text-muted">No lines. Add a product below.</p>}
        {draft && <AddLine products={products} omitted={omitted} onAdd={(p, r) => run(() => addLineAction(rev.id, p, r))} pending={pending} />}
        {omitted.length > 0 && (
          <div className="mt-3"><Alert tone="warning" title={`${omitted.length} inquiry item(s) are not in this quotation`}>
            {omitted.map((r) => `• ${r.item_no ? r.item_no + " " : ""}${r.description}`).join("\n")}
          </Alert></div>
        )}
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Commercial terms">
          <form className="space-y-3" action={(fd) => run(() => updateTermsAction(rev.id, Object.fromEntries([...fd.entries()].map(([k, v]) => [k, String(v)]))))}>
            <fieldset disabled={!draft || pending} className="space-y-3">
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <Small label="Currency" name="currency" def={rev.currency} />
                <Small label="Tax rate %" name="tax_rate" def={fmtQty(rev.tax_rate)} />
                <Small label="Freight" name="freight" def={rev.freight ? fmtQty(rev.freight) : ""} placeholder="None" />
                <Small label="Validity (days)" name="validity_days" def={rev.validity_days?.toString() ?? ""} />
              </div>
              {(["delivery_terms", "payment_terms", "exclusions", "notes"] as const).map((k) => (
                <div key={k}>
                  <label htmlFor={`t-${k}`} className="block text-xs font-medium">{{ delivery_terms: "Delivery terms", payment_terms: "Payment terms", exclusions: "Exclusions", notes: "Notes" }[k]}</label>
                  <Textarea id={`t-${k}`} name={k} rows={2} defaultValue={rev[k] ?? ""} />
                </div>
              ))}
              {draft && <Button type="submit" variant="secondary">Save terms</Button>}
            </fieldset>
          </form>
        </Card>

        <div className="space-y-5">
          {foreign.length > 0 && (
            <Card title="Exchange rates">
              <p className="mb-3 text-sm text-muted">Some lines are priced in another currency. Totals can&apos;t be calculated until you approve a rate. Rates are not looked up automatically.</p>
              {foreign.map((c) => (
                <form key={c} className="mb-2 flex flex-wrap items-end gap-2" action={(fd) => run(() => setFxAction(rev.id, c, String(fd.get("rate") ?? "")), "Exchange rate saved.")}>
                  <div>
                    <label htmlFor={`fx-${c}`} className="block text-xs font-medium">1 {c} = ? {rev.currency}</label>
                    <Input id={`fx-${c}`} name="rate" defaultValue={rev.approved_fx[c] ?? ""} inputMode="decimal" disabled={!draft} className="w-36" />
                  </div>
                  {draft && <Button type="submit" variant="secondary" disabled={pending}>Approve rate</Button>}
                  {rev.approved_fx[c] ? <Badge tone="green">Approved</Badge> : <Badge tone="amber">Not approved</Badge>}
                </form>
              ))}
            </Card>
          )}
          <Card title="Totals">
            <dl className="space-y-1.5 text-sm tabular">
              <Row k="Subtotal (after discounts)" v={fmtMoney(calc.subtotal, calc.currency)} />
              <Row k="Discounts included" v={fmtMoney(calc.discountTotal, calc.currency)} muted />
              <Row k="Freight" v={calc.freight ? fmtMoney(calc.freight, calc.currency) : "None"} />
              <Row k={`Tax (${fmtQty(rev.tax_rate)}%)`} v={fmtMoney(calc.tax, calc.currency)} />
              <div className="border-t border-line pt-1.5"><Row k="Total" v={fmtMoney(calc.total, calc.currency)} strong /></div>
            </dl>
            {blocking.length > 0 && (
              <div className="mt-3"><Alert tone="warning" title="Before this quotation can be approved">
                {[...new Set(blocking.map((i) => i.message))].join("\n")}
              </Alert></div>
            )}
            {draft && (
              <div className="mt-4">
                <Button disabled={pending || blocking.length > 0}
                  onClick={() => { if (confirm("Approve and lock this quotation revision? It will not be sent automatically.")) run(() => approveQuotationAction(rev.id)); }}>
                  Approve quotation
                </Button>
                <p className="mt-2 text-xs text-muted">Totals are calculated by the application with exact decimal arithmetic. Approval locks this revision; nothing is emailed.</p>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function Row({ k, v, strong, muted }: { k: string; v: string; strong?: boolean; muted?: boolean }) {
  return <div className={`flex justify-between gap-3 ${strong ? "text-base font-semibold" : ""} ${muted ? "text-muted" : ""}`}><dt>{k}</dt><dd>{v}</dd></div>;
}
function Small({ label, name, def, placeholder }: { label: string; name: string; def: string; placeholder?: string }) {
  return <div><label htmlFor={`t-${name}`} className="block text-xs font-medium">{label}</label><Input id={`t-${name}`} name={name} defaultValue={def} placeholder={placeholder} /></div>;
}

function LineRow({ l, draft, revId, net, issues, pending, run, quoteCurrency }: { l: Line; draft: boolean; revId: string; net: string | null; issues: string[];
  pending: boolean; run: (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>, ok?: string) => void; quoteCurrency: string }) {
  const [dirty, setDirty] = useState(false);
  const formId = `line-${l.id}`;
  const priceNote = l.unit_price === null ? <span className="text-amber-800">No approved price — enter one</span>
    : l.price_source === "user_edit" ? <span className="text-sky-800">Edited by salesperson{l.catalogue_price ? ` (catalogue: ${fmtQty(l.catalogue_price)} ${l.catalogue_currency})` : ""}</span>
    : <span className="text-muted">From catalogue</span>;
  const cell = "border-b border-line px-2 py-2 align-top";
  return (
    <>
      <tr className={l.line_approved ? "bg-brand-50/40" : ""}>
        <td className={cell}>{l.line_no}</td>
        <td className={cell}>
          <p className="font-mono text-xs text-muted">{l.sku}</p>
          {draft ? <Textarea form={formId} name="description" rows={2} defaultValue={l.description} onChange={() => setDirty(true)} aria-label="Description" className="mt-1 min-w-[240px]" />
            : <p dir="auto">{l.description}</p>}
          <p className="mt-1 text-xs">{priceNote}</p>
        </td>
        <td className={`${cell} text-end`}>{draft ? <Input form={formId} name="quantity" defaultValue={l.quantity ? fmtQty(l.quantity) : ""} placeholder="Required" onChange={() => setDirty(true)} aria-label="Quantity" className="w-24 text-end" inputMode="decimal" />
          : fmtQty(l.quantity)}</td>
        <td className={cell}>{draft ? <Input form={formId} name="unit" defaultValue={l.unit} onChange={() => setDirty(true)} aria-label="Unit" className="w-20" /> : l.unit}</td>
        <td className={`${cell} text-end`}>
          {draft ? <Input form={formId} name="unit_price" defaultValue={l.unit_price ? fmtQty(l.unit_price) : ""} placeholder="Missing" onChange={() => setDirty(true)} aria-label="Unit price" className="w-28 text-end" inputMode="decimal" />
            : fmtMoney(l.unit_price ? fmtQty(l.unit_price) : null)}
          <span className="mt-1 block text-xs text-muted">{l.currency}{l.currency !== quoteCurrency ? " (converted)" : ""}</span>
        </td>
        <td className={`${cell} text-end`}>{draft ? <Input form={formId} name="discount_percent" defaultValue={fmtQty(l.discount_percent)} onChange={() => setDirty(true)} aria-label="Discount percent" className="w-20 text-end" inputMode="decimal" />
          : fmtQty(l.discount_percent)}</td>
        <td className={`${cell} tabular text-end`}>{fmtMoney(net)}</td>
        <td className={cell}>
          {draft ? (
            <div className="space-y-1">
              {dirty
                ? <Button form={formId} type="submit" disabled={pending}>Save</Button>
                : <label className="inline-flex items-center gap-2 text-xs"><input type="checkbox" checked={l.line_approved} disabled={pending}
                    onChange={(e) => run(() => setLineApprovalAction(revId, l.id, e.target.checked))} className="h-4 w-4 accent-brand-600" /> Approved</label>}
              <button className="block text-xs text-red-700 underline" disabled={pending}
                onClick={() => { if (confirm(`Remove line ${l.line_no}?`)) run(() => removeLineAction(revId, l.id)); }}>Remove</button>
            </div>
          ) : (l.line_approved ? <Badge tone="green">Yes</Badge> : <Badge>No</Badge>)}
          <form id={formId} action={(fd) => { setDirty(false); run(() => updateLineAction(revId, l.id, Object.fromEntries([...fd.entries()].map(([k, v]) => [k, String(v)])))); }} />
        </td>
      </tr>
      {issues.length > 0 && <tr><td colSpan={8} className="border-b border-line bg-amber-50 px-3 py-1.5 text-xs text-amber-900">{issues.join(" ")}</td></tr>}
    </>
  );
}

function AddLine({ products, omitted, onAdd, pending }: { products: Product[]; omitted: { id: string; item_no: string | null; description: string }[];
  onAdd: (productId: string, reqId: string | null) => void; pending: boolean }) {
  const [p, setP] = useState(""); const [r, setR] = useState("");
  return (
    <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-line pt-3">
      <div className="min-w-[240px] flex-1">
        <label htmlFor="add-product" className="block text-xs font-medium">Add catalogue product</label>
        <select id="add-product" value={p} onChange={(e) => setP(e.target.value)} className="mt-1 block w-full rounded-md border border-line bg-white px-2 py-1.5 text-sm">
          <option value="">Select product…</option>
          {products.map((x) => <option key={x.id} value={x.id}>{x.sku} — {x.name}{x.unit_price ? ` (${fmtQty(x.unit_price)} ${x.currency})` : " (no price)"}</option>)}
        </select>
      </div>
      {omitted.length > 0 && (
        <div className="min-w-[220px] flex-1">
          <label htmlFor="add-req" className="block text-xs font-medium">For inquiry item (optional)</label>
          <select id="add-req" value={r} onChange={(e) => setR(e.target.value)} className="mt-1 block w-full rounded-md border border-line bg-white px-2 py-1.5 text-sm">
            <option value="">Not linked</option>
            {omitted.map((x) => <option key={x.id} value={x.id}>{x.item_no ? x.item_no + " " : ""}{x.description.slice(0, 60)}</option>)}
          </select>
        </div>
      )}
      <Button variant="secondary" disabled={!p || pending} onClick={() => { onAdd(p, r || null); setP(""); setR(""); }}>Add line</Button>
    </div>
  );
}
