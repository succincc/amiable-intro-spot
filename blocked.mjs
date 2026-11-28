/**
 * Employers nothing is ever sent to, for anybody.
 *
 * The owner's word, for every person the engine works for: no application,
 * no resume, no follow-up email. Checked where a posting is picked up, again
 * where the form would be opened, and again where a follow-up would be
 * written — so that no path around one check leads past the others.
 *
 * Kept as fingerprints of the names, not the names: this file is public,
 * and who the owner will not deal with is not the public's business.
 */
import crypto from "node:crypto";

const print = (word) => crypto.createHash("sha256").update(`applypilot-blocked:${word}`).digest("hex").slice(0, 16);

// One fingerprint for each word that names a blocked employer on its own.
const BLOCKED = new Set(["3c860b6aba15f666"]);

const words = (t) => String(t ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w.length >= 3);

/** Whether a posting belongs to a blocked employer: by the employer's name, or by the address it is applied to at. */
export function isBlocked(job) {
  const names = words(job?.company);
  let hosts = [];
  for (const u of [job?.url, job?.apply_url]) {
    try { hosts.push(...new URL(String(u)).hostname.split(".")); } catch { /* not an address */ }
  }
  // In an address the name may be run together with others: "staplescareers".
  const inHost = hosts.flatMap((h) => { const out = [h]; for (let n = 4; n <= Math.min(h.length, 14); n++) out.push(h.slice(0, n)); return out; });
  return [...names, ...inHost].some((w) => BLOCKED.has(print(w)));
}

export const BLOCKED_REASON = "this employer is blocked by the owner: nothing is sent to it";
export const fingerprint = print;
