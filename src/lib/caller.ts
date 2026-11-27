// ============================================================================
// caller.ts — an assistant that phones a place the owner applied to.
//
// It asks for the hiring manager, says why the owner fits the job, answers
// what the profile answers, offers the owner's open times, and takes down
// what was said. It says it is an AI assistant in its first sentence, every
// call: `opening()` is the only way a call starts, and a test holds it to
// that. It never claims to be the owner.
//
// This is the conversation only. It speaks through whatever voice it is
// given and hears through whatever ears; no phone service is attached, and
// nothing here can place a call.
// ============================================================================

import { pitchFor, type CallJob } from "@/lib/calls";

export type Me = { full_name?: string | null; resume_text?: string | null; earliest_start?: string | null; availability?: string | null; work_authorized?: string | null; phone?: string | null; email?: string | null };
export type Stage = "front" | "manager" | "close" | "done";
export type Line = { who: "assistant" | "them"; said: string };
export type Outcome = "spoke" | "message" | "callback" | "declined" | "no_manager" | null;
export type Call = { stage: Stage; lines: Line[]; outcome: Outcome; pitched: boolean; openTimes: string | null };

const first = (me: Me) => String(me.full_name ?? "").trim().split(/\s+/)[0] || "the applicant";

/** How every call begins. The first sentence says what is calling. */
export function opening(job: CallJob, me: Me): string {
  const full = String(me.full_name ?? "").trim() || first(me);
  const role = job.title ? `the ${job.title} position` : "an open position";
  return `Hi, this is an AI assistant calling about ${full}'s application for ${role}. Is it possible to speak to the hiring manager?`;
}

/**
 * A recorded menu, and which key gets to a person: the operator or customer
 * service where one is offered, never billing or a department. Null when
 * what was heard is not a menu, or offers no such key.
 */
export function menuKey(heard: string): string | null {
  const t = String(heard ?? "").toLowerCase().replace(/\s+/g, " ");
  const options = [...t.matchAll(/(?:press|dial|say) (\d|zero|one|two|three|four|five|six|seven|eight|nine)(?: for| to)? ([^.,;]{2,60})|(?:for|to) ([^.,;]{2,60}?),? (?:press|dial) (\d|zero|one|two|three|four|five|six|seven|eight|nine)/g)].map((m) => ({
    key: m[1] ?? m[4] ?? "",
    what: (m[2] ?? m[3] ?? "").trim(),
  }));
  if (!options.length) return null;
  const digit = (k: string) => ({ zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9" } as Record<string, string>)[k] ?? k;
  // A language menu comes first on many lines: English, then the real menu.
  const wants = [/operator|representative|speak (to|with) (a|an|someone)|front desk|store (associate|manager)|a person|team member/, /customer service|customer care|general (inquir|question)|all other|anything else/, /english/];
  for (const re of wants) {
    const hit = options.find((o) => re.test(o.what));
    if (hit) return digit(hit.key);
  }
  return null;
}

export function start(job: CallJob, me: Me, openTimes: string | null = null): Call {
  return { stage: "front", lines: [{ who: "assistant", said: opening(job, me) }], outcome: null, pitched: false, openTimes };
}

const has = (t: string, re: RegExp) => re.test(t);

/** What the assistant says next, given what it just heard. */
export function reply(call: Call, heard: string, job: CallJob, me: Me): Call {
  const t = String(heard ?? "").toLowerCase().trim();
  const name = first(me);
  const p = pitchFor(job, me);
  const next: Call = { ...call, lines: [...call.lines, { who: "them", said: heard }] };
  const say = (said: string, patch: Partial<Call> = {}): Call => ({ ...next, ...patch, lines: [...next.lines, { who: "assistant", said }] });
  // The case, said plainly and without a narrator: what the application is
  // for, whose name it is under, and the reason it fits. No "I" that would
  // claim to be the applicant, and no "he asked me to say" either.
  const full = String(me.full_name ?? "").trim();
  const proof = (p.pitch.match(/The short version of why I fit: (.+?)\. I can start soon/) ?? [])[1] ?? null;
  const pitch = () =>
    `Hi, this is a call about ${job.title ? `the ${job.title} position` : "the open position"}${job.company ? ` at ${job.company}` : ""}; the application is under the name ${full || name}. ` +
    (proof ? `After reading the job posting this looks like an excellent fit, because of experience like this: ${proof.replace(/^./, (c) => c.toLowerCase())}. ` : "After reading the job posting this looks like a strong fit for what you need. ") +
    `If you have a moment, it would be great to talk more about the position.`;

  if (call.stage === "done") return next;

  // A recorded menu: the key that reaches a person.
  const key = menuKey(heard);
  if (key) return say(`[presses ${key}]`);

  // Asked what it is, at any point: it says so again, plainly.
  if (has(t, /\b(are you (a |an )?(robot|ai|bot|machine|real|recording|human|person)|is this (a |an )?(robot|ai|bot|recording|real person)|who (is|am i) (this|speaking|talking))\b/)) {
    return say(`I'm an AI assistant calling for ${name}; I'm not ${name}. I can pass on anything you'd like, or ${name} can call you directly.`);
  }
  // Whose application it is: the name as it stands on the application.
  if (has(t, /\b(what'?s|what is|what was|can i (get|have)|give me) (the|his|her|their|your) (full )?name|who applied|whose application|name on the application|under what name|what name (is it|should i look)\b/)) {
    return say(full ? `The name on the application is ${full}.` : "The name is on the application; it can be confirmed with a call back.");
  }
  // No, or not interested.
  if (has(t, /\b(not interested|no thank|don'?t call|do not call|stop calling|remove (us|this number)|we'?re not hiring|position (is|has been) filled|no longer (open|hiring))\b/)) {
    return say("Understood. Thank you for your time, and sorry to have troubled you.", { stage: "done", outcome: "declined" });
  }
  // Apply-online-only brush-off.
  if (has(t, /\b(apply|applications?) (are |is )?(only )?(online|on the website|through the (site|website|portal))|just apply online|we don'?t take calls\b/)) {
    return say("Thank you. The online application is already in; this was to make sure it reached the right person. Have a good day.", { stage: "done", outcome: "no_manager" });
  }
  // A time is offered or agreed.
  if (has(t, /\b(come (in|by)|stop (in|by)|interview|meet|see (him|her|them))\b/) && has(t, /\b(mon|tues|wednes|thurs|fri|satur|sun)day|tomorrow|today|\d{1,2}(:\d{2})? ?(am|pm|a\.m|p\.m)|morning|afternoon\b/)) {
    return say("Thank you, that works and will be confirmed with you directly. Is this the best number to reach you on?", { stage: "close", outcome: "spoke" });
  }

  if (call.stage === "front") {
    if (has(t, /\b(speaking|this is (he|she|him|her|the manager)|i'?m the (hiring |store |general )?manager|that'?s me|you'?ve got (him|her)|how can i help)\b/)) return say(pitch(), { stage: "manager", pitched: true });
    if (has(t, /\b(hold on|one (moment|second|sec)|let me (get|grab|transfer|check)|transferring|i'?ll (get|grab|transfer)|just a (moment|minute|sec))\b/)) return say("Thank you, I'll hold.");
    if (has(t, /\b(not (in|here|available)|out (today|right now|of the office)|busy|with a customer|in a meeting|gone for the day|off today|on (break|lunch))\b/)) {
      return say(`No problem. When is a good time to reach the hiring manager? Or a message works: the application is in${full ? ` under ${full}` : ""}, and a call back would be welcome${me.phone ? ` at ${me.phone}` : ""}.`, { stage: "close", outcome: "callback" });
    }
    if (has(t, /\b(take a message|leave a message|what'?s (it|this) (about|regarding)|can i (ask|tell them) what)\b/)) {
      return say(`Of course. It's about an online application for ${job.title ? `the ${job.title} role` : "an opening"}${full ? `, under ${full}` : ""}, and a quick introduction to the hiring manager. The best number is ${me.phone ? me.phone : "the one on the application"}. Thank you.`, { stage: "close", outcome: "message" });
    }
    // Anyone who keeps talking after the opening is treated as the person to talk to.
    return say(pitch(), { stage: "manager", pitched: true });
  }

  if (call.stage === "manager") {
    if (has(t, /\b(when|how soon) (can|could|would) (he|she|they|you) start|start date|available to start\b/)) return say(`${me.earliest_start ? `Available to start ${/^(two|2) weeks?$/i.test(me.earliest_start.trim()) ? "with two weeks' notice" : me.earliest_start}` : "Available to start soon"}.`);
    if (has(t, /\b(availab|what (days|hours|shifts)|weekends?|nights?|evenings?|open availability)\b/)) return say(me.availability ? `Availability is ${me.availability}.` : "The full schedule is best confirmed directly; it is flexible.");
    if (has(t, /\b(authori[sz]ed to work|work authori[sz]ation|eligible to work|legally (work|able))\b/)) return say(/^(no|false)$/i.test(String(me.work_authorized ?? "").trim()) ? "That is best covered directly." : "Yes, authorized to work in the United States.");
    if (has(t, /\b(when|what time|what day).{0,30}\b(come in|interview|meet|free|available)\b|when (is|are) (he|she|they) free\b/)) return say(call.openTimes ? `Open times are ${call.openTimes}. Would any of those work?` : "The schedule is flexible this week; what day works best for you?");
    if (has(t, /\b(send|email|drop off|bring).{0,20}\b(resume|cv)\b|have (him|her|them) (call|come|email)\b/)) return say("That will be taken care of today. Thank you for your time.", { stage: "done", outcome: "spoke" });
    if (has(t, /\b(we'?ll (be in touch|call|review|look)|i'?ll (take a look|look (it|for it) up|pull (it|the application))|thanks for calling|okay,? thank)\b/)) return say("Thank you, that is much appreciated. Have a good day.", { stage: "done", outcome: "spoke" });
    // A question about the person that only the person should answer.
    if (has(t, /\?|\b(tell me|why|what|how|describe|experience|salary|pay|wage)\b/)) return say("That one deserves a proper answer in person, and it would be great to give it. Is there a time this week for an interview?");
    return say("Thank you. Is there a good time to come in, or someone to follow up with?", { stage: "close", outcome: "spoke" });
  }

  // close
  return say("Thank you for your time. Have a good day.", { stage: "done", outcome: next.outcome ?? "spoke" });
}

/** The call as a record: what it was for, how it ended, and every line of it. */
export function transcript(call: Call, job: CallJob): string {
  return [`${job.company ?? "An employer"} - ${job.title ?? "a job"}${job.location ? ` (${job.location})` : ""}`, `Outcome: ${call.outcome ?? "unfinished"}`, "", ...call.lines.map((l) => `${l.who === "assistant" ? "ASSISTANT" : "THEM"}: ${l.said}`)].join("\n");
}
