-- The live call connection.
--
-- call_keys.agent_id / phone_id   what the voice service calls the assistant
--                                 and the number once the panel has set them
--                                 up there; server-only, like the keys.
-- jobs.call_ref                   the voice service's own reference for a call
--                                 that is under way, so it can be read back.
-- heartbeat 'calls'               the turn for placing and reading calls.

alter table call_keys add column if not exists agent_id text;
alter table call_keys add column if not exists phone_id text;
alter table jobs add column if not exists call_ref text;
insert into heartbeat (name) values ('calls') on conflict (name) do nothing;
