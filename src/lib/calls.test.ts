import { describe, expect, it } from "vitest";
import { dialable, goodHour, pitchFor } from "./calls";

describe("calling the place after applying", () => {
  it("makes a number dialable, and refuses what is not one", () => {
    expect(dialable("+1 732-555-0100")).toBe("(732) 555-0100");
    expect(dialable("732.555.0100; 732-555-0199")).toBe("(732) 555-0100");
    expect(dialable("call the front desk")).toBeNull();
  });
  it("says who is calling, for what, and the best true reason on the resume", () => {
    const p = pitchFor(
      { title: "Sales Associate", company: "Example Office Supply", location: "Exampleton, NJ", description: "• Experience helping customers and managing inventory on the sales floor" },
      { full_name: "Sam Sample", resume_text: "Helped customers on a busy sales floor and kept inventory counts accurate for two years.\nDrove a van." },
    );
    expect(p.ask).toBe("Hi, my name is Sam. I applied online for the Sales Associate opening. Is the hiring manager available for a minute?");
    expect(p.pitch).toContain("at your Exampleton location");
    expect(p.pitch).toContain("Helped customers on a busy sales floor and kept inventory counts accurate for two years");
  });
  it("invents no reason where the resume shows none", () => {
    expect(pitchFor({ title: "Welder", description: "• Welding certification required for structural work" }, { full_name: "Sam Sample", resume_text: "Sold shoes." }).pitch).toContain("[Say in one sentence");
  });
  it("knows a good hour to call a store", () => {
    expect(goodHour(new Date("2026-12-01T15:30:00Z"), "America/New_York")).toBe(true); // Tue 10:30
    expect(goodHour(new Date("2026-12-01T17:30:00Z"), "America/New_York")).toBe(false); // Tue 12:30, lunch
    expect(goodHour(new Date("2026-12-05T15:30:00Z"), "America/New_York")).toBe(false); // Saturday
  });
});
