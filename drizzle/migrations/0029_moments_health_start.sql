-- Notification tracking and system health state.
alter table emails add column if not exists notified_at timestamptz;
alter table emails add column if not exists moment text;
alter table profile add column if not exists notify_moments boolean not null default true;
alter table profile add column if not exists health_state text;
alter table profile add column if not exists health_notified_at timestamptz;