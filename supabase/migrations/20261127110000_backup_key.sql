-- A second free key, for the hours the first has no allowance left.
--
-- One night every free Gemini model was spent by eleven and nothing on a form
-- that needed the model was answered until three. Groq gives a free allowance
-- of its own on a key of its own. A person may save one beside their first
-- key; it is asked only when the first cannot answer. Same row, same rule:
-- readable and writable by its person, and by the runner doing their round.

alter table user_keys add column if not exists groq_key text;
