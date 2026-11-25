import { describe, expect, it } from "vitest";
import { composeSummary, whyStuck } from "./summary";

describe("the daily summary", () => {
  const day = composeSummary({
    sent: [
      { company: "Acme Parts", title: "Store Manager", ats: "workday" },
      { company: "Garden State Foods", title: "Assistant Manager", ats: "workday" },
      { company: "Shore Medical", title: "Office Lead", ats: "greenhouse" },
    ],
    replies: [
      { from_addr: "recruiting@acme.com", subject: "Interview availability", category: "interview", reply_state: "sent" },
      { from_addr: "no-reply@other.com", subject: "Your application", category: "rejection" },
      { from_addr: "jobs@third.com", subject: "We received it", category: "confirmation" },
    ],
    stuck: [
      { company: "Lowe's", help_reason: "Filled 30 fields… what are the last 4 digits of your social security number" },
      { company: "Capital Health", help_reason: "This portal's sign-in rendered no fields at all: registration did not complete" },
      { company: "State Street", help_reason: "registration did not complete — the password screen is still showing" },
    ],
    ready: 24,
    review: 21,
    followUps: 0,
    questions: 4,
  });

  it("puts the counts in the subject", () => {
    expect(day.subject).toBe("ApplyPilot: 3 sent, 1 to read, 3 stuck");
  });

  it("names what was sent and where", () => {
    expect(day.body).toContain("SENT: 3  (workday 2, greenhouse 1)");
    expect(day.body).toContain("Acme Parts - Store Manager");
  });

  it("shows the replies worth reading and only counts the rest", () => {
    expect(day.body).toContain("REPLIES: 1 to read, 1 turned down");
    expect(day.body).toContain("[interview] recruiting@acme.com - Interview availability (replied)");
    expect(day.body).toContain("QUESTIONS: 4 that employers asked");
    expect(day.body).not.toContain("We received it");
  });

  it("groups what is stuck by a reason a person can act on", () => {
    expect(day.body).toContain("2 - could not get past the portal's sign-in: Capital Health, State Street");
    expect(day.body).toContain("1 - asks for SSN digits or a birth date, which are never filled in: Lowe's");
    expect(day.body).toContain("WAITING: 24 ready to apply, 21 held for review.");
  });

  it("says so plainly on a day when nothing went out", () => {
    const quiet = composeSummary({ sent: [], replies: [], stuck: [], ready: 0, review: 0, followUps: 0 });
    expect(quiet.subject).toBe("ApplyPilot: 0 sent, 0 to read, 0 stuck");
    expect(quiet.body).toContain("Nothing went out.");
  });

  it("keeps a long reason short", () => {
    expect(whyStuck("x".repeat(300)).length).toBeLessThanOrEqual(70);
    expect(whyStuck(null)).toBe("no reason recorded");
  });
});

import { draftReply, plainInterviewReply } from "./classify.server";

describe("a reply to an interview request with no model", () => {
  const profile = { full_name: "Pat Example", phone: "555-0100", availability: "weekdays between 9am and 5pm Eastern, with a day's notice." };
  const job = { company: "Acme Parts", title: "Store Manager" };

  it("says yes, when, and how to reach me", () => {
    const r = plainInterviewReply({ job, profile });
    expect(r).toContain("about the Store Manager role at Acme Parts");
    expect(r).toContain("I am available weekdays between 9am and 5pm Eastern, with a day's notice. If one of those times suits you");
    expect(r).toContain("reach me directly at 555-0100");
    expect(r.trim().endsWith("Pat Example\n555-0100")).toBe(true);
    expect(r).not.toMatch(/\[[A-Za-z]/);
  });

  it("does not invent times when none are on file", () => {
    const r = plainInterviewReply({ job, profile: { full_name: "Pat Example" } });
    expect(r).toContain("My schedule is flexible");
    expect(r).not.toContain("I am available");
  });

  it("is what an interview request gets when there is no model key", async () => {
    const email = { from_addr: "recruiter@acme.com", subject: "Interview", body: "Can we talk this week?" };
    expect(await draftReply({ email, category: "interview", job, profile, apiKey: "" })).toContain("I would be glad to speak with you");
    // An offer still waits for a person; a rejection and a no-reply address get nothing.
    expect(await draftReply({ email, category: "offer", job, profile, apiKey: "" })).toBeNull();
    expect(await draftReply({ email, category: "rejection", job, profile, apiKey: "" })).toBeNull();
    expect(await draftReply({ email: { ...email, from_addr: "no-reply@acme.com" }, category: "interview", job, profile, apiKey: "" })).toBeNull();
  });
});
