import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyExtraction, parseQuantity, norm } from "../src/lib/ai/verify.ts";
import type { DocInput, ExtractedItem, ExtractionOutput } from "../src/lib/ai/types.ts";

const docs: DocInput[] = [{
  index: 0, documentId: "doc-1", name: "BOQ.xlsx",
  segments: [
    { ref: "BOQ!R1", text: "Item | Description | Unit | Qty" },
    { ref: "BOQ!R2", text: "1.1 | Porcelain floor tile 600x600mm, matt, beige, R10 slip | m2 | 1,250" },
    { ref: "BOQ!R3", text: "1.2 | Ceramic wall tile 300x600 white gloss | m2 | 480" },
    { ref: "BOQ!R4", text: "٢.١ | بلاط بورسلين ٦٠٠×٦٠٠ مم | م2 | ٣٥٠" },
    { ref: "BOQ!R5", text: "Delivery to Jeddah site, quotation due 15 Nov 2026" },
  ],
}];

const item = (o: Partial<ExtractedItem>): ExtractedItem => ({
  item_no: null, description: "", quantity: null, unit: null, specifications: null, requested_brand: null,
  finish: null, colour: null, dimensions: null, delivery_location: null, required_delivery_date: null,
  required_delivery_date_text: null, doc: 0, ref: "BOQ!R2", excerpt: "", ...o,
});
const run = (items: ExtractedItem[], extra: Partial<ExtractionOutput> = {}) =>
  verifyExtraction({ items, quotation_deadline: null, delivery_location: null, notes: [], ...extra }, docs);

test("keeps a fully supported item with source reference", () => {
  const r = run([item({ item_no: "1.1", description: "Porcelain floor tile", quantity: "1,250", unit: "m2",
    finish: "matt", colour: "beige", dimensions: "600x600mm",
    excerpt: "1.1 | Porcelain floor tile 600x600mm, matt, beige, R10 slip | m2 | 1,250" })]);
  assert.equal(r.items.length, 1);
  const v = r.items[0];
  assert.equal(v.quantity, "1250");
  assert.equal(v.unit, "m2");
  assert.equal(v.documentId, "doc-1");
  assert.equal(v.ref, "BOQ!R2");
  assert.deepEqual(v.attributes, { finish: "matt", colour: "beige", dimensions: "600x600mm" });
  assert.deepEqual(v.needs_clarification, ["delivery_location", "required_delivery_date"]);
});

test("rejects items whose quoted text is not in the document", () => {
  const r = run([item({ description: "Granite slab", excerpt: "Granite slab 20mm polished" })]);
  assert.equal(r.items.length, 0);
  assert.match(r.rejected[0].reason, /not found/);
});

test("rejects items citing a location that does not exist", () => {
  const r = run([item({ description: "Porcelain floor tile", ref: "BOQ!R99", excerpt: "Porcelain floor tile" })]);
  assert.equal(r.items.length, 0);
});

test("blanks an invented quantity and flags it", () => {
  const r = run([item({ description: "Ceramic wall tile", quantity: "500", unit: "m2", ref: "BOQ!R3",
    excerpt: "1.2 | Ceramic wall tile 300x600 white gloss | m2 | 480" })]);
  assert.equal(r.items[0].quantity, null);
  assert.ok(r.items[0].removed_values.includes("quantity"));
  assert.ok(r.items[0].needs_clarification.includes("quantity"));
});

test("blanks an invented brand and date", () => {
  const r = run([item({ description: "Ceramic wall tile", requested_brand: "Marazzi", ref: "BOQ!R3",
    required_delivery_date: "2026-12-01", required_delivery_date_text: "1 Dec 2026",
    excerpt: "Ceramic wall tile 300x600 white gloss" })]);
  assert.equal(r.items[0].requested_brand, null);
  assert.equal(r.items[0].required_delivery_date, null);
  assert.deepEqual(r.items[0].removed_values.sort(), ["requested_brand", "required_delivery_date"]);
});

test("Arabic text and Arabic-Indic digits are verified", () => {
  assert.equal(parseQuantity("١٬٢٥٠"), "1250");
  assert.equal(norm("بلاط بورسلين ٦٠٠×٦٠٠"), "بلاط بورسلين 600x600");
  const r = run([item({ item_no: "٢.١", description: "بلاط بورسلين", quantity: "٣٥٠", unit: "م2", ref: "BOQ!R4",
    excerpt: "٢.١ | بلاط بورسلين ٦٠٠×٦٠٠ مم | م2 | ٣٥٠" })]);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].quantity, "350");
  assert.equal(r.items[0].unit, "م2");
});

test("inquiry-level deadline is kept only when found at its location", () => {
  const ok = run([], { quotation_deadline: { value: "2026-11-15", text: "15 Nov 2026", doc: 0, ref: "BOQ!R5" },
                      delivery_location: { value: "Jeddah site", text: "Jeddah site", doc: 0, ref: "BOQ!R5" } });
  assert.equal(ok.quotationDeadline?.value, "2026-11-15");
  const bad = run([], { quotation_deadline: { value: "2026-11-20", text: "20 Nov 2026", doc: 0, ref: "BOQ!R5" } });
  assert.equal(bad.quotationDeadline, null);
  assert.ok(bad.notes.some((n) => /could not be verified/.test(n)));
});

test("general delivery location fills items without one", () => {
  const r = run([item({ description: "Porcelain floor tile", excerpt: "Porcelain floor tile 600x600mm" })],
    { delivery_location: { value: "Jeddah site", text: "Jeddah site", doc: 0, ref: "BOQ!R5" } });
  assert.equal(r.items[0].delivery_location, "Jeddah site");
  assert.ok(!r.items[0].needs_clarification.includes("delivery_location"));
});
