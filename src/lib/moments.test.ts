import { describe, expect, it } from "vitest";
import { afterBooking, afterRejection, bookingLink, deadlineIn, googleCalendarLink, healthProblems, icsFor, meetingLink, momentOf, noticeFor, offerFacts, requirementsMet, statedTime, streetAddress } from "./moments";

const ZONE = "America/New_York";
const NOW = new Date("2026-11-27T15:00:00Z"); // a Friday, 10am Eastern

describe("a time stated in an email", () => {
  it("reads a month, a day and a clock time, in the owner's zone", () => {
    expect(statedTime("Your interview is confirmed for Tuesday, December 1 at 10:00 AM.", ZONE, NOW)?.toISOString()).toBe("2026-12-01T15:00:00.000Z");
    expect(statedTime("We have you down for Dec 3, 2026 2:30 PM EST", ZONE, NOW)?.toISOString()).toBe("2026-12-03T19:30:00.000Z");
    expect(statedTime("See you on 12/4 at 9am", ZONE, NOW)?.toISOString()).toBe("2026-12-04T14:00:00.000Z");
    expect(statedTime("scheduled for 2 December at 1 pm", ZONE, NOW)?.toISOString()).toBe("2026-12-02T18:00:00.000Z");
  });
  it("a day already gone with no year means next year's", () => {
    expect(statedTime("January 5 at 11:00 AM", ZONE, NOW)?.toISOString()).toBe("2027-01-05T16:00:00.000Z");
  });
  it("is not an appointment without both a day and a time, or once it has passed", () => {
    expect(statedTime("Are you free next week, maybe Tuesday afternoon?", ZONE, NOW)).toBeNull();
    expect(statedTime("We met on November 20, 2026 at 10:00 AM", ZONE, NOW)).toBeNull();
    expect(statedTime("Posted December 1. Apply by 5pm.", ZONE, NOW)).toBeNull();
  });
});

describe("links", () => {
  it("knows a booking page from an ordinary link", () => {
    expect(bookingLink("Please pick a time here: https://calendly.com/acme-recruiting/30min. Thanks!")).toBe("https://calendly.com/acme-recruiting/30min");
    expect(bookingLink("Book at https://outlook.office365.com/book/AcmeHiring@acme.com/")).toBe("https://outlook.office365.com/book/AcmeHiring@acme.com/");
    expect(bookingLink("See our site https://www.acme.com/careers and https://acme.com/unsubscribe")).toBeNull();
  });
  it("finds the call's link and a street address", () => {
    expect(meetingLink("Join: https://acme.zoom.us/j/123456789?pwd=abc")).toBe("https://acme.zoom.us/j/123456789?pwd=abc");
    expect(streetAddress("Please come to 100 Example Avenue, Suite 4, Exampleton, NJ 07001 and ask for the manager.")).toBe("100 Example Avenue, Suite 4, Exampleton, NJ 07001");
    expect(streetAddress("We have 100 openings this year.")).toBeNull();
  });
});

describe("deadlines and offers, in the email's own words", () => {
  it("reads a deadline", () => {
    expect(deadlineIn("Please complete the assessment by December 3.")).toBe("December 3");
    expect(deadlineIn("The link expires in 72 hours.")).toBe("72 hours");
    expect(deadlineIn("Complete it within 5 days of this email.")).toBe("within 5 days");
    expect(deadlineIn("Thank you for applying.")).toBeNull();
  });
  it("reads pay, start and the reply-by day out of an offer", () => {
    expect(offerFacts("We are pleased to offer you the role at $58,000 per year, with a start date of January 4, 2027. Please respond by December 5.")).toEqual({ pay: "$58,000 per year", start: "January 4, 2027", replyBy: "December 5" });
    expect(offerFacts("The rate is $24.50 per hour.").pay).toBe("$24.50 per hour");
    expect(offerFacts("Congratulations!")).toEqual({ pay: null, start: null, replyBy: null });
  });
});

describe("which moment an email is", () => {
  it("an interview with a settled time", () => {
    const m = momentOf({ category: "interview", subject: "Interview confirmed", body: "Your phone interview is confirmed for December 1 at 10:00 AM. Join: https://acme.zoom.us/j/1" }, ZONE, NOW);
    expect(m).toEqual({ kind: "interview_time", when: new Date("2026-12-01T15:00:00.000Z"), link: "https://acme.zoom.us/j/1", where: null });
  });
  it("one time put as a question is not settled, and a calendar invitation is", () => {
    expect(momentOf({ category: "interview", subject: "Interview invitation", body: "We would like to invite you to interview. Are you available December 1 at 10:00 AM? Looking forward to speaking." }, ZONE, NOW)).toBeNull();
    expect(momentOf({ category: "interview", subject: "Interview", body: "Would Dec 1 at 10:00 AM work for you? It is scheduled to last 30 minutes." }, ZONE, NOW)).toBeNull();
    expect(momentOf({ category: "interview", subject: "Invitation: Interview with Example Co @ Tue Dec 1, 2026 10am - 11am (EST)", body: "" }, ZONE, NOW)?.kind).toBe("interview_time");
  });
  it("times offered as choices are not an appointment", () => {
    expect(momentOf({ category: "interview", subject: "Interview", body: "Could you do December 1 at 10:00 AM or December 2 at 2:00 PM?" }, ZONE, NOW)).toBeNull();
  });
  it("a booking link is the owner's one tap", () => {
    expect(momentOf({ category: "interview", subject: "Next steps", body: "Please choose a time: https://calendly.com/acme/intro" }, ZONE, NOW)).toEqual({ kind: "pick_a_time", link: "https://calendly.com/acme/intro" });
  });
  it("an assessment, with its link and its day", () => {
    expect(momentOf({ category: "action_needed", subject: "Complete your assessment", body: "Take the skills test at https://assess.example.com/candidate/abc by December 3." }, ZONE, NOW)).toEqual({ kind: "assessment", link: "https://assess.example.com/candidate/abc", due: "December 3" });
  });
  it("a receipt is never a moment, whatever it mentions", () => {
    expect(momentOf({ category: "confirmation", subject: "Thanks for applying", body: "If selected, your interview may be on December 1 at 10:00 AM." }, ZONE, NOW)).toBeNull();
    expect(momentOf({ category: "action_needed", subject: "Finish your profile", body: "Add a photo." }, ZONE, NOW)).toBeNull();
  });
  it("an offer and a rejection", () => {
    expect(momentOf({ category: "offer", subject: "Offer", body: "We offer $60,000 per year." }, ZONE, NOW)).toEqual({ kind: "offer", pay: "$60,000 per year", start: null, replyBy: null });
    expect(momentOf({ category: "rejection", subject: "Update", body: "We went another way." }, ZONE, NOW)).toEqual({ kind: "rejection" });
  });
});

describe("the calendar file", () => {
  it("is one event with its times in UTC and its commas escaped", () => {
    const ics = icsFor({ uid: "abc@applypilot", start: new Date("2026-12-01T15:00:00Z"), end: new Date("2026-12-01T16:00:00Z"), title: "Interview: Store Manager, Example Co", where: "100 Example Ave, Exampleton", notes: "Line one\nLine two", now: NOW });
    expect(ics).toContain("DTSTART:20261201T150000Z");
    expect(ics).toContain("DTEND:20261201T160000Z");
    expect(ics).toContain("SUMMARY:Interview: Store Manager\\, Example Co");
    expect(ics).toContain("LOCATION:100 Example Ave\\, Exampleton");
    expect(ics).toContain("DESCRIPTION:Line one\\nLine two");
    expect(ics.split("\r\n")[0]).toBe("BEGIN:VCALENDAR");
    expect(ics.match(/BEGIN:VEVENT/g)?.length).toBe(1);
  });
});

describe("the posting beside the resume", () => {
  it("marks what the resume shows and what it does not, and invents nothing", () => {
    const got = requirementsMet(
      "About us\n• 3+ years of experience managing inventory and vendor relationships\n• Forklift certification required for warehouse duties\n• We love dogs",
      "Managed inventory across two stores and negotiated with vendor partners for five years.",
    );
    expect(got).toEqual([
      { line: "3+ years of experience managing inventory and vendor relationships", shown: true },
      { line: "Forklift certification required for warehouse duties", shown: false },
    ]);
  });
});

describe("the health check", () => {
  const ok = { now: NOW, autopilot: true, agentLastSeen: "2026-11-27T14:00:00Z", mailLastRun: "2026-11-27T14:30:00Z", mailError: null, gmailConnected: true, gmailError: null, sent72h: 12, ready: 3 };
  it("says nothing when nothing is wrong", () => {
    expect(healthProblems(ok)).toEqual([]);
  });
  it("names each thing that is", () => {
    expect(healthProblems({ ...ok, gmailConnected: false })[0]).toMatch(/Gmail is not connected/);
    expect(healthProblems({ ...ok, mailLastRun: "2026-11-27T02:00:00Z" })[0]).toMatch(/not been read for 13 hours/);
    expect(healthProblems({ ...ok, agentLastSeen: "2026-11-26T15:00:00Z" })[0]).toMatch(/No application round has run for 24 hours/);
    expect(healthProblems({ ...ok, sent72h: 0, ready: 9 })[0]).toMatch(/Nothing has been sent in three days/);
  });
  it("does not complain about rounds when autopilot is off", () => {
    expect(healthProblems({ ...ok, autopilot: false, agentLastSeen: null, sent72h: 0, ready: 40 })).toEqual([]);
  });
});

describe("held times once an answer comes", () => {
  const holds = [
    { start: "2026-12-01T15:00:00.000Z", end: "2026-12-01T16:00:00.000Z", kind: "phone", ref: "job-a", state: "offered" },
    { start: "2026-12-02T15:00:00.000Z", end: "2026-12-02T16:00:00.000Z", kind: "phone", ref: "job-a", state: "offered" },
    { start: "2026-12-02T18:00:00.000Z", end: "2026-12-02T19:00:00.000Z", kind: "virtual", ref: "job-b", state: "booked" },
    { start: "2026-12-03T15:00:00.000Z", end: "2026-12-03T16:00:00.000Z", kind: null, ref: "job-c", state: "offered" },
  ];
  it("booking lets the employer's other times go and keeps everyone else's", () => {
    const got = afterBooking(holds, ["job-a", "msg-1"], new Date("2026-12-02T15:00:00Z"), "phone", NOW);
    expect(got.clash).toBeNull();
    expect(got.holds.map((h) => `${h.ref}:${h.state}:${h.start.slice(5, 13)}`)).toEqual(["job-b:booked:12-02T18", "job-c:offered:12-03T15", "job-a:booked:12-02T15"]);
  });
  it("says so when the time lands on another booked interview", () => {
    const got = afterBooking(holds, ["job-a"], new Date("2026-12-02T18:30:00Z"), "virtual", NOW);
    expect(got.clash?.ref).toBe("job-b");
  });
  it("booking the same interview twice keeps one", () => {
    const once = afterBooking(holds, ["job-a"], new Date("2026-12-02T15:00:00Z"), "phone", NOW);
    const twice = afterBooking(once.holds, ["job-a"], new Date("2026-12-02T15:00:00Z"), "phone", NOW);
    expect(twice.holds.filter((h) => h.ref === "job-a")).toHaveLength(1);
  });
  it("a rejection frees everything held for that employer", () => {
    const got = afterRejection(holds, ["job-a"], NOW);
    expect(got.released).toBe(2);
    expect(got.holds.map((h) => h.ref)).toEqual(["job-b", "job-c"]);
  });
});

describe("the email to the owner", () => {
  const job = { title: "Store Manager", company: "Example Co", location: "Exampleton, NJ", url: "https://jobs.example.com/1", description: "• 3+ years of experience managing inventory and vendor relationships", salary_text: "$55,000", applied_at: "2026-11-20T15:00:00Z" };
  it("an interview: when, how to join, a one-tap calendar link, the role, and their words", () => {
    const n = noticeFor({ moment: { kind: "interview_time", when: new Date("2026-12-01T15:00:00Z"), link: "https://acme.zoom.us/j/1", where: null }, job, from: "recruiter@example.com", subject: "Confirmed", body: "See you then.", zone: ZONE, resume: "Managed inventory and vendor accounts.", kind: "virtual" });
    expect(n.subject).toBe("ApplyPilot: interview booked, Tuesday, December 1 at 10:00 AM EST - Store Manager at Example Co");
    expect(n.body).toContain("When:   Tuesday, December 1 at 10:00 AM EST");
    expect(n.body).toContain("Join:   https://acme.zoom.us/j/1");
    expect(n.body).toContain("https://calendar.google.com/calendar/render?action=TEMPLATE");
    expect(n.body).toContain("dates=20261201T150000Z%2F20261201T160000Z");
    expect(n.body).toContain("[on your resume]");
    expect(n.body).toContain("See you then.");
    expect(n.event?.end.toISOString()).toBe("2026-12-01T16:00:00.000Z");
  });
  it("a booking link, with no job on file: the sender's name stands in", () => {
    const n = noticeFor({ moment: { kind: "pick_a_time", link: "https://calendly.com/acme/intro" }, job: null, from: "talent@acme-corp.com", zone: ZONE, openTimes: "Tuesday at 10 AM or Wednesday at 2 PM" });
    expect(n.subject).toBe("ApplyPilot: pick an interview time - Acme-corp");
    expect(n.body).toContain("Pick here: https://calendly.com/acme/intro");
    expect(n.body).toContain("Open on your calendar: Tuesday at 10 AM or Wednesday at 2 PM.");
    expect(n.event).toBeNull();
  });
  it("an assessment and an offer say what is due and that nothing was done for the owner", () => {
    expect(noticeFor({ moment: { kind: "assessment", link: "https://a.example.com/t", due: "December 3" }, job, zone: ZONE }).subject).toBe("ApplyPilot: assessment to take, due December 3 - Store Manager at Example Co");
    const o = noticeFor({ moment: { kind: "offer", pay: "$58,000 per year", start: "January 4, 2027", replyBy: "December 5" }, job, zone: ZONE });
    expect(o.subject).toBe("ApplyPilot: an offer, answer by December 5 - Store Manager at Example Co");
    expect(o.body).toContain("Pay:        $58,000 per year");
    expect(o.body).toContain("Nothing has been replied.");
  });
  it("the calendar link carries the place", () => {
    expect(googleCalendarLink({ start: new Date("2026-12-01T15:00:00Z"), end: new Date("2026-12-01T16:00:00Z"), title: "Interview", where: "100 Example Ave" })).toContain("location=100+Example+Ave");
  });
});
