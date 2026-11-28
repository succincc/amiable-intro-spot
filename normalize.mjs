/**
 * One answer under its several spellings.
 *
 * A profile says "US"; a form offers "United States". A profile says "NJ";
 * a list says "New Jersey". A person holds a "Bachelor's"; the list says
 * "BA/BS". Each of these stopped a real application with every other field
 * filled, and each was first patched where it was met — a state here, a
 * degree there — so the same answer was understood on one portal and not on
 * the next. This is the one place that says when two spellings are one
 * answer, used by every list, tick-box and pick-one, whatever the portal.
 *
 * It only ever says "these two are the same thing". It never supplies an
 * answer, and it never treats a near-miss as a match: "Male" is not
 * "Female", "CA" alone is California or Canada and matches either only
 * when the other side settles which.
 */

const flat = (t) => String(t ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[.'’]/g, "").replace(/[^a-z0-9+]+/g, " ").trim();

const STATES = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware",
  DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon",
  PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah",
  VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", PR: "Puerto Rico",
};

// Canonical name first; then every other way a form or a profile writes it.
const COUNTRIES = [
  ["united states", "us", "usa", "u s", "u s a", "united states of america", "america", "the united states", "united states (us)", "us only"],
  ["united kingdom", "uk", "gb", "great britain", "britain", "england", "united kingdom of great britain and northern ireland"],
  ["canada", "ca", "can"], ["mexico", "mx", "mex"], ["india", "in", "ind"], ["germany", "de", "deu", "deutschland"],
  ["france", "fr", "fra"], ["spain", "es", "esp"], ["italy", "it", "ita"], ["ireland", "ie", "irl"], ["netherlands", "nl", "nld", "the netherlands", "holland"],
  ["australia", "au", "aus"], ["new zealand", "nz", "nzl"], ["brazil", "br", "bra"], ["japan", "jp", "jpn"], ["china", "cn", "chn"],
  ["singapore", "sg", "sgp"], ["philippines", "ph", "phl", "the philippines"], ["poland", "pl", "pol"], ["israel", "il", "isr"],
  ["sweden", "se", "swe"], ["switzerland", "ch", "che"], ["portugal", "pt", "prt"], ["colombia", "co", "col"], ["argentina", "ar", "arg"],
];

const DEGREES = [
  ["high school", "high school diploma", "high school or equivalent", "high school diploma or equivalent", "ged", "hs diploma", "secondary school", "high school graduate", "high school diploma ged"],
  ["associate", "associates", "associate degree", "associates degree", "aa", "as", "aas", "aa as", "2 year degree", "two year degree"],
  ["bachelor", "bachelors", "bachelor degree", "bachelors degree", "ba", "bs", "bsc", "bba", "ba bs", "bs ba", "ba bs bsn", "undergraduate degree", "4 year degree", "four year degree", "college degree", "bachelor of science", "bachelor of arts"],
  ["master", "masters", "master degree", "masters degree", "ma", "ms", "msc", "mba", "ma ms", "ma ms mba", "graduate degree", "master of science", "master of arts", "master of business administration"],
  ["doctorate", "doctoral", "doctoral degree", "doctorate degree", "phd", "ph d", "doctor of philosophy"],
];

const YES = ["yes", "y", "true", "yes i do", "yes i am", "yes i have", "yes i can", "yes i will", "i do", "i am", "i have", "affirmative", "correct"];
const NO = ["no", "n", "false", "no i do not", "no i am not", "no i have not", "no i cannot", "no i will not", "i do not", "i am not", "i have not", "negative"];

const table = new Map(); // flat spelling -> Set of "class:id"
const put = (spelling, id) => { const k = flat(spelling); if (!k) return; if (!table.has(k)) table.set(k, new Set()); table.get(k).add(id); };
for (const [code, name] of Object.entries(STATES)) { put(code, `state:${code}`); put(name, `state:${code}`); put(`${name} (${code})`, `state:${code}`); put(`${code} - ${name}`, `state:${code}`); }
for (const [name, ...rest] of COUNTRIES) for (const s of [name, ...rest]) put(s, `country:${name}`);
for (const [name, ...rest] of DEGREES) for (const s of [name, ...rest]) put(s, `degree:${name}`);
for (const s of YES) put(s, "yesno:yes");
for (const s of NO) put(s, "yesno:no");
// "no" is never Norway and "in"/"or"/"me"/"as"/"ma"/"ms" are words before they
// are places or degrees: a two-letter spelling counts only where the other
// side is unambiguous (see sameAnswer).

/** Every reading a spelling has: "CA" is California and Canada. Empty when it is none of these. */
export function readings(text) {
  return [...(table.get(flat(text)) ?? [])];
}

/**
 * Whether two spellings are one answer. `about` is the question, where
 * known: it settles a spelling that has two readings ("CA" under "Country"
 * is Canada; under "State" it is California).
 */
export function sameAnswer(a, b, about = "") {
  const fa = flat(a), fb = flat(b);
  if (!fa || !fb) return false;
  if (fa === fb) return true;
  let ra = readings(a), rb = readings(b);
  if (!ra.length || !rb.length) return false;
  const q = flat(about);
  const want = /\bcountr/.test(q) ? "country:" : /\b(state|province|region)\b/.test(q) ? "state:" : /\b(degree|education|diploma)\b/.test(q) ? "degree:" : null;
  if (want) { ra = ra.filter((r) => r.startsWith(want)); rb = rb.filter((r) => r.startsWith(want)); }
  return ra.some((r) => rb.includes(r));
}

/**
 * Which of a list's options is this answer, by meaning: its index, or -1.
 * Exactly one option must mean it; two that do ("Bachelor's (in progress)"
 * and "Bachelor's (completed)" both reduce to nothing here, so neither is
 * taken) leave the choice where it was.
 */
export function optionMeaning(options, answer, about = "") {
  const hits = [];
  (options ?? []).forEach((o, i) => { if (sameAnswer(o, answer, about)) hits.push(i); });
  return hits.length === 1 ? hits[0] : -1;
}

/**
 * A place against a list of areas: "Princeton, NJ" over "New York / New
 * Jersey Metro", "Bay Area", "Other". The option that names the town; else
 * the only option that names the state, by its name or its letters as a
 * word of their own; else the list's own "other", where it has one; else
 * nothing. Never the nearest-sounding one.
 */
export function placeOption(options, place) {
  const [townRaw, stateRaw] = String(place ?? "").split(",").map((s) => s.trim());
  const town = flat(townRaw);
  const code = Object.keys(STATES).find((c) => c === String(stateRaw ?? "").toUpperCase() || flat(STATES[c]) === flat(stateRaw));
  const texts = (options ?? []).map((o) => String(o ?? ""));
  if (town.length > 2) {
    const i = texts.findIndex((t) => new RegExp(`(^| )${town}( |$)`).test(flat(t)));
    if (i >= 0) return i;
  }
  if (code) {
    const name = flat(STATES[code]);
    const hits = texts.map((t, i) => (new RegExp(`(^| )${name}( |$)`).test(flat(t)) || new RegExp(`(^|[^A-Za-z])${code}([^A-Za-z]|$)`).test(t) ? i : -1)).filter((i) => i >= 0);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return -1;
  }
  const other = texts.map((t, i) => (/^(other|not listed|none of (the above|these)|elsewhere|outside (of )?these)\b/i.test(t.trim()) ? i : -1)).filter((i) => i >= 0);
  return other.length === 1 ? other[0] : -1;
}

/** A date, in the forms a form may want it: what was meant is one day. */
export function dateForms(value) {
  const d = value instanceof Date ? value : new Date(String(value ?? ""));
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1, day = d.getUTCDate();
  const p = (n) => String(n).padStart(2, "0");
  const month = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][m - 1];
  return { iso: `${y}-${p(m)}-${p(day)}`, us: `${p(m)}/${p(day)}/${y}`, eu: `${p(day)}/${p(m)}/${y}`, monthYear: `${p(m)}/${y}`, long: `${month} ${day}, ${y}`, monthName: `${month} ${y}`, year: String(y) };
}
