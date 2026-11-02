// Builds a starting clarification email from flagged requirements (deterministic, no AI).
const LABEL: Record<string, string> = {
  quantity: "quantity", unit: "unit of measure", specifications: "technical specifications",
  delivery_location: "delivery location", required_delivery_date: "required delivery date",
};

export function buildClarificationEmail(i: {
  customer: string; project: string | null; reference: string | null;
  reqs: { item_no: string | null; description: string; needs_clarification: string[] }[];
  questions: string[];
}): string {
  const flagged = i.reqs.filter((r) => r.needs_clarification.length);
  // Delivery location/date are often stated once for the whole order; ask once.
  const global = ["delivery_location", "required_delivery_date"].filter((f) => flagged.length && flagged.every((r) => r.needs_clarification.includes(f)));
  const lines: string[] = [];
  for (const r of flagged) {
    const fields = r.needs_clarification.filter((f) => !global.includes(f));
    if (fields.length) lines.push(`- Item ${r.item_no ?? ""} ${r.description.slice(0, 80)}: please confirm the ${fields.map((f) => LABEL[f] ?? f).join(", ")}.`.replace("Item  ", "Item "));
  }
  for (const f of global) lines.push(`- Please confirm the ${LABEL[f]} for this order.`);
  for (const q of i.questions) if (!lines.some((l) => l.includes(q))) lines.push(`- ${q}`);
  const subject = `Clarification needed${i.reference ? ` – ${i.reference}` : ""}${i.project ? ` – ${i.project}` : ""}`;
  return `Subject: ${subject}

Dear ${i.customer} team,

Thank you for your inquiry${i.project ? ` for ${i.project}` : ""}. To prepare an accurate quotation, could you please confirm the following:

${lines.length ? lines.join("\n") : "- (No open questions — edit this draft or skip it.)"}

Once we have these details we will send our quotation promptly.

Kind regards,
`;
}
