alter table search_config alter column include_unknown_location set default false;
update search_config set include_unknown_location = false where id = 1;