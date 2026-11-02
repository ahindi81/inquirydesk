-- Acceptance tests for tenant isolation and quotation rules (plain Postgres + stub).
\set QUIET on
\set ua 'aaaaaaaa-0000-0000-0000-000000000001'
\set us 'aaaaaaaa-0000-0000-0000-000000000002'
\set ub 'bbbbbbbb-0000-0000-0000-000000000001'

create temp table results (n serial, test text, passed boolean);
grant all on results to authenticated;
grant usage on sequence results_n_seq to authenticated;

create function pg_temp.login(p text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p)::text, false); $$;
-- true when the statement raises (we expect it to be refused)
create function pg_temp.fails(sql text) returns boolean language plpgsql as $$
begin execute sql; return false; exception when others then return true; end $$;
create function pg_temp.ok(t text, p boolean) returns void language sql as $$
  insert into results (test, passed) values (t, coalesce(p, false)); $$;

set role authenticated;

-- ---------------- setup via the real sign-up path
select pg_temp.login(:'ua');
select public.create_company('Company A') as ca \gset
select pg_temp.login(:'ub');
select public.create_company('Company B') as cb \gset

select pg_temp.login(:'ua');
insert into company_members (company_id, user_id, role) values (:'ca', :'us', 'salesperson');
insert into catalogue_products (company_id, sku, name, unit, unit_price, currency)
  values (:'ca', 'A-100', 'Porcelain tile 60x60', 'm2', 85.50, 'SAR') returning id as pa \gset
insert into catalogue_products (company_id, sku, name, unit, unit_price, currency)
  values (:'ca', 'A-200', 'Imported mixer', 'pcs', 120, 'USD') returning id as pa_usd \gset
insert into catalogue_products (company_id, sku, name, unit)
  values (:'ca', 'A-300', 'Unpriced item', 'pcs') returning id as pa_noprice \gset
insert into inquiries (company_id, customer_name) values (:'ca', 'Customer X') returning id as ia \gset
insert into storage.objects (bucket_id, name) values ('inquiry-files', :'ca' || '/' || :'ia' || '/boq.xlsx');
insert into requirements (company_id, inquiry_id, item_no, description, quantity, unit)
  values (:'ca', :'ia', '1', 'Floor tile 600x600', 250, 'm2') returning id as ra \gset

select pg_temp.login(:'ub');
insert into catalogue_products (company_id, sku, name, unit, unit_price, currency)
  values (:'cb', 'B-1', 'Other tile', 'm2', 10, 'SAR') returning id as pb \gset

-- ---------------- 1. tenant isolation (user B looking at company A)
select pg_temp.ok('B cannot read A inquiries', (select count(*) = 0 from inquiries where company_id = :'ca'));
select pg_temp.ok('B cannot read A catalogue', (select count(*) = 0 from catalogue_products where company_id = :'ca'));
select pg_temp.ok('B cannot read A requirements', (select count(*) = 0 from requirements where company_id = :'ca'));
select pg_temp.ok('B cannot read A files', (select count(*) = 0 from storage.objects where name like :'ca' || '/%'));
select pg_temp.ok('B cannot read A company', (select count(*) = 0 from companies where id = :'ca'));
select pg_temp.ok('B cannot insert inquiry into A',
  pg_temp.fails(format('insert into inquiries (company_id, customer_name) values (%L, %L)', :'ca', 'x')));
select pg_temp.ok('B cannot upload into A folder',
  pg_temp.fails(format('insert into storage.objects (bucket_id, name) values (%L, %L)', 'inquiry-files', :'ca' || '/x.pdf')));
select pg_temp.ok('B cannot add itself to A',
  pg_temp.fails(format('insert into company_members (company_id, user_id, role) values (%L, %L, %L)', :'ca', :'ub', 'admin')));
update inquiries set customer_name = 'hacked' where id = :'ia';
delete from inquiries where id = :'ia';
select pg_temp.ok('Anonymous (no login) sees nothing',
  (select set_config('request.jwt.claims', '', false) is not null) and (select count(*) = 0 from inquiries));

-- ---------------- 2. roles
select pg_temp.login(:'us');
select pg_temp.ok('Salesperson sees own company inquiry', (select count(*) = 1 from inquiries where id = :'ia'));
select pg_temp.ok('A data untouched by B update/delete', (select customer_name = 'Customer X' from inquiries where id = :'ia'));
update catalogue_products set unit_price = 1 where id = :'pa';
select pg_temp.ok('Salesperson cannot change catalogue prices', (select unit_price = 85.50 from catalogue_products where id = :'pa'));
select pg_temp.ok('Salesperson cannot read audit log', (select count(*) = 0 from audit_log));

-- ---------------- 3. evidence and matching rules
select pg_temp.ok('AI requirement without source evidence is rejected',
  pg_temp.fails(format($q$
    with r as (insert into ai_runs (company_id, inquiry_id, kind, idempotency_key, provider)
               values (%L, %L, 'extract', 'k-test', 'demo') returning id)
    insert into requirements (company_id, inquiry_id, ai_run_id, description) select %L, %L, id, 'x' from r $q$,
    :'ca', :'ia', :'ca', :'ia')));
select pg_temp.ok('Match to another company''s product is rejected',
  pg_temp.fails(format('insert into product_matches (company_id, requirement_id, product_id, label) values (%L,%L,%L,%L)',
    :'ca', :'ra', :'pb', 'potential_match')));
insert into product_matches (company_id, requirement_id, product_id, label, similarities)
  values (:'ca', :'ra', :'pa', 'potential_match', '{"Same 600x600 size"}') returning id as ma \gset

-- ---------------- 4. quotation approval rules
select public.next_quote_number(:'ca') as qn \gset
select pg_temp.ok('Quote numbering works', :'qn' like 'Q-____-0001');
insert into quotations (company_id, inquiry_id, quote_number) values (:'ca', :'ia', :'qn') returning id as q \gset
insert into quotation_revisions (company_id, quotation_id, revision_no, currency, tax_rate)
  values (:'ca', :'q', 0, 'SAR', 15) returning id as r0 \gset
insert into quotation_lines (company_id, revision_id, line_no, requirement_id, match_id, product_id, sku, description,
                             quantity, unit, unit_price, currency, price_source)
  values (:'ca', :'r0', 1, :'ra', :'ma', :'pa', 'A-100', 'Porcelain tile 60x60', 250, 'm2', 85.50, 'SAR', 'catalogue')
  returning id as l1 \gset

select pg_temp.ok('Cannot approve with unapproved line',
  pg_temp.fails(format('select approve_revision(%L, %L)', :'r0', '{}')));
update quotation_lines set line_approved = true where id = :'l1';
select pg_temp.ok('Cannot approve while product match still pending',
  pg_temp.fails(format('select approve_revision(%L, %L)', :'r0', '{}')));
update product_matches set decision = 'approved', decided_by = :'us', decided_at = now() where id = :'ma';

insert into quotation_lines (company_id, revision_id, line_no, product_id, sku, description, quantity, unit,
                             unit_price, currency, price_source, line_approved)
  values (:'ca', :'r0', 2, :'pa_noprice', 'A-300', 'Unpriced item', 2, 'pcs', null, 'SAR', 'catalogue', true)
  returning id as l2 \gset
select pg_temp.ok('Cannot approve with a missing price',
  pg_temp.fails(format('select approve_revision(%L, %L)', :'r0', '{}')));
delete from quotation_lines where id = :'l2';

insert into quotation_lines (company_id, revision_id, line_no, product_id, sku, description, quantity, unit,
                             unit_price, currency, price_source, line_approved)
  values (:'ca', :'r0', 2, :'pa_usd', 'A-200', 'Imported mixer', 3, 'pcs', 120, 'USD', 'catalogue', true)
  returning id as l3 \gset
select pg_temp.ok('Cannot approve mixed currency without approved FX',
  pg_temp.fails(format('select approve_revision(%L, %L)', :'r0', '{}')));
update quotation_revisions set approved_fx = '{"USD":"3.7500"}' where id = :'r0';
select pg_temp.ok('Error helper detects failures', pg_temp.fails('select 1/0'));
update quotation_lines set unit_price = 125 where id = :'l3';
select pg_temp.ok('Price edit reset line_approved to false', (select not line_approved from quotation_lines where id = :'l3'));
update quotation_lines set line_approved = true where id = :'l3';

select approve_revision(:'r0', '{"total":"x"}');
select pg_temp.ok('Approval succeeds when rules are met',
  (select status = 'approved' and approved_by = :'us'::uuid from quotation_revisions where id = :'r0'));

-- ---------------- 4b. blank quantity blocks approval (draft rev of a second quotation)
select public.next_quote_number(:'ca') as qn2 \gset
insert into quotations (company_id, inquiry_id, quote_number) values (:'ca', :'ia', :'qn2') returning id as q2 \gset
insert into quotation_revisions (company_id, quotation_id, revision_no, currency, tax_rate) values (:'ca', :'q2', 0, 'SAR', 15) returning id as q2r0 \gset
insert into quotation_lines (company_id, revision_id, line_no, product_id, sku, description, quantity, unit, unit_price, currency, price_source, line_approved)
  values (:'ca', :'q2r0', 1, :'pa', 'A-100', 'Tile', null, 'm2', 10, 'SAR', 'catalogue', true);
select pg_temp.ok('Cannot approve a line with blank quantity',
  pg_temp.fails(format('select approve_revision(%L, %L)', :'q2r0', '{}')));

-- ---------------- 5. approved revisions are frozen; edits create a new draft
select pg_temp.ok('Cannot edit line of approved revision',
  pg_temp.fails(format('update quotation_lines set quantity = 1 where id = %L', :'l1')));
select pg_temp.ok('Cannot add line to approved revision',
  pg_temp.fails(format($q$insert into quotation_lines (company_id, revision_id, line_no, sku, description, quantity, unit,
     unit_price, currency, price_source) values (%L,%L,9,'X','x',1,'pcs',1,'SAR','user_edit')$q$, :'ca', :'r0')));
select pg_temp.ok('Cannot change terms of approved revision',
  pg_temp.fails(format('update quotation_revisions set payment_terms = %L where id = %L', 'cash', :'r0')));
select revise_quotation(:'r0') as r1 \gset
select pg_temp.ok('Revision creates draft rev 1 with lines needing re-approval',
  (select r.status = 'draft' and r.revision_no = 1 and r.approved_fx = '{}'::jsonb
          and (select count(*) from quotation_lines where revision_id = r.id) = 2
          and (select bool_and(not line_approved) from quotation_lines where revision_id = r.id)
     from quotation_revisions r where r.id = :'r1'));
select pg_temp.ok('Original approved revision unchanged',
  (select status = 'approved' from quotation_revisions where id = :'r0'));
select pg_temp.ok('Only one draft at a time',
  pg_temp.fails(format('select revise_quotation(%L)', :'r0')));
update quotation_revisions set approved_fx = '{"USD":"3.7500"}' where id = :'r1';
update quotation_lines set line_approved = true where revision_id = :'r1';
select approve_revision(:'r1', '{}');
select pg_temp.ok('Approving rev 1 supersedes rev 0',
  (select status = 'superseded' from quotation_revisions where id = :'r0'));

-- ---------------- 6. audit trail
select pg_temp.login(:'ua');
select pg_temp.ok('Admin sees audit entries with actor',
  (select count(*) > 0 from audit_log where table_name = 'quotation_revisions' and actor_id = :'us'::uuid));
update requirements set quantity = 260, corrected_by = :'ua', corrected_at = now() where id = :'ra';
select pg_temp.ok('Requirement correction is audited with before/after',
  (select changes -> 'quantity' ->> 'from' = '250.0000' and changes -> 'quantity' ->> 'to' = '260.0000'
     from audit_log where table_name = 'requirements' and action = 'update' and row_id = :'ra'::uuid));

select pg_temp.ok('Admin cannot turn a real company into a demo',
  pg_temp.fails(format('update companies set is_demo = true where id = %L', :'ca')));
select pg_temp.ok('Admin can edit company profile',
  not pg_temp.fails(format('update companies set phone = %L where id = %L', '+966 12 000 0000', :'ca')));

-- ---------------- 7. user can delete inquiry with everything under it
delete from inquiries where id = :'ia';
select pg_temp.ok('Deleting inquiry removes approved quotations too',
  (select count(*) = 0 from quotation_revisions where quotation_id = :'q'));

reset role;
\set QUIET off
select n, case when passed then 'PASS' else 'FAIL' end as result, test from results order by n;
select count(*) filter (where not passed) as failures from results \gset
\if :failures
  \echo SOME TESTS FAILED
\else
  \echo ALL TESTS PASSED
\endif
