-- Invitation rules (plain Postgres + local stub).
\set QUIET on
\set admin 'cccccccc-0000-4000-8000-000000000001'
\set sales 'cccccccc-0000-4000-8000-000000000002'
\set invitee 'cccccccc-0000-4000-8000-000000000003'
\set stranger 'dddddddd-0000-4000-8000-000000000001'

-- Test users' verified emails (local stand-in for Supabase Auth's user table).
create schema if not exists local_auth;
create table if not exists local_auth.users (id uuid primary key, email text not null unique, password_hash text not null default '', full_name text, created_at timestamptz default now());
insert into local_auth.users (id, email) values
  (:'admin', 'admin@a.test'), (:'sales', 'sales@a.test'), (:'invitee', 'new.hire@a.test'), (:'stranger', 'someone@b.test')
on conflict (id) do nothing;

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

\set h1 '1111111111111111111111111111111111111111111111111111111111111111'
\set h2 '2222222222222222222222222222222222222222222222222222222222222222'
\set h3 '3333333333333333333333333333333333333333333333333333333333333333'
\set h4 '4444444444444444444444444444444444444444444444444444444444444444'

set role authenticated;
select pg_temp.login(:'admin');
select public.create_company('Invite Co') as co \gset
insert into company_members (company_id, user_id, role) values (:'co', :'sales', 'salesperson');

-- admin creates invitations
insert into invitations (company_id, email, role, token_hash, invited_by) values (:'co', 'new.hire@a.test', 'salesperson', :'h1', :'admin');
select pg_temp.ok('Admin can create an invitation', (select count(*) = 1 from invitations where company_id = :'co'));
select pg_temp.ok('Only one open invitation per email',
  pg_temp.fails(format('insert into invitations (company_id, email, token_hash) values (%L, %L, %L)', :'co', 'new.hire@a.test', :'h2')));
select pg_temp.ok('Invalid email rejected',
  pg_temp.fails(format('insert into invitations (company_id, email, token_hash) values (%L, %L, %L)', :'co', 'not-an-email', :'h2')));

-- salesperson and outsiders cannot manage invitations
select pg_temp.login(:'sales');
select pg_temp.ok('Salesperson cannot see invitations', (select count(*) = 0 from invitations));
select pg_temp.ok('Salesperson cannot create invitations',
  pg_temp.fails(format('insert into invitations (company_id, email, token_hash) values (%L, %L, %L)', :'co', 'x@a.test', :'h3')));
select pg_temp.login(:'stranger');
select pg_temp.ok('Other company cannot see invitations', (select count(*) = 0 from invitations));
select pg_temp.ok('Other company cannot invite into this company',
  pg_temp.fails(format('insert into invitations (company_id, email, token_hash) values (%L, %L, %L)', :'co', 'y@b.test', :'h3')));

-- preview works without signing in, and only with the right token
reset role; set role anon;
select set_config('request.jwt.claims', '', false);
select pg_temp.ok('Anonymous preview shows company, email and status',
  (select company_name = 'Invite Co' and email = 'new.hire@a.test' and status = 'valid' from public.invitation_preview(:'h1')));
select pg_temp.ok('Wrong token shows nothing', (select count(*) = 0 from public.invitation_preview(:'h4')));
select pg_temp.ok('Anonymous cannot accept', pg_temp.fails(format('select public.accept_invitation(%L)', :'h1')));
select pg_temp.ok('Anonymous cannot read invitations table', pg_temp.fails('select * from public.invitations'));
reset role; set role authenticated;

-- someone else with the link cannot use it
select pg_temp.login(:'stranger');
select pg_temp.ok('Different email cannot accept (clear message)',
  pg_temp.err(format('select public.accept_invitation(%L)', :'h1')) like 'This invitation is for new.hire@a.test%');
select pg_temp.ok('Stranger still not a member', (select count(*) = 0 from company_members where company_id = :'co'));

-- invited person accepts
select pg_temp.login(:'invitee');
select public.accept_invitation(:'h1', 'New Hire') as joined \gset
select pg_temp.ok('Invited person joins the right company', :'joined' = :'co');
select pg_temp.ok('Joined with the invited role and name',
  (select role = 'salesperson' and full_name = 'New Hire' from company_members where company_id = :'co' and user_id = :'invitee'));
select pg_temp.ok('Link cannot be used twice', pg_temp.err(format('select public.accept_invitation(%L)', :'h1')) like '%already been used%');
select pg_temp.ok('New member sees company inquiries list (access works)', not pg_temp.fails('select count(*) from inquiries'));
select pg_temp.ok('New salesperson cannot invite others',
  pg_temp.fails(format('insert into invitations (company_id, email, token_hash) values (%L, %L, %L)', :'co', 'z@a.test', :'h3')));

-- revoke and expiry
select pg_temp.login(:'admin');
insert into invitations (company_id, email, role, token_hash) values (:'co', 'admin2@a.test', 'admin', :'h2');
update invitations set revoked_at = now() where token_hash = :'h2';
select pg_temp.ok('Revoked link refused', pg_temp.err(format('select public.accept_invitation(%L)', :'h2')) like '%cancelled%');
insert into invitations (company_id, email, token_hash) values (:'co', 'admin2@a.test', :'h3');
select pg_temp.ok('Admin can invite again after revoking', (select count(*) = 1 from invitations where token_hash = :'h3'));
reset role;
update invitations set expires_at = now() - interval '1 minute' where token_hash = :'h3';
set role authenticated;
select pg_temp.ok('Expired link refused', pg_temp.err(format('select public.accept_invitation(%L)', :'h3')) like '%expired%');
select pg_temp.ok('Admin cannot mark an invitation accepted directly',
  pg_temp.fails(format('update invitations set accepted_at = now() where token_hash = %L', :'h3')));
select pg_temp.ok('Admin can renew a link (new token + expiry)',
  not pg_temp.fails(format('update invitations set token_hash = %L, expires_at = now() + interval ''7 days'' where token_hash = %L', :'h4', :'h3')));
select pg_temp.ok('Invitation changes are audited', (select count(*) >= 3 from audit_log where table_name = 'invitations'));

reset role;
\set QUIET off
select n, case when passed then 'PASS' else 'FAIL' end as result, test from results order by n;
select count(*) filter (where not passed) as failures from results \gset
\if :failures
  \echo SOME TESTS FAILED
\else
  \echo ALL TESTS PASSED
\endif
