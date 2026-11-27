-- A call to the place itself, after applying.
--
-- jobs.phone       the location's own published number, where one is found
-- jobs.call_state  what came of the call: null (not yet), spoke, message,
--                  callback, no_answer, skip
-- jobs.call_note   what was said, in the owner's words
-- jobs.call_at     when the call was made, or when to call back

alter table jobs add column if not exists phone text;
alter table jobs add column if not exists call_state text;
alter table jobs add column if not exists call_note text;
alter table jobs add column if not exists call_at timestamptz;
