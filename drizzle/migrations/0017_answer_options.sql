alter table public.answers
  add column if not exists options jsonb not null default '[]'::jsonb;

comment on column public.answers.options is
  'Choices the portal offered, verbatim. Empty for free-text questions.';