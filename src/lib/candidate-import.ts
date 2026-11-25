export type ImportBatch = {
  done: boolean;
  stats: { pending: number | null } | null;
};

/** A batch is complete only when the server explicitly says so. */
export async function importAllCandidates<T extends ImportBatch>(
  verify: () => Promise<T>,
  onProgress: (result: T) => void,
  retry = false,
) {
  while (true) {
    const result = await verify();
    onProgress(result);
    if (result.done || (!retry && result.stats?.pending === 0)) return result;
    if (!result.stats) throw new Error("Employer progress unavailable. Import stopped; retry to resume.");
  }
}