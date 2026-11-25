-- Take the timer back out of the database.
--
-- It was put in to keep time for the whole system, because GitHub's own
-- scheduler was not starting things. It kept time perfectly — and kept the
-- database awake to do it. This database is billed for the hours it is
-- awake, not for what it does in them, so a timer that fires every five
-- minutes is a database that never sleeps: by the host's own estimate up to
-- ten times what the whole project had been using.
--
-- The time is kept on GitHub now, by a job that waits there, where waiting
-- is free, and wakes the database only when there is a round of work to do.
--
-- The heartbeat table stays. It is how the panel knows when it last read the
-- mailbox, so that being asked twice does not mean reading twice.

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'applypilot-tick';
  end if;
exception when others then
  raise notice 'the timer could not be removed here: %', sqlerrm;
end $$;
