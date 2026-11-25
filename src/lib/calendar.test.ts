import { describe, expect, it } from "vitest";
import { hoursFrom, openSlots, sayTimes } from "./calendar.server";

const ZONE = "America/New_York";
// A Wednesday, 1pm Eastern (standard time, UTC-5).
const NOW = new Date("2026-12-02T18:00:00Z");
const at = (iso: string) => new Date(iso);

describe("the hours the owner wrote down", () => {
  it("reads a from and a to", () => {
    expect(hoursFrom("weekdays between 9am and 5pm Eastern, with a day's notice")).toEqual({ from: 9, to: 17, weekends: false });
    expect(hoursFrom("10:30 am to 4 pm")).toEqual({ from: 10.5, to: 16, weekends: false });
  });
  it("reads one end of the day", () => {
    expect(hoursFrom("any weekday after 1pm")).toEqual({ from: 13, to: 17, weekends: false });
    expect(hoursFrom("mornings until 12pm")).toEqual({ from: 9, to: 12, weekends: false });
  });
  it("falls back to nine to five, and takes weekends only when told", () => {
    expect(hoursFrom("")).toEqual({ from: 9, to: 17, weekends: false });
    expect(hoursFrom("any day including weekends")).toEqual({ from: 9, to: 17, weekends: true });
    expect(hoursFrom("weekdays, no weekends")).toEqual({ from: 9, to: 17, weekends: false });
  });
  it("never offers the middle of the night", () => {
    expect(hoursFrom("12am to 5pm").from).toBe(7);
  });
});

describe("open times", () => {
  const base = { now: NOW, zone: ZONE, from: 9, to: 17, weekends: false };

  it("offers ten and two on the next working days, a full day out", () => {
    const slots = openSlots([], base);
    expect(slots.map((s) => s.toISOString())).toEqual([
      // Thursday 2pm Eastern is the first hour a full day away; Thursday 10am is not.
      "2026-12-03T19:00:00.000Z",
      "2026-12-04T15:00:00.000Z",
      "2026-12-04T19:00:00.000Z",
      "2026-12-07T15:00:00.000Z",
    ]);
  });

  it("steps round what is already on the calendar, with room either side", () => {
    const busy = [
      { start: "2026-12-03T19:00:00Z", end: "2026-12-03T20:00:00Z" }, // Thursday 2-3pm
      { start: "2026-12-04T14:30:00Z", end: "2026-12-04T15:50:00Z" }, // Friday 9:30-10:50am
    ];
    const slots = openSlots(busy, base).map((s) => s.toISOString());
    // Thursday moves to 4pm (3pm is inside the quarter-hour after the meeting ends at 3).
    expect(slots[0]).toBe("2026-12-03T21:00:00.000Z");
    // Friday morning: 10am is taken and 11am starts inside the margin, so the morning is skipped.
    expect(slots).not.toContain("2026-12-04T15:00:00.000Z");
    expect(slots).toContain("2026-12-04T19:00:00.000Z");
  });

  it("skips the weekend unless the owner takes weekends", () => {
    const days = (w: boolean) => openSlots([], { ...base, weekends: w, want: 8 }).map((s) => s.getUTCDay());
    expect(days(false)).not.toContain(6);
    expect(days(false)).not.toContain(0);
    expect(days(true)).toContain(6);
  });

  it("offers nothing on a calendar with no room", () => {
    expect(openSlots([{ start: "2026-12-01T00:00:00Z", end: "2027-01-01T00:00:00Z" }], base)).toEqual([]);
  });

  it("says them the way a person would", () => {
    const text = sayTimes([at("2026-12-03T19:00:00Z"), at("2026-12-04T15:00:00Z"), at("2026-12-04T19:00:00Z")], ZONE);
    expect(text).toBe("Thursday, December 3 at 2:00 PM; Friday, December 4 at 10:00 AM or 2:00 PM (Eastern Time)");
  });
});
