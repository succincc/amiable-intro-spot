import { describe, expect, it } from "vitest";

import { cleanResumeText } from "@/lib/resume-parse";

describe("a resume's text as a person would have typed it", () => {
  it("takes out what the database refuses and no keyboard has", () => {
    expect(cleanResumeText("Pat\u0000 Example​\r\nSales Lead\ud83d")).toBe("Pat Example\nSales Lead");
  });

  it("puts a bullet back with its sentence and drops the ones with nothing after them", () => {
    expect(cleanResumeText("Experience\n•\nRan the store\n• Hired staff\n•\n•\n•\nEducation")).toBe("Experience\n• Ran the store\n• Hired staff\nEducation");
    expect(cleanResumeText(" Opened the shop\n▪   Closed the shop")).toBe("• Opened the shop\n• Closed the shop");
  });

  it("reads a wide gap as the join between two things, and tidies blank lines", () => {
    expect(cleanResumeText("Sales Associate      Springfield, NJ\nSample Mart   09/2019 - 05/2023\n\n\n\nSkills\nSales  Service")).toBe("Sales Associate | Springfield, NJ\nSample Mart | 09/2019 - 05/2023\n\nSkills\nSales Service");
  });
});
