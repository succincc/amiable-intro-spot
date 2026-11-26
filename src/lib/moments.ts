// ============================================================================
// moments.ts — the few things in a job search that the owner has to know
// about, read out of the mail.
//
// Hundreds of emails arrive and nearly all of them need nothing: receipts,
// status notices, rejections. Four kinds do:
//
//   an interview with a time on it   → it goes on the calendar, with a brief
//   a link to pick an interview time → one tap, and only the owner can tap it
//   an assessment                    → the owner's to take, usually by a date
//   an offer                         → the owner's to answer
//
// Everything here is a pure function over text, so each has a test and none
// needs a mailbox. What is sent, and when, is moments.server.ts.
// ============================================================================

import { cleanHolds, type Hold, type Kind } from "@/lib/availability";

export type Moment =
  | { kind: "interview_time"; when: Date; link: string | null; where: string | null }
  | { kind: "pick_a_time"; link: string }
  | { kind: "assessment"; link: string | null; due: string | null }
  | { kind: "offer"; pay: string | null; start: string | null; replyBy: string | null }
  | { kind: "rejection" };

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const MONTH_RE = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";

/** The instant a zone's clock reads the given date and time. */
function instantIn(zone: string, y: number, mo: number, d: number, h: number, mi: number): Date {
  const want = Date.UTC(y, mo - 1, d, h, mi);
  let t = want;
  for (let i = 0; i < 3; i++) {
    const p: Record<string, string> = {};
    for (const part of new Intl.DateTimeFormat("en-US", {
      timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(new Date(t))) p[part.type] = part.value;
    t += want - Date.UTC(Number(p["year"]), Number(p["month"]) - 1, Number(p["day"]), Number(p["hour"]) % 24, Number(p["minute"]));
  }
  return new Date(t);
}

/**
 * A date and a time of day stated together in the text — "Tuesday, December
 * 1 at 10:00 AM", "12/1/2026 at 2pm", "Dec 1, 2026 10:30 AM EST" — as an
 * instant in the owner's zone. Null unless both a day and a clock time are
 * there: "next week" and "tomorrow afternoon" are not appointments.
 * Only a time still to come counts.
 */
export function statedTime(text: string | null | undefined, zone: string, now: Date): Date | null {
  const t = String(text ?? "").replace(/\s+/g, " ");
  const clock = "(\\d{1,2})(?::(\\d{2}))?\\s*(a\\.?m\\.?|p\\.?m\\.?)";
  const tries: Array<[RegExp, (m: RegExpMatchArray) => [number, number, number | null, RegExpMatchArray]]> = [
    // December 1[, 2026] at 10:00 AM
    [new RegExp(`\\b(${MONTH_RE})\\.? (\\d{1,2})(?:st|nd|rd|th)?(?:,? (\\d{4}))?[, ]*(?:at|@|-|–|from)? ?${clock}`, "i"),
      (m) => [MONTHS[m[1]!.toLowerCase().replace(/\.$/, "")]!, Number(m[2]), m[3] ? Number(m[3]) : null, m.slice(4) as unknown as RegExpMatchArray]],
    // 1 December [2026] at 10:00 AM
    [new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)? (${MONTH_RE})\\.?(?:,? (\\d{4}))?[, ]*(?:at|@|-|–|from)? ?${clock}`, "i"),
      (m) => [MONTHS[m[2]!.toLowerCase().replace(/\.$/, "")]!, Number(m[1]), m[3] ? Number(m[3]) : null, m.slice(4) as unknown as RegExpMatchArray]],
    // 12/1[/2026] at 10:00 AM
    [new RegExp(`\\b(\\d{1,2})/(\\d{1,2})(?:/(\\d{2,4}))?[, ]*(?:at|@|-|–|from)? ?${clock}`, "i"),
      (m) => [Number(m[1]), Number(m[2]), m[3] ? (Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3])) : null, m.slice(4) as unknown as RegExpMatchArray]],
  ];
  for (const [re, read] of tries) {
    const m = t.match(re);
    if (!m) continue;
    const [mo, d, yRaw, c] = read(m);
    if (!mo || d < 1 || d > 31) continue;
    let h = Number(c[0]) % 12;
    if (/^p/i.test(String(c[2] ?? ""))) h += 12;
    const mi = c[1] ? Number(c[1]) : 0;
    if (Number(c[0]) < 1 || Number(c[0]) > 12 || mi > 59) continue;
    const thisYear = Number(new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric" }).format(now));
    let when = instantIn(zone, yRaw ?? thisYear, mo, d, h, mi);
    // No year given and the day has gone by: it means next year's.
    if (yRaw === null && when.getTime() < now.getTime() - 86_400_000) when = instantIn(zone, thisYear + 1, mo, d, h, mi);
    if (when.getTime() <= now.getTime()) continue;
    // Nothing is booked a year out; a date that far off was read wrong.
    if (when.getTime() - now.getTime() > 200 * 86_400_000) continue;
    return when;
  }
  return null;
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
const BOOKING_HOSTS =
  /(^|\.)(calendly\.com|cal\.com|savvycal\.com|youcanbook\.me|goodtime\.io|modernloop\.io|chilipiper\.com|hubspot\.com|zcal\.co|tidycal\.com|acuityscheduling\.com|oncehub\.com|scheduleonce\.com|paradox\.ai|calendar\.app\.google|bookings\.cloud\.microsoft)$/i;

/** A link that opens somebody's booking page, if the text holds one. */
export function bookingLink(text: string | null | undefined): string | null {
  for (const raw of String(text ?? "").match(URL_RE) ?? []) {
    const url = raw.replace(/[.,;]+$/, "");
    try {
      const u = new URL(url);
      if (BOOKING_HOSTS.test(u.hostname)) {
        if (/hubspot\.com$/i.test(u.hostname) && !/meetings/i.test(u.hostname + u.pathname)) continue;
        return url;
      }
      if (/outlook\.office(365)?\.com$/i.test(u.hostname) && /\/book(ings)?(with)?\//i.test(u.pathname)) return url;
      if (/\b(schedul|book|interview-?slot|self-?schedule)/i.test(u.pathname) && /(greenhouse\.io|lever\.co|ashbyhq\.com|myworkday(jobs)?\.com|icims\.com|smartrecruiters\.com|hirevue\.com)$/i.test(u.hostname)) return url;
    } catch {
      /* not an address */
    }
  }
  return null;
}

/** A link to a call — Zoom, Teams, Meet — if the text holds one. */
export function meetingLink(text: string | null | undefined): string | null {
  for (const raw of String(text ?? "").match(URL_RE) ?? []) {
    const url = raw.replace(/[.,;]+$/, "");
    if (/(zoom\.us\/j\/|teams\.microsoft\.com\/l\/meetup-join|teams\.live\.com\/meet|meet\.google\.com\/[a-z]|webex\.com\/(meet|join)|whereby\.com\/)/i.test(url)) return url;
  }
  return null;
}

/** A street address stated in the text, for an interview in person. */
export function streetAddress(text: string | null | undefined): string | null {
  const m = String(text ?? "").replace(/\s+/g, " ").match(/\b\d{1,6} [A-Z][A-Za-z0-9.' -]{2,40} (?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Highway|Hwy|Route|Rt|Parkway|Pkwy|Plaza|Court|Ct|Place|Pl|Turnpike|Tpke)\b\.?(?:,? (?:Suite|Ste|Floor|Fl|Unit|#) ?[A-Za-z0-9-]+)?(?:,? [A-Z][A-Za-z .'-]{2,30},? [A-Z]{2}(?: \d{5})?)?/);
  return m ? m[0].trim() : null;
}

/** The first other link in the text that is not an unsubscribe or a tracker's own page. */
function firstLink(text: string, want: RegExp): string | null {
  for (const raw of text.match(URL_RE) ?? []) {
    const url = raw.replace(/[.,;]+$/, "");
    if (/unsubscribe|preferences|privacy|\.(png|jpg|gif)(\?|$)/i.test(url)) continue;
    if (want.test(url)) return url;
  }
  return null;
}

/** "by December 3", "within 5 days", "expires in 72 hours" — as the email words it. */
export function deadlineIn(text: string | null | undefined): string | null {
  const t = String(text ?? "").replace(/\s+/g, " ");
  const m =
    t.match(new RegExp(`\\b(?:by|before|no later than|until|due(?: on)?|expires?(?: on)?|deadline(?: is| of)?:?) ((?:(?:mon|tues|wednes|thurs|fri|satur|sun)day,? )?(?:${MONTH_RE})\\.? \\d{1,2}(?:st|nd|rd|th)?(?:,? \\d{4})?|\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?)`, "i")) ??
    t.match(/\b(within (?:the next )?\d{1,3} (?:hours?|days?|business days?|weeks?))\b/i) ??
    t.match(/\b(?:expires?|valid|available) (?:in|for) (\d{1,3} (?:hours?|days?))\b/i);
  return m ? m[1]!.trim() : null;
}

/** What an offer says about itself: pay, start, and the day an answer is wanted by. */
export function offerFacts(text: string | null | undefined): { pay: string | null; start: string | null; replyBy: string | null } {
  const t = String(text ?? "").replace(/\s+/g, " ");
  const pay =
    t.match(/\$ ?\d{1,3}(?:,\d{3})+(?:\.\d{2})?(?: ?(?:per|a|\/) ?(?:year|yr|annum|hour|hr))?|\$ ?\d{2,3}(?:\.\d{2})? ?(?:per|an|a|\/) ?(?:hour|hr)|\$ ?\d{2,3}k\b(?: ?(?:per|a|\/) ?(?:year|yr))?/i)?.[0] ?? null;
  const start =
    t.match(new RegExp(`\\b(?:start(?:ing)? date|start(?:ing)? on|begin(?:ning)? on|first day)(?: (?:is|will be|of))?:? ((?:(?:mon|tues|wednes|thurs|fri|satur|sun)day,? )?(?:${MONTH_RE})\\.? \\d{1,2}(?:st|nd|rd|th)?(?:,? \\d{4})?|\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?)`, "i"))?.[1] ?? null;
  return { pay, start, replyBy: deadlineIn(t) };
}

/**
 * The moment an email is, if it is one. `category` is what the classifier
 * already decided; this only reads the details out and never upgrades a
 * receipt into something it is not.
 */
export function momentOf(
  m: { category: string | null | undefined; subject?: string | null | undefined; body?: string | null | undefined },
  zone: string,
  now: Date,
): Moment | null {
  const text = `${m.subject ?? ""}\n${m.body ?? ""}`;
  if (m.category === "rejection") return { kind: "rejection" };
  if (m.category === "offer") return { kind: "offer", ...offerFacts(text) };
  if (m.category === "interview") {
    const when = statedTime(text, zone, now);
    // A time is an appointment only when the email is settling one, not
    // listing choices: "confirmed", "scheduled", "invitation", "see you".
    const settled =
      /\b(confirm(?:ed|ing|ation)|(?:is|are|been|was) (?:now )?scheduled|has been (?:booked|set|arranged)|is (?:set|booked) for|see you (?:on|at|then)|looking forward to (?:speaking|meeting|talking|seeing))\b/i.test(text) ||
      /^\s*(?:updated )?invitation:/i.test(String(m.subject ?? ""));
    // A single time put as a question is still a question.
    const asking = /\b(are you (?:available|free)|would .{0,40} work\b|does .{0,40} work\b|do(?:es)? (?:either|any) of|let (?:me|us) know (?:if|what|which|whether)|can you (?:do|make)|could you (?:do|make)|what (?:times?|days?)|please confirm (?:if|whether|that you|your availability))/i.test(text);
    if (when && settled && !asking) return { kind: "interview_time", when, link: meetingLink(text), where: streetAddress(text) };
    const link = bookingLink(text);
    if (link) return { kind: "pick_a_time", link };
    return null;
  }
  if (m.category === "action_needed" && /\b(assessment|skills? test|questionnaire|coding (?:challenge|test)|online test|video interview|hirevue|one-way interview|complete (?:the|your|a) (?:assessment|test|survey))\b/i.test(text)) {
    return { kind: "assessment", link: firstLink(text, /assess|test|survey|hirevue|challenge|interview|questionnaire|candidate/i), due: deadlineIn(text) };
  }
  return null;
}

const icsStamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const icsText = (s: string) => String(s).replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/([,;])/g, "\\$1");

/** A calendar file for one appointment: tapping it adds the interview to any calendar. */
export function icsFor(e: { uid: string; start: Date; end: Date; title: string; where?: string | null; notes?: string | null; now?: Date }): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//ApplyPilot//Interview//EN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${e.uid}`,
    `DTSTAMP:${icsStamp(e.now ?? new Date())}`,
    `DTSTART:${icsStamp(e.start)}`,
    `DTEND:${icsStamp(e.end)}`,
    `SUMMARY:${icsText(e.title)}`,
    ...(e.where ? [`LOCATION:${icsText(e.where)}`] : []),
    ...(e.notes ? [`DESCRIPTION:${icsText(e.notes.slice(0, 1800))}`] : []),
    "BEGIN:VALARM",
    "TRIGGER:-PT60M",
    "ACTION:DISPLAY",
    "DESCRIPTION:Interview in one hour",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

/**
 * What the posting asks for, set beside what the resume shows: the lines of
 * the posting that read as requirements, each marked with whether the
 * resume has its words. Nothing is added to either; it is a reading aid.
 */
export function requirementsMet(description: string | null | undefined, resume: string | null | undefined, max = 6): Array<{ line: string; shown: boolean }> {
  const have = new Set(String(resume ?? "").toLowerCase().match(/[a-z][a-z+#.]{3,}/g) ?? []);
  const STOP = new Set(["with", "that", "this", "have", "will", "your", "must", "able", "and", "the", "for", "from", "years", "year", "experience", "ability", "strong", "excellent", "skills", "work", "working", "including", "required", "preferred", "knowledge", "related", "other", "such", "their", "they", "into", "more", "plus", "minimum", "least"]);
  const out: Array<{ line: string; shown: boolean }> = [];
  for (const raw of String(description ?? "").split(/\n|•|·|;(?= )/)) {
    const line = raw.replace(/^[\s\-*–—]+/, "").replace(/^\d{1,2}[.)]\s+/, "").replace(/\s+/g, " ").trim();
    if (line.length < 25 || line.length > 200) continue;
    if (!/\b(experience|years?|ability|able to|knowledge|proficien|degree|diploma|licen[cs]e|certif|skills?|must|required|responsible|manage|lead|familiar)\b/i.test(line)) continue;
    const words = (line.toLowerCase().match(/[a-z][a-z+#.]{3,}/g) ?? []).filter((w) => !STOP.has(w));
    if (words.length < 2) continue;
    const hit = words.filter((w) => have.has(w)).length;
    out.push({ line, shown: hit / words.length >= 0.34 });
    if (out.length >= max) break;
  }
  return out;
}

/** What is wrong with the system, in plain words; empty when nothing is. */
export function healthProblems(s: {
  now: Date;
  autopilot: boolean;
  agentLastSeen: string | null;
  mailLastRun: string | null;
  mailError: string | null;
  gmailConnected: boolean;
  gmailError: string | null;
  sent72h: number;
  ready: number;
}): string[] {
  const hours = (iso: string | null) => (iso ? (s.now.getTime() - new Date(iso).getTime()) / 3_600_000 : Infinity);
  const out: string[] = [];
  if (!s.gmailConnected) out.push("Gmail is not connected, so emailed codes, links and replies cannot be read. Reconnect it in Settings → Email.");
  else if (s.gmailError) out.push(`Gmail access is failing (${s.gmailError.slice(0, 120)}). Reconnect it in Settings → Email.`);
  else if (hours(s.mailLastRun) > 6) out.push(`The inbox has not been read for ${Math.round(hours(s.mailLastRun))} hours.`);
  else if (s.mailError) out.push(`The last inbox read failed: ${s.mailError.slice(0, 120)}.`);
  if (s.autopilot && hours(s.agentLastSeen) > 8) {
    out.push(Number.isFinite(hours(s.agentLastSeen)) ? `No application round has run for ${Math.round(hours(s.agentLastSeen))} hours.` : "No application round has ever run.");
  }
  if (s.autopilot && s.sent72h === 0 && s.ready >= 5) out.push(`Nothing has been sent in three days, though ${s.ready} postings are ready.`);
  return out;
}

/** The holds once an interview is settled for `refs`: its other held times let go, this one booked. */
export function afterBooking(holds: unknown, refs: string[], when: Date, kind: Kind | null, now: Date, minutes = 60): { holds: Hold[]; clash: Hold | null } {
  const mine = new Set(refs.filter(Boolean));
  const start = when.getTime();
  const end = start + minutes * 60_000;
  const kept = cleanHolds(holds, now).filter((h) => !mine.has(h.ref));
  const clash = kept.find((h) => h.state === "booked" && new Date(h.start).getTime() < end && new Date(h.end).getTime() > start) ?? null;
  kept.push({ start: new Date(start).toISOString(), end: new Date(end).toISOString(), kind, ref: refs.find(Boolean) ?? "", state: "booked" });
  return { holds: kept.slice(-200), clash };
}

/** The holds once an employer has said no: nothing is kept for it. */
export function afterRejection(holds: unknown, refs: string[], now: Date): { holds: Hold[]; released: number } {
  const mine = new Set(refs.filter(Boolean));
  const all = cleanHolds(holds, now);
  const kept = all.filter((h) => !mine.has(h.ref));
  return { holds: kept, released: all.length - kept.length };
}

/** A link that opens Google Calendar with the event filled in, for one tap. */
export function googleCalendarLink(e: { start: Date; end: Date; title: string; where?: string | null; notes?: string | null }): string {
  const q = new URLSearchParams({ action: "TEMPLATE", text: e.title, dates: `${icsStamp(e.start)}/${icsStamp(e.end)}` });
  if (e.where) q.set("location", e.where);
  if (e.notes) q.set("details", e.notes.slice(0, 600));
  return `https://calendar.google.com/calendar/render?${q.toString()}`;
}

export const sayWhen = (when: Date, zone: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(when);

type NoticeJob = { title?: string | null; company?: string | null; location?: string | null; url?: string | null; apply_url?: string | null; description?: string | null; salary_text?: string | null; applied_at?: string | null } | null;

/** The employer as the owner would know it: the job's, or else the sender's domain. */
function whoFrom(job: NoticeJob, from: string | null | undefined): string {
  if (job?.company) return job.company;
  const host = String(from ?? "").split("@")[1]?.replace(/>.*$/, "").trim() ?? "";
  const name = host.split(".").slice(-2, -1)[0] ?? "";
  return name ? name[0]!.toUpperCase() + name.slice(1) : "An employer";
}

/**
 * The email the owner gets about a moment: a subject that says it all on a
 * lock screen, and a body with everything needed and nothing else.
 * `event` is set when there is something to put on a calendar.
 */
export function noticeFor(a: {
  moment: Exclude<Moment, { kind: "rejection" }>;
  job: NoticeJob;
  from?: string | null;
  subject?: string | null;
  body?: string | null;
  zone: string;
  resume?: string | null;
  kind?: Kind | null;
  clash?: Hold | null;
  openTimes?: string | null;
}): { subject: string; body: string; event: { start: Date; end: Date; title: string; where: string | null; notes: string } | null } {
  const who = whoFrom(a.job, a.from);
  const role = a.job?.title ? `${a.job.title} at ${who}` : who;
  const theirs = String(a.body ?? "").replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 1200);
  const L: string[] = [];
  const say = (s = "") => L.push(s);
  const mail = () => {
    say();
    say("THEIR EMAIL");
    if (a.from) say(`From: ${a.from}`);
    if (a.subject) say(`Subject: ${a.subject}`);
    say();
    say(theirs || "(no text)");
  };
  const m = a.moment;

  if (m.kind === "interview_time") {
    const how = a.kind === "phone" ? "Phone" : a.kind === "in_person" ? "In person" : a.kind === "virtual" || m.link ? "Video call" : null;
    const where = m.link ?? m.where ?? null;
    const end = new Date(m.when.getTime() + 60 * 60_000);
    const title = `Interview: ${role}`;
    say(`Interview booked: ${role}`);
    say();
    say(`When:   ${sayWhen(m.when, a.zone)}`);
    if (how) say(`How:    ${how}`);
    if (m.link) say(`Join:   ${m.link}`);
    if (m.where) say(`Where:  ${m.where}`);
    const notes = [a.job?.url ? `Posting: ${a.job.url}` : "", m.link ? `Join: ${m.link}` : ""].filter(Boolean).join("\n");
    say();
    say(`Add to Google Calendar: ${googleCalendarLink({ start: m.when, end, title, where, notes })}`);
    say("The attached file adds it to any other calendar.");
    if (a.clash) {
      say();
      say(`CHECK THIS: it overlaps another interview already booked for ${sayWhen(new Date(a.clash.start), a.zone)}.`);
    }
    if (a.job) {
      say();
      say("THE ROLE");
      say([a.job.title, who, a.job.location].filter(Boolean).join(" - "));
      if (a.job.salary_text) say(`Pay on the posting: ${a.job.salary_text}`);
      if (a.job.applied_at) say(`Applied: ${new Intl.DateTimeFormat("en-US", { timeZone: a.zone, month: "long", day: "numeric" }).format(new Date(a.job.applied_at))}`);
      if (a.job.url) say(`Posting: ${a.job.url}`);
      const asks = requirementsMet(a.job.description, a.resume);
      if (asks.length) {
        say();
        say("WHAT THEY ASK FOR, BESIDE YOUR RESUME");
        for (const r of asks) say(`${r.shown ? "  [on your resume]     " : "  [have an answer ready]"} ${r.line}`);
      }
    }
    mail();
    say();
    say("Any other times that were being held for this employer have been let go, and this hour is marked booked so nobody else is offered it.");
    return { subject: `ApplyPilot: interview booked, ${sayWhen(m.when, a.zone)} - ${role}`.slice(0, 150), body: L.join("\n"), event: { start: m.when, end, title, where, notes: `${notes}\n\n${theirs.slice(0, 600)}`.trim() } };
  }

  if (m.kind === "pick_a_time") {
    say(`${who} wants you to pick an interview time${a.job?.title ? ` for ${a.job.title}` : ""}.`);
    say();
    say(`Pick here: ${m.link}`);
    if (a.openTimes) {
      say();
      say(`Open on your calendar: ${a.openTimes}.`);
    }
    say();
    say("Only you can pick. Once you have, their confirmation is read and the interview goes on your calendar.");
    mail();
    return { subject: `ApplyPilot: pick an interview time - ${role}`.slice(0, 150), body: L.join("\n"), event: null };
  }

  if (m.kind === "assessment") {
    say(`${who} sent an assessment${a.job?.title ? ` for ${a.job.title}` : ""}.`);
    say();
    if (m.link) say(`Open:  ${m.link}`);
    if (m.due) say(`Due:   ${m.due}`);
    say();
    say("This one is yours to take; it is never taken for you.");
    mail();
    return { subject: `ApplyPilot: assessment to take${m.due ? `, due ${m.due}` : ""} - ${role}`.slice(0, 150), body: L.join("\n"), event: null };
  }

  say(`An offer: ${role}.`);
  say();
  if (m.pay) say(`Pay:        ${m.pay}`);
  if (m.start) say(`Start:      ${m.start}`);
  if (m.replyBy) say(`Answer by:  ${m.replyBy}`);
  if (a.job?.salary_text) say(`The posting said: ${a.job.salary_text}`);
  say();
  say("Nothing has been replied. This one is yours to answer.");
  mail();
  return { subject: `ApplyPilot: an offer${m.replyBy ? `, answer by ${m.replyBy}` : ""} - ${role}`.slice(0, 150), body: L.join("\n"), event: null };
}
