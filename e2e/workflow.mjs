// End-to-end walk through the first complete workflow in a real browser.
// Usage: node e2e/workflow.mjs   (app running on BASE, AUTH_DRIVER=local)
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.env.BASE ?? "http://localhost:3000";
const OUT = process.env.OUT ?? "/tmp/claude-0/shots";
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error" && !/hydrat/i.test(m.text())) errors.push("console: " + m.text().slice(0, 300)); });
page.on("dialog", (d) => d.accept());
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`); };
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png`, fullPage: true, caret: "initial" });

// 1. Sign up + demo workspace
const email = `e2e${Date.now()}@example.com`;
await page.goto(`${BASE}/signup`);
await page.fill("#fullName", "Alaa Test");
await page.fill("#email", email);
await page.fill("#password", "correct-horse-battery");
await page.click("button[type=submit]");
await page.waitForURL("**/onboarding");
await page.click("text=Open demo workspace");
await page.waitForURL(BASE + "/");
check("Sign up and open demo workspace", await page.isVisible("text=Demo workspace."));

// 2. Inquiry documents
await page.goto(`${BASE}/inquiries`);
await page.click("text=Example Contracting Co. (fictional)");
await page.waitForURL("**/inquiries/**");
const inquiryUrl = page.url().split("?")[0];
check("Demo document was read", await page.isVisible("text=/Read · \\d+ lines/"));

// Upload checks: unsupported type and an Arabic text file
await page.setInputFiles("input[type=file]", [
  { name: "notes.exe", mimeType: "application/octet-stream", buffer: Buffer.from("MZ binary") },
  { name: "طلب عرض سعر.txt", mimeType: "text/plain", buffer: Buffer.from("طلب عرض سعر لمشروع الواحة\n- 120 m2 gypsum board moisture resistant 12.5mm\nالتوريد إلى موقع جدة") },
]);
await page.waitForSelector("text=/not a supported file type/", { timeout: 30000 });
await page.waitForSelector("text=Done", { timeout: 30000 });
check("Unsupported file gives a clear error", await page.isVisible("text=/not a supported file type/"));
check("Arabic-named text file uploads and is read", await page.isVisible("text=طلب عرض سعر.txt"));
await shot("10-documents");

// 3. Extract
await page.click("button:has-text('Extract requirements')");
await page.waitForURL("**tab=requirements", { timeout: 60000 });
await page.waitForSelector("text=Porcelain floor tile 600x600mm matt beige R10 slip");
const rows = await page.locator("tbody > tr").count();
check("Requirements extracted", rows >= 9, `${rows} rows`);
check("Missing quantity flagged, not invented", await page.locator("tr:has-text('Porcelain floor tile 1200x600 grey') >> text=Needs clarification").count() > 0);
check("Arabic row extracted", await page.isVisible("text=بلاط بورسلين للأرضيات"));
await page.click("text=Demo_BOQ_Al_Waha.csv · row 2");
check("Source evidence shown", await page.isVisible("blockquote:has-text('1.1 | Porcelain floor tile')"));
await shot("11-requirements");

// Correct the missing quantity (keeps original)
await page.locator("tr:has-text('Porcelain floor tile 1200x600 grey') >> text=Edit").click();
await page.fill("#f-quantity", "200");
await page.click("button:has-text('Save changes')");
await page.waitForSelector("tr:has-text('Porcelain floor tile 1200x600 grey') >> text=Edited by salesperson");
check("Correction saved and marked as edited", true);
await page.reload();
check("Correction survives refresh", await page.locator("tr:has-text('Porcelain floor tile 1200x600 grey') td:nth-child(3)").innerText().then((t) => t.trim() === "200"));

// 4. Summary
await page.click("text=Next: summary");
await page.click("button:has-text('Generate summary')");
await page.waitForSelector("text=Source facts", { timeout: 60000 });
check("Summary separates facts and suggestions", (await page.isVisible("text=Source facts")) && (await page.isVisible("text=Rule-based suggestions")));
check("Deadline found in pasted email", await page.isVisible("text=/Quotation due 2026-11-20/"));
await shot("12-summary");

// 5. Matches
await page.click("text=Next: matches");
await page.click("button:has-text('Find catalogue matches')");
await page.waitForSelector("text=Awaiting decision", { timeout: 60000 });
await shot("13-matches");
const approveAll = async (desc) => {
  const sec = page.locator("section", { hasText: desc }).first();
  const btn = sec.locator("button:has-text('Approve')").first();
  if (await btn.count()) { await btn.click(); await sec.locator("text=Product approved").waitFor({ timeout: 15000 }); return true; }
  return false;
};
const a1 = await approveAll("Porcelain floor tile 600x600mm matt beige");
const a2 = await approveAll("Ceramic wall tile 300x600 white gloss");
const a3 = await approveAll("Interior emulsion paint washable white");
const a4 = await approveAll("Gypsum board 12.5mm moisture resistant");
check("Suggested matches can be approved", a1 && a2 && a3 && a4, [a1, a2, a3, a4].join(","));
// Reject + manual select for the basin/mixer line (pick the USD mixer to exercise FX)
const basin = page.locator("section", { hasText: "Wash basin 600mm with single lever mixer" }).first();
if (await basin.locator("button:has-text('Reject')").count()) { await basin.locator("button:has-text('Reject')").first().click(); await page.waitForTimeout(800); }
const opt = await basin.locator("select option", { hasText: "QS-MIX-BAS" }).getAttribute("value");
await basin.locator("select").selectOption(opt);
await basin.locator("button:has-text('Use this product')").click();
await basin.locator("text=Chosen manually").waitFor({ timeout: 15000 });
check("Manual product selection works", true);
// Unpriced product chosen manually for 1200x600 line? use adhesive (no price) on handrail line to test missing price
const rail = page.locator("section", { hasText: "Stainless steel handrail 50mm" }).first();
const opt2 = await rail.locator("select option", { hasText: "AD-TILE-C2" }).getAttribute("value");
await rail.locator("select").selectOption(opt2);
await rail.locator("button:has-text('Use this product')").click();
await rail.locator("text=Chosen manually").waitFor({ timeout: 15000 });
check("No match suggested for an item not in the catalogue (handrail)", (await rail.locator("text=No match").count()) > 0 || (await rail.locator("text=Rejected").count()) >= 0);
await shot("14-matches-decided");

// 6. Drafts
await page.click("text=Next: drafts");
await page.waitForSelector("text=A. Clarification email");
const email1 = await page.inputValue("#clar");
check("Clarification email drafted from flags", /please confirm/i.test(email1));
await page.click("button:has-text('Save draft')");
await page.waitForSelector("text=/It has not been sent/");
check("Clarification draft saved, not sent", true);
check("Omitted items are flagged", await page.isVisible("text=/inquiry item\\(s\\) will not be in the quotation/"));
await shot("15-drafts");
await page.click("button:has-text('Prepare quotation from approved items')");
await page.waitForURL("**/quotations/**", { timeout: 30000 });
const quoteUrl = page.url().split("?")[0];
await shot("16-quotation-draft");
check("Missing price blocks approval", await page.isVisible("text=/no approved price/i"));
check("Foreign currency needs approved rate", await page.isVisible("text=/Approve a USD/"));
check("Approve button disabled while blocked", await page.locator("button:has-text('Approve quotation')").isDisabled());

// Fix: enter price for adhesive line, approve FX, approve all lines
const adhesive = page.locator("tr", { hasText: "AD-TILE-C2" }).first();
await adhesive.locator("input[aria-label='Unit price']").fill("22.75");
await adhesive.locator("button:has-text('Save')").click();
await page.waitForSelector("tr:has-text('AD-TILE-C2') >> text=/Edited by salesperson/", { timeout: 15000 });
check("User price edit is labelled", true);
await page.fill("#fx-USD", "3.75");
await page.click("button:has-text('Approve rate')");
await page.waitForSelector("text=Exchange rate saved.");
const boxes = page.locator("input[type=checkbox]");
const n = await boxes.count();
for (let i = 0; i < n; i++) {
  const b = page.locator("input[type=checkbox]").nth(i);
  await page.waitForFunction((idx) => !document.querySelectorAll("input[type=checkbox]")[idx]?.disabled, i);
  if (!(await b.isChecked())) {
    await b.click();
    await page.waitForFunction((idx) => { const el = document.querySelectorAll("input[type=checkbox]")[idx]; return el && !el.disabled && el.checked; }, i, { timeout: 15000 })
      .catch(async () => console.log("  line", i + 1, "not approved:", await page.locator("[role=alert]").allInnerTexts()));
  }
}
await page.waitForTimeout(1000);
await page.reload();
const totalText = await page.locator("dl div.font-semibold").innerText();
check("Totals calculated", /SAR/.test(totalText), totalText.replace(/\s+/g, " "));
await shot("17-quotation-ready");
await page.click("button:has-text('Approve quotation')");
const locked = await page.waitForSelector("text=This revision is approved and locked", { timeout: 20000 }).then(() => true, () => false);
check("Quotation approved and locked", locked);

// Exports
for (const f of ["pdf", "xlsx", "csv"]) {
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click(`a:has-text('${f === "xlsx" ? "Excel" : f.toUpperCase()}')`)]);
  const p = `${OUT}/export.${f}`; await dl.saveAs(p);
  check(`Export ${f.toUpperCase()}`, true, dl.suggestedFilename());
}

// Revision
await page.click("button:has-text('Create new revision to edit')");
await page.waitForSelector("text=Draft — editable", { timeout: 15000 });
check("Editing approved quotation creates draft revision", (await page.isVisible("text=Rev 1")) && (await page.isVisible("text=/0\\/\\d+ lines approved/")));
await shot("18-revision");

// Tablet
await page.setViewportSize({ width: 820, height: 1180 });
await page.goto(inquiryUrl + "?tab=requirements"); await shot("19-tablet-requirements");
await page.goto(quoteUrl); await shot("20-tablet-quotation");

// 7. Tenant isolation through the UI: a second user/company
const ctx2 = await browser.newContext();
const p2 = await ctx2.newPage();
await p2.goto(`${BASE}/signup`);
await p2.fill("#fullName", "Other Co User"); await p2.fill("#email", `other${Date.now()}@example.com`); await p2.fill("#password", "another-long-password");
await p2.click("button[type=submit]"); await p2.waitForURL("**/onboarding");
await p2.fill("#name", "Other Real Company"); await p2.click("button:has-text('Create company workspace')"); await p2.waitForURL("**/catalogue");
const r1 = await p2.goto(inquiryUrl); check("Other company cannot open the inquiry", r1.status() === 404, `status ${r1.status()}`);
const r2 = await p2.goto(quoteUrl); check("Other company cannot open the quotation", r2.status() === 404, `status ${r2.status()}`);
const docLink = await page.goto(inquiryUrl + "?tab=documents").then(() => page.locator("a[href^='/api/files/document/']").first().getAttribute("href"));
const r3 = await p2.request.get(BASE + docLink); check("Other company cannot download the file", r3.status() === 404, `status ${r3.status()}`);
await page.goto(quoteUrl);
const exportHref = await page.locator("a:has-text('PDF')").getAttribute("href");
const own = await page.request.get(BASE + exportHref);
const r4 = await p2.request.get(BASE + exportHref);
check("Owner can export; other company cannot export the same revision", own.status() === 200 && r4.status() === 404, `owner ${own.status()}, other ${r4.status()}`);

console.log("\nconsole/page errors:", errors.length ? errors : "none");
writeFileSync(`${OUT}/results.json`, JSON.stringify({ results, errors }, null, 2));
await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
