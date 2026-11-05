-- Team invitations.
-- An admin creates an invitation for an email address and role. The app generates a
-- random token, shows it to the admin once as a link, and stores only its SHA-256 hash.
-- The invited person opens the link, signs in with that same email, and accepts.

create table public.invitations (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  email       text not null check (email = lower(trim(email)) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  role        public.member_role not null default 'salesperson',
  token_hash  text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  invited_by  uuid,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '7 days',
  accepted_at timestamptz,
  accepted_by uuid,
  revoked_at  timestamptz
);
create index invitations_company_idx on public.invitations (company_id, created_at desc);
-- At most one open invitation per email per company.
create unique index invitations_one_open on public.invitations (company_id, email)
  where accepted_at is null and revoked_at is null;

alter table public.invitations enable row level security;
alter table public.invitations force row level security;

-- Only admins of the company can see, create, revoke or renew its invitations.
create policy invitations_admin on public.invitations for all to authenticated
  using ((select private.is_admin(company_id))) with check ((select private.is_admin(company_id)));

grant select, insert, update on public.invitations to authenticated;
-- Accepted/revoked state is only set by accept_invitation() or by revoking (revoked_at).
revoke update on public.invitations from authenticated;
grant update (token_hash, expires_at, revoked_at, role) on public.invitations to authenticated;
revoke all on public.invitations from anon;

create trigger invitations_audit after insert or update or delete on public.invitations
  for each row execute function private.audit();

-- The signed-in user's verified email: from Supabase Auth when present, otherwise
-- from the local development user table.
create or replace function private.current_user_email() returns text
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_email text;
begin
  if v_uid is null then return null; end if;
  if to_regclass('auth.users') is not null then
    execute 'select email from auth.users where id = $1' into v_email using v_uid;
  elsif to_regclass('local_auth.users') is not null then
    execute 'select email from local_auth.users where id = $1' into v_email using v_uid;
  end if;
  return lower(v_email);
end $$;
revoke all on function private.current_user_email() from public;

-- What an invitation link points to, for the join page. Looked up by token hash only,
-- so invitations can't be listed or guessed.
create or replace function public.invitation_preview(p_token_hash text)
returns table (company_name text, email text, role public.member_role, status text, expires_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select c.name, i.email, i.role,
         case when i.accepted_at is not null then 'accepted'
              when i.revoked_at is not null then 'revoked'
              when i.expires_at < now() then 'expired'
              else 'valid' end,
         i.expires_at
    from public.invitations i join public.companies c on c.id = i.company_id
   where i.token_hash = p_token_hash;
$$;
revoke all on function public.invitation_preview(text) from public;
grant execute on function public.invitation_preview(text) to anon, authenticated;

-- Accept an invitation as the signed-in user. The user's email must match the invite.
create or replace function public.accept_invitation(p_token_hash text, p_full_name text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_email text; i public.invitations;
begin
  if v_uid is null then raise exception 'Sign in to accept this invitation' using errcode = '42501'; end if;
  select * into i from public.invitations where token_hash = p_token_hash for update;
  if not found then raise exception 'This invitation link is not valid' using errcode = 'P0002'; end if;
  if i.accepted_at is not null then raise exception 'This invitation has already been used' using errcode = '23514'; end if;
  if i.revoked_at is not null then raise exception 'This invitation was cancelled by the company admin' using errcode = '23514'; end if;
  if i.expires_at < now() then raise exception 'This invitation has expired. Ask the admin for a new link' using errcode = '23514'; end if;
  v_email := private.current_user_email();
  if v_email is distinct from i.email then
    raise exception 'This invitation is for %. You are signed in as %. Sign out and sign in with the invited email.',
      i.email, coalesce(v_email, 'another account') using errcode = '42501';
  end if;
  insert into public.company_members (company_id, user_id, role, full_name)
  values (i.company_id, v_uid, i.role, nullif(trim(coalesce(p_full_name, '')), ''))
  on conflict (company_id, user_id) do nothing;
  update public.invitations set accepted_at = now(), accepted_by = v_uid where id = i.id;
  return i.company_id;
end $$;
revoke all on function public.accept_invitation(text, text) from public, anon;
grant execute on function public.accept_invitation(text, text) to authenticated;
