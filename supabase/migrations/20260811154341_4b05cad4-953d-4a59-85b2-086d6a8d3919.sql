alter table public.jobs add column if not exists skip_reason text;
alter table public.jobs add column if not exists attention_reason text;
alter table public.jobs add column if not exists resume_pdf_path text;
alter table public.jobs add column if not exists cover_letter_path text;
alter table public.jobs add column if not exists updated_at timestamptz default now();
alter table public.search_presets add column if not exists auto_run_hours numeric default 0;

alter table public.profile add column if not exists resume_file_path text;
alter table public.profile add column if not exists resume_file_name text;
alter table public.profile add column if not exists resume_uploaded_at timestamptz;
alter table public.profile add column if not exists resume_parse_error text;
alter table public.profile add column if not exists resume_word_count int;
alter table public.profile add column if not exists resume_warnings text;

do $$
begin
  begin
    alter publication supabase_realtime add table public.emails;
  exception when duplicate_object then null;
  end;
end $$;

drop policy if exists "Authenticated manage artifacts" on storage.objects;
create policy "Authenticated manage artifacts"
on storage.objects for all to authenticated
using (bucket_id = 'artifacts') with check (bucket_id = 'artifacts');