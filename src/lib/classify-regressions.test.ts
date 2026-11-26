import { describe, expect, it } from "vitest";
import { classifyEmail, matchJob } from "./classify.server";

// Three failures seen together in one real inbox sync. Each is pinned here
// because each was invisible until the panel showed the wrong answer
// confidently.
describe("regressions from the first real Gmail sync", () => {
  // ---------------------------------------------------------------------
  // 1. A receipt filed as an interview
  // ---------------------------------------------------------------------
  // Plain-text mail wraps at about 72 columns, so the conditional clause and
  // its consequence land on different lines. Splitting sentences on a single
  // newline severed "...we will contact you to" from "schedule an interview."
  // and the guard then read the orphaned half as a genuine invitation.
  it("reads a wrapped 'if selected we will schedule an interview' as a receipt", () => {
    const body = [
      "Hi Pat,",
      "",
      "Thank you for applying to Ramp. We have received your application",
      "for the Operations Analyst role and our team is reviewing it.",
      "",
      "If your qualifications match our needs, we will contact you to",
      "schedule an interview.",
      "",
      "- The Ramp Recruiting Team",
    ].join("\n");

    expect(classifyEmail("Thank you for applying to Ramp", body).category).toBe("confirmation");
  });

  it("still reads a real invitation as an interview", () => {
    const body = [
      "Hi Pat,",
      "",
      "We reviewed your application and would like to speak with you.",
      "Are you available Thursday afternoon?",
    ].join("\n");
    expect(classifyEmail("Next steps", body).category).toBe("interview");
  });

  // ---------------------------------------------------------------------
  // 2. Promotional mail filed as action_needed
  // ---------------------------------------------------------------------
  // The deadline patterns ("expires in 3 days", "submit a claim form") are
  // not recruiting language at all, so every promotion and legal notice in
  // the inbox tripped them and was stored.
  const promos: Array<[string, string]> = [
    ["Earn 8% credits back on Lyft rides", "Limited time only. This offer expires in 3 days. Terms apply."],
    ["Feeling lucky? So many prizes are up for grabs.", "Enter within 7 days for your chance to win. No purchase necessary."],
    ["AG Generic Drugs Settlement - UPDATE", "To receive a payment you must submit a claim form within 30 days."],
    ["Claim it: 25% off 1 ride", "Your promo code expires in 24 hours. Redeem it now."],
  ];
  for (const [subject, body] of promos) {
    it(`does not treat "${subject.slice(0, 32)}..." as something you must act on`, () => {
      expect(classifyEmail(subject, body).category).toBe("other");
    });
  }

  it("still flags a real assessment with a deadline", () => {
    expect(
      classifyEmail(
        "Your assessment for the Analyst role",
        "Please complete the assessment for your application within 48 hours.",
      ).category,
    ).toBe("action_needed");
  });

  // ---------------------------------------------------------------------
  // 3. Spam matched to a job
  // ---------------------------------------------------------------------
  // "Performance Marketing Agentur firststars GmbH" is almost entirely
  // generic business words. Any mail whose sender or footer said "marketing"
  // scored a match against it.
  const junkEmployer = [
    { id: "job-x", company: "Performance Marketing Agentur firststars GmbH", title: "Werkstudent" },
  ];

  it("does not match promotional mail to a company named out of generic words", () => {
    expect(
      matchJob(
        {
          from_addr: "no-reply@marketing.example.com",
          subject: "Claim it: 25% off 1 ride",
          body: "You received this marketing email because you signed up. Unsubscribe.",
        },
        junkEmployer,
      ),
    ).toBeNull();

    expect(
      matchJob(
        {
          from_addr: "netflix@tiktokshop.example",
          subject: "Pat, bestseller picks you'll love",
          body: "Shop the Black Friday sale. This is a marketing message from our performance team.",
        },
        junkEmployer,
      ),
    ).toBeNull();
  });

  // ---------------------------------------------------------------------
  // 4. Mail that is not about your applications at all
  // ---------------------------------------------------------------------
  it("does not treat a security notice as something a job search must act on", () => {
    expect(
      classifyEmail(
        "Your Lovable account was used on a new device",
        "If this wasn't you, reset your password immediately.",
      ).category,
    ).toBe("other");
  });

  it("still flags a portal asking you to verify an email", () => {
    expect(
      classifyEmail("Confirm your email", "Please verify your email to finish creating your account.")
        .category,
    ).toBe("action_needed");
  });

  it("does not match an aggregator job alert to an application", () => {
    const jobs = [{ id: "job-k", company: "Kyra", title: "Account Associate" }];
    expect(
      matchJob(
        {
          from_addr: "alerts@ziprecruiter.com",
          subject: "Account Associate - State Farm Agent Team Member opening at Ed Hocker",
          body: "New jobs matching your search. Kyra and others are hiring near you.",
        },
        jobs,
      ),
    ).toBeNull();
  });

  // ---------------------------------------------------------------------
  // 5. A hand-sent test moved a real job to "interview"
  // ---------------------------------------------------------------------
  // The message was sent from a personal gmail account, so it was neither
  // the profile address nor its own recipient, and the self-sent check did
  // not see it. It named Ramp once, scored a match, and a database trigger
  // moved the application to interview.
  it("will not match a webmail sender on a single company mention", () => {
    const jobs = [{ id: "job-1", company: "Ramp", title: "Analyst, Deal Operations" }];
    expect(
      matchJob(
        {
          from_addr: "pat.example@gmail.com",
          subject: "Thank you for applying to Ramp",
          body: "Thank you for applying to Ramp. We have received your application for the Operations Analyst role.",
        },
        jobs,
      ),
    ).toBeNull();
  });

  it("still matches a webmail sender that names the company and the exact role", () => {
    const jobs = [{ id: "job-1", company: "Ramp", title: "Analyst, Deal Operations" }];
    expect(
      matchJob(
        {
          from_addr: "hiring.lead@gmail.com",
          subject: "Ramp - Analyst, Deal Operations",
          body: "Following up about your application to Ramp for Analyst, Deal Operations.",
        },
        jobs,
      ),
    ).toBe("job-1");
  });

  it("still matches an employer writing from its own domain on one mention", () => {
    const jobs = [{ id: "job-1", company: "Ramp", title: "Analyst, Deal Operations" }];
    expect(
      matchJob(
        { from_addr: "no-reply@ramp.com", subject: "Your application", body: "Thanks from Ramp." },
        jobs,
      ),
    ).toBe("job-1");
  });

  it("still matches a receipt to the right employer", () => {
    const jobs = [{ id: "job-1", company: "Ramp", title: "Operations Analyst" }];
    expect(
      matchJob(
        {
          from_addr: "no-reply@greenhouse.io",
          subject: "Thank you for applying to Ramp",
          body: "We have received your application to Ramp for the Operations Analyst role.",
        },
        jobs,
      ),
    ).toBe("job-1");
  });

  // A receipt that talks about interviews, with no line break to blame.
  it("files 'we received your application ... a recruiter may schedule an interview' as a receipt", () => {
    const body =
      "Hi, thank you for applying to the Store Manager role. We have received your application and our team is reviewing it. If your experience matches, a recruiter will contact you to schedule an interview. You can check your status any time.";
    expect(classifyEmail("Thank you for applying", body).category).toBe("confirmation");
  });
  it("but a thank-you that goes on to ask for a time is an interview", () => {
    const body =
      "Thank you for applying to the Store Manager role. We would like to schedule a phone interview with you. Are you available Tuesday or Wednesday afternoon?";
    expect(classifyEmail("Next steps with us", body).category).toBe("interview");
  });

  // The inbox showed twenty-three of these under "interview".
  it("files the portals' own receipts as receipts, curly apostrophe and all", () => {
    const tail = " If your qualifications match our needs, a member of our team will contact you to schedule an interview.";
    expect(classifyEmail("We’ve received your application", `Hello, we’ve received your application for the role.${tail}`).category).toBe("confirmation");
    expect(classifyEmail("Thank you for applying to Example Corp", `Thank you for applying.${tail}`).category).toBe("confirmation");
    expect(classifyEmail("Job Application Retail Associate : Application Update", `There is an update on your profile.${tail}`).category).not.toBe("interview");
  });
});
