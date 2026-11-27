import { describe, expect, it } from "vitest";
import { opening, reply, start, transcript } from "./caller";

const job = { title: "Sales Associate", company: "Example Office Supply", location: "Exampleton, NJ", description: "• Experience helping customers and managing inventory on the sales floor" };
const me = { full_name: "Sam Sample", resume_text: "Helped customers on a busy sales floor and kept inventory counts accurate for two years.", earliest_start: "two weeks", phone: "(732) 555-0100" };

describe("the calling assistant", () => {
  it("says it is an AI assistant in its first sentence, every call, whatever the job or the owner", () => {
    for (const j of [job, {}, { title: "X" }]) for (const m of [me, {}, { full_name: "A B" }]) {
      const firstSentence = opening(j, m).split(/(?<=[.?!])\s/)[0] ?? "";
      expect(firstSentence).toMatch(/AI assistant calling on behalf of/);
      expect(start(j, m).lines[0]?.said).toBe(opening(j, m));
    }
  });
  it("never says it is the owner, and says again what it is when asked", () => {
    const c = reply(start(job, me), "Wait, is this a real person?", job, me);
    expect(c.lines.at(-1)?.said).toMatch(/I'm an AI assistant calling for Sam; I'm not Sam/);
  });
  it("holds, then makes the case to the manager from the resume", () => {
    let c = reply(start(job, me), "Sure, one moment, let me get her.", job, me);
    expect(c.lines.at(-1)?.said).toBe("Thank you, I'll hold.");
    c = reply(c, "Hi, this is the manager.", job, me);
    expect(c.stage).toBe("manager");

    const said = c.lines.at(-1)?.said ?? "";
    expect(said).toBe("Thank you for taking the call. The application is for the Sales Associate role at your Exampleton location, and the name on it is Sam Sample. After reviewing the posting it looks like an excellent fit, with experience like this: helped customers on a busy sales floor and kept inventory counts accurate for two years. Would there be a good time to come in and talk?");
    // No narrator: it neither claims to be the applicant nor speaks about them.
    expect(said).not.toMatch(/\bI (applied|helped|can start)\b|\bSam (applied|asked|can|is)\b/);
  });
  it("answers facts from the profile and leaves the person's own questions to the person", () => {
    let c = reply(reply(start(job, me), "Speaking.", job, me), "When can he start?", job, me);
    expect(c.lines.at(-1)?.said).toBe("Available to start with two weeks' notice.");
    c = reply(c, "Why does he want to work here?", job, me);
    expect(c.lines.at(-1)?.said).toMatch(/deserves a proper answer in person/);
  });
  it("takes no for an answer, and a message when the manager is out", () => {
    expect(reply(start(job, me), "We're not hiring, please don't call again.", job, me)).toMatchObject({ stage: "done", outcome: "declined" });
    const out = reply(start(job, me), "She's not in today.", job, me);
    expect(out.outcome).toBe("callback");
    expect(out.lines.at(-1)?.said).toContain("(732) 555-0100");
  });
  it("passes on an offered time and keeps the whole call as a record", () => {
    const c = reply(reply(start(job, me), "This is the manager.", job, me), "Have him come in Thursday at 2 pm for an interview.", job, me);
    expect(c.outcome).toBe("spoke");
    const t = transcript(c, job);
    expect(t.split("\n")[0]).toBe("Example Office Supply - Sales Associate (Exampleton, NJ)");
    expect(t).toContain("THEM: Have him come in Thursday at 2 pm for an interview.");
  });
  it("gives the name on the application when asked for it", () => {
    const c = reply(reply(start(job, me), "This is the manager.", job, me), "Sure, what's the name on the application?", job, me);
    expect(c.lines.at(-1)?.said).toBe("The name on the application is Sam Sample.");
  });
});
