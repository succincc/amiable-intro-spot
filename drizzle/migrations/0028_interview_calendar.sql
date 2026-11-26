-- The owner's interview calendar.
--
-- availability_slots: the windows marked free on the month view in settings —
--   [{ "day": "2026-12-03", "from": 540, "to": 1020, "kinds": ["phone","virtual"] }]
--   with from/to as minutes after midnight in the owner's time zone.
-- interview_holds: every time offered to an employer and not yet past, so
--   the same hour is never offered to two of them.
-- same_country_only: postings outside the owner's country are left out. On
--   unless switched off; remote roles are held to it too, since a remote job
--   advertised abroad cannot usually be worked from here.

alter table profile add column if not exists availability_slots jsonb not null default '[]'::jsonb;
alter table profile add column if not exists interview_holds jsonb not null default '[]'::jsonb;
alter table search_config add column if not exists same_country_only boolean not null default true;