-- Subscriptions for the online version.
-- Billing is manual for now: the platform owner (the InquiryDesk operator) records each
-- payment and sets the company's plan and "paid until" date. No card payments happen here.
-- Plan limits are enforced in the database, so they apply to every way data gets in.
-- billing_enabled is OFF by default, so an installed copy with its own database is never limited.

-- ---------------------------------------------------------------- platform owner
create table public.platform_admins (
  user_id    uuid primary key,
  created_at timestamptz not null default now()
);

create or replace function private.is_platform_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.platform_admins a where a.user_id = (select auth.uid()));
$$;
revoke all on function private.is_platform_admin() from public;
grant execute on function private.is_platform_admin() to authenticated;

create table public.platform_settings (
  id              boolean primary key default true check (id),
  billing_enabled boolean not null default false,
  trial_days      integer not null default 14 check (trial_days between 1 and 90),
  grace_days      integer not null default 3  check (grace_days between 0 and 30),
  billing_contact text,                       -- shown to customers: how to pay / whom to contact
  updated_at      timestamptz not null default now()
);
insert into public.platform_settings default values;

-- ---------------------------------------------------------------- plans
-- Limits: null = unlimited. Prices: null = not set yet (shown as "Price on request").
create table public.plans (
  code                    text primary key check (code ~ '^[a-z][a-z0-9_]{1,30}$'),
  name                    text not null check (length(trim(name)) > 0),
  description             text,
  max_users               integer check (max_users > 0),
  max_inquiries_per_month integer check (max_inquiries_per_month > 0),
  max_ai_runs_per_month   integer check (max_ai_runs_per_month > 0),
  price_monthly           numeric(12,2) check (price_monthly >= 0),
  price_yearly            numeric(12,2) check (price_yearly >= 0),
  currency                char(3) not null default 'SAR' check (currency ~ '^[A-Z]{3}$'),
  is_trial                boolean not null default false,
  is_public               boolean not null default true,
  sort                    integer not null default 0
);
-- Starting limits only; the platform owner edits them (and sets prices) on the Platform page.
insert into public.plans (code, name, description, max_users, max_inquiries_per_month, max_ai_runs_per_month, is_trial, sort) values
  ('trial',        'Free trial',   'Try every feature before you subscribe.',  3,   20,   60, true, 0),
  ('starter',      'Starter',      'For a small sales team.',                   3,   50,  150, false, 1),
  ('professional', 'Professional', 'For growing teams with more inquiries.',   10,  300, 1000, false, 2),
  ('enterprise',   'Enterprise',   'No limits.',                              null, null, null, false, 3);

-- ---------------------------------------------------------------- subscriptions & payments
create type public.subscription_status as enum ('trialing', 'active', 'cancelled', 'complimentary');

create table public.subscriptions (
  company_id    uuid primary key references public.companies(id) on delete cascade,
  plan_code     text not null references public.plans(code),
  status        public.subscription_status not null default 'trialing',
  trial_ends_at timestamptz,
  paid_until    timestamptz,
  billing_cycle text check (billing_cycle in ('monthly', 'yearly')),
  updated_at    timestamptz not null default now(),
  updated_by    uuid
);

create table public.payments (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  amount      numeric(12,2) not null check (amount > 0),
  currency    char(3) not null check (currency ~ '^[A-Z]{3}$'),
  paid_on     date not null,
  method      text not null check (method in ('bank_transfer', 'card', 'cash', 'cheque', 'other')),
  reference   text,
  covers_to   date,
  note        text,
  recorded_by uuid,
  created_at  timestamptz not null default now()
);
create index payments_company_idx on public.payments (company_id, paid_on desc);

create trigger subscriptions_audit after insert or update or delete on public.subscriptions
  for each row execute function private.audit();
create trigger payments_audit after insert or update or delete on public.payments
  for each row execute function private.audit();

-- Every new company starts on the free trial (demo workspaces are never limited).
create or replace function private.start_trial() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_days integer;
begin
  select trial_days into v_days from public.platform_settings;
  insert into public.subscriptions (company_id, plan_code, status, trial_ends_at)
  values (new.id, 'trial',
          case when new.is_demo then 'complimentary' else 'trialing' end::public.subscription_status,
          case when new.is_demo then null else now() + make_interval(days => coalesce(v_days, 14)) end)
  on conflict (company_id) do nothing;
  return new;
end $$;
create trigger companies_start_trial after insert on public.companies
  for each row execute function private.start_trial();

-- Existing companies: a fresh trial from today.
insert into public.subscriptions (company_id, plan_code, status, trial_ends_at)
select c.id, 'trial',
       case when c.is_demo then 'complimentary' else 'trialing' end::public.subscription_status,
       case when c.is_demo then null else now() + interval '14 days' end
  from public.companies c
on conflict (company_id) do nothing;

-- ---------------------------------------------------------------- access state & limits
-- state: 'ok' | 'trial_ended' | 'expired' | 'cancelled'. 'ok' also during the grace period.
create or replace function private.access_state(p_company uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
declare s public.subscriptions; v_on boolean; v_grace integer; v_demo boolean;
begin
  select billing_enabled, grace_days into v_on, v_grace from public.platform_settings;
  if not coalesce(v_on, false) then return 'ok'; end if;
  select is_demo into v_demo from public.companies where id = p_company;
  if coalesce(v_demo, false) then return 'ok'; end if;
  select * into s from public.subscriptions where company_id = p_company;
  if not found then return 'ok'; end if;
  return case s.status
    when 'complimentary' then 'ok'
    when 'cancelled' then 'cancelled'
    when 'trialing' then case when s.trial_ends_at is null or s.trial_ends_at > now() then 'ok' else 'trial_ended' end
    when 'active' then case when s.paid_until is null or s.paid_until + make_interval(days => v_grace) > now() then 'ok' else 'expired' end
  end;
end $$;

create or replace function private.limits_apply(p_company uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select billing_enabled from public.platform_settings), false)
     and not coalesce((select is_demo from public.companies where id = p_company), false);
$$;

create or replace function private.usage(p_company uuid)
returns table (users integer, open_invitations integer, inquiries_this_month integer, ai_runs_this_month integer)
language sql stable security definer set search_path = '' as $$
  select (select count(*)::int from public.company_members where company_id = p_company),
         (select count(*)::int from public.invitations where company_id = p_company
             and accepted_at is null and revoked_at is null and expires_at > now()),
         (select count(*)::int from public.inquiries where company_id = p_company
             and created_at >= date_trunc('month', now())),
         (select count(*)::int from public.ai_runs where company_id = p_company and provider <> 'rules'
             and created_at >= date_trunc('month', now()));
$$;

-- Raised messages are shown to the user as they are.
create or replace function private.enforce_plan() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_state text; p public.plans; u record; v_what text;
        v_provider text := to_jsonb(new) ->> 'provider';   -- ai_runs only
begin
  if not private.limits_apply(new.company_id) then return new; end if;
  v_state := private.access_state(new.company_id);
  v_what := case tg_table_name when 'inquiries' then 'add inquiries' when 'ai_runs' then 'run processing'
                               else 'add team members' end;
  if v_state = 'trial_ended' then
    raise exception 'Your free trial has ended, so you can''t % right now. You can still view and export your work. See the Subscription page to continue.', v_what using errcode = '23514';
  elsif v_state = 'expired' then
    raise exception 'Your subscription has expired, so you can''t % right now. You can still view and export your work. See the Subscription page to renew.', v_what using errcode = '23514';
  elsif v_state = 'cancelled' then
    raise exception 'This subscription is cancelled, so you can''t % right now. See the Subscription page.', v_what using errcode = '23514';
  end if;
  select pl.* into p from public.subscriptions s join public.plans pl on pl.code = s.plan_code where s.company_id = new.company_id;
  if not found then return new; end if;
  select * into u from private.usage(new.company_id);
  if tg_table_name = 'inquiries' and p.max_inquiries_per_month is not null and u.inquiries_this_month >= p.max_inquiries_per_month then
    raise exception 'Your % plan allows % new inquiries per month, and this month''s are used up. Upgrade on the Subscription page, or wait until next month.', p.name, p.max_inquiries_per_month using errcode = '23514';
  elsif tg_table_name = 'ai_runs' and v_provider <> 'rules' and p.max_ai_runs_per_month is not null and u.ai_runs_this_month >= p.max_ai_runs_per_month then
    raise exception 'Your % plan allows % AI processing runs per month, and this month''s are used up. Upgrade on the Subscription page, or wait until next month.', p.name, p.max_ai_runs_per_month using errcode = '23514';
  elsif tg_table_name = 'invitations' and p.max_users is not null and u.users + u.open_invitations >= p.max_users then
    raise exception 'Your % plan allows % users (team members plus open invitations). Cancel an open invitation or upgrade on the Subscription page.', p.name, p.max_users using errcode = '23514';
  elsif tg_table_name = 'company_members' and p.max_users is not null and u.users >= p.max_users then
    raise exception 'This company''s % plan allows % users and is full. Ask the company admin to upgrade.', p.name, p.max_users using errcode = '23514';
  end if;
  return new;
end $$;

create trigger inquiries_enforce_plan before insert on public.inquiries for each row execute function private.enforce_plan();
create trigger ai_runs_enforce_plan before insert on public.ai_runs for each row execute function private.enforce_plan();
create trigger invitations_enforce_plan before insert on public.invitations for each row execute function private.enforce_plan();
create trigger members_enforce_plan before insert on public.company_members for each row execute function private.enforce_plan();

-- For the Subscription page and the banner: any member of the company may read this.
create or replace function public.company_subscription(p_company uuid)
returns table (billing_enabled boolean, state text, status public.subscription_status, plan_code text, plan_name text,
               max_users integer, max_inquiries_per_month integer, max_ai_runs_per_month integer,
               trial_ends_at timestamptz, paid_until timestamptz, billing_cycle text, grace_days integer,
               users integer, open_invitations integer, inquiries_this_month integer, ai_runs_this_month integer,
               billing_contact text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (private.is_member(p_company) or private.is_platform_admin()) then
    raise exception 'Not a member of this company' using errcode = '42501';
  end if;
  return query
    select private.limits_apply(p_company), private.access_state(p_company), s.status, p.code, p.name,
           p.max_users, p.max_inquiries_per_month, p.max_ai_runs_per_month,
           s.trial_ends_at, s.paid_until, s.billing_cycle, ps.grace_days,
           u.users, u.open_invitations, u.inquiries_this_month, u.ai_runs_this_month, ps.billing_contact
      from public.subscriptions s join public.plans p on p.code = s.plan_code
      cross join public.platform_settings ps cross join lateral private.usage(p_company) u
     where s.company_id = p_company;
end $$;
revoke all on function public.company_subscription(uuid) from public, anon;
grant execute on function public.company_subscription(uuid) to authenticated;

-- For the platform owner: every company with its plan, usage and first admin's email.
create or replace function public.platform_companies()
returns table (company_id uuid, company_name text, created_at timestamptz, state text, status public.subscription_status,
               plan_code text, plan_name text, trial_ends_at timestamptz, paid_until timestamptz,
               users integer, inquiries_this_month integer, ai_runs_this_month integer, admin_email text, last_payment date)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_platform_admin() then raise exception 'Platform owner only' using errcode = '42501'; end if;
  return query
    select c.id, c.name, c.created_at, private.access_state(c.id), s.status, p.code, p.name, s.trial_ends_at, s.paid_until,
           u.users, u.inquiries_this_month, u.ai_runs_this_month,
           private.user_email((select m.user_id from public.company_members m where m.company_id = c.id and m.role = 'admin'
                                order by m.created_at limit 1)),
           (select max(pay.paid_on) from public.payments pay where pay.company_id = c.id)
      from public.companies c
      join public.subscriptions s on s.company_id = c.id
      join public.plans p on p.code = s.plan_code
      cross join lateral private.usage(c.id) u
     where not c.is_demo
     order by c.created_at desc;
end $$;
revoke all on function public.platform_companies() from public, anon;
grant execute on function public.platform_companies() to authenticated;

create or replace function private.user_email(p_user uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
declare v_email text;
begin
  if p_user is null then return null; end if;
  if to_regclass('auth.users') is not null then
    execute 'select email from auth.users where id = $1' into v_email using p_user;
  elsif to_regclass('local_auth.users') is not null then
    execute 'select email from local_auth.users where id = $1' into v_email using p_user;
  end if;
  return lower(v_email);
end $$;
revoke all on function private.user_email(uuid) from public;

-- ---------------------------------------------------------------- RLS
do $$ declare t text; begin
  foreach t in array array['platform_admins','platform_settings','plans','subscriptions','payments'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
  end loop;
end $$;

-- Platform owners: you can see whether you are one; nobody adds owners from the app.
create policy platform_admins_self on public.platform_admins for select to authenticated
  using (user_id = (select auth.uid()));

create policy platform_settings_read on public.platform_settings for select to authenticated using (true);
create policy platform_settings_owner on public.platform_settings for update to authenticated
  using ((select private.is_platform_admin())) with check ((select private.is_platform_admin()));

create policy plans_read on public.plans for select to authenticated
  using (is_public or (select private.is_platform_admin())
         or exists (select 1 from public.subscriptions s where s.plan_code = plans.code and (select private.is_member(s.company_id))));
create policy plans_owner on public.plans for all to authenticated
  using ((select private.is_platform_admin())) with check ((select private.is_platform_admin()));

create policy subscriptions_read on public.subscriptions for select to authenticated
  using ((select private.is_member(company_id)) or (select private.is_platform_admin()));
create policy subscriptions_owner on public.subscriptions for update to authenticated
  using ((select private.is_platform_admin())) with check ((select private.is_platform_admin()));

create policy payments_read on public.payments for select to authenticated
  using ((select private.is_admin(company_id)) or (select private.is_platform_admin()));
create policy payments_owner on public.payments for all to authenticated
  using ((select private.is_platform_admin())) with check ((select private.is_platform_admin()));

revoke all on public.platform_admins, public.platform_settings, public.plans, public.subscriptions, public.payments from anon, authenticated;
grant select on public.platform_admins, public.platform_settings, public.plans, public.subscriptions, public.payments to authenticated;
grant update (billing_enabled, trial_days, grace_days, billing_contact, updated_at) on public.platform_settings to authenticated;
grant insert, update, delete on public.plans to authenticated;
grant update (plan_code, status, trial_ends_at, paid_until, billing_cycle, updated_at, updated_by) on public.subscriptions to authenticated;
grant insert, update, delete on public.payments to authenticated;
