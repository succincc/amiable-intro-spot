import { describe, expect, it } from "vitest";

import { confirmationGap, distanceLabel, parseDailyCap, percentToScore, scoreToPercent } from "@/hooks/use-mission-control";
import { docxXmlToText, looksScanned } from "@/lib/resume-parse";

describe("confirmation gap", () => {
  it("warns when confirmed is under 70% of sent", () => {
    expect(confirmationGap(40, 12)).toEqual({ warn: true, missing: 28 });
  });
  it("does not warn at exactly 70%", () => {
    expect(confirmationGap(10, 7).warn).toBe(false);
  });
});

describe("resume scan check", () => {
  it("flags text under 200 characters", () => {
    expect(looksScanned("x".repeat(199))).toBe(true);
    expect(looksScanned("x".repeat(200))).toBe(false);
  });
  it("turns each docx paragraph into a line", () => {
    expect(docxXmlToText("<w:p><w:t>A</w:t></w:p><w:p><w:t>B</w:t></w:p>")).toBe("A\nB");
  });
});

describe("distance label", () => {
  it("formats miles, remote and unknown", () => {
    expect(distanceLabel({ remote: false, distance_miles: 18 })).toBe("18 mi");
    expect(distanceLabel({ remote: true, distance_miles: null })).toBe("Remote");
    expect(distanceLabel({ remote: false, distance_miles: null })).toBe("—");
  });
});

describe("match percentage thresholds", () => {
  it("converts 1-10 scores to 10%-100% steps and back", () => {
    expect(scoreToPercent(5)).toBe(50);
    expect(scoreToPercent(1)).toBe(10);
    expect(scoreToPercent(10)).toBe(100);
    expect(percentToScore(70)).toBe(7);
    expect(percentToScore(50)).toBe(5);
    expect(percentToScore(0)).toBe(1);
    expect(percentToScore(120)).toBe(10);
  });
});

describe("daily cap bounds", () => {
  it("accepts whole numbers from 1 to 1000 and rejects out-of-range values", () => {
    expect(parseDailyCap(1)).toBe(1);
    expect(parseDailyCap("50")).toBe(50);
    expect(parseDailyCap(1000)).toBe(1000);
    expect(parseDailyCap(0)).toBeNull();
    expect(parseDailyCap(-5)).toBeNull();
    expect(parseDailyCap(1001)).toBeNull();
    expect(parseDailyCap("")).toBeNull();
    expect(parseDailyCap(12.5)).toBeNull();
  });
});
