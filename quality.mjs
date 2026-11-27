/**
 * The last look at a document before it is sent.
 *
 * ats.mjs measures a resume against a posting's vocabulary and closes the
 * honest part of the gap; tailor.mjs holds what the model wrote against what
 * it was given. Neither looked at the finished text as a recruiter or a
 * parser would: whether the posting's REQUIRED qualifications are the ones
 * covered, whether the writing reads like a person's, whether every figure
 * in it is the candidate's own, and whether the PDF that is actually
 * attached can be read back out as text.
 *
 * Everything here is deterministic and runs offline. Nothing is added to a
 * document by this file: it removes, reports, or refuses.
 *
 * The numbers it gives are this system's own estimate of how a keyword
 * screener would read the document. They are not an employer's score, and
 * are never to be shown or logged as one.
 *
 * The shape of the checks follows what other open tools look at — the split
 * of a posting into required / preferred / responsibilities, and findings
 * such as first-person lines, weak or repeated openers, over-long bullets
 * and mixed date formats (VeriWorkly/ats-engine, MIT; srbhr/resume-matcher,
 * Apache-2.0; LEKKALAGANESH/ats-resume-optimizer, MIT), and the families of
 * stock phrasing that mark machine-written prose (Aboudjem/humanizer-skill,
 * MIT). The code and the word lists are written for this system; nothing is
 * copied from them, and nothing is taken from tools whose licences do not
 * allow it.
 */

import { execFileSync } from "node:child_process";
import { requirementTerms, coverage } from "./ats.mjs";

// ---------------------------------------------------------------------------
// The posting, by what each part of it asks
// ---------------------------------------------------------------------------

const HEADINGS = [
  ["required", /^(minimum |basic |required |essential |must[- ]have )?(qualifications?|requirements?|skills( and experience)?|experience)( required)?$|^what (you('|’)ll|you will|we('|’)re|you) (need|bring|looking for|have)|^who you are|^you (have|are|bring)|^must[- ]haves?|^requirements?|^minimum qualifications?|^basic qualifications?|^required (skills|experience|qualifications?)/i],
  ["preferred", /^(preferred|desired|bonus|additional|nice[- ]to[- ]have|plus)( qualifications?| skills?| experience| points)?$|^nice to haves?|^bonus points|^(it('|’)s|it is) a plus|^preferred qualifications?|^extra credit|^even better if/i],
  ["responsibilities", /^(key |core |primary |main )?(responsibilities|duties|accountabilities)|^what you('|’)ll do|^what you will do|^the role|^your (role|impact|day)|^in this role|^about the (role|job|position)/i],
  ["excluded", /^(benefits|perks|compensation|salary|pay|what we offer|why (join|work)|about (us|the company|the team)|our (mission|values|story)|equal opportunity|eeo|how to apply|additional information)/i],
];

/**
 * A posting cut into its parts by its own headings. A posting with none is
 * one "body" part, and is then treated as required throughout: there is no
 * telling a must-have from a nice-to-have that the employer did not mark.
 */
export function segmentPosting(posting) {
  const parts = { required: "", preferred: "", responsibilities: "", body: "", excluded: "" };
  let kind = "body";
  let marked = false;
  for (const raw of String(posting ?? "").replace(/\r/g, "").split("\n")) {
    const line = raw.replace(/^[\s#*•·\-–—]+|[\s*:：]+$/g, "").trim();
    // A heading is a short line on its own; a sentence that happens to
    // contain "requirements" does not re-label what follows it.
    if (line && line.length <= 60 && !/[.!?]$/.test(line)) {
      const hit = HEADINGS.find(([, re]) => re.test(line));
      if (hit) { kind = hit[0]; marked = true; continue; }
    }
    parts[kind] += raw + "\n";
  }
  return { ...parts, marked };
}

/**
 * How the document covers what the posting REQUIRES, apart from what it
 * would merely like. An estimate of this system's own, by this system's own
 * list of terms.
 */
export function requirementReport(resumeText, posting, company = "") {
  const seg = segmentPosting(posting);
  const mustText = seg.marked && seg.required.trim() ? seg.required : `${seg.required}\n${seg.responsibilities}\n${seg.body}`;
  const must = requirementTerms(mustText, 30, company);
  const nice = seg.preferred.trim() ? requirementTerms(seg.preferred, 20, company).filter((t) => !must.some((m) => keyOf(m) === keyOf(t))) : [];
  const read = (terms) => {
    if (!terms.length) return { total: 0, covered: 0, missing: [] };
    const c = coverage(resumeText, terms);
    const missing = (c.missing ?? c.gaps ?? []).map(nameOf);
    return { total: terms.length, covered: terms.length - missing.length, percent: c.percent, missing: missing.slice(0, 12) };
  };
  return { split: seg.marked && Boolean(seg.required.trim()), required: read(must), preferred: read(nice) };
}

const nameOf = (t) => (typeof t === "string" ? t : String(t?.term ?? t?.name ?? t?.label ?? ""));
const keyOf = (t) => nameOf(t).toLowerCase();

// ---------------------------------------------------------------------------
// The writing
// ---------------------------------------------------------------------------

// Stock phrasing that says nothing a recruiter can check, and that a
// machine reaches for first. Each is a whole word or phrase.
const STOCK = [
  "results-driven", "results driven", "results-oriented", "detail-oriented", "detail oriented", "self-starter", "self-motivated",
  "team player", "go-getter", "hard-working", "hardworking", "passionate", "dynamic", "synergy", "synergies", "synergistic",
  "proven track record", "track record of success", "think outside the box", "fast-paced environment", "wear many hats",
  "seamless", "seamlessly", "robust", "cutting-edge", "state-of-the-art", "best-in-class", "world-class", "game-changing",
  "delve", "delved", "tapestry", "testament to", "realm of", "landscape of", "in today's", "ever-evolving", "ever-changing",
  "it is worth noting", "it's worth noting", "furthermore", "moreover", "additionally", "in conclusion", "needless to say",
  "spearheaded", "orchestrated", "championed", "revolutionized", "supercharged", "unlock", "unleash", "elevate", "elevated",
  "leveraged", "leveraging", "leverage", "utilized", "utilizing", "utilize", "holistic", "pivotal", "paramount", "myriad", "plethora",
];
const stockRe = (w) => new RegExp(`(?<![a-z])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[- ]/g, "[- ]")}(?![a-z])`, "gi");

const WEAK_OPENERS = /^(responsible for|duties included?|tasked with|helped( to)?|assisted (with|in)|worked (on|with)|involved in|participated in|in charge of)\b/i;
const FIRST_PERSON = /(^|[\s(])(i|i'm|i've|my|me|we|our)(?=[\s,.)])/i;

const bulletsOf = (text) =>
  String(text ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[•\-–*·]/.test(l) || (l.length > 40 && /^[A-Z]/.test(l) && !/[:|]/.test(l.slice(0, 30))))
    .map((l) => l.replace(/^[•\-–*·]\s*/, ""));

/**
 * What a careful reader would mark on the page. Each finding is a kind, a
 * count and a short example; none of them changes the text.
 */
export function writingFindings(text) {
  const out = [];
  const body = String(text ?? "");
  const bullets = bulletsOf(body);
  const add = (kind, hits) => { if (hits.length) out.push({ kind, count: hits.length, example: String(hits[0]).slice(0, 70) }); };

  const stock = [];
  for (const w of STOCK) for (const m of body.matchAll(stockRe(w))) stock.push(m[0]);
  add("stock phrasing", stock);
  add("weak opener", bullets.filter((b) => WEAK_OPENERS.test(b)));
  add("first person", bullets.filter((b) => FIRST_PERSON.test(b)));
  add("over-long bullet", bullets.filter((b) => b.split(/\s+/).length > 38));

  // The same first word carrying a third of the bullets, or more.
  const first = {};
  for (const b of bullets) { const w = b.split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, ""); if (w && w.length > 2) first[w] = (first[w] ?? 0) + 1; }
  const repeated = Object.entries(first).filter(([, n]) => n >= 4 && n / Math.max(bullets.length, 1) >= 0.3).map(([w, n]) => `${w} x${n}`);
  add("repeated opener", repeated);

  const seen = new Map();
  const twice = [];
  for (const b of bullets) { const k = b.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); if (k.length > 20) { if (seen.has(k)) twice.push(b); seen.set(k, true); } }
  add("said twice", twice);

  // Dates written two ways in one document: "03/2021" beside "Mar 2021".
  const numeric = (body.match(/(?<!\d)\d{1,2}[/.]\d{4}(?!\d)/g) ?? []).length;
  const named = (body.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? \d{4}\b/g) ?? []).length;
  if (numeric && named) out.push({ kind: "dates written two ways", count: Math.min(numeric, named), example: "" });
  return out;
}

/**
 * The part of that which can be put right without writing anything new:
 * stock adjectives taken out, the plain word put for the inflated one, a
 * bullet said twice said once. Every change removes or shortens. A figure,
 * a name, a tool or a claim is never touched, and nothing is ever added.
 */
export function tidyWriting(text) {
  let s = String(text ?? "");
  let changes = 0;
  const swap = (re, to) => { s = s.replace(re, (m, ...rest) => { changes++; return typeof to === "function" ? to(m, ...rest) : to; }); };
  const keepCase = (to) => (m) => (m[0] === m[0].toUpperCase() ? to[0].toUpperCase() + to.slice(1) : to);

  swap(/\butiliz(e|ed|es|ing)\b/gi, (m, e) => keepCase({ e: "use", ed: "used", es: "uses", ing: "using" }[e.toLowerCase()])(m));
  swap(/\bleverag(e|ed|es|ing)\b/gi, (m, e) => keepCase({ e: "use", ed: "used", es: "uses", ing: "using" }[e.toLowerCase()])(m));
  swap(/\bin order to\b/gi, keepCase("to"));
  swap(/\b(successfully|effectively|proactively|seamlessly) (?=[a-z])/gi, "");
  // A stock adjective before a noun, with its comma or "and" where it was
  // one of a list: "a dynamic, results-driven manager" -> "a manager".
  // A stock adjective that can mean nothing else is taken out wherever it
  // stands. One that is also an ordinary word — "dynamic pricing" — only
  // where it follows an article and so describes the person.
  const ONLY_STOCK = "results[- ]driven|results[- ]oriented|detail[- ]oriented|highly motivated|self[- ]motivated";
  const ALSO_WORDS = "dynamic|passionate|seasoned|accomplished";
  const article = (a, next) => (/^an?$/i.test(a) ? (a[0] === "A" ? "A" : "a") + (/^[aeiou]/i.test(next) ? "n" : "") : a);
  s = s.replace(new RegExp(`\\b(an?|the)\\s+((?:(?:${ONLY_STOCK}|${ALSO_WORDS})\\b,?\\s+(?:and\\s+)?)+)(?=([a-z]))`, "gi"), (m, a, _adj, next) => { changes++; return `${article(a, next)} `; });
  swap(new RegExp(`\\b(${ONLY_STOCK})\\b,?\\s+(and\\s+)?(?=[a-z])`, "gi"), "");
  s = s.replace(/[ \t]{2,}/g, " ").replace(/ ([,.;])/g, "$1");
  // A line whose first word was taken away starts with its next one.
  s = s.replace(/^(\s*[•\-–*·]\s*)([a-z])/gm, (m, lead, c) => lead + c.toUpperCase());

  // A bullet that says what another already said.
  const seen = new Set();
  s = s
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (!/^[•\-–*·]/.test(t)) return true;
      const k = t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      if (k.length <= 20) return true;
      if (seen.has(k)) { changes++; return false; }
      seen.add(k);
      return true;
    })
    .join("\n");
  return { text: s, changes };
}

// ---------------------------------------------------------------------------
// Whether every claim in the document is the candidate's own
// ---------------------------------------------------------------------------

const squash = (t) => String(t ?? "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "");

/**
 * Figures and named things in the document that the candidate's own material
 * does not contain. A year is let through; so is a figure the posting did
 * not put there and the source spells differently only in its commas.
 */
export function unsupportedClaims(finalText, sourceText) {
  const src = String(sourceText ?? "");
  const flat = squash(src);
  const digits = new Set((src.match(/\d[\d,.]*/g) ?? []).map((n) => n.replace(/[,.]+$/, "").replace(/,/g, "")));
  const out = [];
  for (const m of String(finalText ?? "").matchAll(/[$€£]?\d[\d,.]*\s?(%|percent|k\b|m\b|million|billion|\+)?/gi)) {
    const raw = m[0].trim();
    const v = raw.replace(/[^\d.]/g, "").replace(/\.+$/, "");
    if (!v || v.length < 2 && !/[%$€£]/.test(raw)) continue;
    if (/^(19|20)\d{2}$/.test(v)) continue;
    if (digits.has(v) || digits.has(v.replace(/\.0+$/, ""))) continue;
    out.push(raw.slice(0, 14));
  }
  // Certifications and degrees are claims a background check reads.
  for (const m of String(finalText ?? "").matchAll(/\b(PMP|CPA|CFA|CISSP|CISA|CSM|SHRM-CP|SHRM-SCP|PHR|SPHR|Six Sigma [A-Z][a-z]+ Belt|MBA|Ph\.?D\.?|J\.?D\.?|RN|LPN|CDL)\b/g)) {
    if (!flat.includes(squash(m[0]))) out.push(m[0]);
  }
  return [...new Set(out)].slice(0, 10);
}

// ---------------------------------------------------------------------------
// The PDF, read back as a parser reads it
// ---------------------------------------------------------------------------

let PDFTOTEXT;
function pdfText(path) {
  if (PDFTOTEXT === false) return null;
  try {
    const out = execFileSync("pdftotext", ["-layout", "-enc", "UTF-8", path, "-"], { encoding: "utf8", timeout: 20_000, maxBuffer: 8_000_000 });
    PDFTOTEXT = true;
    return out;
  } catch (e) {
    if (e?.code === "ENOENT") PDFTOTEXT = false;
    return null;
  }
}

/**
 * The attached PDF's own text, held against what was meant to be in it. A
 * file that reads back empty, as glyph codes, or without the candidate's
 * name and contact line is one a screener cannot read either.
 */
export function pdfReadBack(path, expectedText, profile = {}) {
  const got = pdfText(path);
  if (got === null) return { checked: false };
  const flat = squash(got);
  const problems = [];
  // Against what was put in, not a fixed length: a short resume is short.
  const meant = squash(expectedText).length;
  if (flat.length < 120 || (meant > 0 && flat.length < meant * 0.4)) problems.push("almost no text can be read out of it");
  if (/\(cid:\d+\)/.test(got) || (got.match(/\uFFFD/g) ?? []).length > 5) problems.push("its letters read back as codes");
  const need = [["name", profile.full_name], ["email", profile.email]];
  for (const [what, value] of need) if (value && !flat.includes(squash(value))) problems.push(`the ${what} is not in its text`);
  const digits = String(profile.phone ?? "").replace(/\D/g, "").slice(-10);
  if (digits.length === 10 && !got.replace(/\D/g, "").includes(digits)) problems.push("the phone number is not in its text");
  // Each line that was meant to be there, by its first words.
  const lines = String(expectedText ?? "").split("\n").map((l) => l.trim()).filter((l) => l.length > 25);
  const kept = lines.filter((l) => flat.includes(squash(l.split(/\s+/).slice(0, 5).join(" "))));
  const share = lines.length ? Math.round((100 * kept.length) / lines.length) : 100;
  if (lines.length >= 6 && share < 85) problems.push(`only ${share}% of its lines read back`);
  return { checked: true, ok: problems.length === 0, share, problems };
}

// ---------------------------------------------------------------------------
// One answer
// ---------------------------------------------------------------------------

/**
 * Everything above, on one document, as a few facts and one line to print.
 * "blockers" are the two things a document is not sent with: a claim that is
 * not the candidate's, and a file that cannot be read.
 */
export function documentCheck({ text, source, posting, company = "", pdfPath = null, profile = {} }) {
  const req = posting ? requirementReport(text, posting, company) : null;
  const writing = writingFindings(text);
  const unsupported = unsupportedClaims(text, source);
  const pdf = pdfPath ? pdfReadBack(pdfPath, text, profile) : { checked: false };
  const blockers = [];
  if (unsupported.length) blockers.push(`not in the candidate's own material: ${unsupported.slice(0, 5).join(", ")}`);
  if (pdf.checked && !pdf.ok) blockers.push(`the PDF: ${pdf.problems.join("; ")}`);
  const pct = (r) => (r && r.total ? `${r.percent ?? Math.round((100 * r.covered) / r.total)}%` : "n/a");
  const line =
    `document check (this system's own estimate, not the employer's score): ` +
    (req ? `required ${pct(req.required)} of ${req.required.total}${req.split ? "" : " (the posting marks no requirements apart)"}, preferred ${pct(req.preferred)} of ${req.preferred.total}; ` : "") +
    `writing: ${writing.length ? writing.map((f) => `${f.kind} x${f.count}`).join(", ") : "nothing marked"}; ` +
    `claims: ${unsupported.length ? `${unsupported.length} unsupported` : "all the candidate's own"}; ` +
    `PDF: ${pdf.checked ? (pdf.ok ? `reads back (${pdf.share}% of lines)` : "does not read back") : "not read back here"}`;
  return { ok: blockers.length === 0, blockers, requirements: req, writing, unsupported, pdf, line };
}
