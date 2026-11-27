// ============================================================================
// dial.ts — what a live call is told, when one is due, and what came of it.
//
// The call itself is carried by the user's own voice and phone accounts. This
// is everything about it that can be decided without them: the standing brief
// the assistant works from, the facts of one call, which applications are due
// a call under the user's rule, and how a finished call is read back. Pure,
// so each part has a test.
//
// Every call opens with `opening()` from caller.ts, whose first sentence says
// an AI assistant is calling. The brief holds the assistant to that for the
// rest of the call: it is never the applicant and never a person.
// ============================================================================

import { opening, type Me } from "@/lib/caller";
import { dialable, goodHour, pitchFor, type CallJob } from "@/lib/calls";
import { statedTime } from "@/lib/moments";

/** The first thing said on every call: the opening, and nothing else. */
export const FIRST_MESSAGE = "{{opening}}";

/** The standing brief. The braces are filled in per call from `callFacts`. */
export const BRIEF = [
  "You are an AI assistant on a phone call to a workplace about a job application that {{applicant_name}} has already sent in for {{role}} at {{company}}.",
  "",
  "What you are:",
  "- You are an AI assistant calling for {{first_name}}. You are not {{first_name}} and you are not a person. Your first sentence said so. Never say or imply otherwise, and never speak as the applicant: no \"I applied\", no \"my experience\".",
  "- If anyone asks who or what is calling, say plainly: \"I'm an AI assistant calling for {{first_name}}.\"",
  "",
  "What the call is for:",
  "- Reach the hiring manager. If someone else answers, ask for the hiring manager and hold if asked to.",
  "- Once with the manager, make the case in a few warm, natural sentences: the application is in under the name {{applicant_name}}; after reading the job posting it looks like an excellent fit, because of this experience: {{proof}}.",
  "- Then ask for an interview. Open times: {{open_times}}. If a day and time is agreed, say it back once, clearly, with the day and the time, and ask who to ask for.",
  "- If the manager is not in, ask when is best to reach them, or leave a message: the application is in under {{applicant_name}}, and a call back is welcome at {{callback_number}}.",
  "",
  "What you may say about the applicant, and nothing beyond it:",
  "- Start: {{start}}. Availability: {{availability}}. Location applied to: {{location}}.",
  "- Anything else about the applicant (pay, history, reasons, references): say it deserves a proper answer from {{first_name}} in person, and ask for a time to meet. Never guess and never make anything up.",
  "",
  "How to behave:",
  "- Sound like a friendly, capable person on the phone: short sentences, no lists, no jargon. Let them finish. Do not repeat the opening.",
  "- A recorded menu: ask for the operator, or customer service. Never billing or another department.",
  "- A voicemail greeting: leave one short message with the name on the application, the position, and the call-back number, then end the call.",
  "- If they say they are not interested, the job is filled, or not to call: thank them and end the call. Never argue and never call it a mistake.",
  "- Keep the whole call under three minutes. End politely as soon as there is an answer.",
].join("\n");

const first = (me: Me) => String(me.full_name ?? "").trim().split(/\s+/)[0] || "the applicant";
const orNot = (v: string | null | undefined, none: string) => String(v ?? "").trim() || none;

/** The facts of one call. Every value is a plain string, as the brief's braces need. */
export function callFacts(job: CallJob, me: Me, openTimes: string | null): Record<string, string> {
  const proof = (pitchFor(job, me).pitch.match(/The short version of why I fit: (.+?)\. I can start soon/) ?? [])[1] ?? null;
  return {
    opening: opening(job, me),
    applicant_name: orNot(me.full_name, "the applicant"),
    first_name: first(me),
    role: job.title ? `the ${job.title} position` : "an open position",
    company: orNot(job.company, "your location"),
    location: orNot(job.location, "this location"),
    proof: proof ? proof.replace(/[.;]+$/, "") : "the experience on the resume that came with the application",
    open_times: orNot(openTimes, "flexible this week; ask what day suits them"),
    start: orNot(me.earliest_start, "soon"),
    availability: orNot(me.availability, "flexible; best confirmed directly"),
    callback_number: orNot(me.phone, "the number on the application"),
  };
}

/** A US number as a phone network takes it: +1 and ten digits. */
export function e164(raw: string | null | undefined): string | null {
  const shown = dialable(raw);
  return shown ? `+1${shown.replace(/\D/g, "")}` : null;
}

export type CallRule = { calls_enabled?: boolean | null; calls_min_score?: number | null; calls_targets_only?: boolean | null; target_role?: string | null };
export type DueJob = CallJob & { phone?: string | null; call_state?: string | null; score?: number | null; status?: string | null };

/** Is this one of the roles the user is aiming for? Every word of one of them is in the title. */
export function targeted(title: string | null | undefined, targets: string | null | undefined): boolean {
  const t = ` ${String(title ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  return String(targets ?? "")
    .split(/[,;\n|]+/)
    .map((r) => r.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2))
    .some((words) => words.length > 0 && words.every((w) => t.includes(` ${w} `)));
}

/**
 * Is this application due a call now? Only when the user has switched calls
 * on, the application went out, the place has a number that can be dialled,
 * nobody has called about it yet, it is an hour a store would take a call,
 * and it passes the user's rule: a role they are aiming for, or a match at
 * or above their line.
 */
export function dueToCall(job: DueJob, rule: CallRule, now: Date, zone: string): boolean {
  if (rule.calls_enabled !== true) return false;
  if (job.status !== "applied" || job.call_state || !e164(job.phone)) return false;
  if (!goodHour(now, zone)) return false;
  const aimed = targeted(job.title, rule.target_role);
  if (rule.calls_targets_only === true) return aimed;
  return aimed || Number(job.score ?? 0) >= Number(rule.calls_min_score ?? 7);
}

/**
 * A day and a time as people say them on the phone: "Thursday at 2 pm",
 * "tomorrow at ten thirty a.m." is beyond it, "tomorrow at 10:30 am" is not.
 * The next such day still to come, in the owner's zone. A written date is
 * read as mail is. Null unless there is both a day and a clock time.
 */
export function spokenTime(text: string | null | undefined, zone: string, now: Date): Date | null {
  const t = String(text ?? "").replace(/\s+/g, " ");
  const written = statedTime(t, zone, now);
  if (written) return written;
  const m = t.match(/\b(today|tomorrow|(?:this |next )?(sun|mon|tues|wednes|thurs|fri|satur)day)\b[^.?!]{0,40}?\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/i);
  if (!m) return null;
  const parts: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", year: "numeric", month: "numeric", day: "numeric" }).formatToParts(now)) parts[p.type] = p.value;
  const today = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts["weekday"] ?? "");
  const word = m[1]!.toLowerCase();
  let ahead = 0;
  if (word === "tomorrow") ahead = 1;
  else if (word !== "today") {
    const want = ["sun", "mon", "tues", "wednes", "thurs", "fri", "satur"].indexOf(m[2]!.toLowerCase());
    ahead = (want - today + 7) % 7;
  }
  const clock = `${m[3]}${m[4] ? `:${m[4]}` : ""} ${m[5]}`;
  // The calendar does the carrying: noon UTC on the zone's own date, moved on.
  for (const extra of [0, 7]) {
    const day = new Date(Date.UTC(Number(parts["year"]), Number(parts["month"]) - 1, Number(parts["day"]) + ahead + extra, 12));
    const when = statedTime(`${day.getUTCMonth() + 1}/${day.getUTCDate()}/${day.getUTCFullYear()} at ${clock}`, zone, now);
    if (when) return when;
    if (word === "today" || word === "tomorrow") break;
  }
  return null;
}

export type CallResult = { finished: boolean; state: "spoke" | "message" | "no_answer" | null; text: string; when: Date | null };

/**
 * A call as the voice service reports it, read back: whether it is over, how
 * it went, every line of it, and a day and time if one was agreed.
 */
export function readCall(raw: unknown, zone: string, now: Date): CallResult {
  const c = (raw ?? {}) as { status?: unknown; transcript?: unknown; analysis?: { transcript_summary?: unknown } | null };
  const status = String(c.status ?? "").toLowerCase();
  if (status === "failed") return { finished: true, state: "no_answer", text: "The call did not connect.", when: null };
  if (status !== "done") return { finished: false, state: null, text: "", when: null };
  const lines = (Array.isArray(c.transcript) ? c.transcript : [])
    .map((l) => l as { role?: unknown; message?: unknown })
    .filter((l) => typeof l.message === "string" && l.message.trim())
    .map((l) => ({ them: String(l.role) !== "agent", said: String(l.message).replace(/\s+/g, " ").trim() }));
  const theirs = lines.filter((l) => l.them).map((l) => l.said);
  if (!theirs.length) return { finished: true, state: "no_answer", text: "Nobody spoke.", when: null };
  const heard = theirs.join(" ");
  const machine = /leave (a|your) message|after the (tone|beep)|is not available|voice ?mail|mailbox/i.test(heard) && theirs.length <= 2;
  const summary = typeof c.analysis?.transcript_summary === "string" ? c.analysis.transcript_summary.trim() : "";
  const text = [summary ? `Summary: ${summary}` : null, summary ? "" : null, ...lines.map((l) => `${l.them ? "THEM" : "ASSISTANT"}: ${l.said}`)].filter((x) => x !== null).join("\n");
  // A time counts only where they were talking about meeting.
  const when = !machine && /\b(interview|come (in|by)|stop (in|by)|meet|see you)\b/i.test(heard) ? spokenTime(heard, zone, now) : null;
  return { finished: true, state: machine ? "message" : "spoke", text: text.slice(0, 6000), when };
}
