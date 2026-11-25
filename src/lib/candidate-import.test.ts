import { describe, expect, it } from "vitest";
import { importAllCandidates } from "./candidate-import";

describe("large employer import completion", () => {
  it("retries eight-employer batches until done even with zero pending and remaining failures", async () => {
    let calls = 0;
    const checked = [8, 8, 0];
    await importAllCandidates(async () => {
      const count = checked[calls++];
      return { done: count === 0, checked: count, stats: { pending: 0, failed: 335 } };
    }, () => {}, true);
    expect(calls).toBe(3);
  });
  it("continues calling batches until pending is zero", async () => {
    const pending = [382, 362, 0];
    let calls = 0;
    const progress: number[] = [];
    await importAllCandidates(async () => ({ done: false, stats: { pending: pending[calls++] ?? 0 } }),
      (result) => progress.push(result.stats.pending));
    expect(calls).toBe(3);
    expect(progress).toEqual([382, 362, 0]);
  });
  it("stops when done is true even if pending is not zero", async () => {
    let calls = 0;
    await importAllCandidates(async () => { calls++; return { done: true, stats: { pending: 2 } }; }, () => {});
    expect(calls).toBe(1);
  });
  it("does not treat missing progress as completion", async () => {
    await expect(importAllCandidates(async () => ({ done: false, stats: null }), () => {})).rejects.toThrow("progress unavailable");
  });
});