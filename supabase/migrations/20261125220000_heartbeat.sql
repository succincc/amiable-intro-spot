-- A clock of the panel's own.
--
-- Everything this system does on a timer was started by GitHub's scheduler,
-- and GitHub's scheduler turned out to start very little: over one day a job
-- set for every three hours ran three times, and across every job in the
-- repository it had fired twenty-two times in all. Nothing was broken; it
-- simply was not being started.
--
-- So the database keeps time instead. Every five minutes it asks the panel
-- one question — "anything due?" — at /api/public/cron/tick. The panel reads
-- the mail, sends replies that have been cleared, and every half hour wakes
-- the job on GitHub that starts whatever else has come round.
--
-- That address takes no key, so none is written here, in a public
-- repository. It does not need one: it does only what the timer would have
-- done anyway, and no more often — the table below is how it knows when it
-- last did each thing, and a caller who asks a thousand times gets the same
-- one read of the mailbox every ten minutes as a caller who asks once.

create table if not exists heartbeat (
  name text primary key,
  at   timestamptz not null default 'epoch'
);

insert into heartbeat (name) values ('mail'), ('watch') on conflict (name) do nothing;

-- Only the panel's own server reads or writes it.
alter table heartbeat enable row level security;

-- The scheduler and the request it makes. Both come with the database on
-- this host; if either is not available the rest of this file still applies,
-- and the address above can be pinged by any free outside timer instead.
do $$
begin
  create extension if not exists pg_cron with schema pg_catalog;
exception when others then
  raise notice 'pg_cron is not available here: %', sqlerrm;
end $$;

do $$
begin
  create extension if not exists pg_net with schema extensions;
exception when others then
  raise notice 'pg_net is not available here: %', sqlerrm;
end $$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron')
     and exists (select 1 from pg_extension where extname = 'pg_net') then
    -- Replace rather than add, so applying this twice leaves one timer.
    perform cron.unschedule(jobid) from cron.job where jobname = 'applypilot-tick';
    perform cron.schedule(
      'applypilot-tick',
      '*/5 * * * *',
      $job$
        select net.http_post(
          url := 'https://applynow.lol/api/public/cron/tick',
          body := '{}'::jsonb,
          headers := '{"Content-Type": "application/json"}'::jsonb,
          timeout_milliseconds := 60000
        );
      $job$
    );
  end if;
exception when others then
  raise notice 'the timer could not be set: %', sqlerrm;
end $$;
