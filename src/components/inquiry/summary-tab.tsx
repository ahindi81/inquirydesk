"use client";
import { summarizeAction } from "@/app/actions/inquiry";
import { Badge, ButtonLink, Card, Empty, fmtDate } from "../ui";
import { RunButton } from "./run-button";

type Sourced = { text: string; sources: { doc: string; ref: string }[] };
export type SummaryContent = {
  provider: string; isAI: boolean; model: string; overview: string;
  scope_of_supply: Sourced[]; deadlines: Sourced[]; conflicts: Sourced[];
  missing_information: string[]; suggested_next_actions: string[]; clarification_questions: string[];
};

function Facts({ items, empty }: { items: Sourced[]; empty: string }) {
  if (items.length === 0) return <p className="text-sm text-muted">{empty}</p>;
  return (
    <ul className="space-y-2">
      {items.map((s, i) => (
        <li key={i} className="text-sm">
          <span dir="auto">{s.text}</span>
          <span className="ms-2 inline-flex flex-wrap gap-1 align-middle">
            {s.sources.length ? s.sources.map((r, j) => <Badge key={j} tone="navy">{r.doc} · {r.ref}</Badge>) : <Badge tone="amber">No source found — treat as unverified</Badge>}
          </span>
        </li>
      ))}
    </ul>
  );
}
function List({ items, empty }: { items: string[]; empty: string }) {
  return items.length === 0 ? <p className="text-sm text-muted">{empty}</p>
    : <ul className="list-disc space-y-1 ps-5 text-sm">{items.map((t, i) => <li key={i} dir="auto">{t}</li>)}</ul>;
}

export function SummaryTab({ inquiryId, summary, hasReqs }: { inquiryId: string; summary: { content: SummaryContent; created_at: Date } | null; hasReqs: boolean }) {
  if (!hasReqs) return <Empty title="Extract requirements first" action={<ButtonLink href={`/inquiries/${inquiryId}?tab=documents`}>Go to documents</ButtonLink>} />;
  const c = summary?.content;
  const who = c ? (c.isAI ? `AI (${c.model})` : "Rule-based reader (no AI)") : "";
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="text-sm text-muted">{c ? `Generated ${fmtDate(summary!.created_at)} by ${who}. Regenerate after editing requirements.` : "Summarise the opportunity from the reviewed requirements and documents."}</p>
        <div className="flex items-start gap-2">
          <RunButton variant={c ? "secondary" : "primary"} pendingLabel="Summarising…" run={() => summarizeAction(inquiryId)}>{c ? "Regenerate summary" : "Generate summary"}</RunButton>
          {c && <ButtonLink href={`/inquiries/${inquiryId}?tab=matches`}>Next: matches</ButtonLink>}
        </div>
      </div>
      {c && (
        <>
          <Card title={<span>From the documents <Badge tone="navy">Source facts</Badge></span>}>
            <div className="space-y-5">
              <div><h3 className="mb-1 text-sm font-semibold">Overview</h3><p className="text-sm" dir="auto">{c.overview}</p>
                <p className="mt-1 text-xs text-muted">Overview written by {who}; check it against the facts below.</p></div>
              <div><h3 className="mb-2 text-sm font-semibold">Scope of supply</h3><Facts items={c.scope_of_supply} empty="No items." /></div>
              <div><h3 className="mb-2 text-sm font-semibold">Deadlines</h3><Facts items={c.deadlines} empty="No deadlines found in the documents." /></div>
              <div><h3 className="mb-2 text-sm font-semibold">Conflicting or ambiguous requirements</h3><Facts items={c.conflicts} empty="None found." /></div>
            </div>
          </Card>
          <Card title={<span>Suggestions <Badge tone={c.isAI ? "blue" : "gray"}>{c.isAI ? "AI suggestions" : "Rule-based suggestions"}</Badge></span>}>
            <div className="grid gap-5 md:grid-cols-3">
              <div><h3 className="mb-2 text-sm font-semibold">Missing information</h3><List items={c.missing_information} empty="Nothing flagged." /></div>
              <div><h3 className="mb-2 text-sm font-semibold">Suggested next actions</h3><List items={c.suggested_next_actions} empty="—" /></div>
              <div><h3 className="mb-2 text-sm font-semibold">Clarification questions</h3><List items={c.clarification_questions} empty="No questions." /></div>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
