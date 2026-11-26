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
  | { kind: "assessment"; link: string | null; due: string | null; type?: AssessmentType; ai?: { stance: "permitted" | "prohibited" | "not stated"; quote: string | null }; provider?: { name: string; what: string; ready: string[] } | null; questions?: string[] }
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

/**
 * What an assessment's invitation says about using AI tools, in its own
 * words. Only what is stated counts: "permitted" and "prohibited" each need
 * the invitation to say so, and silence is "not stated" — which is treated
 * as the owner's own work to do.
 */
export function aiPolicy(text: string | null | undefined): { stance: "permitted" | "prohibited" | "not stated"; quote: string | null } {
  const sentences = String(text ?? "").replace(/\s+/g, " ").split(/(?<=[.!?])\s+/);
  const about = /\b(a\.?i\.?|artificial intelligence|chatgpt|gpt|copilot|claude|gemini|llm|generative|large language model)\b/i;
  const no = /\b(not (?:be )?(?:permitted|allowed|use|used|to use|rely)|do not use|don'?t use|may not|must not|cannot|can'?t|prohibit(?:ed|s)?|forbidden|without (?:the )?(?:use|help|aid|assistance) of|unassisted|your own work|disqualif|refrain from|no (?:use of|ai|outside))\b/i;
  const yes = /\b(may use|can use|are (?:welcome|free|allowed|permitted|encouraged) to use|is (?:allowed|permitted|encouraged|welcome)|feel free to use|encourage (?:you|the use)|permitted to use|allowed to use)\b/i;
  for (const sentence of sentences) {
    if (!about.test(sentence)) continue;
    if (no.test(sentence)) return { stance: "prohibited", quote: sentence.trim().slice(0, 240) };
  }
  for (const sentence of sentences) {
    if (about.test(sentence) && yes.test(sentence)) return { stance: "permitted", quote: sentence.trim().slice(0, 240) };
  }
  return { stance: "not stated", quote: null };
}

/** What kind of assessment a known provider gives, and how to get ready for it. */
const PROVIDERS: Array<{ re: RegExp; name: string; what: string; ready: string[] }> = [
  { re: /hirevue/i, name: "HireVue", what: "recorded video answers, sometimes with short games; usually 20 to 30 minutes, each answer timed with one or two retakes",
    ready: ["A quiet room, the camera at eye level, light on your face.", "Three stories ready from your own roles: a problem you solved, a time you dealt with a difficult person, something you improved. Say what you did and what came of it.", "Use the practice question first; it is not recorded."] },
  { re: /criteria|ccat|ondemandassessment/i, name: "Criteria (CCAT)", what: "50 questions in 15 minutes: arithmetic, word and pattern problems. Nobody finishes; it is scored on how many are right",
    ready: ["No calculator is allowed; have paper and a pen.", "Skip what stalls you: a guess costs nothing, time does.", "Criteria publishes sample questions; ten minutes with them shows the pace."] },
  { re: /wonderlic/i, name: "Wonderlic", what: "50 questions in 12 minutes (or 30 in 8 online): quick reasoning with words and numbers",
    ready: ["About fourteen seconds a question: answer, or guess and move on.", "Paper and a pen; no calculator."] },
  { re: /predictive ?index|\bpi (?:behavioral|cognitive)|predictiveindex/i, name: "Predictive Index", what: "a behavioural checklist of adjectives (untimed, about six minutes) and often a 12-minute, 50-question reasoning test",
    ready: ["The checklist has no right answers; answer as you are at work, and consistently.", "For the timed part, pace over perfection."] },
  { re: /\bshl\b|talentcentral/i, name: "SHL", what: "timed numerical, verbal or inductive reasoning sets, sometimes a personality questionnaire",
    ready: ["A calculator and paper are usually allowed for the numerical set; the instructions say.", "SHL has free practice tests under 'practice' on its site."] },
  { re: /pymetrics|harver|plum\.io|arctic ?shores/i, name: "a games-based assessment", what: "short on-screen games measuring attention, memory and risk, about 25 minutes; no knowledge is tested",
    ready: ["A laptop with a mouse, not a phone.", "Rested and uninterrupted matters more than practice."] },
  { re: /hackerrank|codility|codesignal|coderpad/i, name: "a coding assessment", what: "timed programming problems in a browser editor",
    ready: ["Read the rules on outside help before starting; they differ by employer.", "The practice environment is worth five minutes to learn the editor."] },
  { re: /testgorilla|eskill|indeed\.com\/(?:assessments|test)|assessments?\.indeed/i, name: "a skills test", what: "multiple-choice questions on the skills the posting names, usually 10 to 20 minutes a section, timed",
    ready: ["The posting's own requirements are the syllabus: read it once more first.", "Once started the clock does not stop; start when you have the full time free."] },
  { re: /hogan|caliper|korn ?ferry|16pf|disc\b|gallup/i, name: "a personality questionnaire", what: "untimed statements to agree or disagree with; 20 to 40 minutes",
    ready: ["Answer as you are at work, steadily; these check for consistency.", "No preparation changes the result much; a clear half hour does."] },
];

export function assessmentKind(text: string | null | undefined): { name: string; what: string; ready: string[] } | null {
  const t = String(text ?? "");
  const hit = PROVIDERS.find((p) => p.re.test(t));
  return hit ? { name: hit.name, what: hit.what, ready: hit.ready } : null;
}

export type AssessmentType = "recorded_interview" | "skills_exam" | "personality" | "written_questions" | "screening_questionnaire" | "unknown";

/**
 * Which of several different things an employer is asking for. They are not
 * one thing: a form of facts and eligibility is answered from the profile
 * like any application form, and written questions from the resume; a test
 * of skill, a questionnaire about temperament and a recorded interview are
 * measures of the person, and are the person's to sit.
 */
export function assessmentType(text: string | null | undefined, body?: string | null): AssessmentType {
  const t = String(text ?? "").toLowerCase();
  if (/hirevue|spark ?hire|willo\b|vidcruiter|one[- ]way (?:video )?interview|recorded (?:video )?(?:interview|responses?|answers?)|video interview|on[- ]demand interview|record your (?:answers|responses)/.test(t)) return "recorded_interview";
  if (/coding (?:challenge|test|assessment)|skills? (?:test|exam)|typing test|excel test|hackerrank|codility|codesignal|testgorilla|eskill|aptitude|cognitive|ccat\b|wonderlic|reasoning (?:test|assessment)|timed (?:test|assessment)|proctored/.test(t)) return "skills_exam";
  if (/personality|behaviou?ral (?:assessment|profile|survey)|predictive index|hogan|caliper|\bdisc (?:assessment|profile)|culture index|pymetrics|plum\.io|work ?style|strengths? (?:assessment|finder)/.test(t)) return "personality";
  if (writtenQuestions(body ?? text).length && /\b(reply|respond|answer|send (?:us )?your (?:answers|responses))\b/.test(t)) return "written_questions";
  if (/questionnaire|pre-?screen|screening questions?|supplemental questions?|additional (?:information|questions|details)|a few (?:more |quick |additional )?questions|eligibility|availability form|complete (?:the|this|your|a) (?:form|survey|application)|background (?:check )?(?:form|authorization)|finish (?:your|the) application/.test(t)) return "screening_questionnaire";
  if (/skills? assessment|online assessment|assessment/.test(t)) return "skills_exam";
  return "unknown";
}

/** Questions an invitation puts in so many words, for answering in writing. */
export function writtenQuestions(text: string | null | undefined): string[] {
  const out: string[] = [];
  for (const raw of String(text ?? "").split(/\n+|(?<=[?])\s+/)) {
    const line = raw.replace(/^[\s\-*•\d.)]+/, "").replace(/\s+/g, " ").trim();
    if (line.length < 25 || line.length > 300 || !line.endsWith("?")) continue;
    if (/\b(questions\?|any questions|need (?:help|assistance)|unsubscribe|trouble|having issues|did you know)\b/i.test(line)) continue;
    if (!/\b(why|how|what|describe|tell us|explain|which|when have|give an example)\b/i.test(line)) continue;
    if (!out.includes(line)) out.push(line);
    if (out.length >= 5) break;
  }
  return out;
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
    return { kind: "assessment", link: firstLink(text, /assess|test|survey|hirevue|challenge|interview|questionnaire|candidate/i), due: deadlineIn(text), type: assessmentType(text, m.body), ai: aiPolicy(text), provider: assessmentKind(text), questions: writtenQuestions(m.body) };
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
  /** Answers drafted for written questions: never where the invitation rules AI out. */
  drafts?: Array<{ question: string; answer: string }> | null;
  /** True when a questionnaire has been handed to the applier to fill. */
  queued?: boolean;
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
    const type = m.type ?? "unknown";
    const stance = m.ai?.stance ?? "not stated";
    const name = { recorded_interview: "a recorded interview", skills_exam: "a skills test", personality: "a personality questionnaire", written_questions: "written questions", screening_questionnaire: "a questionnaire", unknown: "an assessment" }[type];
    const mine = type === "screening_questionnaire" && a.queued;
    say(`${who} sent ${name}${a.job?.title ? ` for ${a.job.title}` : ""}.`);
    say();
    if (m.link) say(`Open:  ${m.link}`);
    if (m.due) say(`Due:   ${m.due}`);
    if (mine) {
      say();
      say("BEING DONE FOR YOU: it is a form of facts about you, like the application itself. It is being filled from your profile and saved answers and sent. Anything it asks that nothing on file answers will be on the Answers page; you need do nothing unless that happens.");
    } else if (type === "screening_questionnaire") {
      say();
      say("It is a form of facts about you. It carries no link that can be opened for you, so it is yours to fill; your saved answers are on the Answers page.");
    }
    if (m.provider && !mine) {
      say();
      say(`WHAT IT IS: ${m.provider.name} - ${m.provider.what}.`);
      say();
      say("TO BE READY");
      for (const r of m.provider.ready) say(`  - ${r}`);
    }
    if (!mine) {
      say();
      if (stance === "prohibited") say(`AI TOOLS: the invitation rules them out - "${m.ai?.quote}" Nothing is drafted for this one.`);
      else if (stance === "permitted") say(`AI TOOLS: the invitation allows them - "${m.ai?.quote}"`);
      else if (type === "written_questions") say("AI TOOLS: the invitation does not say. These are written application questions, answered the way the application's own were: from your resume.");
      else say("AI TOOLS: the invitation does not say. Treated as your own work: nothing is drafted or taken for you.");
      if (a.drafts?.length && (stance === "permitted" || (type === "written_questions" && stance !== "prohibited"))) {
        say();
        say("DRAFTS, written from your resume alone. They are yours to check, change and send; nothing has been submitted.");
        for (const d of a.drafts) {
          say();
          say(`Q: ${d.question}`);
          say(d.answer);
        }
      }
      if (type === "recorded_interview" || type === "skills_exam" || type === "personality" || type === "unknown") {
        say();
        say("It measures you, so it is yours to take. What is done for you is this page: what it is, when it is due, and how to be ready.");
      }
    }
    mail();
    const lead = mine ? "a questionnaire is being filled for you" : type === "written_questions" ? "written questions to answer" : type === "screening_questionnaire" ? "a questionnaire to fill" : `${name} to take`;
    return { subject: `ApplyPilot: ${lead}${m.due ? `, due ${m.due}` : ""} - ${role}`.slice(0, 150), body: L.join("\n"), event: null };
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
