-- When the owner can interview, in their own words.
--
-- A reply to an interview request has to say when. Until now it could only
-- say "I am flexible, you pick", because the times were nowhere on file. This
-- is written once in settings — "weekdays between 9am and 5pm Eastern, with a
-- day's notice" — and offered exactly as written in every such reply.

alter table profile add column if not exists availability text;
