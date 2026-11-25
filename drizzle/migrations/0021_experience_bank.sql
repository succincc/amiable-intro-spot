-- Every job the owner has held, kept in one place.
--
-- A resume is one page and a career is not. Until now the only source for a
-- tailored resume was the single resume on file, so whatever had been left
-- off that page could never appear on any application, however well it
-- suited the role.
--
-- This holds all of it: each job with its dates and, in the owner's own
-- words, what was done there. When a resume is written for a posting, the
-- roles that bear on that posting are chosen from here and the rest are
-- left off. Nothing is invented from it — the company, title and dates go
-- onto the page exactly as they are entered.

create table if not exists experience (
  id          uuid primary key default gen_random_uuid(),
  company     text not null,
  title       text not null,
  location    text,
  -- as they should read on a resume: "Jul 2024", "2019"
  start_date  text,
  -- empty means the job is current
  end_date    text,
  -- what was done, achievements, tools, numbers: the raw material
  details     text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_experience_created on experience(created_at desc);

alter table experience enable row level security;
drop policy if exists owner_all on experience;
create policy owner_all on experience for all to authenticated using (true) with check (true);