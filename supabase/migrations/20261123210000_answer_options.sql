-- The choices an employer offered for a question the applier could not answer.
--
-- Without these the Answers page is a free-text box, and answering it is
-- guessing at a spelling. One real questionnaire offers "Bachelor’s Degree"
-- with a curly apostrophe; a typed straight one misses in silence, and the
-- person is left believing they answered the question. With the options
-- stored, the panel shows the employer's own wording as buttons and the
-- saved answer matches by construction.
alter table public.answers
  add column if not exists options jsonb not null default '[]'::jsonb;

comment on column public.answers.options is
  'Choices the portal offered, verbatim. Empty for free-text questions.';
