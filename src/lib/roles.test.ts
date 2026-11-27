import { describe, expect, it } from "vitest";

import { rolesFrom } from "@/lib/roles";

describe("the jobs on a resume", () => {
  it("reads title and place over employer and dates, the way a two-column resume comes out", () => {
    const roles = rolesFrom([
      "Pat Example", "Experience",
      "Owner and Operator | Springfield, NJ", "Example Goods LLC | 06/2023 - Present", "• Ran every part of the business", "• Hired and trained four people",
      "Sales Associate | Newark, NJ", "Sample Mart | 09/2019 - 05/2023", "• Served customers", "•", "• Closed the store",
      "Education", "Bachelor of Arts — Law", "Example University | 09/2015 - 05/2019",
    ].join("\n"));
    expect(roles.map((r) => [r.title, r.company, r.location, r.start_date, r.end_date])).toEqual([
      ["Owner and Operator", "Example Goods LLC", "Springfield, NJ", "06/2023", "Present"],
      ["Sales Associate", "Sample Mart", "Newark, NJ", "09/2019", "05/2023"],
    ]);
    expect(roles[0]!.details).toBe("• Ran every part of the business\n• Hired and trained four people");
    // A bullet with nothing after it is not a line of anybody's work.
    expect(roles[1]!.details).toBe("• Served customers\n• Closed the store");
  });

  it("reads everything on one line, and dates written with months", () => {
    const roles = rolesFrom("WORK EXPERIENCE\nStore Manager - Example Goods, Springfield, NJ   Jan 2020 – Present\n- Led a team of 12\nShift Lead at Sample Mart   March 2016 - Dec 2019\n- Opened the store\n\nSKILLS\nSales");
    expect(roles.map((r) => [r.title, r.company, r.start_date, r.end_date])).toEqual([
      ["Store Manager", "Example Goods, Springfield, NJ", "Jan 2020", "Present"],
      ["Shift Lead", "Sample Mart", "March 2016", "Dec 2019"],
    ]);
    expect(roles[1]!.details).toBe("• Opened the store");
  });

  it("does not take schooling for work, or a bullet with a year in it for a job", () => {
    expect(rolesFrom("Experience\nCashier | Sample Mart | 2018 - 2020\n• Grew sales from 2018 - 2019 by a fifth\nEducation\nExample College | 2014 - 2018")).toHaveLength(1);
    expect(rolesFrom("")).toEqual([]);
    expect(rolesFrom("just a paragraph with no dates at all")).toEqual([]);
  });
});
