import { describe, expect, it } from "vitest";
import { boardReceipt, companiesFromAlert, guessCareersUrl, isJobAlert } from "./alerts.server";
import { greenhousePlace } from "./careers";

describe("job-board alerts", () => {
  it("knows an alert from a receipt", () => {
    expect(isJobAlert({ from_addr: "jobalerts-noreply@linkedin.com", subject: "30+ new jobs for operations manager" })).toBe(true);
    expect(isJobAlert({ from_addr: "alert@indeed.com", subject: "Operations Manager jobs in Princeton, NJ" })).toBe(true);
    expect(isJobAlert({ from_addr: "jobs-noreply@linkedin.com", subject: "Your application was sent to Acme" })).toBe(false);
    expect(isJobAlert({ from_addr: "recruiting@ramp.com", subject: "Thank you for applying" })).toBe(false);
  });

  it("reads the employer beside its place", () => {
    const body = [
      "Operations Manager",
      "Acme Logistics · Newark, NJ",
      "View job",
      "Store Manager",
      "Garden State Foods - Princeton, NJ (On-site)",
      "Area Supervisor",
      "Shore Medical Group",
      "Red Bank, NJ",
      "See all jobs",
      "Unsubscribe",
    ].join("\n");
    expect(companiesFromAlert({ body })).toEqual(["Acme Logistics", "Garden State Foods", "Shore Medical Group"]);
  });

  it("does not take a title, a place or a button for an employer", () => {
    const body = ["Princeton, NJ", "Newark, NJ", "View job", "https://example.com/x · Newark, NJ"].join("\n");
    expect(companiesFromAlert({ body })).toEqual([]);
  });

  it("guesses the company's own site", () => {
    expect(guessCareersUrl("Acme Logistics, Inc.")).toBe("https://www.acmelogistics.com/careers");
    expect(guessCareersUrl("A")).toBeNull();
  });
});

describe("a Greenhouse posting's place", () => {
  it("keeps a real place as the board gives it", () => {
    expect(greenhousePlace({ location: { name: "Edison, NJ" }, offices: [{ name: "HQ", location: "Austin, TX" }] })).toBe("Edison, NJ");
    expect(greenhousePlace({ location: { name: "Remote" }, offices: [{ name: "New York" }] })).toBe("Remote");
    expect(greenhousePlace({ location: { name: "New York, NY (Hybrid)" } })).toBe("New York, NY (Hybrid)");
  });

  it("reads the office when the place line holds only the arrangement", () => {
    expect(greenhousePlace({ location: { name: "Hybrid" }, offices: [{ name: "NYC", location: "New York, NY, United States" }] })).toBe("New York, NY, United States");
    expect(greenhousePlace({ location: { name: "Hybrid; In-Office" }, offices: [{ name: "Princeton, NJ", location: null }] })).toBe("Princeton, NJ");
    expect(greenhousePlace({ location: { name: "N/A" }, offices: [{ name: "HQ" }, { name: "Newark, NJ" }] })).toBe("Newark, NJ");
  });

  it("makes nothing up when no office is named", () => {
    expect(greenhousePlace({ location: { name: "In-Office" }, offices: [] })).toBe("In-Office");
    expect(greenhousePlace({ location: { name: "Hybrid" }, offices: [{ name: "HQ" }] })).toBe("Hybrid");
    expect(greenhousePlace({})).toBeUndefined();
  });
});

describe("a board's receipt for an application made on the board", () => {
  it("is read for the employer and the role, in each board's wording", () => {
    expect(boardReceipt({ from_addr: "jobs-noreply@linkedin.com", subject: "Your application was sent to Acme Logistics", body: "Operations Manager\nAcme Logistics · Newark, NJ\nApplied on November 26" })).toEqual({ board: "linkedin", company: "Acme Logistics", title: "Operations Manager" });
    expect(boardReceipt({ from_addr: "indeedapply@indeed.com", subject: "Indeed Application: Store Manager", body: "Your application has been submitted.\nThe following items were sent to Garden State Foods. Good luck!" })).toEqual({ board: "indeed", company: "Garden State Foods", title: "Store Manager" });
    expect(boardReceipt({ from_addr: "noreply@ziprecruiter.com", subject: "You applied to Shift Supervisor at Shore Medical Group", body: "" })).toEqual({ board: "ziprecruiter", company: "Shore Medical Group", title: "Shift Supervisor" });
    expect(boardReceipt({ from_addr: "jobs@monster.com", subject: "Your application for Area Manager at Acme Logistics has been submitted", body: "" })).toEqual({ board: "monster", company: "Acme Logistics", title: "Area Manager" });
  });
  it("is not made out of an alert, or of mail from anyone else", () => {
    expect(boardReceipt({ from_addr: "alert@indeed.com", subject: "Operations Manager jobs in Princeton, NJ", body: "" })).toBeNull();
    expect(boardReceipt({ from_addr: "recruiting@acme.com", subject: "Your application was sent to Acme", body: "" })).toBeNull();
  });
});
