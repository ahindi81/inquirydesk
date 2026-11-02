// Run: node --test tests/   (Node 22.18+ runs TypeScript directly)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Dec } from '../src/lib/quote/decimal.ts';
import { calculateQuote, type QuoteLineInput } from '../src/lib/quote/calculate.ts';

const line = (o: Partial<QuoteLineInput> = {}): QuoteLineInput => ({
  lineNo: 1, sku: 'T-1', description: 'Tile', quantity: '1', unit: 'm2', unitPrice: '1', currency: 'SAR', ...o,
});

test('decimal: no floating point drift', () => {
  assert.equal(Dec.from('0.1').add(Dec.from('0.2')).toString(), '0.3');
  assert.equal(Dec.from('1.005').round(2).toFixed(2), '1.01');     // half away from zero
  assert.equal(Dec.from('-1.005').round(2).toFixed(2), '-1.01');
  assert.equal(Dec.from('1,234.50').toFixed(2), '1234.50');
  assert.throws(() => Dec.from('12abc'));
  assert.throws(() => Dec.from(NaN));
});

test('basic quote with discount, freight and 15% VAT', () => {
  const r = calculateQuote({
    currency: 'SAR', taxRatePercent: 15, freight: '350',
    lines: [
      line({ lineNo: 1, quantity: '250', unitPrice: '85.50', discountPercent: '10' }), // 21375.00 - 2137.50 = 19237.50
      line({ lineNo: 2, quantity: '3', unitPrice: '1199.99' }),                          // 3599.97
    ],
  });
  assert.equal(r.ok, true);
  assert.equal(r.lines[0].gross, '21375.00');
  assert.equal(r.lines[0].discount, '2137.50');
  assert.equal(r.subtotal, '22837.47');
  assert.equal(r.discountTotal, '2137.50');
  assert.equal(r.taxableAmount, '23187.47');  // freight taxable by default
  assert.equal(r.tax, '3478.12');             // 23187.47 × 0.15 = 3478.1205
  assert.equal(r.total, '26665.59');
});

test('freight can be excluded from tax', () => {
  const r = calculateQuote({ currency: 'SAR', taxRatePercent: 15, freight: 100, freightTaxable: false,
                             lines: [line({ unitPrice: '1000' })] });
  assert.equal(r.tax, '150.00');
  assert.equal(r.total, '1250.00');
});

test('missing price blocks totals and is never zero', () => {
  const r = calculateQuote({ currency: 'SAR', taxRatePercent: 15,
    lines: [line({ lineNo: 1 }), line({ lineNo: 2, sku: 'X-9', unitPrice: null })] });
  assert.equal(r.ok, false);
  assert.equal(r.total, null);
  assert.equal(r.subtotal, null);
  assert.ok(r.issues.some(i => i.code === 'missing_price' && i.lineNo === 2));
  assert.equal(r.lines[1].net, null);
});

test('empty-string price is treated as missing, not zero', () => {
  const r = calculateQuote({ currency: 'SAR', taxRatePercent: 0, lines: [line({ unitPrice: '  ' })] });
  assert.equal(r.ok, false);
  assert.equal(r.issues[0].code, 'missing_price');
});

test('explicit zero price is allowed (free item)', () => {
  const r = calculateQuote({ currency: 'SAR', taxRatePercent: 15, lines: [line({ unitPrice: '0' })] });
  assert.equal(r.ok, true);
  assert.equal(r.total, '0.00');
});

test('foreign currency needs an approved exchange rate', () => {
  const base = { currency: 'SAR', taxRatePercent: 15, lines: [line({ unitPrice: '120', quantity: 3, currency: 'USD' })] };
  const blocked = calculateQuote(base);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.issues[0].code, 'missing_fx');
  const ok = calculateQuote({ ...base, approvedFx: { USD: '3.75' } });
  assert.equal(ok.ok, true);
  assert.equal(ok.lines[0].convertedUnitPrice, '450.0000');
  assert.equal(ok.subtotal, '1350.00');
  assert.equal(ok.total, '1552.50');
});

test('three-decimal currencies round correctly', () => {
  const r = calculateQuote({ currency: 'KWD', taxRatePercent: 0, lines: [line({ unitPrice: '1.2345', quantity: 3, currency: 'KWD' })] });
  assert.equal(r.subtotal, '3.704'); // 3.7035 → 3.704
});

test('approval mode blocks unapproved lines', () => {
  const r = calculateQuote({ currency: 'SAR', taxRatePercent: 15, lines: [line({ lineApproved: false })] }, { requireApproval: true });
  assert.equal(r.ok, false);
  assert.equal(r.issues[0].code, 'line_not_approved');
});

test('omitted inquiry items are flagged but do not block', () => {
  const r = calculateQuote({ currency: 'SAR', taxRatePercent: 15,
    lines: [line({ requirementId: 'req-1' })], requirementIds: ['req-1', 'req-2', 'req-3'] });
  assert.equal(r.ok, true);
  const omitted = r.issues.filter(i => i.code === 'omitted_requirement').map(i => i.requirementId);
  assert.deepEqual(omitted, ['req-2', 'req-3']);
});

test('invalid inputs are reported, not guessed', () => {
  for (const bad of [line({ quantity: '0' }), line({ quantity: null }), line({ discountPercent: '120' }),
                     line({ unitPrice: '-5' }), line({ unitPrice: 'abc' })]) {
    const r = calculateQuote({ currency: 'SAR', taxRatePercent: 15, lines: [bad] });
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal(r.total, null);
  }
  assert.equal(calculateQuote({ currency: 'SAR', taxRatePercent: 15, lines: [] }).issues[0].code, 'no_lines');
});

test('large BOQ: 2,000 lines sum exactly', () => {
  const lines = Array.from({ length: 2000 }, (_, i) => line({ lineNo: i + 1, quantity: '0.1', unitPrice: '0.10' }));
  const r = calculateQuote({ currency: 'SAR', taxRatePercent: 0, lines });
  assert.equal(r.subtotal, '20.00'); // each line 0.01 exactly
});
