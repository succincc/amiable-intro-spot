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