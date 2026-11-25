update jobs set status='needs_attention', attention_reason='captcha' where url='https://initech.wd5.myworkdayjobs.com/3003';
update jobs set status='review' where url in ('https://www.indeed.com/viewjob?jk=4005','https://www.indeed.com/viewjob?jk=4006');
update questions set confidence='low' where question_normalized in ('are you willing to undergo a background check','what is your desired salary');
delete from commands;
update engine_status set last_heartbeat = now() - interval '30 minutes', online=false, current_stage='idle' where id=1;
insert into commands (command, payload, status, created_at) values ('start_run', '{"preset_id":"demo"}', 'pending', now() - interval '25 minutes');