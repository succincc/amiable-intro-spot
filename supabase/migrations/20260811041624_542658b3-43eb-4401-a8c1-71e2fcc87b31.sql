delete from commands;
update engine_status set online=true, current_stage='apply', last_heartbeat=now(), run_started_at=now() - interval '2 hours' where id=1;