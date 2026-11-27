// ============================================================================
// calls.ts — what to say when calling the place after applying.
//
// "I applied online for the opening you have; is the hiring manager in?" and
// thirty seconds on why. The number is the location's own published one, the
// words come from the posting and the owner's resume, and the owner is the
// one who says them. Pure, so each part has a test.
// ============================================================================

import { requirementsMet } from "@/lib/moments";

export type CallJob = { title?: string | null; company?: string | null; location?: string | null; description?: string | null; applied_at?: string | null };

/** A number as a person dials it, or null for something that is not one. */
export function dialable(raw: string | null | undefined): string | null {
  const first = String(raw ?? "").split(/[;,/]| or /)[0] ?? "";
  const digits = first.replace(/[^0-9+]/g, "").replace(/^\+?1(?=\d{10}$)/, "");
  if (!/^\d{10}$/.test(digits)) return null;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

/** The line from the resume that best answers what the posting asks for. */
function bestLine(description: string | null | undefined, resume: string | null | undefined): string | null {
  const asks = requirementsMet(description, resume, 6).filter((r) => r.shown);
  if (!asks.length) return null;
  const want = new Set((asks.map((a) => a.line).join(" ").toLowerCase().match(/[a-z]{5,}/g) ?? []));
  let best: { line: string; hits: number } | null = null;
  for (const raw of String(resume ?? "").split(/\n|•/)) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (line.length < 30 || line.length > 220) continue;
    const hits = (line.toLowerCase().match(/[a-z]{5,}/g) ?? []).filter((w) => want.has(w)).length;
    if (hits >= 2 && (!best || hits > best.hits)) best = { line, hits };
  }
  return best?.line ?? null;
}

/**
 * The call, in three parts: how to get to the manager, what to say once
 * there, and how to leave it. Only what the resume shows is offered as a
 * reason; where it shows nothing for this posting, the pitch says so and
 * leaves the reason to the owner.
 */
export function pitchFor(job: CallJob, me: { full_name?: string | null; resume_text?: string | null }): { ask: string; pitch: string; close: string } {
  const name = String(me.full_name ?? "").trim().split(/\s+/)[0] || "[your name]";
  const role = job.title ? `the ${job.title} opening` : "the opening you have";
  const proof = bestLine(job.description, me.resume_text);
  return {
    ask: `Hi, my name is ${name}. I applied online for ${role}. Is the hiring manager available for a minute?`,
    pitch:
      `Hi, this is ${name}. I applied for ${role}${job.location ? ` at your ${String(job.location).split(",")[0]} location` : ""} and wanted to put a voice to the application. ` +
      (proof ? `The short version of why I fit: ${proof.replace(/[.;]+$/, "")}. ` : "[Say in one sentence the thing you have done that is closest to this job.] ") +
      `I can start soon and I'd welcome the chance to come in and talk.`,
    close: `Is there a good time this week to stop by, or someone I should follow up with? Thank you for your time.`,
  };
}

/** Is this an hour a store would rather take the call? Mid-morning or mid-afternoon on a weekday. */
export function goodHour(now: Date, zone: string): boolean {
  const parts: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", hour: "2-digit", hour12: false }).formatToParts(now)) parts[p.type] = p.value;
  const h = Number(parts["hour"]) % 24;
  return !/Sat|Sun/.test(parts["weekday"] ?? "") && ((h >= 10 && h < 12) || (h >= 14 && h < 16));
}
