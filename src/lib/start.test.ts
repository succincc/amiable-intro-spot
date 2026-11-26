import { describe, expect, it } from "vitest";
import { isStarted, readyToStart, setupSteps } from "./start";

const NOW = new Date("2026-11-27T15:00:00Z");
const full = {
  profile: { full_name: "A Person", email: "a@example.com", phone: "5550100", resume_text: "x".repeat(400), citizenship: "United States only", hispanic_latino: "No", availability_slots: [{ day: "2026-12-01", from: 600, to: 720, kinds: ["phone"] }] },
  titles: ["store manager"],
  mailLastRun: "2026-11-27T14:30:00Z",
  waiting: 0,
  now: NOW,
};

describe("the setup list", () => {
  it("is all done when everything is there", () => {
    const steps = setupSteps(full);
    expect(steps.every((s) => s.done)).toBe(true);
    expect(readyToStart(steps)).toBe(true);
  });
  it("will not start without the four it cannot work without", () => {
    for (const broken of [
      { ...full, mailLastRun: "2026-11-27T02:00:00Z" },
      { ...full, profile: { ...full.profile, resume_text: "" } },
      { ...full, profile: { ...full.profile, phone: " " } },
      { ...full, titles: [] },
    ]) expect(readyToStart(setupSteps(broken))).toBe(false);
  });
  it("starts with the optional ones undone, and says what is waiting", () => {
    const steps = setupSteps({ ...full, profile: { ...full.profile, citizenship: null, availability_slots: [{ day: "2026-11-01" }] }, waiting: 3 });
    expect(readyToStart(steps)).toBe(true);
    expect(steps.filter((s) => !s.done).map((s) => s.key)).toEqual(["facts", "windows", "answers"]);
    expect(steps.find((s) => s.key === "answers")?.label).toBe("3 questions waiting for you");
  });
  it("says when postings are being held for a yes, and never blocks on it", () => {
    const steps = setupSteps({ ...full, reviewing: 16 });
    expect(steps.at(-1)).toMatchObject({ key: "review", label: "16 postings held for your yes", done: false, required: false });
    expect(readyToStart(steps)).toBe(true);
    expect(setupSteps({ ...full, reviewing: 0 }).some((s) => s.key === "review")).toBe(false);
  });
  it("counts as started only with applying and replying both on", () => {
    expect(isStarted({ autopilot: true, auto_reply: true })).toBe(true);
    expect(isStarted({ autopilot: true, auto_reply: false })).toBe(false);
    expect(isStarted(null)).toBe(false);
  });
});
