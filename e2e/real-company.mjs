// Non-demo company: catalogue import with validation, then extraction with the
// Anthropic provider configured with an INVALID key, to check the failure path.
import { chromium } from "playwright-core";
const BASE = process.env.BASE ?? "http://localhost:3000";
const OUT = process.env.OUT ?? "/tmp/claude-0/shots";
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
page.on("dialog", (d) => d.accept());
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`); };

await page.goto(`${BASE}/signup`);
await page.fill("#fullName", "Real Co Admin"); await page.fill("#email", `real${Date.now()}@example.com`); await page.fill("#password", "a-long-enough-password");
await page.click("button[type=submit]"); await page.waitForURL("**/onboarding");
await page.fill("#name", "Test Trading Co."); await page.click("button:has-text('Create company workspace')"); await page.waitForURL("**/catalogue");
check("Real company starts with empty catalogue", await page.isVisible("text=Your catalogue is empty"));

const csv = "Code,Product Name,Unit,Price,Currency,Category\nT-1,Porcelain tile 600x600,m2,85.5,SAR,Tiles\nT-2,Wall tile 300x600,m2,abc,SAR,Tiles\n,Missing SKU,pcs,10,SAR,Misc\nT-3,Grout,bag,,,Misc\nT-1,Duplicate,m2,1,SAR,Tiles\n";
await page.goto(`${BASE}/catalogue/import`);
await page.setInputFiles("#file", { name: "catalogue.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
await page.click("button:has-text('Read file')");
await page.waitForSelector("text=2. Match columns");
check("Columns auto-mapped", (await page.inputValue("#map-sku")) === "0" && (await page.inputValue("#map-unit_price")) === "3");
await page.click("button:has-text('Validate and import')");
await page.waitForSelector("text=/row\\(s\\) have problems/");
const errs = await page.locator("li").allInnerTexts();
check("Invalid rows reported, nothing saved yet", errs.some((e) => /not a number/.test(e)) && errs.some((e) => /SKU is empty/.test(e)) && errs.some((e) => /also appears on row/.test(e)), errs.join(" | "));
await page.click("button:has-text('Import only the valid rows')");
await page.waitForSelector("text=Import complete");
check("Valid rows imported", await page.isVisible("text=/2 product\\(s\\) added/"));
await page.goto(`${BASE}/catalogue`);
check("Product without price shows 'No price', not zero", await page.isVisible("tr:has-text('T-3') >> text=No price"));

await page.goto(`${BASE}/inquiries/new`);
await page.fill("#customer_name", "Customer A");
await page.fill("#pasted_text", "Please quote 250 m2 porcelain tile 600x600, delivery to Riyadh.");
await page.click("button:has-text('Create and add documents')");
await page.waitForURL("**tab=documents");
await page.click("button:has-text('Extract requirements')");
const alert = page.locator("div[role=alert]", { hasText: /API key|AI provider/ }).first();
await alert.waitFor({ timeout: 90000 });
const msg = await alert.innerText();
check("Failed AI call gives a useful error", /rejected the API key|API key/i.test(msg), msg.replace(/\s+/g, " "));
await page.reload();
check("Failure is recorded and nothing was changed", await page.isVisible("text=/last extraction run failed/i") && await page.isVisible("text=Nothing was changed"));
check("Inquiry status not left on Processing", !(await page.isVisible("span:has-text('Processing')")));
await page.screenshot({ path: `${OUT}/30-ai-error.png`, fullPage: true });
await browser.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
