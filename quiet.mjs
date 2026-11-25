// What a run may say out loud.
//
// A run's log is how anyone finds out what happened in it, and it may be
// read by people other than the person the run was for. So nothing in it may
// say who that person is. The scripts are written to print shapes and counts
// — "title set, company empty" — rather than contents, and mostly they do;
// but twice a line slipped through with a job title or a file name in it,
// and a rule that depends on never making a mistake is not a rule.
//
// This is the net under that. Once the owner's details are known, every line
// on its way out is searched for them — the name, the email address, the
// phone number in whatever way it is written, the street, the employers and
// schools on the resume — and whatever is found is struck out before the
// line is written. It changes nothing about what a script does; only what it
// is able to say.

import crypto from "node:crypto";

const MARK = "[…]";

// What stands in for an employer's name: the same few letters every time for
// the same employer, so that one run can be compared with the next, and no
// way back from the letters to the name without a key that is never printed.
const SALT = String(process.env.ENGINE_API_KEY || process.env.APPLYPILOT_PASSWORD || "applypilot");
export function aliasFor(name) {
  const flat = String(name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!flat) return "employer-none";
  return `employer-${crypto.createHmac("sha256", SALT).update(flat).digest("hex").slice(0, 5)}`;
}

// Which kind of portal an address belongs to. The kind is worth knowing —
// it says which code was running — and names no one.
const FAMILIES = [
  [/(^|\.)myworkday(jobs|site)\.com$/i, "workday"],
  [/(^|\.)oraclecloud\.com$/i, "oracle"],
  [/(^|\.)(successfactors\.(com|eu)|sapsf\.(com|eu))$/i, "successfactors"],
  [/(^|\.)greenhouse\.io$/i, "greenhouse"],
  [/(^|\.)lever\.co$/i, "lever"],
  [/(^|\.)ashbyhq\.com$/i, "ashby"],
  [/(^|\.)icims\.com$/i, "icims"],
];
// Addresses that are this system's own or a tool's, and say nothing about
// where anyone is applying.
const OWN = /(^|\.)(supabase\.co|applynow\.lol|github\.com|githubusercontent\.com|googleapis\.com|google\.com|127\.0\.0\.1|localhost|ubuntu\.com|microsoft\.com|npmjs\.org|nodejs\.org)$/i;
function placeOf(host) {
  const h = String(host).toLowerCase().replace(/:\d+$/, "");
  if (OWN.test(h)) return null;
  const family = FAMILIES.find(([re]) => re.test(h))?.[1] ?? "site";
  return `[${family} ${aliasFor(h).replace("employer-", "")}]`;
}

const esc = (t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A phone number however it is punctuated: 732-555-0100, (732) 555 0100, +1 7325550100. */
function phonePattern(phone) {
  const digits = String(phone ?? "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  if (digits.length < 10) return null;
  const d = digits.slice(-10);
  return `(?:\\+?1[\\s.-]?)?\\(?${d.slice(0, 3)}\\)?[\\s.-]?${d.slice(3, 6)}[\\s.-]?${d.slice(6)}`;
}

/**
 * The things to strike out, from a profile and the resume read into roles.
 * Short and common words are left alone: striking out "Pat" would also take
 * the middle out of "dispatch", and a log full of holes says nothing.
 */
export function privateTerms(profile, structured = null) {
  const out = new Set();
  const add = (v, min = 5) => {
    const t = String(v ?? "").replace(/\s+/g, " ").trim();
    if (t.length >= min) out.add(t);
  };
  const p = profile ?? {};
  add(p.full_name, 4);
  const names = String(p.full_name ?? "").trim().split(/\s+/).filter(Boolean);
  // A surname on its own; a first name only when it is long enough not to
  // be an ordinary word.
  if (names.length > 1) add(names[names.length - 1], 4);
  if (names[0]) add(names[0], 6);
  add(p.email, 5);
  add(String(p.email ?? "").split("@")[0], 6);
  add(p.address, 6);
  add(p.address_line1, 6);
  // The town and the postcode, wherever they are kept.
  add(p.city, 4);
  add(p.home_city, 4);
  add(p.postal_code, 5);
  add(p.linkedin_url, 8);
  add(String(p.linkedin_url ?? "").replace(/\/+$/, "").split("/").pop(), 6);
  add(p.resume_file_name, 5);
  for (const e of structured?.experience ?? []) {
    add(e.company, 5);
    add(e.title, 8);
  }
  for (const e of structured?.education ?? []) add(e.school, 6);
  for (const c of structured?.certifications ?? []) add(c.name, 8);
  // The town by its own name as well as in full: a form's list of places is
  // searched by "Springfield", not "Springfield Township".
  for (const town of [p.city, p.home_city]) {
    for (const w of String(town ?? "").split(/[\s,]+/)) if (w.length >= 5 && !PLAIN_PLACE.test(w)) add(w, 5);
  }
  // The state spelled out. Its two letters are too short to strike safely.
  for (const st of [p.state, p.home_state]) {
    const full = STATES[String(st ?? "").trim().toUpperCase()] ?? (String(st ?? "").trim().length > 3 ? String(st).trim() : "");
    if (full) add(full, 4);
  }
  // A line is often cut to a width, and a term cut short is still the term.
  for (const t of [...out]) for (const n of [34, 30, 28, 26, 24, 22, 20, 18, 16, 14]) if (t.length > n) add(t.slice(0, n).trim(), 12);
  return [...out].sort((a, b) => b.length - a.length);
}

const PLAIN_PLACE = /^(township|borough|village|north|south|east|west|upper|lower|mount|saint|point|beach|park|city|town|lake|heights|falls|springs|county|new|fort|port)$/i;
const STATES = { AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming" };
// Words too ordinary to stand for an employer on their own.
const PLAIN_FIRM = /^(the|american|america|national|international|united|first|general|global|group|health|healthcare|bank|financial|services|service|company|corporation|systems|solutions|technologies|technology|digital|capital|partners|associates|medical|center|university|college|school|state|county|city|north|south|east|west|central|pacific|atlantic|advanced|applied|modern|premier|standard|universal|community|consumer|energy|foods|home|life|management|marketing|network|office|people|public|retail|supply|trust|world)$/i;

/** One line, with whatever is the owner's struck out of it. */
export function scrub(line, terms, phone = null) {
  let s = String(line);
  for (const t of terms) s = s.replace(new RegExp(esc(t).replace(/\\? /g, "\\s+"), "gi"), MARK);
  if (phone) s = s.replace(new RegExp(phone, "g"), MARK);
  return s;
}

/**
 * Where a run went, reduced to the kind of place. An address names the
 * employer in its first word and the posting in its path, so the whole of it
 * is replaced: "https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Edison/
 * Store-Manager_R1" becomes "[workday 3f9a1]". The system's own addresses are
 * left as they are.
 */
export function scrubPlaces(line) {
  let s = String(line);
  s = s.replace(/https?:\/\/([A-Za-z0-9.-]+(?::\d+)?)([^\s"'<>)\]]*)/g, (whole, host) => placeOf(host) ?? whole);
  // A bare portal host with no scheme in front of it.
  s = s.replace(/\b([a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:myworkdayjobs\.com|myworkdaysite\.com|oraclecloud\.com|successfactors\.(?:com|eu)|greenhouse\.io|lever\.co|ashbyhq\.com|icims\.com))\b(?:\/[^\s"'<>)\]]*)?/gi, (whole, host) => placeOf(host) ?? whole);
  // Any other host written without its scheme ("the wall at careers.acme.com/apply").
  s = s.replace(/(^|[\s"'(=:])((?:[a-z0-9-]+\.)+(?:com|org|net|io|co|us|eu|jobs|careers|ai|app|edu|gov)(?::\d+)?)(\/[^\s"'<>)\]]*)?(?=$|[\s"'<>),;:\]])/gi, (whole, lead, host) => {
    const to = placeOf(host);
    return to ? `${lead}${to}` : whole;
  });
  return s;
}

// Employers and postings met during a run. An employer becomes its alias; a
// posting's title becomes "a posting". Kept apart from the owner's own
// details because they are learned one job at a time.
const SWAPS = new Map();
// First words of employers, for when a quoted question is cut off partway
// through one: "have you ever worked for acm".
const TAILS = new Map();
const cuts = (t, sizes) => [t, ...sizes.filter((n) => n < t.length && n >= 8).map((n) => t.slice(0, n).trim())];
export function hideJob(job) {
  const company = String(job?.company ?? "").replace(/\s+/g, " ").trim();
  const title = String(job?.title ?? "").replace(/\s+/g, " ").trim();
  // Lines are often cut to a width, so the cut forms are known too.
  if (title.length >= 6) for (const t of cuts(title, [70, 60, 52, 44, 40, 34, 30, 28, 24, 20])) SWAPS.set(t, "[a posting]");
  if (company.length >= 3) for (const c of cuts(company, [40, 30, 28, 26, 24, 22, 20, 18])) SWAPS.set(c, aliasFor(company));
  // The name people actually use is its first word — a form asks "have you
  // ever worked for Acme", not "for Acme Holdings, Inc." — and its questions
  // are printed cut short, so the start of that word counts too.
  const first = company.split(/[\s,.&/-]+/).find((w) => w.length >= 5 && !PLAIN_FIRM.test(w));
  if (first) {
    SWAPS.set(first, aliasFor(company));
    TAILS.set(first.toLowerCase(), aliasFor(company));
  }
}
/** A list of employers, by name, to be printed only as their aliases. */
export function hideNames(names) {
  for (const n of names ?? []) hideJob({ company: n });
}

/**
 * What a record looks like without what it says: each field's name, and for
 * its value only the kind and the size. Enough to see that a reader found the
 * right fields; nothing of what was in them.
 */
export function shape(row) {
  const out = {};
  for (const [k, v] of Object.entries(row ?? {})) {
    out[k] = v == null ? "empty" : Array.isArray(v) ? `list of ${v.length}` : typeof v === "string" ? `text of ${v.length}` : typeof v;
  }
  return out;
}

function swap(line) {
  let s = String(line);
  // The start of an employer's name where a quoted text was cut: three or
  // more of its letters, a space before, the closing quote straight after.
  if (TAILS.size) {
    s = s.replace(/(\s)([A-Za-z]{3,})(\s?")/g, (whole, lead, word, close) => {
      const w = word.toLowerCase();
      for (const [name, to] of TAILS) if (name.length > w.length && name.startsWith(w)) return `${lead}${to}${close}`;
      return whole;
    });
  }
  for (const [from, to] of [...SWAPS.entries()].sort((a, b) => b[0].length - a[0].length)) {
    // A short name only as a whole word: "Coty" is not the middle of another.
    const body = esc(from).replace(/\\? /g, "\\s+");
    s = s.replace(new RegExp(from.length < 8 ? `(^|[^A-Za-z0-9])${body}(?![A-Za-z0-9])` : body, "gi"), (m, lead) => (from.length < 8 ? `${lead ?? ""}${to}` : to));
  }
  return s;
}

let ACTIVE = false;
/**
 * From here on, everything this process prints goes through the net. Safe to
 * call twice; the second call adds to what is struck out.
 */
const TERMS = new Set();
let PHONE = null;
export function guardLogs(profile, structured = null) {
  for (const t of privateTerms(profile, structured)) TERMS.add(t);
  PHONE = phonePattern(profile?.phone) ?? PHONE;
  if (ACTIVE) return;
  ACTIVE = true;
  const text = (a) => (typeof a === "string" ? a : a instanceof Error ? String(a.stack ?? a.message) : (() => { try { return JSON.stringify(a); } catch { return String(a); } })());
  for (const kind of ["log", "info", "warn", "error"]) {
    const plain = console[kind].bind(console);
    console[kind] = (...args) => {
      const terms = [...TERMS].sort((a, b) => b.length - a.length);
      plain(...args.map((a) => scrubPlaces(swap(scrub(text(a), terms, PHONE)))));
    };
  }
}
