// Browser test: admin invites a colleague, colleague joins via the link.
import { chromium } from "playwright-core";
const BASE = process.env.BASE ?? "http://localhost:3000";
const OUT = process.env.OUT ?? "/tmp/claude-0/shots";
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const results = [];
const errors = [];
const check = (name, ok, detail = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`); };
const stamp = Date.now();
async function session() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.accept());
  page.on("pageerror", (e) => errors.push(e.message));
  return page;
}
async function signup(page, name, email, next) {
  await page.goto(`${BASE}/signup${next ? `?next=${encodeURIComponent(next)}&email=${encodeURIComponent(email)}` : ""}`);
  await page.fill("#fullName", name);
  if (!next) await page.fill("#email", email);
  await page.fill("#password", "a-long-test-password");
  await page.click("button[type=submit]");
}

// 1. Admin creates a company and an invitation
const admin = await session();
const adminEmail = `boss${stamp}@acme.test`, hireEmail = `new.hire${stamp}@acme.test`;
await signup(admin, "Acme Boss", adminEmail);
await admin.waitForURL("**/onboarding");
await admin.fill("#name", "Acme Real Co");
await admin.click("button:has-text('Create company workspace')");
await admin.waitForURL("**/catalogue");
await admin.goto(`${BASE}/team`);
await admin.fill("#invite-email", hireEmail);
await admin.selectOption("#invite-role", "salesperson");
await admin.click("button:has-text('Create invitation link')");
await admin.waitForSelector("input[aria-label='Invitation link']");
const link = await admin.inputValue("input[aria-label='Invitation link']");
check("Admin gets an invitation link", /\/invite\/[A-Za-z0-9_-]{20,}$/.test(link), link.replace(/[A-Za-z0-9_-]{20,}$/, "…"));
check("Open invitation listed", await admin.isVisible(`td:has-text('${hireEmail}')`));
await admin.fill("#invite-email", hireEmail); // same email again
await admin.click("button:has-text('Create invitation link')");
await admin.waitForSelector("text=/already has an open invitation/");
check("Duplicate invitation explained", true);
await admin.screenshot({ path: `${OUT}/50-team-invite.png`, fullPage: true });

// 2. Colleague opens the link, creates an account, joins
const hire = await session();
await hire.goto(link);
check("Invite page names the company and email", (await hire.isVisible("text=Join Acme Real Co")) && (await hire.isVisible(`strong:has-text('${hireEmail}')`)));
await hire.screenshot({ path: `${OUT}/51-invite-page.png`, fullPage: true });
await hire.click(`text=Create an account with ${hireEmail}`);
await hire.waitForURL("**/signup**");
check("Sign-up form has the invited email filled in", (await hire.inputValue("#email")) === hireEmail);
await hire.fill("#fullName", "New Hire");
await hire.fill("#password", "a-long-test-password");
await hire.click("button[type=submit]");
await hire.waitForURL("**/invite/**");
check("After sign-up the colleague returns to the invitation", true);
await hire.click("button:has-text('Join Acme Real Co')");
await hire.waitForURL(`${BASE}/?joined=1`);
check("Colleague joined and sees the company", (await hire.isVisible("text=/Welcome to Acme Real Co/")) && (await hire.isVisible("aside >> text=Acme Real Co")));
await hire.goto(`${BASE}/team`);
check("Salesperson cannot invite", (await hire.isVisible("text=Ask a workspace admin")) && !(await hire.isVisible("#invite-email")));
check("Salesperson sees both team members", (await hire.locator("tbody tr").count()) === 2);

// 3. Link cannot be reused
const other = await session();
await other.goto(link);
check("Used link is refused", await other.isVisible("text=This invitation has already been used."));

// 4. Admin sees the new member; invitation no longer open
await admin.goto(`${BASE}/team`);
check("Admin sees new member", await admin.isVisible("input[value='New Hire']"));
check("Accepted invitation no longer listed as open", !(await admin.isVisible(`td:has-text('${hireEmail}')`)));

// 5. Wrong account and cancelled links
const targetEmail = `invited${stamp}@acme.test`;
await admin.fill("#invite-email", targetEmail);
await admin.click("button:has-text('Create invitation link')");
await admin.waitForSelector("input[aria-label='Invitation link']");
const link2 = await admin.inputValue("input[aria-label='Invitation link']");
await signup(other, "Outsider", `outsider${stamp}@else.test`);
await other.waitForURL("**/onboarding");
await other.goto(link2);
check("Different signed-in account is told to switch", await other.isVisible("text=/You.re signed in as/"));
await admin.goto(`${BASE}/team`);
await admin.locator("tr", { hasText: targetEmail }).locator("button:has-text('New link')").click();
await admin.waitForSelector("input[aria-label='Invitation link']");
const link3 = await admin.inputValue("input[aria-label='Invitation link']");
check("New link replaces the old one", link3 !== link2);
await other.goto(link2);
check("Old link stops working after renewal", await other.isVisible("text=Invitation not found"));
await admin.locator("tr", { hasText: targetEmail }).locator("button:has-text('Cancel')").click();
await admin.waitForSelector("text=Invitation cancelled");
await other.goto(link3);
check("Cancelled link is refused", await other.isVisible("text=This invitation was cancelled"));

// 6. Sign-in path keeps the invitation (existing account)
await admin.fill("#invite-email", `outsider${stamp}@else.test`);
await admin.click("button:has-text('Create invitation link')");
await admin.waitForSelector("input[aria-label='Invitation link']");
const link4 = await admin.inputValue("input[aria-label='Invitation link']");
const fresh = await session();
await fresh.goto(link4);
await fresh.click("text=I already have an account — sign in");
await fresh.waitForURL("**/login**");
check("Sign-in form has the invited email filled in", (await fresh.inputValue("#email")) === `outsider${stamp}@else.test`);
await fresh.fill("#password", "a-long-test-password");
await fresh.click("button[type=submit]");
await fresh.waitForURL("**/invite/**");
await fresh.click("button:has-text('Join Acme Real Co')");
await fresh.waitForURL(`${BASE}/?joined=1`);
check("Existing user joins via sign-in", await fresh.isVisible("text=/Welcome to Acme Real Co/"));

console.log("page errors:", errors.length ? errors : "none");
await browser.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
process.exit(results.every(Boolean) ? 0 : 1);
