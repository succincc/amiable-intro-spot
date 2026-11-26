import { describe, expect, it } from "vitest";
import { cleanHolds, cleanSlots, instantAt, kindOf, offerable, weekdaysOfMonth, withOffers, type Hold, type Slot } from "./availability";

const ZONE = "America/New_York";
// A Wednesday, 1pm Eastern (standard time, UTC-5).
const NOW = new Date("2026-12-02T18:00:00Z");
const slot = (day: string, from: number, to: number, kinds: Slot["kinds"]): Slot => ({ day, from, to, kinds });
const hhmm = (d: Date) => new Intl.DateTimeFormat("en-US", { timeZone: ZONE, hour: "numeric", minute: "2-digit", weekday: "short" }).format(d);

describe("stored windows are only trusted once checked", () => {
  it("drops what is malformed, too short, or good for nothing", () => {
    expect(cleanSlots([
      { day: "2026-12-03", from: 540, to: 1020, kinds: ["phone"] },
      { day: "12/03/2026", from: 540, to: 1020, kinds: ["phone"] },
      { day: "2026-12-03", from: 600, to: 610, kinds: ["phone"] },
      { day: "2026-12-03", from: 600, to: 700, kinds: [] },
      { day: "2026-12-03", from: 600, to: 700, kinds: ["carrier pigeon"] },
      "nonsense",
    ])).toEqual([{ day: "2026-12-03", from: 540, to: 1020, kinds: ["phone"] }]);
    expect(cleanSlots(null)).toEqual([]);
  });
  it("a hold that has passed holds nothing", () => {
    const holds = cleanHolds([
      { start: "2026-12-01T15:00:00Z", end: "2026-12-01T16:00:00Z", kind: "phone", ref: "a", state: "offered" },
      { start: "2026-12-04T15:00:00Z", end: "2026-12-04T16:00:00Z", kind: "phone", ref: "b", state: "booked" },
    ], NOW);
    expect(holds.map((h) => h.ref)).toEqual(["b"]);
  });
});

describe("what kind of interview an email asks for", () => {
  it("reads the three kinds", () => {
    expect(kindOf("We'd like to invite you on-site to meet the team")).toBe("in_person");
    expect(kindOf("Are you free for a Zoom interview next week?")).toBe("virtual");
    expect(kindOf("I'd love to set up a quick call to talk through the role")).toBe("phone");
  });
  it("says nothing where the email says nothing", () => {
    expect(kindOf("We would like to schedule an interview with you.")).toBeNull();
  });
});

describe("the clock in the owner's zone", () => {
  it("puts ten in the morning Eastern at fifteen hundred UTC in December", () => {
    expect(instantAt(ZONE, "2026-12-03", 600).toISOString()).toBe("2026-12-03T15:00:00.000Z");
  });
  it("and at fourteen hundred in July, when the clocks are forward", () => {
    expect(instantAt(ZONE, "2026-07-08", 600).toISOString()).toBe("2026-07-08T14:00:00.000Z");
  });
});

describe("the times offered", () => {
  const windows = [
    slot("2026-12-03", 540, 1020, ["phone", "virtual"]),
    slot("2026-12-04", 600, 900, ["in_person"]),
    slot("2026-12-07", 540, 720, ["phone", "virtual", "in_person"]),
  ];

  it("only ever inside a window marked for that kind", () => {
    const inPerson = offerable(windows, [], [], { now: NOW, zone: ZONE, kind: "in_person" });
    expect(inPerson.length).toBeGreaterThan(0);
    for (const o of inPerson) expect(["Fri", "Mon"]).toContain(hhmm(o.start).slice(0, 3));
    const phone = offerable(windows, [], [], { now: NOW, zone: ZONE, kind: "phone" });
    for (const o of phone) expect(hhmm(o.start).slice(0, 3)).not.toBe("Fri");
  });

  it("never sooner than the notice, and never outside the window's hours", () => {
    // Thursday 9am Eastern is twenty hours from NOW: allowed at eighteen hours' notice.
    const got = offerable(windows, [], [], { now: NOW, zone: ZONE, kind: "phone" });
    expect(got[0]!.start.toISOString()).toBe("2026-12-03T14:00:00.000Z");
    for (const o of got) expect(o.start.getTime()).toBeGreaterThanOrEqual(NOW.getTime() + 18 * 3_600_000);
    const tight = offerable([slot("2026-12-03", 540, 600, ["phone"])], [], [], { now: NOW, zone: ZONE, kind: "phone" });
    expect(tight.map((o) => o.start.toISOString())).toEqual(["2026-12-03T14:00:00.000Z"]);
    expect(offerable([slot("2026-12-03", 540, 590, ["phone"])], [], [], { now: NOW, zone: ZONE, kind: "phone" })).toEqual([]);
  });

  it("never over something on the calendar, nor within a quarter of an hour of it", () => {
    const busy = [{ start: "2026-12-03T14:00:00Z", end: "2026-12-03T15:00:00Z" }]; // 9–10 Eastern
    const got = offerable(windows, busy, [], { now: NOW, zone: ZONE, kind: "phone" });
    // 10:00 is inside the quarter hour after; 10:30 is the first clear start.
    expect(got[0]!.start.toISOString()).toBe("2026-12-03T15:30:00.000Z");
  });

  it("never the same hour to two employers, whatever kind each wants", () => {
    const first = offerable(windows, [], [], { now: NOW, zone: ZONE, kind: "phone" });
    const holds = withOffers([], "employer-a", first, NOW);
    const second = offerable(windows, [], holds, { now: NOW, zone: ZONE, kind: "virtual" });
    expect(second.length).toBeGreaterThan(0);
    for (const a of first) for (const b of second) {
      expect(a.start.getTime() < b.end.getTime() && a.end.getTime() > b.start.getTime()).toBe(false);
    }
  });

  it("offering again to the same employer replaces what it was offered, and frees those hours", () => {
    const first = offerable(windows, [], [], { now: NOW, zone: ZONE, kind: "phone", want: 2 });
    let holds: Hold[] = withOffers([], "employer-a", first, NOW);
    holds = withOffers(holds, "employer-a", [], NOW);
    expect(holds).toEqual([]);
  });

  it("a booked time stays held when offers to the same employer are replaced", () => {
    const booked: Hold = { start: "2026-12-07T14:00:00.000Z", end: "2026-12-07T15:00:00.000Z", kind: "phone", ref: "employer-a", state: "booked" };
    expect(withOffers([booked], "employer-a", [], NOW)).toEqual([booked]);
    const got = offerable([slot("2026-12-07", 540, 660, ["phone"])], [], [booked], { now: NOW, zone: ZONE, kind: "phone" });
    for (const o of got) expect(o.start.toISOString()).not.toBe("2026-12-07T14:00:00.000Z");
  });

  it("at most two a day, and those not back to back", () => {
    const got = offerable([slot("2026-12-03", 540, 1020, ["phone"])], [], [], { now: NOW, zone: ZONE, kind: "phone" });
    expect(got.length).toBe(2);
    expect(got[1]!.start.getTime() - got[0]!.end.getTime()).toBeGreaterThanOrEqual(60 * 60_000);
  });

  it("with nothing marked, nothing is offered", () => {
    expect(offerable([], [], [], { now: NOW, zone: ZONE, kind: null })).toEqual([]);
  });

  it("an email that names no kind may take any window", () => {
    const got = offerable([slot("2026-12-04", 600, 900, ["in_person"])], [], [], { now: NOW, zone: ZONE, kind: null });
    expect(got[0]!.kind).toBe("in_person");
  });
});

describe("marking a month at once", () => {
  it("lists the weekdays of a month and nothing else", () => {
    const days = weekdaysOfMonth(2026, 12);
    expect(days[0]).toBe("2026-12-01");
    expect(days).not.toContain("2026-12-05");
    expect(days).not.toContain("2026-12-06");
    expect(days.length).toBe(23);
  });
});
