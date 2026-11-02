-- InquiryDesk core schema
-- Tenant model: every business row carries company_id. Access is enforced by
-- row-level security (RLS) against company_members, plus server-side checks.
-- Money and quantities use numeric (exact decimal), never float.

create extension if not exists pgcrypto;
create schema if not exists private;

-- ---------------------------------------------------------------- enums
create type public.member_role       as enum ('admin', 'salesperson');
create type public.inquiry_status    as enum ('new','processing','needs_clarification','ready_for_review','draft_prepared','approved');
create type public.document_status   as enum ('uploaded','processing','extracted','failed','unsupported');
create type public.match_label       as enum ('potential_match','alternative','no_match');
create type public.match_decision    as enum ('pending','approved','rejected');
create type public.revision_status   as enum ('draft','approved','superseded');
create type public.ai_run_status     as enum ('queued','running','succeeded','failed');

-- ---------------------------------------------------------------- tenants
create table public.companies (
  id              uuid primary key default gen_random_uuid(),
  name            text not null check (length(trim(name)) > 0),
  legal_name      text,
  address         text,
  phone           text,
  email           text,
  website         text,
  tax_number      text,
  logo_path       text,
  default_currency char(3) not null default 'SAR' check (default_currency ~ '^[A-Z]{3}$'),
  default_tax_rate numeric(7,4) not null default 15 check (default_tax_rate >= 0 and default_tax_rate <= 100),
  quote_prefix    text not null default 'Q',
  next_quote_seq  integer not null default 1,
  is_demo         boolean not null default false,
  created_at      timestamptz not null default now()
);

create table public.company_members (
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id    uuid not null,                 -- auth.users.id
  role       public.member_role not null default 'salesperson',
  full_name  text,
  created_at timestamptz not null default now(),
  primary key (company_id, user_id)
);
create index company_members_user_idx on public.company_members (user_id);

-- Membership helpers. SECURITY DEFINER so policies don't recurse through RLS
-- on company_members; each one checks the caller's own identity.
create or replace function private.is_member(p_company uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.company_members m
                 where m.company_id = p_company and m.user_id = (select auth.uid()));
$$;

create or replace function private.is_admin(p_company uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.company_members m
                 where m.company_id = p_company and m.user_id = (select auth.uid())
                   and m.role = 'admin');
$$;

revoke all on function private.is_member(uuid), private.is_admin(uuid) from public;
grant usage on schema private to authenticated;
grant execute on function private.is_member(uuid), private.is_admin(uuid) to authenticated;

-- ---------------------------------------------------------------- catalogue
create table public.catalogue_products (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id) on delete cascade,
  sku            text not null check (length(trim(sku)) > 0),
  name           text not null check (length(trim(name)) > 0),
  brand          text,
  category       text,
  description    text,
  specifications jsonb not null default '{}'::jsonb,
  unit           text not null,
  variants       text[] not null default '{}',
  unit_price     numeric(18,4) check (unit_price is null or unit_price >= 0), -- null = no approved price
  currency       char(3) check (currency ~ '^[A-Z]{3}$'),
  lead_time_days integer check (lead_time_days is null or lead_time_days >= 0),
  datasheet_path text,
  active         boolean not null default true,
  created_by     uuid,
  updated_by     uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (company_id, sku),
  check (unit_price is null or currency is not null)
);
create index catalogue_products_company_idx on public.catalogue_products (company_id);

-- ---------------------------------------------------------------- inquiries
create table public.inquiries (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references public.companies(id) on delete cascade,
  customer_name      text not null,
  project_name       text,
  reference_number   text,
  owner_id           uuid,
  status             public.inquiry_status not null default 'new',
  quotation_deadline date,
  pasted_text        text,
  is_demo            boolean not null default false,
  created_by         uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index inquiries_company_idx on public.inquiries (company_id, status);

create table public.inquiry_documents (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  inquiry_id    uuid not null references public.inquiries(id) on delete cascade,
  file_name     text not null,
  mime_type     text not null,
  size_bytes    bigint not null check (size_bytes > 0 and size_bytes <= 26214400), -- 25 MB
  sha256        text not null,
  storage_path  text not null,
  status        public.document_status not null default 'uploaded',
  error_message text,
  extracted_text jsonb,          -- [{ref:'p1'|'Sheet1!R4', text:'...', ocr:bool}]
  ocr_used      boolean not null default false,
  uploaded_by   uuid,
  created_at    timestamptz not null default now(),
  unique (inquiry_id, sha256),   -- same file re-uploaded = same row (idempotent)
  check (status <> 'failed' or error_message is not null)
);
create index inquiry_documents_inquiry_idx on public.inquiry_documents (inquiry_id);
create index inquiry_documents_company_idx on public.inquiry_documents (company_id);

-- AI runs: one row per (inquiry, kind, input fingerprint). Retrying with the
-- same inputs finds the existing row instead of calling the provider again.
create table public.ai_runs (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id) on delete cascade,
  inquiry_id      uuid not null references public.inquiries(id) on delete cascade,
  kind            text not null check (kind in ('extract','summarize','match')),
  idempotency_key text not null,
  provider        text not null,       -- 'anthropic' | 'openai' | 'demo'
  model           text,
  status          public.ai_run_status not null default 'queued',
  error_code      text,
  error_message   text,
  output          jsonb,
  input_tokens    integer,
  output_tokens   integer,
  started_by      uuid,
  created_at      timestamptz not null default now(),
  finished_at     timestamptz,
  unique (company_id, idempotency_key)
);
create index ai_runs_inquiry_idx on public.ai_runs (inquiry_id);

-- ---------------------------------------------------------------- requirements
-- `original` keeps the AI extraction verbatim; the flat columns hold the
-- current (possibly corrected) values.
create table public.requirements (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references public.companies(id) on delete cascade,
  inquiry_id            uuid not null references public.inquiries(id) on delete cascade,
  ai_run_id             uuid references public.ai_runs(id) on delete set null,
  item_no               text,
  description           text not null,
  quantity              numeric(18,4) check (quantity is null or quantity > 0),
  unit                  text,
  specifications        text,
  requested_brand       text,
  attributes            jsonb not null default '{}'::jsonb,  -- finish, colour, dimensions…
  delivery_location     text,
  required_delivery_date date,
  source_document_id    uuid references public.inquiry_documents(id) on delete set null,
  source_ref            text,          -- 'page 3', 'BOQ!R14', 'pasted text line 7'
  source_excerpt        text,          -- verbatim evidence
  needs_clarification   text[] not null default '{}',  -- field names lacking evidence
  original              jsonb,
  corrected_by          uuid,
  corrected_at          timestamptz,
  sort_order            integer not null default 0,
  created_at            timestamptz not null default now(),
  -- Every AI-extracted row must cite evidence; manually added rows may not.
  check (ai_run_id is null or (source_ref is not null and source_excerpt is not null))
);
create index requirements_inquiry_idx on public.requirements (inquiry_id, sort_order);
create index requirements_company_idx on public.requirements (company_id);

create table public.inquiry_summaries (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  inquiry_id  uuid not null references public.inquiries(id) on delete cascade,
  ai_run_id   uuid references public.ai_runs(id) on delete set null,
  content     jsonb not null,   -- {facts:[{text,source_ref}], suggestions:[...], questions:[...]}
  created_at  timestamptz not null default now()
);
create index inquiry_summaries_inquiry_idx on public.inquiry_summaries (inquiry_id, created_at desc);

-- ---------------------------------------------------------------- matches
create table public.product_matches (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id) on delete cascade,
  requirement_id  uuid not null references public.requirements(id) on delete cascade,
  product_id      uuid references public.catalogue_products(id) on delete restrict,
  label           public.match_label not null,
  similarities    text[] not null default '{}',
  differences     text[] not null default '{}',
  missing_evidence text[] not null default '{}',
  is_manual       boolean not null default false,
  decision        public.match_decision not null default 'pending',
  decided_by      uuid,
  decided_at      timestamptz,
  ai_run_id       uuid references public.ai_runs(id) on delete set null,
  created_at      timestamptz not null default now(),
  check ((label = 'no_match') = (product_id is null)),
  check (decision = 'pending' or decided_by is not null)
);
create index product_matches_requirement_idx on public.product_matches (requirement_id);
create index product_matches_company_idx on public.product_matches (company_id);
-- At most one approved match per requirement.
create unique index product_matches_one_approved
  on public.product_matches (requirement_id) where decision = 'approved';

-- A suggested product must belong to the same company as the requirement.
create or replace function private.check_match_tenant() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.product_id is not null and not exists (
       select 1 from public.catalogue_products p
       where p.id = new.product_id and p.company_id = new.company_id) then
    raise exception 'Product is not in this company''s catalogue' using errcode = '23514';
  end if;
  if not exists (select 1 from public.requirements r
                 where r.id = new.requirement_id and r.company_id = new.company_id) then
    raise exception 'Requirement belongs to a different company' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger product_matches_tenant before insert or update on public.product_matches
  for each row execute function private.check_match_tenant();

-- ---------------------------------------------------------------- quotations
create table public.quotations (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete cascade,
  inquiry_id   uuid not null references public.inquiries(id) on delete cascade,
  quote_number text not null,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  unique (company_id, quote_number)
);
create index quotations_inquiry_idx on public.quotations (inquiry_id);

create table public.quotation_revisions (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id) on delete cascade,
  quotation_id   uuid not null references public.quotations(id) on delete cascade,
  revision_no    integer not null check (revision_no >= 0),
  status         public.revision_status not null default 'draft',
  quote_date     date not null default current_date,
  currency       char(3) not null check (currency ~ '^[A-Z]{3}$'),
  tax_rate       numeric(7,4) not null check (tax_rate >= 0 and tax_rate <= 100),
  freight        numeric(18,4) check (freight is null or freight >= 0),
  validity_days  integer check (validity_days is null or validity_days > 0),
  delivery_terms text,
  payment_terms  text,
  exclusions     text,
  notes          text,
  -- exchange rates the user explicitly approved: {"USD": "3.7500"} = 1 USD -> 3.75 quote currency
  approved_fx    jsonb not null default '{}'::jsonb,
  totals         jsonb,            -- snapshot computed by application code at approval
  approved_by    uuid,
  approved_at    timestamptz,
  created_by     uuid,
  created_at     timestamptz not null default now(),
  unique (quotation_id, revision_no),
  check ((status = 'approved') = (approved_by is not null and approved_at is not null)
         or status = 'superseded')
);
create index quotation_revisions_company_idx on public.quotation_revisions (company_id);
create unique index quotation_one_draft on public.quotation_revisions (quotation_id) where status = 'draft';

create table public.quotation_lines (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id) on delete cascade,
  revision_id       uuid not null references public.quotation_revisions(id) on delete cascade,
  line_no           integer not null,
  requirement_id    uuid references public.requirements(id) on delete set null,
  match_id          uuid references public.product_matches(id) on delete set null,
  product_id        uuid references public.catalogue_products(id) on delete restrict,
  sku               text not null,
  description       text not null,
  quantity          numeric(18,4) not null check (quantity > 0),
  unit              text not null,
  unit_price        numeric(18,4) check (unit_price is null or unit_price >= 0),  -- null = missing, never 0
  currency          char(3) not null check (currency ~ '^[A-Z]{3}$'),
  price_source      text not null check (price_source in ('catalogue','user_edit')),
  discount_percent  numeric(7,4) not null default 0 check (discount_percent >= 0 and discount_percent <= 100),
  line_approved     boolean not null default false,
  created_at        timestamptz not null default now(),
  unique (revision_id, line_no)
);
create index quotation_lines_revision_idx on public.quotation_lines (revision_id);
create index quotation_lines_company_idx on public.quotation_lines (company_id);

-- Approved and superseded revisions are frozen. Changes require a new draft
-- revision (see public.revise_quotation).
create or replace function private.block_frozen_revision() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and old.status = 'draft' then
    return new;  -- draft edits (including the approval itself) are allowed
  end if;
  if tg_op = 'UPDATE' and old.status = 'approved' and new.status = 'superseded'
     and (to_jsonb(old) - 'status') = (to_jsonb(new) - 'status') then
    return new;  -- only the status flip to superseded is allowed
  end if;
  if tg_op = 'DELETE' and not exists (select 1 from public.quotations q where q.id = old.quotation_id) then
    return old;  -- cascade from deleting the quotation/inquiry
  end if;
  if old.status in ('approved','superseded') then
    raise exception 'Revision % is % and cannot be changed; create a new draft revision',
      old.revision_no, old.status using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;
create trigger quotation_revisions_frozen before update or delete on public.quotation_revisions
  for each row execute function private.block_frozen_revision();

create or replace function private.block_frozen_lines() returns trigger
language plpgsql set search_path = '' as $$
declare v_status public.revision_status;
begin
  select status into v_status from public.quotation_revisions
   where id = coalesce(new.revision_id, old.revision_id);
  if v_status is null and tg_op = 'DELETE' then
    return old;  -- cascade from deleting the revision
  end if;
  if tg_op = 'UPDATE'
     and (to_jsonb(new) - 'requirement_id' - 'match_id') = (to_jsonb(old) - 'requirement_id' - 'match_id')
     and (new.requirement_id is null or new.requirement_id = old.requirement_id)
     and (new.match_id is null or new.match_id = old.match_id) then
    return new;  -- source record deleted (FK set null); commercial content unchanged
  end if;
  if v_status is distinct from 'draft' then
    raise exception 'Lines of a % revision cannot be changed; create a new draft revision', v_status
      using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and new.revision_id <> old.revision_id then
    raise exception 'Lines cannot move between revisions' using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;
create trigger quotation_lines_frozen before insert or update or delete on public.quotation_lines
  for each row execute function private.block_frozen_lines();

-- Line edits that change commercial content reset that line's approval.
create or replace function private.reset_line_approval() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (new.product_id, new.sku, new.quantity, new.unit, new.unit_price, new.currency, new.discount_percent)
     is distinct from
     (old.product_id, old.sku, old.quantity, old.unit, old.unit_price, old.currency, old.discount_percent)
     and new.line_approved = old.line_approved then
    new.line_approved := false;
  end if;
  return new;
end $$;
create trigger quotation_lines_reset_approval before update on public.quotation_lines
  for each row execute function private.reset_line_approval();

-- Copy an approved revision into a new draft (the only way to "edit" one).
create or replace function public.revise_quotation(p_revision uuid)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare r public.quotation_revisions; v_new uuid;
begin
  select * into r from public.quotation_revisions where id = p_revision;
  if not found then raise exception 'Revision not found or not accessible' using errcode = 'P0002'; end if;
  if exists (select 1 from public.quotation_revisions
             where quotation_id = r.quotation_id and status = 'draft') then
    raise exception 'A draft revision already exists for this quotation' using errcode = '23505';
  end if;
  insert into public.quotation_revisions
    (company_id, quotation_id, revision_no, status, currency, tax_rate, freight, validity_days,
     delivery_terms, payment_terms, exclusions, notes, approved_fx, created_by)
  select company_id, quotation_id,
         (select max(revision_no) + 1 from public.quotation_revisions where quotation_id = r.quotation_id),
         'draft', currency, tax_rate, freight, validity_days, delivery_terms, payment_terms,
         exclusions, notes, '{}'::jsonb, (select auth.uid())   -- FX approval must be given again
    from public.quotation_revisions where id = p_revision
  returning id into v_new;
  insert into public.quotation_lines
    (company_id, revision_id, line_no, requirement_id, match_id, product_id, sku, description,
     quantity, unit, unit_price, currency, price_source, discount_percent, line_approved)
  select company_id, v_new, line_no, requirement_id, match_id, product_id, sku, description,
         quantity, unit, unit_price, currency, price_source, discount_percent, false
    from public.quotation_lines where revision_id = p_revision;
  return v_new;
end $$;

-- Approval gate. Totals are computed by application code and passed in; the
-- database enforces the rules that must never be bypassed.
create or replace function public.approve_revision(p_revision uuid, p_totals jsonb)
returns void language plpgsql security invoker set search_path = '' as $$
declare r public.quotation_revisions;
begin
  select * into r from public.quotation_revisions where id = p_revision for update;
  if not found then raise exception 'Revision not found or not accessible' using errcode = 'P0002'; end if;
  if r.status <> 'draft' then raise exception 'Only draft revisions can be approved' using errcode = '42501'; end if;
  if not exists (select 1 from public.quotation_lines where revision_id = p_revision) then
    raise exception 'Quotation has no lines' using errcode = '23514';
  end if;
  if exists (select 1 from public.quotation_lines where revision_id = p_revision and not line_approved) then
    raise exception 'All lines must be approved by a salesperson before the quotation is approved' using errcode = '23514';
  end if;
  if exists (select 1 from public.quotation_lines where revision_id = p_revision and unit_price is null) then
    raise exception 'One or more lines have no price' using errcode = '23514';
  end if;
  if exists (select 1 from public.quotation_lines l
             where l.revision_id = p_revision and l.currency <> r.currency
               and not (r.approved_fx ? l.currency)) then
    raise exception 'Lines in another currency need an approved exchange rate' using errcode = '23514';
  end if;
  if exists (select 1 from public.quotation_lines l
               join public.product_matches m on m.id = l.match_id
             where l.revision_id = p_revision and m.decision <> 'approved') then
    raise exception 'A line references a product match that is not approved' using errcode = '23514';
  end if;
  update public.quotation_revisions
     set status = 'superseded'
   where quotation_id = r.quotation_id and status = 'approved';
  update public.quotation_revisions
     set status = 'approved', totals = p_totals,
         approved_by = (select auth.uid()), approved_at = now()
   where id = p_revision;
end $$;

-- ---------------------------------------------------------------- audit
create table public.audit_log (
  id          bigint generated always as identity primary key,
  company_id  uuid not null references public.companies(id) on delete cascade,
  actor_id    uuid,
  table_name  text not null,
  row_id      uuid,
  action      text not null,
  changes     jsonb,
  created_at  timestamptz not null default now()
);
create index audit_log_company_idx on public.audit_log (company_id, created_at desc);

create or replace function private.audit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_old jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
        v_new jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
        v_diff jsonb;
begin
  if tg_op = 'UPDATE' then
    select jsonb_object_agg(k, jsonb_build_object('from', v_old -> k, 'to', v_new -> k)) into v_diff
      from jsonb_object_keys(v_new) k where v_old -> k is distinct from v_new -> k;
    if v_diff is null then return new; end if;
  else
    v_diff := coalesce(v_new, v_old);
  end if;
  insert into public.audit_log (company_id, actor_id, table_name, row_id, action, changes)
  values ((coalesce(v_new, v_old) ->> 'company_id')::uuid, (select auth.uid()), tg_table_name,
          (coalesce(v_new, v_old) ->> 'id')::uuid, lower(tg_op), v_diff);
  return coalesce(new, old);
end $$;

do $$ declare t text; begin
  foreach t in array array['catalogue_products','inquiries','requirements','product_matches',
                           'quotation_revisions','quotation_lines','company_members'] loop
    execute format('create trigger %I_audit after insert or update or delete on public.%I
                    for each row execute function private.audit()', t, t);
  end loop;
end $$;
-- company_members has no id column; audit row_id is null for it.

-- ---------------------------------------------------------------- RLS
do $$ declare t text; begin
  foreach t in array array['companies','company_members','catalogue_products','inquiries',
                           'inquiry_documents','ai_runs','requirements','inquiry_summaries',
                           'product_matches','quotations','quotation_revisions','quotation_lines',
                           'audit_log'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
  end loop;
end $$;

-- Companies: members read; admins update. Creation goes through create_company().
create policy companies_select on public.companies for select to authenticated
  using ((select private.is_member(id)));
create policy companies_update on public.companies for update to authenticated
  using ((select private.is_admin(id))) with check ((select private.is_admin(id)));

-- Members: see your colleagues; only admins add/change/remove members.
create policy members_select on public.company_members for select to authenticated
  using ((select private.is_member(company_id)));
create policy members_admin_write on public.company_members for all to authenticated
  using ((select private.is_admin(company_id))) with check ((select private.is_admin(company_id)));

-- Standard tenant tables: any member can read and write their company's rows.
do $$ declare t text; begin
  foreach t in array array['inquiries','inquiry_documents','ai_runs','requirements','inquiry_summaries',
                           'product_matches','quotations','quotation_revisions','quotation_lines'] loop
    execute format('create policy %I on public.%I for all to authenticated
                      using ((select private.is_member(company_id)))
                      with check ((select private.is_member(company_id)))', t || '_tenant', t);
  end loop;
end $$;

-- Catalogue: members read; only admins change prices and products.
create policy catalogue_select on public.catalogue_products for select to authenticated
  using ((select private.is_member(company_id)));
create policy catalogue_admin_write on public.catalogue_products for all to authenticated
  using ((select private.is_admin(company_id))) with check ((select private.is_admin(company_id)));

-- Audit log: admins read; nobody writes directly (triggers only).
create policy audit_select on public.audit_log for select to authenticated
  using ((select private.is_admin(company_id)));

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
revoke insert, update, delete on public.audit_log from authenticated;
revoke all on all tables in schema public from anon;
-- Company settings: admins may edit profile fields only (not the demo flag or numbering counter).
revoke update on public.companies from authenticated;
grant update (name, legal_name, address, phone, email, website, tax_number, logo_path,
              default_currency, default_tax_rate, quote_prefix) on public.companies to authenticated;

-- Sign-up path: a new user creates a company and becomes its admin.
create or replace function public.create_company(p_name text, p_demo boolean default false)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_uid uuid := (select auth.uid());
begin
  if v_uid is null then raise exception 'Not signed in' using errcode = '42501'; end if;
  if length(trim(coalesce(p_name, ''))) < 2 then raise exception 'Company name is required' using errcode = '23514'; end if;
  insert into public.companies (name, is_demo) values (trim(p_name), p_demo) returning id into v_id;
  insert into public.company_members (company_id, user_id, role) values (v_id, v_uid, 'admin');
  return v_id;
end $$;
revoke all on function public.create_company(text, boolean) from public, anon;
grant execute on function public.create_company(text, boolean) to authenticated;

-- Atomic quotation numbering per company.
create or replace function public.next_quote_number(p_company uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v_seq integer; v_prefix text;
begin
  if not private.is_member(p_company) then raise exception 'Not a member' using errcode = '42501'; end if;
  update public.companies set next_quote_seq = next_quote_seq + 1
   where id = p_company returning next_quote_seq - 1, quote_prefix into v_seq, v_prefix;
  return v_prefix || '-' || to_char(now(), 'YYYY') || '-' || lpad(v_seq::text, 4, '0');
end $$;
revoke all on function public.next_quote_number(uuid) from public, anon;
grant execute on function public.next_quote_number(uuid) to authenticated;
