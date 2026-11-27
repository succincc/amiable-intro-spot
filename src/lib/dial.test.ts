import { describe, expect, it } from "vitest";

import { BRIEF, FIRST_MESSAGE, callFacts, dueToCall, e164, readCall, spokenTime, targeted } from "@/lib/dial";

const me = { full_name: "Pat Example", phone: "(732) 555-0100", resume_text: "" };
const job = { title: "Sales Associate", company: "Example Goods", location: "Springfield, NJ", description: "" };
// A Tuesday, 10:30 in New York.
const tue = new Date("2026-12-01T15:30:00Z");
const zone = "America/New_York";

describe("the live call", () => {
  it("opens with the opening and nothing else, and the opening says an AI assistant is calling", () => {
    expect(FIRST_MESSAGE).toBe("{{opening}}");
    expect(callFacts(job, me, null)["opening"]).toMatch(/^Hi, this is an AI assistant calling about Pat Example's application/);
  });

  it("holds the assistant to being an assistant, and to the facts it was given", () => {
    expect(BRIEF).toMatch(/You are not \{\{first_name\}\} and you are not a person/);
    expect(BRIEF).toMatch(/Never guess and never make anything up/);
    // Every brace in the brief has a fact behind it.
    const facts = callFacts(job, me, "Tuesday 2 to 4");
    for (const m of BRIEF.matchAll(/\{\{(\w+)\}\}/g)) expect(typeof facts[m[1] as string]).toBe("string");
    for (const v of Object.values(facts)) expect(v.length).toBeGreaterThan(0);
  });

  it("dials a US number and nothing else", () => {
    expect(e164("(732) 555-0100")).toBe("+17325550100");
    expect(e164("+44 20 7946 0000")).toBeNull();
    expect(e164(null)).toBeNull();
  });

  it("knows a role the user is aiming for", () => {
    expect(targeted("Senior Sales Associate - Part Time", "store manager, sales associate")).toBe(true);
    expect(targeted("Cashier", "store manager, sales associate")).toBe(false);
    expect(targeted("Cashier", "")).toBe(false);
  });

  it("calls only under the user's rule, once, and at an hour a store would take it", () => {
    const j = { ...job, status: "applied", phone: "732-555-0199", call_state: null, score: 6 };
    const on = { calls_enabled: true, calls_min_score: 7, calls_targets_only: false, target_role: "store manager" };
    expect(dueToCall(j, { ...on, calls_enabled: false }, tue, zone)).toBe(false);
    expect(dueToCall(j, on, tue, zone)).toBe(false);
    expect(dueToCall({ ...j, score: 7 }, on, tue, zone)).toBe(true);
    expect(dueToCall({ ...j, title: "Store Manager" }, on, tue, zone)).toBe(true);
    expect(dueToCall({ ...j, score: 9 }, { ...on, calls_targets_only: true }, tue, zone)).toBe(false);
    expect(dueToCall({ ...j, score: 9, call_state: "spoke" }, on, tue, zone)).toBe(false);
    expect(dueToCall({ ...j, score: 9, phone: null }, on, tue, zone)).toBe(false);
    expect(dueToCall({ ...j, score: 9, status: "queued" }, on, tue, zone)).toBe(false);
    // Saturday, and a weekday evening.
    expect(dueToCall({ ...j, score: 9 }, on, new Date("2026-12-05T15:30:00Z"), zone)).toBe(false);
    expect(dueToCall({ ...j, score: 9 }, on, new Date("2026-12-01T23:30:00Z"), zone)).toBe(false);
  });

  it("reads a finished call back: who said what, and a time if one was agreed", () => {
    expect(readCall({ status: "in-progress" }, zone, tue).finished).toBe(false);
    expect(readCall({ status: "failed" }, zone, tue).state).toBe("no_answer");
    expect(readCall({ status: "done", transcript: [{ role: "agent", message: "Hi, this is an AI assistant" }] }, zone, tue).state).toBe("no_answer");
    const vm = readCall({ status: "done", transcript: [{ role: "agent", message: "Hi" }, { role: "user", message: "Please leave a message after the tone." }] }, zone, tue);
    expect([vm.state, vm.when]).toEqual(["message", null]);
    const r = readCall(
      { status: "done", analysis: { transcript_summary: "An interview was set." }, transcript: [{ role: "agent", message: "Hi, this is an AI assistant calling." }, { role: "user", message: "Sure, have them come in for an interview Thursday at 2 pm." }] },
      zone,
      tue,
    );
    expect(r.state).toBe("spoke");
    expect(r.text).toMatch(/^Summary: An interview was set\.\n\nASSISTANT: Hi/);
    expect(r.text).toMatch(/THEM: Sure, have them come in/);
    // Tuesday 1 December: Thursday is the 3rd, 2 pm in New York is 19:00 UTC.
    expect(r.when?.toISOString()).toBe("2026-12-03T19:00:00.000Z");
  });

  it("hears a day and a time as people say them", () => {
    expect(spokenTime("tomorrow at 10:30 am works", zone, tue)?.toISOString()).toBe("2026-12-02T15:30:00.000Z");
    // The same weekday, an hour already gone: next week's.
    expect(spokenTime("come by Tuesday at 9 am", zone, tue)?.toISOString()).toBe("2026-12-08T14:00:00.000Z");
    expect(spokenTime("sometime next week", zone, tue)).toBeNull();
    expect(spokenTime("Thursday afternoon", zone, tue)).toBeNull();
  });
});
