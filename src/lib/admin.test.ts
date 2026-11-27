import { describe, expect, it } from "vitest";

import { ago, missing, narrow, totals, type Person } from "@/lib/admin";

const now = Date.parse("2026-12-01T12:00:00Z");
const base: Person = {
  user_id: "u", is_owner: false, full_name: "", email: "", status: "approved", created_at: "2026-11-20T00:00:00Z", decided_at: null, last_sign_in_at: "2026-12-01T10:00:00Z",
  has_workspace: true, autopilot: true, has_resume: true, titles: 3, mail_connected: true, mail_last_read: null, own_key: false,
  employers: 10, jobs: 5, queued: 1, needs_help: 0, applied: 4, applied_24h: 2, interviews: 0, last_applied_at: "2026-12-01T09:00:00Z", questions_waiting: 0,
};
const people: Person[] = [
  { ...base, user_id: "o", is_owner: true, full_name: "Owner Example", email: "owner@example.test", applied: 40, applied_24h: 9, interviews: 1 },
  { ...base, user_id: "a", full_name: "Amy Example", email: "amy@example.test" },
  { ...base, user_id: "b", full_name: "Bob Sample", email: "bob@example.test", has_resume: false, autopilot: false, applied: 0, applied_24h: 0, last_sign_in_at: "2026-11-21T00:00:00Z", last_applied_at: null },
  { ...base, user_id: "c", full_name: "Cy Waiting", email: "cy@example.test", status: "pending", has_workspace: false, autopilot: false, applied: 0, applied_24h: 0, created_at: "2026-11-30T00:00:00Z" },
  { ...base, user_id: "d", full_name: "Di Denied", email: "di@example.test", status: "denied", has_workspace: false, autopilot: false, applied: 0, applied_24h: 0 },
];

describe("the owner's list of people", () => {
  it("says what an approved person has left to set up, and nothing for anyone else", () => {
    expect(missing(people[1]!)).toEqual([]);
    expect(missing(people[2]!)).toEqual(["resume", "START not pressed"]);
    expect(missing({ ...base, has_workspace: false })).toEqual(["has not signed in yet"]);
    expect(missing(people[3]!)).toEqual([]);
  });

  it("narrows by where a request stands, by how a workspace is doing, and by words typed", () => {
    const ids = (filter: Parameters<typeof narrow>[1]["filter"], words = "") => narrow(people, { filter, words, sort: "name", now }).map((p) => p.user_id);
    expect(ids("pending")).toEqual(["c"]);
    expect(ids("denied")).toEqual(["d"]);
    expect(ids("running")).toEqual(["o", "a"]);
    expect(ids("stuck")).toEqual(["b"]);
    expect(ids("idle")).toEqual(["b"]);
    expect(ids("all", "example amy")).toEqual(["a"]);
    expect(ids("all", "BOB@")).toEqual(["b"]);
  });

  it("keeps the owner first whatever the order", () => {
    expect(narrow(people, { filter: "all", words: "", sort: "newest", now }).map((p) => p.user_id)).toEqual(["o", "c", "a", "b", "d"]);
    expect(narrow(people, { filter: "approved", words: "", sort: "applied", now }).map((p) => p.user_id)).toEqual(["o", "a", "b"]);
  });

  it("adds up the top line", () => {
    expect(totals(people, now)).toEqual({ waiting: 1, approved: 2, denied: 1, running: 2, stuck: 1, applied_24h: 11, applied: 44, interviews: 1 });
  });

  it("says how long ago in a few words", () => {
    expect([ago("2026-12-01T11:30:00Z", now), ago("2026-12-01T06:00:00Z", now), ago("2026-11-28T12:00:00Z", now), ago(null, now)]).toEqual(["30 min ago", "6 h ago", "3 d ago", "never"]);
  });
});
