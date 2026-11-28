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
import fs from "node:fs";

const MARK = "[…]";

// What stands in for an employer's name: the same few letters every time for
// the same employer, so that one run can be compared with the next, and no
// way back from the letters to the name without a key that is never printed.
//
// The key is the engine's own, where the run has it. Where it has only the
// panel's password, the key is that password put through a slow function
// first: an alias in a public log would otherwise be a way to test guesses
// at the password, thousands a second. And with neither, the key is made up
// on the spot — aliases then hold for one run only, and nobody can undo them.
const SALT = process.env.ENGINE_API_KEY
  ? String(process.env.ENGINE_API_KEY)
  : process.env.APPLYPILOT_PASSWORD
    ? crypto.scryptSync(String(process.env.APPLYPILOT_PASSWORD), "applypilot: names in a public log", 32, { N: 16384, r: 8, p: 1 }).toString("hex")
    : crypto.randomBytes(24).toString("hex");
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
export const STATES = { AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming" };
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
const SHORT = new Map();
const cuts = (t, sizes) => [t, ...sizes.filter((n) => n < t.length && n >= 8).map((n) => t.slice(0, n).trim())];
export function hideJob(job) {
  const company = String(job?.company ?? "").replace(/\s+/g, " ").trim();
  const title = String(job?.title ?? "").replace(/\s+/g, " ").trim();
  // Lines are often cut to a width, so the cut forms are known too.
  if (title.length >= 6) for (const t of cuts(title, [70, 60, 52, 44, 40, 34, 30, 28, 24, 20])) SWAPS.set(t, "[a posting]");
  if (company.length >= 3) for (const c of cuts(company, [40, 30, 28, 26, 24, 22, 20, 18])) SWAPS.set(c, aliasFor(company));
  // A name of two capitals or digits is too short to look for in any case,
  // but exactly as written, standing alone, it is still the employer.
  else if (/^[A-Z0-9]{2}$/.test(company)) SHORT.set(company, aliasFor(company));
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
    const body = esc(from).replace(/\\? /g, "\\s+").replace(/['’]/g, "['’]");
    s = s.replace(new RegExp(from.length < 8 ? `(^|[^A-Za-z0-9])${body}(?![A-Za-z0-9])` : body, "gi"), (m, lead) => (from.length < 8 ? `${lead ?? ""}${to}` : to));
  }
  // Whose other companies a question names is the employer's business.
  s = s.replace(/(employer-[0-9a-f]{5}) or any of [^"|;\]]*/g, "$1 or any of [its companies]");
  // Which state the owner searches in is the owner's.
  s = s.replace(/\boutside [A-Z]{2}\b/g, "outside the state").replace(/\b[A-Z]{2} is far beyond \d+ mi\b/g, "another state, far beyond the radius");
  // A town with its state is a place, whoever wrote it.
  s = s.replace(/\b[A-Z][a-z]+(?:[ -][A-Z][a-z]+){0,2}, (?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b/g, "[a place]");
  for (const [from, to] of SHORT) s = s.replace(new RegExp(`(^|[^A-Za-z0-9])${esc(from)}(?![A-Za-z0-9])`, "g"), (m, lead) => `${lead ?? ""}${to}`);
  return s;
}
/** A line as it would be printed, for the checks. */
export const asPrinted = (line) => swap(line);

// ---------------------------------------------------------------------------
// The second net: what may be printed at all.
//
// Everything above strikes out what is known to be somebody's. It cannot
// strike out what it was never told: an employer in an email's subject, a
// town in a reason somebody stored, a code a portal sent. Four times a line
// like that reached a public log. So this works the other way round. A word
// is printed only if this program's own source already uses it — its
// messages, its field names, the names of the portals it knows — and the
// source is public, so nothing is told by printing it. Any other word came
// from outside: a form, a posting, a mailbox, a person. It is struck out,
// whatever it is, without anybody having to have thought of it first.
//
// Numbers are counts and pass, except where their shape says what they are:
// a phone number, a code that was sent, a postcode, a place on the map.
// Anything shaped like a key, a token or a password is struck out wherever
// it is, and so is any value a script has handed to secret().

const HERE = new URL(".", import.meta.url);
// Files whose words are places, or people and employers made up for the
// checks: real code, but not a vocabulary anything should be printed from.
const PLACES = new Set(["geo.mjs", "near.mjs"]);
const CHECKS = new Set(["unit.mjs", "selftest.mjs", "extension-test.mjs"]);
// The checks themselves work on made-up people only, and say what failed in
// their own words. When the script that was started is one of the checks,
// its own words are printed whole. Nothing else can ask for that.
const FOR_CHECKS = () => CHECKS.has(String(process.argv[1] ?? "").split(/[\\/]/).pop());

/** A source file without its comments: what the program says, not what is said about it. */
export function withoutComments(src) {
  const out = [];
  let inBlock = false;
  for (let line of String(src).split("\n")) {
    if (inBlock) {
      const end = line.indexOf("*/");
      if (end < 0) continue;
      line = line.slice(end + 2);
      inBlock = false;
    }
    line = line.replace(/\/\*.*?\*\//g, " ");
    const open = line.indexOf("/*");
    if (open >= 0 && !/["'`]/.test(line.slice(0, open))) { line = line.slice(0, open); inBlock = true; }
    if (/^\s*(\/\/|\*)/.test(line)) continue;
    // A comment after code: two slashes with a space before them. An
    // address has a colon there instead.
    line = line.replace(/\s\/\/\s.*$/, "");
    out.push(line);
  }
  return out.join("\n");
}

/**
 * The words of a text, as two sets: those written small somewhere (or as the
 * inner part of a joinedName), and those only ever written in CAPITALS. A
 * word met only with a capital first letter — a name — is in neither.
 */
export function wordsOf(text, into = { lower: new Set(), upper: new Set() }) {
  for (const m of String(text).matchAll(/[A-Za-z]+/g)) {
    const run = m[0];
    if (run.length > 1 && run === run.toUpperCase()) { into.upper.add(run); continue; }
    // helpReason -> help, Reason; XMLHttp -> XML, Http.
    const parts = run.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+/g) ?? [];
    parts.forEach((w, k) => {
      if (w.length < 2) return;
      if (w === w.toLowerCase()) into.lower.add(w);
      else if (w === w.toUpperCase()) into.upper.add(w);
      // A capital inside a joined name is the program's own; one standing
      // at the front of a word may be anybody's name.
      else if (k > 0) into.lower.add(w.toLowerCase());
    });
  }
  return into;
}

// Never part of the vocabulary, whatever the source says: the two letters
// of a state, and a state's or the country's own name.
const STATE_CODES = "AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC";
// Two letters that are also words a log writes in capitals: these are left
// alone unless they stand where a state stands, or are the person's own.
const ALSO_WORDS = new Set(["ID", "OK", "OR", "IN", "ME", "HI"]);
const STATE_SET = new Set(STATE_CODES.split("|"));

const VOCABULARY = new Map();
/**
 * The words this program's own source uses. Read once, when first needed.
 * `forChecks` adds the checks' own words, and is true only when a check is
 * the script that was started.
 */
export function vocabulary(forChecks = FOR_CHECKS()) {
  if (VOCABULARY.has(forChecks)) return VOCABULARY.get(forChecks);
  const v = { lower: new Set(), upper: new Set() };
  try {
    for (const name of fs.readdirSync(HERE)) {
      if (!name.endsWith(".mjs") || PLACES.has(name) || (CHECKS.has(name) && !forChecks)) continue;
      wordsOf(withoutComments(fs.readFileSync(new URL(name, HERE), "utf8")), v);
    }
  } catch { /* with nothing read, nothing but numbers is printed: safe, and plainly broken */ }
  for (const code of STATE_CODES.split("|")) v.upper.delete(code);
  for (const name of Object.values(STATES)) for (const w of name.toLowerCase().split(" ")) if (!PLAIN_PLACE.test(w) && w !== "of") v.lower.delete(w);
  VOCABULARY.set(forChecks, v);
  return v;
}

// Values never to be printed, handed over by the script that holds them: a
// code read from a mailbox, a password made for a portal, a key from the
// database. And the run's own secrets, which the runner strikes out only
// when they are printed exactly as given.
const SECRETS = new Set();
export function secret(...values) {
  for (const v of values) {
    const t = String(v ?? "").trim();
    if (t.length < 4) continue;
    SECRETS.add(t);
    try { SECRETS.add(encodeURIComponent(t)); SECRETS.add(Buffer.from(t).toString("base64")); } catch { /* as given is enough */ }
  }
}
/**
 * Rows read from where credentials are kept: every value under a name that
 * says it is one — a password, a token, a key — is handed to secret().
 */
export function secretsIn(rows) {
  const walk = (v, depth) => {
    if (!v || typeof v !== "object" || depth > 4) return;
    for (const [k, x] of Object.entries(v)) {
      if (typeof x === "string" && /pass|secret|token|key|cookie|session|credential/i.test(k)) secret(x);
      else walk(x, depth + 1);
    }
  };
  walk(Array.isArray(rows) ? rows : [rows], 0);
  return rows;
}
for (const [k, v] of Object.entries(process.env)) {
  if (/(KEY|TOKEN|SECRET|PASSWORD|PASSWD|COOKIE|SESSION|CREDENTIAL)/i.test(k) && String(v ?? "").length >= 8 && !/^(GITHUB_|ACTIONS_|RUNNER_|npm_)/.test(k) && k !== "SUPABASE_ANON_KEY") secret(v);
}
const OWN_ADDRESSES = new Set();
if (process.env.APPLYPILOT_EMAIL) OWN_ADDRESSES.add(String(process.env.APPLYPILOT_EMAIL).toLowerCase());

const SHAPED = [
  // Keys and tokens, by the way their makers write them.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, "[token]"],
  [/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{8,}/gi, "[token]"],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, "[key]"],
  [/\b(?:sk|pk|rk|gsk|xox[abprs]|ya29|sbp|sb_secret|gh[pousr]|github_pat|glpat)[-_][A-Za-z0-9_-]{16,}/g, "[key]"],
  // "password: hunter2", "token=abc", "cookie: a=b; c=d" — the name stays, what it holds goes.
  [/\b((?:pass(?:word|wd|code|phrase)?|pwd|secret|token|api[_-]?key|apikey|authorization|cookie|session(?:[_-]?id)?|credential)s?)(["']?\s*[:=]\s*["']?)(?!\[)[^\s"',;}{]{4,}/gi, "$1$2[secret]"],
  // A code that was sent: digits, or letters and digits, close after the word for one.
  [/\b(code|otp|passcode|pin|one[- ]time[^.\n]{0,12}?|verification[^.\n]{0,12}?)((?:\s+(?:is|was|of|sent|read|entered|typed))?["':=\s]{1,4})(?=[A-Z0-9-]*\d)([A-Z0-9]{4,10}|\d{3}[- ]\d{3})\b/gi, "$1$2[code]"],
  // Addresses for mail.
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, "[address]"],
  // A row's own id: thirty-six characters that name one person or one job.
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[id]"],
  // Anything long and unreadable is a key until shown otherwise.
  [/\b[0-9a-f]{32,}\b/gi, "[key]"],
  [/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{40,}\b/g, "[key]"],
  // A person's numbers.
  [/(?<![\d.])\d{3}-\d{2}-\d{4}(?![\d.])/g, "[number]"],
  [/(?<![\d.-])(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]\d{4}(?![\d-])/g, "[phone]"],
  [/(?<![\d.-])\+?1?\d{10}(?![\d.-])/g, "[phone]"],
  // A place on the map, and a postcode: one that starts with a nought is
  // never a count, and one after a state or a place is where somebody is.
  [/-?\d{1,3}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}/g, "[a point on the map]"],
  [/(?<![\d.,-])0\d{4}(?:-\d{4})?(?![\d.,-])/g, "[postcode]"],
  [new RegExp(`(\\[a place\\]|\\[state\\]|\\b(?:${STATE_CODES})\\b)([ ,]{1,2})\\d{5}(?:-\\d{4})?(?!\\d)`, "g"), "$1$2[postcode]"],
];

const STATE_NAMES = new RegExp(`\\b(?:${Object.values(STATES).sort((a, b) => b.length - a.length).map((n) => n.replace(/ /g, "\\s+")).join("|")})\\b`, "gi");
const STATE_ALONE = new RegExp(`(^|[^A-Za-z0-9])(${STATE_CODES})(?![A-Za-z0-9])`, "g");
let OWN_STATE = null;

/** Keys, codes, addresses and numbers, by their shape and by having been named. */
export function scrubShaped(line) {
  let s = String(line);
  for (const v of [...SECRETS].sort((a, b) => b.length - a.length)) if (s.includes(v)) s = s.split(v).join("[secret]");
  for (const [re, to] of SHAPED) s = s.replace(re, to);
  // A state by name, and by its two letters where they stand as one.
  s = s.replace(STATE_NAMES, "[state]");
  s = s.replace(STATE_ALONE, (whole, lead, code) => (ALSO_WORDS.has(code) && code !== OWN_STATE ? whole : `${lead}[state]`));
  return s;
}

// What the nets above have already put in place of something: left as it is.
const PLACED = /\[(?:workday|oracle|successfactors|greenhouse|lever|ashby|icims|site) [0-9a-f]{5}\]|employer-(?:[0-9a-f]{5}|none)|\[[a-z …]{1,24}\]/g;

/** Every word this program does not itself use, struck out. */
export function ownWordsOnly(line, forChecks = FOR_CHECKS()) {
  const { lower, upper } = vocabulary(forChecks);
  const text = String(line);
  let out = "";
  let at = 0;
  const pass = (piece) => piece.replace(/[A-Za-z0-9]*[A-Za-z][A-Za-z0-9]*/g, (run) => {
    // Short and made of 0-9a-f with a digit in it: a count in sixteens, an alias.
    if (/\d/.test(run) && /^[0-9a-f]+$/i.test(run) && run.length <= 16) return run;
    return run.replace(/[A-Za-z]+/g, (letters) => {
      if (letters.length === 1) return letters;
      // Two capitals that are a state are a state, whatever they are joined to ("mi" is miles; "MI" is not).
      const known = (w) => (w.length === 2 && w === w.toUpperCase() && STATE_SET.has(w) && !ALSO_WORDS.has(w) ? false : w === w.toUpperCase() ? upper.has(w) || lower.has(w.toLowerCase()) : lower.has(w.toLowerCase()));
      if (letters === letters.toUpperCase()) return known(letters) ? letters : MARK;
      const parts = letters.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+/g) ?? [letters];
      return parts.map((w) => (w.length === 1 || known(w) ? w : MARK)).join("");
    });
  });
  for (const m of text.matchAll(PLACED)) {
    out += pass(text.slice(at, m.index)) + m[0];
    at = m.index + m[0].length;
  }
  out += pass(text.slice(at));
  // A run of struck-out words is one thing struck out.
  return out.replace(/\[…\](?:[\s,.'’&/-]{0,3}\[…\])+/g, MARK);
}

// Outside a public runner the last net can be lifted, to read a fixture's
// own words while working on it. On a runner nothing lifts it.
const ON_A_RUNNER = process.env.GITHUB_ACTIONS === "true";
const OWN_WORDS = ON_A_RUNNER || process.env.QUIET_WORDS !== "off";

/** A line as it may be printed where anybody can read it. */
export function asPublic(line, forChecks = FOR_CHECKS()) {
  const terms = [...TERMS].sort((a, b) => b.length - a.length);
  let s = scrubPlaces(swap(scrub(String(line), terms, PHONE)));
  for (const a of OWN_ADDRESSES) if (s.toLowerCase().includes(a)) s = s.replace(new RegExp(esc(a), "gi"), "[address]");
  s = scrubShaped(s);
  return OWN_WORDS ? ownWordsOnly(s, forChecks) : s;
}

let ACTIVE = false;
const TERMS = new Set();
let PHONE = null;

/**
 * Puts the nets under everything this process writes: what console prints,
 * what is written to the two streams directly, and what an error nobody
 * caught would have printed on its way out. Done once.
 */
export function install() {
  if (ACTIVE) return;
  ACTIVE = true;
  const text = (a) => (typeof a === "string" ? a : a instanceof Error ? String(a.stack ?? a.message) : (() => { try { return JSON.stringify(a); } catch { return String(a); } })());
  for (const kind of ["log", "info", "warn", "error", "debug"]) {
    const plain = console[kind].bind(console);
    // One piece of text per thing printed, as before; the stream below makes it safe.
    console[kind] = (...args) => plain(...args.map(text));
  }
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream);
    stream.write = (chunk, encoding, done) => {
      if (typeof encoding === "function") { done = encoding; encoding = undefined; }
      let out;
      try {
        const raw = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        out = raw.split("\n").map((l) => (l ? asPublic(l) : l)).join("\n");
      } catch {
        // Nothing unsafe is printed because making it safe failed.
        out = "[a line that could not be made safe to print]\n";
      }
      return write(out, done);
    };
  }
  // An error nobody caught is printed by the runtime itself, past every
  // net. Caught here, it is printed through them, and the run still fails.
  const fatal = (e) => {
    try { console.error(`stopped by an error nobody caught: ${e instanceof Error ? String(e.stack ?? e.message) : String(e)}`.slice(0, 1500)); } catch { /* the exit code says it */ }
    process.exit(1);
  };
  process.on("uncaughtException", fatal);
  process.on("unhandledRejection", fatal);
}

/**
 * From here on, everything this process prints goes through the nets, with
 * this person's own details among what is struck out. Safe to call twice;
 * the second call adds to what is struck out.
 */
export function guardLogs(profile, structured = null) {
  learn(profile, structured);
  install();
}

/** A person's details, added to what is struck out. Changes nothing about where printing goes. */
export function learn(profile, structured = null) {
  for (const t of privateTerms(profile, structured)) TERMS.add(t);
  PHONE = phonePattern(profile?.phone) ?? PHONE;
  const st = String(profile?.state ?? profile?.home_state ?? "").trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(st)) OWN_STATE = st;
  if (profile?.email) OWN_ADDRESSES.add(String(profile.email).toLowerCase());
}

// On a public runner the nets are under every script that so much as
// imports this file, from its first line, whether or not it ever learns
// whose round it is.
if (ON_A_RUNNER || process.env.QUIET === "on") install();

// Run as a program, this is a filter: what a workflow is about to print
// that no script wrote — the panel's answer to a request, say — is passed
// in on one side and comes out the other through the same nets.
if (String(process.argv[1] ?? "").split(/[\\/]/).pop() === "quiet.mjs") {
  let all = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) all += chunk;
  const out = all.split("\n").map((l) => (l ? asPublic(l) : l)).join("\n");
  // The stream has the nets under it already on a runner; twice is the same as once.
  process.stdout.write(out.endsWith("\n") || !out ? out : `${out}\n`);
}
