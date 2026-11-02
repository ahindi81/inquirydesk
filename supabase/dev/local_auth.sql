-- DEVELOPMENT ONLY: password store for the local sign-in stand-in used when
-- AUTH_DRIVER=local. Production uses Supabase Auth and never loads this.
create schema if not exists local_auth;
create table if not exists local_auth.users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null unique check (email = lower(email)),
  password_hash text not null,
  full_name     text,
  created_at    timestamptz not null default now()
);
-- The app server role may read/write here directly (outside RLS).
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'app_server') then
    create role app_server login password 'app_server_dev_only' noinherit;
  end if;
end $$;
grant authenticated to app_server;
grant usage on schema local_auth to app_server;
grant select, insert on local_auth.users to app_server;
