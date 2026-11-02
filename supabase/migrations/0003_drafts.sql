-- Editable clarification email draft per inquiry (never sent automatically).
alter table public.inquiries add column if not exists clarification_draft text;
alter table public.inquiries add column if not exists clarification_updated_by uuid;
alter table public.inquiries add column if not exists clarification_updated_at timestamptz;

-- A quotation line may have no quantity yet (the inquiry didn't state one).
-- It is never filled in with a placeholder; approval is refused until it is entered.
alter table public.quotation_lines alter column quantity drop not null;

create or replace function private.require_quantities() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status = 'approved' and old.status = 'draft' and exists (
       select 1 from public.quotation_lines where revision_id = new.id and quantity is null) then
    raise exception 'One or more lines have no quantity' using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists quotation_revisions_require_qty on public.quotation_revisions;
create trigger quotation_revisions_require_qty before update on public.quotation_revisions
  for each row execute function private.require_quantities();
