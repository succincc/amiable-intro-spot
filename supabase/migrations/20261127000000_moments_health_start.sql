-- The few emails the owner has to know about, and a check on the system
-- itself.
--
-- emails.notified_at   when the owner was told about this message (an
--                      interview with a time on it, a link to pick a time,
--                      an assessment, an offer), or when it was looked at
--                      and found to need no telling. Told once.
-- emails.moment        which of those it was, for the panel.
-- profile.notify_moments  the owner's switch for those emails. On unless
--                      switched off: they go only to the owner's own address.
-- profile.health_state what is wrong with the system, in words, or null.
--                      Shown on the dashboard; emailed when it changes.
-- profile.health_notified_at  when that was last emailed.

alter table emails add column if not exists notified_at timestamptz;
alter table emails add column if not exists moment text;

alter table profile add column if not exists notify_moments boolean not null default true;
alter table profile add column if not exists health_state text;
alter table profile add column if not exists health_notified_at timestamptz;

insert into heartbeat (name) values ('health') on conflict (name) do nothing;
