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
  const role = job.title ? `the ${job.title} opening` : "an opening you have";
  return `Hi, this is an AI assistant calling on behalf of ${first(me)}, who applied online for ${role}. Is the hiring manager available for a minute?`;
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
  // The case is the owner's own, in the first person, carried as a message:
  // said to be from them, and said to be passed on.
  const own = p.pitch
    .replace(/^Hi, this is [^.]+\. /, "")
    .replace(/^I applied for [^.]*? and wanted to put a voice to the application\. /, "")
    .replace(/^The short version of why I fit: /, "")
    .replace(/\bI can start soon and I'd welcome\b/, "I can start soon and I'd really welcome")
    .trim();
  const pitch = () =>
    `Thank you for taking the call. ${name} applied for ${job.title ? `the ${job.title} role` : "the role"}${job.location ? ` at your ${String(job.location).split(",")[0]} location` : ""} ` +
    `and asked me to pass this on in ${name}'s own words: "${own.replace(/^./, (c) => c.toUpperCase())}" ` +
    `Would there be a good time for ${name} to come in and talk?`;

  if (call.stage === "done") return next;

  // Asked what it is, at any point: it says so again, plainly.
  if (has(t, /\b(are you (a |an )?(robot|ai|bot|machine|real|recording|human|person)|is this (a |an )?(robot|ai|bot|recording|real person)|who (is|am i) (this|speaking|talking))\b/)) {
    return say(`I'm an AI assistant calling for ${name}; I'm not ${name}. I can pass on anything you'd like, or ${name} can call you directly.`);
  }
  // Whose application it is: the name as it stands on the application.
  if (has(t, /\b(what'?s|what is|what was|can i (get|have)|give me) (the|his|her|their|your) (full )?name|who applied|whose application|name on the application|under what name|what name (is it|should i look)\b/)) {
    const full = String(me.full_name ?? "").trim();
    return say(full ? `The name on the application is ${full}.` : `I'll have ${name} confirm the name on the application with you directly.`);
  }
  // No, or not interested.
  if (has(t, /\b(not interested|no thank|don'?t call|do not call|stop calling|remove (us|this number)|we'?re not hiring|position (is|has been) filled|no longer (open|hiring))\b/)) {
    return say("Understood. Thank you for your time, and sorry to have troubled you.", { stage: "done", outcome: "declined" });
  }
  // Apply-online-only brush-off.
  if (has(t, /\b(apply|applications?) (are |is )?(only )?(online|on the website|through the (site|website|portal))|just apply online|we don'?t take calls\b/)) {
    return say(`Thank you. ${name} has applied online already and wanted to make sure it reached the right person. I'll let ${name} know. Have a good day.`, { stage: "done", outcome: "no_manager" });
  }
  // A time is offered or agreed.
  if (has(t, /\b(come (in|by)|stop (in|by)|interview|meet|see (him|her|them))\b/) && has(t, /\b(mon|tues|wednes|thurs|fri|satur|sun)day|tomorrow|today|\d{1,2}(:\d{2})? ?(am|pm|a\.m|p\.m)|morning|afternoon\b/)) {
    return say(`Thank you. I'll pass that to ${name} right away, and ${name} will confirm with you directly. Is this the best number to reach you on?`, { stage: "close", outcome: "spoke" });
  }

  if (call.stage === "front") {
    if (has(t, /\b(speaking|this is (he|she|him|her|the manager)|i'?m the (hiring |store |general )?manager|that'?s me|you'?ve got (him|her)|how can i help)\b/)) return say(pitch(), { stage: "manager", pitched: true });
    if (has(t, /\b(hold on|one (moment|second|sec)|let me (get|grab|transfer|check)|transferring|i'?ll (get|grab|transfer)|just a (moment|minute|sec))\b/)) return say("Thank you, I'll hold.");
    if (has(t, /\b(not (in|here|available)|out (today|right now|of the office)|busy|with a customer|in a meeting|gone for the day|off today|on (break|lunch))\b/)) {
      return say(`No problem. When is a good time to reach the hiring manager? Or I can leave a message that ${name} applied and would welcome a call${me.phone ? ` at ${me.phone}` : ""}.`, { stage: "close", outcome: "callback" });
    }
    if (has(t, /\b(take a message|leave a message|what'?s (it|this) (about|regarding)|can i (ask|tell them) what)\b/)) {
      return say(`Of course. ${name} applied online for ${job.title ? `the ${job.title} role` : "an opening"} and wanted to introduce themselves to the hiring manager. ${name} can be reached${me.phone ? ` at ${me.phone}` : " at the number on the application"}. Thank you.`, { stage: "close", outcome: "message" });
    }
    // Anyone who keeps talking after the opening is treated as the person to talk to.
    return say(pitch(), { stage: "manager", pitched: true });
  }

  if (call.stage === "manager") {
    if (has(t, /\b(when|how soon) (can|could|would) (he|she|they|you) start|start date|available to start\b/)) return say(`${name} ${me.earliest_start ? `can start ${/^(two|2) weeks?$/i.test(me.earliest_start.trim()) ? "with two weeks' notice" : me.earliest_start}` : "can start soon"}.`);
    if (has(t, /\b(availab|what (days|hours|shifts)|weekends?|nights?|evenings?|open availability)\b/)) return say(me.availability ? `${name}'s availability: ${me.availability}.` : `I don't have ${name}'s full schedule in front of me; ${name} will confirm that with you directly.`);
    if (has(t, /\b(authori[sz]ed to work|work authori[sz]ation|eligible to work|legally (work|able))\b/)) return say(/^(no|false)$/i.test(String(me.work_authorized ?? "").trim()) ? `${name} will speak to that directly.` : `Yes, ${name} is authorized to work in the United States.`);
    if (has(t, /\b(when|what time|what day).{0,30}\b(come in|interview|meet|free|available)\b|when (is|are) (he|she|they) free\b/)) return say(call.openTimes ? `${name} is free ${call.openTimes}. Would any of those work?` : `${name}'s schedule is flexible this week; what day works best for you?`);
    if (has(t, /\b(send|email|drop off|bring).{0,20}\b(resume|cv)\b|have (him|her|them) (call|come|email)\b/)) return say(`I'll pass that on to ${name} today. Thank you for your time.`, { stage: "done", outcome: "spoke" });
    if (has(t, /\b(we'?ll (be in touch|call|review|look)|i'?ll (take a look|look (it|for it) up|pull (it|the application))|thanks for calling|okay,? thank)\b/)) return say(`Thank you, ${name} appreciates it. Have a good day.`, { stage: "done", outcome: "spoke" });
    // A question about the person that only the person should answer.
    if (has(t, /\?|\b(tell me|why|what|how|describe|experience|salary|pay|wage)\b/)) return say(`That's one ${name} should answer in person, and I don't want to speak for ${name} on it. Could ${name} call you back or come in to talk?`);
    return say(`Thank you. Is there a good time for ${name} to come in, or someone ${name} should follow up with?`, { stage: "close", outcome: "spoke" });
  }

  // close
  return say(`Thank you, I'll let ${name} know. Have a good day.`, { stage: "done", outcome: next.outcome ?? "spoke" });
}

/** The call as a record: what it was for, how it ended, and every line of it. */
export function transcript(call: Call, job: CallJob): string {
  return [`${job.company ?? "An employer"} - ${job.title ?? "a job"}${job.location ? ` (${job.location})` : ""}`, `Outcome: ${call.outcome ?? "unfinished"}`, "", ...call.lines.map((l) => `${l.who === "assistant" ? "ASSISTANT" : "THEM"}: ${l.said}`)].join("\n");
}
