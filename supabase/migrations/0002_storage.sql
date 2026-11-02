-- Private storage bucket for inquiry files, datasheets, logos and exports.
-- Object paths always start with the company id: <company_id>/<inquiry_id>/<file>
-- Files are only ever served through short-lived signed URLs created server-side.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('inquiry-files', 'inquiry-files', false, 26214400, array[
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv', 'text/plain',
  'image/png', 'image/jpeg', 'image/webp', 'image/tiff'
])
on conflict (id) do update set public = false,
  file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create or replace function private.object_company(p_name text)
returns uuid language sql immutable set search_path = '' as $$
  select case when split_part(p_name, '/', 1) ~ '^[0-9a-f-]{36}$'
              then split_part(p_name, '/', 1)::uuid end;
$$;
grant execute on function private.object_company(text) to authenticated;

create policy inquiry_files_select on storage.objects for select to authenticated
  using (bucket_id = 'inquiry-files' and (select private.is_member(private.object_company(name))));
create policy inquiry_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'inquiry-files' and (select private.is_member(private.object_company(name))));
-- Upsert (re-uploading the same file) needs UPDATE as well as INSERT + SELECT.
create policy inquiry_files_update on storage.objects for update to authenticated
  using (bucket_id = 'inquiry-files' and (select private.is_member(private.object_company(name))))
  with check (bucket_id = 'inquiry-files' and (select private.is_member(private.object_company(name))));
create policy inquiry_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'inquiry-files' and (select private.is_member(private.object_company(name))));
