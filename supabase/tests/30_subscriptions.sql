-- Subscription rules (plain Postgres + local stub).
\set QUIET on
\set owner 'eeeeeeee-0000-4000-8000-000000000001'
\set admin 'eeeeeeee-0000-4000-8000-000000000002'
\set sales 'eeeeeeee-0000-4000-8000-000000000003'
\set stranger 'eeeeeeee-0000-4000-8000-000000000004'

create schema if not exists local_auth;
create table if not exists local_auth.users (id uuid primary key, email text not null unique, password_hash text not null default '', full_name text, created_at timestamptz default now());
insert into local_auth.users (id, email) values
  (:'owner', 'owner@platform.test'), (:'admin', 'admin@sub.test'), (:'sales', 'sales@sub.test'), (:'stranger', 'x@other.test')
on conflict (id) do nothing;
insert into platform_admins (user_id) values (:'owner');

create temp table results (n serial, test text, passed boolean);
grant all on results to authenticated, anon;
grant usage on sequence results_n_seq to authenticated, anon;
create function pg_temp.login(p text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p)::text, false); $$;
create function pg_temp.fails(q text) returns boolean language plpgsql as $$
begin execute q; return false; exception when others then return true; end $$;
create function pg_temp.err(q text) returns text language plpgsql as $$
begin execute q; return 'no error'; exception when others then return sqlerrm; end $$;
create function pg_temp.ok(t text, p boolean) returns void language sql as $$
  insert into results (test, passed) values (t, coalesce(p, false)); $$;
create function pg_temp.add_inquiry(c uuid) returns text language sql as $$
  select pg_temp.err(format('insert into inquiries (company_id, customer_name) values (%L, %L)', c, 'Cust')); $$;

set role authenticated;
select pg_temp.login(:'admin');
select public.create_company('Sub Co') as co \gset
select public.create_company('Sub Demo', true) as demo \gset
insert into company_members (company_id, user_id, role) values (:'co', :'sales', 'salesperson');

select pg_temp.ok('New company starts a 14-day free trial',
  (select status = 'trialing' and plan_code = 'trial' and trial_ends_at between now() + interval '13 days' and now() + interval '15 days'
     from subscriptions where company_id = :'co'));
select pg_temp.ok('Demo workspace is complimentary', (select status = 'complimentary' from subscriptions where company_id = :'demo'));

-- Billing switched off (default; e.g. an installed copy): nothing is limited.
reset role; update subscriptions set trial_ends_at = now() - interval '1 day' where company_id = :'co'; set role authenticated;
select pg_temp.ok('Billing off: expired trial does not block', pg_temp.add_inquiry(:'co') = 'no error');
select pg_temp.ok('Billing off: state reported as not limited', (select not billing_enabled and state = 'ok' from public.company_subscription(:'co')));

-- Billing on.
reset role; update platform_settings set billing_enabled = true;
update subscriptions set trial_ends_at = now() + interval '5 days' where company_id = :'co'; set role authenticated;
select pg_temp.ok('Trial: can add inquiries', pg_temp.add_inquiry(:'co') = 'no error');
reset role; insert into inquiries (company_id, customer_name) select :'co', 'Bulk' from generate_series(1, 18); set role authenticated;
select pg_temp.ok('Usage counts this month''s inquiries', (select inquiries_this_month = 20 from public.company_subscription(:'co')));
select pg_temp.ok('Monthly inquiry limit enforced with a clear message', pg_temp.add_inquiry(:'co') like '%allows 20 new inquiries per month%');
select pg_temp.ok('Editing existing inquiries still works at the limit',
  not pg_temp.fails(format('update inquiries set project_name = %L where company_id = %L', 'P', :'co')));

-- AI runs: rule-based runs are free, AI runs count.
reset role; update plans set max_inquiries_per_month = null, max_ai_runs_per_month = 1 where code = 'trial'; set role authenticated;
select id as inq from inquiries where company_id = :'co' limit 1 \gset
select pg_temp.ok('Rule-based processing is not counted',
  pg_temp.err(format('insert into ai_runs (company_id, inquiry_id, kind, idempotency_key, provider) values (%L, %L, %L, %L, %L)', :'co', :'inq', 'extract', 'k1', 'rules')) = 'no error'
  and pg_temp.err(format('insert into ai_runs (company_id, inquiry_id, kind, idempotency_key, provider) values (%L, %L, %L, %L, %L)', :'co', :'inq', 'extract', 'k2', 'rules')) = 'no error');
select pg_temp.ok('First AI run allowed',
  pg_temp.err(format('insert into ai_runs (company_id, inquiry_id, kind, idempotency_key, provider) values (%L, %L, %L, %L, %L)', :'co', :'inq', 'extract', 'k3', 'gemini')) = 'no error');
select pg_temp.ok('Monthly AI run limit enforced',
  pg_temp.err(format('insert into ai_runs (company_id, inquiry_id, kind, idempotency_key, provider) values (%L, %L, %L, %L, %L)', :'co', :'inq', 'extract', 'k4', 'gemini')) like '%allows 1 AI processing runs per month%');

-- Users: trial allows 3 (2 members now).
select pg_temp.ok('Invitation within user limit allowed',
  pg_temp.err(format('insert into invitations (company_id, email, token_hash) values (%L, %L, %L)', :'co', 'third@sub.test', repeat('a', 64))) = 'no error');
select pg_temp.ok('Open invitations count toward the user limit',
  pg_temp.err(format('insert into invitations (company_id, email, token_hash) values (%L, %L, %L)', :'co', 'fourth@sub.test', repeat('b', 64))) like '%allows 3 users%');
reset role; insert into company_members (company_id, user_id) values (:'co', :'stranger'); set role authenticated;
select pg_temp.ok('Joining a full company is refused',
  pg_temp.err(format('insert into company_members (company_id, user_id) values (%L, %L)', :'co', gen_random_uuid())) like '%plan allows 3 users and is full%');
reset role; delete from company_members where company_id = :'co' and user_id = :'stranger'; set role authenticated;

-- Trial ended / expired / cancelled / complimentary.
reset role; update plans set max_inquiries_per_month = 20, max_ai_runs_per_month = 60 where code = 'trial';
update subscriptions set trial_ends_at = now() - interval '1 minute' where company_id = :'co'; set role authenticated;
select pg_temp.ok('Ended trial blocks new inquiries', pg_temp.add_inquiry(:'co') like '%free trial has ended%');
select pg_temp.ok('Ended trial blocks AI runs',
  pg_temp.err(format('insert into ai_runs (company_id, inquiry_id, kind, idempotency_key, provider) values (%L, %L, %L, %L, %L)', :'co', :'inq', 'extract', 'k5', 'rules')) like '%free trial has ended%');
select pg_temp.ok('Ended trial: existing work still readable', (select count(*) > 0 from inquiries where company_id = :'co'));
select pg_temp.ok('Ended trial reported to the company', (select state = 'trial_ended' from public.company_subscription(:'co')));
reset role; update subscriptions set status = 'active', plan_code = 'professional', paid_until = now() - interval '1 day' where company_id = :'co'; set role authenticated;
select pg_temp.ok('Within grace days after paid-until: still works', pg_temp.add_inquiry(:'co') = 'no error');
reset role; update subscriptions set paid_until = now() - interval '4 days' where company_id = :'co'; set role authenticated;
select pg_temp.ok('After grace days: expired', pg_temp.add_inquiry(:'co') like '%subscription has expired%');
reset role; update subscriptions set status = 'cancelled' where company_id = :'co'; set role authenticated;
select pg_temp.ok('Cancelled blocks new inquiries', pg_temp.add_inquiry(:'co') like '%cancelled%');
reset role; update subscriptions set status = 'complimentary' where company_id = :'co'; set role authenticated;
select pg_temp.ok('Complimentary works regardless of dates', pg_temp.add_inquiry(:'co') = 'no error');
select pg_temp.ok('Demo workspace never limited (billing on)', pg_temp.add_inquiry(:'demo') = 'no error');

-- Who can change what.
select pg_temp.ok('Company admin cannot change own subscription',
  pg_temp.fails(format('update subscriptions set status = %L where company_id = %L', 'active', :'co'))
  or (select status = 'complimentary' from subscriptions where company_id = :'co'));
select pg_temp.ok('Company admin cannot record payments',
  pg_temp.fails(format('insert into payments (company_id, amount, currency, paid_on, method) values (%L, 100, %L, current_date, %L)', :'co', 'SAR', 'cash')));
select pg_temp.ok('Company admin cannot change plan prices',
  pg_temp.fails('update plans set price_monthly = 1') or (select count(*) = 0 from plans where price_monthly = 1));
select pg_temp.ok('Company admin cannot change platform settings',
  pg_temp.fails('update platform_settings set billing_enabled = false') or (select billing_enabled from platform_settings));
select pg_temp.ok('Nobody can make themselves platform owner',
  pg_temp.fails(format('insert into platform_admins (user_id) values (%L)', :'admin')));
select pg_temp.ok('Company admin cannot list all companies', pg_temp.err('select * from public.platform_companies()') like '%Platform owner only%');
select pg_temp.ok('Members can see their plans', (select count(*) = 4 from plans));

select pg_temp.login(:'sales');
select pg_temp.ok('Salesperson can see the subscription', (select plan_name = 'Professional' from public.company_subscription(:'co')));
select pg_temp.login(:'stranger');
select pg_temp.ok('Outsider cannot see another company''s subscription', pg_temp.fails(format('select * from public.company_subscription(%L)', :'co')));
select pg_temp.ok('Outsider cannot read another company''s subscription row', (select count(*) = 0 from subscriptions where company_id = :'co'));

-- Platform owner.
select pg_temp.login(:'owner');
select pg_temp.ok('Owner lists companies with admin email', (select admin_email = 'admin@sub.test' from public.platform_companies() where company_id = :'co'));
select pg_temp.ok('Owner list excludes demo workspaces', (select count(*) = 0 from public.platform_companies() where company_id = :'demo'));
update subscriptions set status = 'active', plan_code = 'starter', paid_until = now() + interval '30 days', updated_by = :'owner' where company_id = :'co';
select pg_temp.ok('Owner can change a subscription', (select status = 'active' and plan_code = 'starter' from subscriptions where company_id = :'co'));
insert into payments (company_id, amount, currency, paid_on, method, reference, covers_to, recorded_by)
values (:'co', 1250.50, 'SAR', current_date, 'bank_transfer', 'TRX-1', current_date + 30, :'owner');
select pg_temp.ok('Owner can record a payment (exact decimals)', (select amount = 1250.50 from payments where company_id = :'co'));
update plans set price_monthly = 199.00 where code = 'starter';
select pg_temp.ok('Owner can set plan prices', (select price_monthly = 199.00 from plans where code = 'starter'));
select pg_temp.ok('Owner cannot see inquiries of companies (business data stays private)', (select count(*) = 0 from inquiries where company_id = :'co'));

select pg_temp.login(:'admin');
select pg_temp.ok('Company admin sees own payments', (select count(*) = 1 from payments where company_id = :'co'));
select pg_temp.login(:'sales');
select pg_temp.ok('Salesperson cannot see payments', (select count(*) = 0 from payments where company_id = :'co'));
reset role;
select pg_temp.ok('Subscription and payment changes are audited',
  (select count(*) >= 2 from audit_log where table_name in ('subscriptions', 'payments') and company_id = :'co'));
set role anon;
select pg_temp.ok('Visitors cannot read plans', pg_temp.fails('select * from plans'));
reset role;
update platform_settings set billing_enabled = false;

\set QUIET off
select n, case when passed then 'PASS' else 'FAIL' end as result, test from results order by n;
select count(*) filter (where not passed) as failures from results \gset
\if :failures
  \echo SOME TESTS FAILED
\else
  \echo ALL TESTS PASSED
\endif
