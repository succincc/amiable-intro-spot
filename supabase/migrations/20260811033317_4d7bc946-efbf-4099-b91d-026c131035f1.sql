create policy "owner reads artifacts" on storage.objects for select to authenticated using (bucket_id = 'artifacts');
create policy "owner writes artifacts" on storage.objects for insert to authenticated with check (bucket_id = 'artifacts');
create policy "owner updates artifacts" on storage.objects for update to authenticated using (bucket_id = 'artifacts');