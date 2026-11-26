import { describe, expect, it } from "vitest";
import { questionsFor, readAnswer } from "./practice";

const job = { title: "Store Manager", company: "Example Co", description: "• 3+ years of experience managing inventory and vendor relationships\n• Forklift certification required for warehouse duties" };
const resume = "Managed inventory across two stores and negotiated with vendor partners for five years.";

describe("the practice interviewer", () => {
  it("asks about the posting: what the resume shows, what it does not, and how the owner works", () => {
    const qs = questionsFor(job, resume);
    expect(qs[0]).toMatchObject({ about: "opening" });
    expect(qs[0]?.ask).toContain("the Store Manager role at Example Co");
    expect(qs.filter((q) => q.about === "requirement")).toHaveLength(1);
    expect(qs.find((q) => q.about === "gap")?.ask).toContain("Your resume does not show it");
    expect(qs.at(-1)).toMatchObject({ about: "closing" });
    expect(qs.length).toBeLessThanOrEqual(9);
  });
  it("still has an interview to give with no posting text", () => {
    const qs = questionsFor(null, null);
    expect(qs.length).toBeGreaterThanOrEqual(5);
    expect(qs.some((q) => q.about === "behaviour")).toBe(true);
  });
  it("reads a thin answer as thin and says how to fix it", () => {
    const r = readAnswer({ ask: "x", about: "behaviour" }, "We had a problem and the team fixed it.");
    expect(r.fix.join(" ")).toMatch(/Too short/);
  });
  it("credits what a full answer has", () => {
    const q = questionsFor(job, resume).find((x) => x.about === "requirement")!;
    const r = readAnswer(q, "At my last store I managed inventory for two locations. Counts were off by about 8 percent every month, so I set up a weekly cycle count and renegotiated delivery windows with our three largest vendor partners. As a result shrink dropped to under 2 percent within a quarter and stayed there for the rest of the year.", resume);
    expect(r.good).toEqual(expect.arrayContaining(["A good length.", "You said what you did, in the first person.", "You gave a number or a scale.", "You said how it ended.", "You used the posting's own words, which is what they are listening for."]));
    expect(r.fix).toEqual([]);
  });
  it("wants honesty about a gap, never a claim", () => {
    const q = questionsFor(job, resume).find((x) => x.about === "gap")!;
    expect(readAnswer(q, "Yes I have plenty of forklift experience from many places and I am very good at warehouse duties and certification work in general and always have been.").fix.join(" ")).toMatch(/Do not claim it/);
  });
});
