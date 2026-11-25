insert into engine_status (id, online, last_heartbeat, current_stage, run_started_at, counters)
values (1, true, now(), 'apply', now() - interval '2 hours',
        '{"discovered": 142, "scored": 98, "applied_today": 37, "attention": 2}')
on conflict (id) do update set online = excluded.online,
  last_heartbeat = excluded.last_heartbeat, current_stage = excluded.current_stage,
  run_started_at = excluded.run_started_at, counters = excluded.counters;

insert into jobs (url, title, company, location, salary_text, site, fit_score, score_reasoning, status, attention_reason, skip_reason, applied_at, discovered_at) values
('https://boards.greenhouse.io/acme/jobs/1001', 'Backend Engineer', 'Acme Corp', 'Tampa, FL', '$95k–$120k', 'greenhouse', 8, 'Strong match: Python, FastAPI, PostgreSQL all present.', 'applied', null, null, now() - interval '1 day', now() - interval '2 days'),
('https://jobs.lever.co/globex/2002', 'Full Stack Developer', 'Globex', 'Remote', '$85k–$110k', 'lever', 7, 'Good match; React + Python overlap.', 'interview', null, null, now() - interval '5 days', now() - interval '6 days'),
('https://initech.wd5.myworkdayjobs.com/3003', 'Software Engineer II', 'Initech', 'Orlando, FL', null, 'workday', 6, 'Moderate: stack partially overlaps.', 'needs_attention', 'captcha', null, null, now() - interval '3 hours'),
('https://umbrella.wd1.myworkdayjobs.com/3004', 'Platform Engineer', 'Umbrella Inc', 'Remote', '$130k', 'workday', 9, 'Excellent match.', 'needs_attention', 'unknown_question', null, null, now() - interval '1 hour'),
('https://www.indeed.com/viewjob?jk=4005', 'Python Developer', 'Hooli', 'Miami, FL', '$90k', 'indeed', 5, 'Borderline: junior-leaning.', 'review', null, null, null, now() - interval '4 hours'),
('https://www.indeed.com/viewjob?jk=4006', 'Systems Engineer', 'Stark Industries', 'Tampa, FL', null, 'indeed', 4, 'Weak-moderate match.', 'review', null, null, null, now() - interval '5 hours'),
('https://www.linkedin.com/jobs/view/5007', 'Sales Engineer — Commission', 'Vandelay', 'Remote', 'Commission', 'linkedin', 7, 'Skipped by rule.', 'skipped', null, 'no_go_pattern: commission only', null, now() - interval '6 hours'),
('https://boards.greenhouse.io/pied/jobs/6008', 'DevOps Engineer', 'Pied Piper', 'Remote', '$105k', 'greenhouse', 8, 'Strong match.', 'queued', null, null, null, now() - interval '30 minutes'),
('https://jobs.ashbyhq.com/dunder/7009', 'Data Engineer', 'Dunder Mifflin', 'Remote', null, 'ashby', 6, 'Decent match.', 'applied', null, null, now() - interval '3 days', now() - interval '4 days'),
('https://jobs.lever.co/wonka/8010', 'Cloud Engineer', 'Wonka Industries', 'Remote', '$115k', 'lever', 7, 'Good match.', 'rejected', null, null, now() - interval '10 days', now() - interval '11 days')
on conflict (url) do nothing;

insert into questions (question_normalized, question_raw, answer, confidence, times_used, source_job_url) values
('are you willing to undergo a background check', 'Are you willing to undergo a background check?', 'Yes', 'low', 1, 'https://initech.wd5.myworkdayjobs.com/3003'),
('what is your desired salary', 'What is your desired salary?', '95000', 'low', 3, 'https://boards.greenhouse.io/acme/jobs/1001'),
('are you legally authorized to work in the united states', 'Are you legally authorized to work in the United States?', 'Yes', 'high', 14, null),
('will you now or in the future require sponsorship', 'Will you now or in the future require sponsorship for employment visa status?', 'No', 'high', 12, null)
on conflict (question_normalized) do nothing;

insert into emails (gmail_id, from_address, subject, snippet, body_text, received_at, category, classified_by, job_id, is_read) values
('seed-001', 'no-reply@hire.lever.co', 'Interview availability — Globex Full Stack Developer', 'We''d love to schedule a phone screen…', 'Hi, thanks for applying to Globex. We''d love to schedule a 30-minute phone screen. Please pick a time…', now() - interval '2 days', 'interview', 'rules', (select id from jobs where url = 'https://jobs.lever.co/globex/2002'), false),
('seed-002', 'no-reply@greenhouse.io', 'Update on your application — Wonka Industries', 'Unfortunately we have decided…', 'Thank you for your interest. Unfortunately, we have decided to move forward with other candidates…', now() - interval '9 days', 'rejection', 'rules', (select id from jobs where url = 'https://jobs.lever.co/wonka/8010'), true),
('seed-003', 'assessments@hackerrank.com', 'Action required: complete your Acme Corp assessment', 'You have 5 days to complete…', 'Acme Corp has invited you to complete a coding assessment. Deadline in 5 days…', now() - interval '20 hours', 'action_needed', 'rules', (select id from jobs where url = 'https://boards.greenhouse.io/acme/jobs/1001'), false),
('seed-004', 'donotreply@myworkday.com', 'Application received — Dunder Mifflin', 'Thank you for applying…', 'This confirms we received your application for Data Engineer…', now() - interval '3 days', 'confirmation', 'rules', (select id from jobs where url = 'https://jobs.ashbyhq.com/dunder/7009'), true)
on conflict (gmail_id) do nothing;

insert into search_presets (name, is_active, queries, locations, job_types, salary_floor, hours_old, boards, exclude_titles, exclude_companies)
select 'Main hunt', true,
  '[{"query":"software engineer","tier":1},{"query":"backend developer","tier":1},{"query":"python developer","tier":2},{"query":"developer","tier":3}]',
  '[{"location":"Tampa, FL","remote":false,"radius_miles":25},{"location":"Remote","remote":true,"radius_miles":100}]',
  '{fulltime}', 80000, 72, '{indeed,linkedin,glassdoor,zip_recruiter,google}',
  '{intern,director,clearance}', '{}'
where not exists (select 1 from search_presets);