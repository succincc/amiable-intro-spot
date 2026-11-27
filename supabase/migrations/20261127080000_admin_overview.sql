-- The owner's view of everyone: who has asked to come in, who is in, and
-- how each person's workspace is doing — in counts and switches only. No
-- row of anyone's jobs, mail, resume or keys is returned; whether a mailbox
-- or a key is connected is a yes or a no.
--
-- For the owner alone: anybody else who calls it is refused.

create or replace function public.admin_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  owner uuid := (select user_id from app_owner limit 1);
begin
  if not public.is_app_owner() then
    raise exception 'owner only';
  end if;
  return coalesce((
    select jsonb_agg(row_to_json(x) order by x.is_owner desc, x.created_at desc)
    from (
      select
        p.user_id,
        p.is_owner,
        coalesce(nullif(p.full_name, ''), pr.full_name, '') as full_name,
        coalesce(nullif(p.email, ''), u.email, '') as email,
        p.status,
        p.created_at,
        p.decided_at,
        u.last_sign_in_at,
        (pr.user_id is not null) as has_workspace,
        coalesce(pr.autopilot, false) as autopilot,
        (pr.resume_text is not null and length(pr.resume_text) > 200) as has_resume,
        (select coalesce(array_length(sc.titles, 1), 0) from search_config sc where sc.user_id = p.user_id) as titles,
        exists (select 1 from google_tokens g where g.user_id = p.user_id and g.refresh_token is not null) as mail_connected,
        (select es.last_run_at from email_sync es where es.user_id = p.user_id) as mail_last_read,
        exists (select 1 from user_keys k where k.user_id = p.user_id and k.gemini_key is not null) as own_key,
        (select count(*) from companies c where c.user_id = p.user_id and c.enabled is not false) as employers,
        (select count(*) from jobs j where j.user_id = p.user_id) as jobs,
        (select count(*) from jobs j where j.user_id = p.user_id and j.status = 'queued') as queued,
        (select count(*) from jobs j where j.user_id = p.user_id and j.status = 'needs_help') as needs_help,
        (select count(*) from jobs j where j.user_id = p.user_id and j.applied_at is not null) as applied,
        (select count(*) from jobs j where j.user_id = p.user_id and j.applied_at >= now() - interval '24 hours') as applied_24h,
        (select count(*) from jobs j where j.user_id = p.user_id and j.status in ('interview', 'offer')) as interviews,
        (select max(j.applied_at) from jobs j where j.user_id = p.user_id) as last_applied_at,
        (select count(*) from answers a where a.user_id = p.user_id and a.confirmed is not true) as questions_waiting
      from (
        select m.user_id, false as is_owner, m.full_name, m.email, m.status, m.created_at, m.decided_at from members m where m.user_id <> owner
        union all
        select owner, true, '', '', 'approved', (select created_at from auth.users where id = owner), null
      ) p
      left join auth.users u on u.id = p.user_id
      left join profile pr on pr.user_id = p.user_id
    ) x
  ), '[]'::jsonb);
end $$;
revoke all on function public.admin_overview() from public, anon;
grant execute on function public.admin_overview() to authenticated;
