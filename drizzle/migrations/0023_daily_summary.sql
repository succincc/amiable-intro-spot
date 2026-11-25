-- One email a day to the owner's own mailbox: what was sent, who wrote back,
-- what is stuck and why.
--
-- Off by default, like every other piece of mail this sends: it is the
-- owner's inbox, and whether something arrives in it every morning is the
-- owner's decision.

alter table profile add column if not exists daily_summary boolean default false;
