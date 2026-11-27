-- A new person's search reads every system the employer list is on.
--
-- A new workspace took the search table's first defaults, from before
-- Workday and SmartRecruiters could be read: its search skipped 346 of the
-- 632 employers on the shared list, and still named a job board that was
-- retired. The default now matches what is read, and searches made under the
-- old default are brought up to it. A source somebody has switched on is
-- left on; nothing is switched off but the retired board.

alter table search_config
  alter column sources set default array['greenhouse','lever','ashby','workday','smartrecruiters','workable','remotive','remoteok','usajobs']::text[];

update search_config
   set sources = array_remove(sources, 'arbeitnow')
 where 'arbeitnow' = any(sources);

update search_config
   set sources = sources || array['workday']::text[]
 where not ('workday' = any(sources));

update search_config
   set sources = sources || array['smartrecruiters']::text[]
 where not ('smartrecruiters' = any(sources));
