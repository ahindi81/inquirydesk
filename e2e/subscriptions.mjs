// Browser test: platform owner manages plans/subscriptions; a customer company sees its trial,
// gets limited when it ends, and is reactivated by a recorded payment.
// Needs the local dev database (DEV_DB) so the test can make the first user a platform owner.
import { chromium } from "playwright-core";
import { execFileSync } from "node:child_process";
const BASE = process.env.BASE ?? "http://localhost:3000";
const OUT = process.env.OUT ?? "/tmp/claude-0/shots";
const DB = process.env.DEV_DB ?? "inquirydesk_dev";
const psql = (q) => execFileSync("su", ["postgres", "-c", `psql -Atq -d ${DB} -c "${q.replace(/"/g, '\\"')}"`]).toString().trim();
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const results = [];
const errors = [];
const check = (name, ok, detail = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`); };
const stamp = Date.now();
async function session() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  return page;
}
async function signupWithCompany(page, name, email, company) {
  await page.goto(`${BASE}/signup`);
  await page.fill("#fullName", name);
  await page.fill("#email", email);
  await page.fill("#password", "a-long-test-password");
  await page.click("button[type=submit]");
  await page.waitForURL("**/onboarding");
  await page.fill("#name", company);
  await page.click("button:has-text('Create company workspace')");
  await page.waitForURL("**/catalogue");
}
async function newInquiry(page) {
  await page.goto(`${BASE}/inquiries/new`);
  await page.fill("#customer_name", "Test Customer");
  await page.click("button:has-text('Create and add documents')");
  await page.waitForLoadState("networkidle");
}

// 1. Platform owner
const owner = await session();
const ownerEmail = `owner${stamp}@platform.test`;
await signupWithCompany(owner, "Platform Owner", ownerEmail, "Owner Co");
psql(`insert into platform_admins (user_id) select id from local_auth.users where email = '${ownerEmail}'`);
await owner.goto(`${BASE}/platform`);
check("Owner sees the Platform page", await owner.isVisible("h1:has-text('Platform (owner)')"));
await owner.check("input[name=billing_enabled]");
await owner.fill("#billing_contact", `Bank transfer to Test Bank, IBAN SA00 TEST ${stamp}. Send the receipt to billing@platform.test`);
await owner.click("button:has-text('Save settings')");
await owner.waitForSelector("text=Settings saved.");
check("Owner switches subscriptions on", psql("select billing_enabled from platform_settings") === "t");
const starter = owner.locator("form[aria-label='Plan Starter']");
await starter.locator("input[name=price_monthly]").fill("199");
await starter.locator("input[name=price_yearly]").fill("1990.50");
await starter.locator("button:has-text('Save')").click();
await owner.waitForSelector("text=/Plan .Starter. saved/");
check("Owner sets plan prices", psql("select price_monthly::text || '/' || price_yearly::text from plans where code = 'starter'") === "199.00/1990.50");
await starter.locator("input[name=price_monthly]").fill("12abc");
await starter.locator("button:has-text('Save')").click();
await owner.waitForSelector("text=/Prices must be numbers/");
check("Invalid price refused with a message", psql("select price_monthly::text from plans where code = 'starter'") === "199.00");

// 2. Customer on a trial
const cust = await session();
const custEmail = `buyer${stamp}@customer.test`;
await signupWithCompany(cust, "Customer Admin", custEmail, `Customer ${stamp}`);
check("Customer has a Subscription menu item, no Platform item",
  (await cust.isVisible("aside a[href='/billing']:visible")) && !(await cust.isVisible("aside a[href='/platform']:visible")));
await cust.goto(`${BASE}/billing`);
check("Customer sees free trial with days left", (await cust.isVisible("text=Free trial")) && (await cust.isVisible("text=/1[34] days left/")));
check("Customer sees owner's price", await cust.isVisible("text=199.00 SAR"));
check("Unpriced plan shows 'Price on request'", await cust.isVisible("text=Price on request"));
check("Customer sees how to pay", await cust.isVisible(`text=/IBAN SA00 TEST ${stamp}/`));
await cust.screenshot({ path: `${OUT}/60-billing-trial.png`, fullPage: true });
await cust.goto(`${BASE}/platform`);
await cust.waitForURL("**/?error=admin-only");
check("Customer cannot open the Platform page", true);

// 3. Trial ends
const custCo = psql(`select c.id from companies c where c.name = 'Customer ${stamp}'`);
psql(`update subscriptions set trial_ends_at = now() - interval '1 minute' where company_id = '${custCo}'`);
await cust.goto(`${BASE}/`);
check("Ended trial shows a banner", await cust.isVisible("text=/Your free trial has ended/"));
await newInquiry(cust);
check("New inquiry refused after the trial with a clear message", await cust.isVisible("[role=alert]:has-text('free trial has ended')"));
await cust.screenshot({ path: `${OUT}/61-trial-ended.png`, fullPage: true });

// 4. Owner records a payment
await owner.goto(`${BASE}/platform`);
check("Owner list shows the customer as Trial ended",
  await owner.locator("tr", { hasText: `Customer ${stamp}` }).locator("text=Trial ended").isVisible());
await owner.click(`a:has-text('Customer ${stamp}')`);
await owner.waitForURL("**/platform/companies/**");
const until = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
await owner.fill("#amount", "199");
await owner.fill("#reference", "TRX-778");
await owner.fill("#covers_to", until);
await owner.selectOption("#pay_plan", "starter");
await owner.click("button:has-text('Record payment')");
await owner.waitForSelector("text=/Payment recorded. Subscription active until/");
check("Payment recorded and subscription activated",
  psql(`select status || '/' || plan_code from subscriptions where company_id = '${custCo}'`) === "active/starter");
await owner.screenshot({ path: `${OUT}/62-owner-company.png`, fullPage: true });
await owner.fill("#amount", "0");
await owner.click("button:has-text('Record payment')");
await owner.waitForSelector("text=/more than zero/");
check("Zero payment refused", psql(`select count(*) from payments where company_id = '${custCo}'`) === "1");

// 5. Customer is active again
await cust.goto(`${BASE}/billing`);
check("Customer sees Active, Starter, paid-until", (await cust.isVisible("text=Active")) && (await cust.isVisible("dd:has-text('Starter')")) && (await cust.isVisible("text=Paid until")));
check("Customer admin sees payment history", (await cust.isVisible("text=199.00 SAR >> nth=0")) && (await cust.isVisible("td:has-text('TRX-778')")));
await newInquiry(cust);
check("Customer can add inquiries again", /\/inquiries\/[0-9a-f-]{36}/.test(cust.url()));
await cust.screenshot({ path: `${OUT}/63-billing-active.png`, fullPage: true });

// 6. Switch billing off again (leaves the dev database unlimited)
await owner.goto(`${BASE}/platform`);
await owner.uncheck("input[name=billing_enabled]");
await owner.click("button:has-text('Save settings')");
await owner.waitForSelector("text=Settings saved.");
await cust.goto(`${BASE}/`);
check("Billing off: Subscription menu hidden", !(await cust.isVisible("aside a[href='/billing']:visible")));

console.log("page errors:", errors.length ? errors : "none");
await browser.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
process.exit(results.every(Boolean) ? 0 : 1);
