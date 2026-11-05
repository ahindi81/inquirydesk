# InquiryDesk

Sales inquiry → requirements → summary → catalogue matches → clarification email and quotation.
Built with Next.js 16, TypeScript, Tailwind CSS and Supabase (Postgres, Auth, Storage).

## What works (milestone 2)

The first complete workflow, tested end to end in a browser:

1. **Sign in / sign up**, create a company workspace (you become Admin), or open a separate **demo workspace**.
2. **Catalogue**: add/edit products, datasheet PDFs, CSV/Excel import with column mapping and row-by-row validation.
3. **Inquiry**: customer/project/reference/owner/deadline, pasted email text, upload PDF, Word, Excel, CSV, text and image files
   (with per-file progress and clear errors; scanned pages use OCR when Tesseract is installed on the server).
4. **Requirements**: editable table; every extracted line links to its source file and page/sheet/row/line with the quoted text.
   Values not found in the source are left blank and marked *Needs clarification*. The original extraction is kept beside edits.
5. **Summary**: facts with sources, shown separately from suggestions.
6. **Matches**: suggestions only from your own catalogue, labelled Potential match / Alternative / No match, with
   similarities, differences and missing evidence. Approve, reject, or choose another product manually.
7. **Drafts**: editable clarification email (never sent automatically); quotation built from approved lines.
8. **Team**: admins invite colleagues by link (email + role); links work once, only for the invited email, expire after
   7 days, and can be renewed or cancelled. InquiryDesk never sends the link itself.
9. **Quotation**: edit quantities/prices/discounts/terms, approve exchange rates, approve each line, approve the quotation
   (locks it), create revisions, export PDF / Excel / CSV.

### Safety rules enforced in code
- AI output is checked by ordinary code: an item is kept only if its quoted text exists at the cited location, and each
  quantity, unit, brand, size and date must appear in that quote — otherwise it is blanked and flagged.
- Uploaded documents are treated as untrusted data; instructions inside them are ignored.
- Money uses exact decimal arithmetic; missing prices/quantities are never treated as zero; mixed currencies need an
  approved exchange rate; totals are frozen at approval.
- Tenant isolation is enforced by Postgres row-level security on every table and on stored files.
- Approved revisions cannot be changed; edits create a new draft that must be approved again.
- Audit log of who changed or approved catalogue items, requirements, matches and quotations.
- AI runs are idempotent (a retry or double-click does not call the provider twice) and rate-limited per user.

## Not done yet
- OpenAI provider (Anthropic is implemented; OpenAI shows a clear "not implemented" message).
- Scanned documents without Tesseract on the server are reported as unreadable (not sent to the AI's own reader yet).
- Not yet tested with a real Anthropic API key (the AI failure path is tested).

## Set up (on your computer)

1. Install **Node.js 22.18+** (LTS) from nodejs.org.
2. Create a free project at **supabase.com**. In its **SQL Editor**, run these files in order:
   `supabase/migrations/0001_core_schema.sql`, `0002_storage.sql`, `0003_drafts.sql`, `0004_invitations.sql`.
3. In Supabase → Authentication → Providers, keep **Email** enabled.
4. Copy `.env.example` to `.env.local` and fill in the values from your Supabase project settings.
   Optional: add your Anthropic API key (billed separately from any Claude subscription).
5. In a terminal, in this folder:
   ```
   npm install
   npm run dev
   ```
6. Open http://localhost:3000, create an account, then a company workspace or the demo workspace.

## Online version (Render)

- Live at https://inquirydesk.onrender.com, built automatically from the `main` branch of this repository.
- Settings live in Render → inquirydesk → Environment (never in the repository): `DATABASE_URL` uses a dedicated
  least-privilege database login (`inquirydesk_app`) that can only act as a signed-in user, so all row-level security applies.
- On every start the server logs `[startup] Database connection OK` or the exact failure (password hidden).
- Free plan: sleeps after ~15 minutes idle; first visit then takes up to a minute. Upgrade to "Starter" to keep it always on.
- Supabase → Authentication → URL Configuration should list `https://inquirydesk.onrender.com/**` and
  `http://localhost:3000/**` as redirect URLs so confirmation emails return to the right site.

## Testing

| Suite | Command | Result here |
|---|---|---|
| Quotation maths + evidence checker | `npm test` | 20/20 pass |
| Database security & rules incl. invitations (needs local PostgreSQL) | `npm run test:db` | 60/60 pass |
| Full browser workflow (demo data) | `node e2e/workflow.mjs` | 32/32 pass |
| Catalogue import + AI failure handling | `node e2e/real-company.mjs` | 8/8 pass |
| Team invitations | `node e2e/invitations.mjs` | 18/18 pass |

The browser tests ran against a local PostgreSQL database with the same migrations, using a development-only
sign-in stand-in (`AUTH_DRIVER=local`, refused in production builds) and local file storage. The Supabase sign-in
and storage code paths and a live AI call still need checking on a real project.

Fonts: `assets/fonts` contains DejaVu Sans (free licence in `DejaVu-LICENSE.txt`) for Arabic text in PDFs.
