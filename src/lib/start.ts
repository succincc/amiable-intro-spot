// ============================================================================
// start.ts — what has to be true before "start" means anything.
//
// The dashboard's first card. Four things the system cannot work without,
// three that make it ask the owner less, and one button. Pure, so the list
// itself has a test.
// ============================================================================

export type Step = { key: string; label: string; done: boolean; required: boolean; hint: string; to: "/settings" | "/answers" };

export function setupSteps(s: {
  profile: Record<string, unknown> | null | undefined;
  titles: unknown;
  mailLastRun: string | null | undefined;
  waiting: number;
  /** Postings scored in the middle band, held for the owner's yes. */
  reviewing?: number;
  now: Date;
}): Step[] {
  const p = s.profile ?? {};
  const has = (k: string) => String(p[k] ?? "").trim().length > 0;
  const mailAge = s.mailLastRun ? s.now.getTime() - new Date(s.mailLastRun).getTime() : Infinity;
  const windows = Array.isArray(p["availability_slots"])
    ? (p["availability_slots"] as Array<{ day?: string }>).filter((w) => String(w?.day ?? "") >= s.now.toISOString().slice(0, 10)).length
    : 0;
  return [
    { key: "gmail", label: "gmail connected and being read", done: mailAge < 3 * 3_600_000, required: true, hint: "emailed codes, receipts and replies are read from it", to: "/settings" },
    { key: "resume", label: "resume on file", done: String(p["resume_text"] ?? "").trim().length > 200, required: true, hint: "every application is written from it", to: "/settings" },
    { key: "contact", label: "name, email and phone", done: has("full_name") && has("email") && has("phone"), required: true, hint: "the first three boxes on every form", to: "/settings" },
    { key: "titles", label: "what to look for", done: Array.isArray(s.titles) && s.titles.length > 0, required: true, hint: "at least one job title to search", to: "/settings" },
    { key: "facts", label: "citizenship and ethnicity", done: has("citizenship") && has("hispanic_latino"), required: false, hint: "asked on most forms; never guessed, so unanswered they come to you", to: "/settings" },
    { key: "windows", label: "interview windows marked", done: windows > 0 || has("availability"), required: false, hint: "the times offered when an employer asks", to: "/settings" },
    { key: "answers", label: s.waiting ? `${s.waiting} question${s.waiting === 1 ? "" : "s"} waiting for you` : "no questions waiting", done: s.waiting === 0, required: false, hint: "answered once, reused on every form after", to: "/answers" },
    ...(s.reviewing
      ? [{ key: "review", label: `${s.reviewing} posting${s.reviewing === 1 ? "" : "s"} held for your yes`, done: false, required: false, hint: "set the auto-apply score down to the review score and they go without asking", to: "/settings" as const }]
      : []),
  ];
}

export const readyToStart = (steps: Step[]) => steps.every((x) => x.done || !x.required);

/** Everything "start" switches on, and nothing it does not say. */
export const STARTED = { autopilot: true, auto_reply: true, daily_summary: true, notify_moments: true } as const;

export const isStarted = (p: Record<string, unknown> | null | undefined) => p?.["autopilot"] === true && p?.["auto_reply"] === true;
