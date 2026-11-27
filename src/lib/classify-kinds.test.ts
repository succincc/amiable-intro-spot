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
