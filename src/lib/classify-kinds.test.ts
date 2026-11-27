import { describe, expect, it } from "vitest";
import { classifyEmail, emailKind } from "./classify.server";

// The kinds an audit of a real inbox showed the six categories could not
// tell apart. Each case is the shape of a subject that was really received.
const kindOf = (subject: string, body = "") => emailKind(classifyEmail(subject, body).category, subject, body);

describe("mail by kind", () => {
  it("a one-time code is a verification code, not something to read", () => {
    expect(emailKind("action_needed", "Confirm your identity", "Your one-time code is 123456")).toBe("verification_code");
    expect(emailKind("action_needed", "Verify your candidate account", "")).toBe("verification_code");
    expect(kindOf("Please verify your email", "Use this link to verify your email for your candidate profile.")).toBe("verification_code");
  });
  it("a password notice is an account notice", () => {
    expect(emailKind("action_needed", "Reset your password", "for your job application account")).toBe("account_notice");
  });
  it("an assessment stays an assessment", () => {
    expect(kindOf("Action required: complete your assessment", "Please complete the assessment for your application within 5 days.")).toBe("assessment");
    expect(emailKind("action_needed", "Next step in your application", "Please take the HireVue video interview.")).toBe("assessment");
  });
  it("a receipt that also asks for an address to be verified is still a receipt", () => {
    expect(emailKind("action_needed", "We've received your application", "Please verify your email to see its status.")).toBe("acknowledgement");
    expect(emailKind("confirmation", "Thank you for applying", "")).toBe("acknowledgement");
  });
  it("an invitation with a time to pick is told from a recruiter getting in touch", () => {
    expect(emailKind("interview", "Interview with Acme", "Please pick a time: https://calendly.com/x")).toBe("interview_invitation");
    expect(emailKind("interview", "Your background", "I'd love to connect about next steps.")).toBe("recruiter_inquiry");
  });
  it("carries the plain categories through", () => {
    expect(emailKind("offer", "x")).toBe("offer");
    expect(emailKind("rejection", "x")).toBe("rejection");
    expect(emailKind("other", "x")).toBe("other");
    expect(emailKind(null, "x")).toBe("other");
  });
  it("a receipt that speaks of interviews is never an interview", () => {
    const c = classifyEmail("Thank you for applying", "We have received your application. If selected, we will contact you to schedule an interview. Next steps are below.");
    expect(c.category).toBe("confirmation");
  });
});

import { spreadReceipts, sameEmployer } from "./classify.server";

describe("receipts at an employer applied to more than once", () => {
  const t = (min: number) => new Date(Date.UTC(2026, 10, 27, 12, min)).toISOString();
  const jobs = [
    { id: "c", company: "Acme Corp", title: "Operations Analyst III", applied_at: t(20) },
    { id: "b", company: "Acme", title: "Operations Analyst II", applied_at: t(10) },
    { id: "a", company: "Acme, Inc.", title: "Operations Analyst I", applied_at: t(0) },
    { id: "z", company: "Zenith", title: "Buyer", applied_at: t(5) },
  ];
  it("gives each receipt to the application sent just before it, not all to the newest", () => {
    const moves = spreadReceipts(jobs, [
      { message_id: "m1", job_id: "c", received_at: t(1) },
      { message_id: "m2", job_id: "c", received_at: t(11) },
      { message_id: "m3", job_id: "c", received_at: t(21) },
      { message_id: "mz", job_id: "z", received_at: t(6) },
    ]);
    expect(moves).toEqual([{ message_id: "m1", job_id: "a" }, { message_id: "m2", job_id: "b" }]);
  });
  it("leaves a second mail about one application where it is when no other application fits", () => {
    expect(spreadReceipts(jobs, [
      { message_id: "m1", job_id: "c", received_at: t(21) },
      { message_id: "m2", job_id: "c", received_at: t(22) },
    ])).toEqual([]);
  });
  it("never moves a receipt that arrived days later onto an application it cannot be timed to", () => {
    expect(spreadReceipts(jobs, [
      { message_id: "m1", job_id: "c", received_at: t(21) },
      { message_id: "m2", job_id: "c", received_at: new Date(Date.UTC(2026, 10, 29)).toISOString() },
    ])).toEqual([]);
  });
  it("believes a receipt that names its job over the clock", () => {
    expect(spreadReceipts(jobs, [
      { message_id: "m1", job_id: "c", received_at: t(21), text: "Thank you for applying to Operations Analyst I" },
    ])).toEqual([{ message_id: "m1", job_id: "a" }]);
  });
  it("hands a burst of receipts out one each when there are exactly as many receipts as applications", () => {
    // Three sent at 0, 10 and 20; their three receipts all arrive after the last.
    expect(spreadReceipts(jobs, [
      { message_id: "m1", job_id: "c", received_at: t(21) },
      { message_id: "m2", job_id: "c", received_at: t(22) },
      { message_id: "m3", job_id: "c", received_at: t(23) },
    ]).map((m) => m.job_id).sort()).toEqual(["a", "b"]);
  });
  it("moves nothing in a burst where the counts differ", () => {
    expect(spreadReceipts(jobs.slice(0, 2).concat(jobs.slice(3)), [
      { message_id: "m1", job_id: "c", received_at: t(21) },
      { message_id: "m2", job_id: "c", received_at: t(22) },
      { message_id: "m3", job_id: "c", received_at: t(23) },
    ]).length).toBe(0);
  });
  it("is settled: run again on its own result, it moves nothing", () => {
    const r = [
      { message_id: "m1", job_id: "c", received_at: t(1) },
      { message_id: "m2", job_id: "c", received_at: t(11) },
      { message_id: "m3", job_id: "c", received_at: t(21) },
    ];
    for (const mv of spreadReceipts(jobs, r)) r.find((x) => x.message_id === mv.message_id)!.job_id = mv.job_id;
    expect(spreadReceipts(jobs, r)).toEqual([]);
  });
  it("knows one employer under its several spellings", () => {
    expect(sameEmployer("Acme, Inc.", "ACME Corp")).toBe(true);
    expect(sameEmployer("Acme", "Zenith")).toBe(false);
  });
});
