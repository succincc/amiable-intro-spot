
// ============================================================================
// apply.mjs — the cloud applier.
//
// Runs on GitHub Actions with Playwright. This is what makes the whole system
// work from a phone: you press a button in the panel, GitHub runs this, and
// applications get submitted. Your computer is never involved.
//
// Why GitHub Actions: it is the only free way to get a real browser running
// in the cloud on a schedule. Public repositories get unlimited runner
// minutes. No resume or personal data lives in this repo — everything is
// pulled from Supabase at runtime using a secret, so the repo can be public
// and still hold nothing about you.
//
// The field-matching logic below is deliberately the same approach as the
// Chrome extension: identify fields by the LABEL a human reads, not by CSS
// selectors, because every ATS uses different markup but all of them show a
// person "First Name".
// ============================================================================

import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";

import { chromium } from "playwright";

import { chooseOption, generateAnswer, resumeFacts } from "./answers.mjs";
import { alignToPosting, composeAnswer } from "./ats.mjs";
import { tailorResume, rolesText, standardResume, arrangedResume, structureResume } from "./tailor.mjs";
import { guardLogs, hideJob } from "./quiet.mjs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const AP_EMAIL = process.env.APPLYPILOT_EMAIL;
const AP_PASSWORD = process.env.APPLYPILOT_PASSWORD;
const MAX_JOBS = parseInt(process.env.MAX_JOBS || "25", 10);
// Decided once in main(): the autopilot setting can turn it off for a
// scheduled run. applyToJob reads this binding, so there must not be a
// second copy of the decision floating around.
let DRY_RUN = process.env.DRY_RUN === "true";

if (!SUPABASE_URL || !ANON_KEY || !AP_EMAIL || !AP_PASSWORD) {
  console.error("Missing SUPABASE_URL, SUPABASE_ANON_KEY, APPLYPILOT_EMAIL or APPLYPILOT_PASSWORD secret.");
  process.exit(1);
}

// Sign in as the panel user (RLS allows authenticated only; no service key exists on Lovable Cloud).
let ACCESS = "";
let REFRESH = "";
let EXPIRES = 0;
async function auth(body, grant) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=${grant}`, {
    method: "POST",
    headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Sign-in failed ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  ACCESS = j.access_token; REFRESH = j.refresh_token;
  EXPIRES = Date.now() + (j.expires_in - 120) * 1000;
}
await auth({ email: AP_EMAIL, password: AP_PASSWORD }, "password");
async function token() {
  if (Date.now() > EXPIRES) await auth({ refresh_token: REFRESH }, "refresh_token");
  return ACCESS;
}

// ---------------------------------------------------------------------------
// Supabase REST
// ---------------------------------------------------------------------------
async function db(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${await token()}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`DB ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const rpc = (fn, args = {}) =>
  db(`rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });

const patchJob = (id, patch) =>
  db(`jobs?id=eq.${id}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });

/** Report status so the panel can show the cloud agent as alive.
 *
 * Without this the dashboard reads the `agent` table — written only by the
 * Chrome extension — and shows "offline" the whole time the cloud agent is
 * working, which looks exactly like the system being broken. */
/**
 * Give back the jobs this applier parked before its own last change.
 *
 * Nearly every job sitting in "needs you" was parked by a fault that has
 * since been fixed, and nothing ever offered it again: claim_next_job only
 * takes queued jobs, so each fix quietly helped future jobs and abandoned
 * the ones that provoked it. Forty-odd real postings rotted that way.
 *
 * Keying on the applier's own commit time makes this self-limiting. A
 * requeued job's updated_at moves to now, which is later than the commit, so
 * it is not offered again until a NEWER version of the applier exists — one
 * retry per job per fix, never a loop.
 */
// "login" joined once there was something new to try at a sign-in wall: the
// portal's own password reset. One attempt per portal per run, so a wall that
// still will not open costs one visit, not one per posting.
const RETRYABLE_PARKED = ["incomplete", "error", "no_form", "login"];

/**
 * What shape each location field is in — never what it says.
 *
 * The state box turned out to hold a street address, and Booz Allen now
 * rejects every attempt with "Enter a postal code in the correct format",
 * so the rest of these are suspect too. This repository is PUBLIC and its
 * run logs are public with it, so this reports the shape of each value and
 * never the value: enough to see which box holds the wrong kind of thing.
 */
function profileShape(p) {
  const kind = (v) => {
    const t = String(v ?? "").trim();
    if (!t) return "empty";
    if (/^\d{5}(-\d{4})?$/.test(t)) return "a zip";
    if (/^\+?[\d\s().-]{7,}$/.test(t)) return "a phone number";
    if (STATE_NAMES[t.toUpperCase()]) return "a state code";
    if (Object.values(STATE_NAMES).some((n) => n.toLowerCase() === t.toLowerCase())) {
      return "a state name";
    }
    if (/^\d+\s+\S/.test(t)) return "a STREET ADDRESS";
    if (/^\d+$/.test(t)) return `${t.length} digits`;
    return `${t.length} chars of text`;
  };
  return {
    address: kind(p.address),
    city: kind(p.city),
    state: kind(p.state),
    postal_code: kind(p.postal_code),
    phone: kind(p.phone),
  };
}

async function requeueStaleParked() {
  let since = null;
  try {
    since = execSync("git log -1 --format=%cI", { encoding: "utf8", timeout: 10_000 }).trim();
  } catch {
    /* a checkout without history; fall through and leave the backlog alone */
  }
  if (!/^\d{4}-\d{2}-\d{2}/.test(since ?? "")) {
    console.log("Could not read the applier's commit time, so parked jobs were left alone.");
    return;
  }

  const stale = await db(
    `jobs?status=eq.needs_help&help_reason=in.(${RETRYABLE_PARKED.join(",")})` +
      `&updated_at=lt.${encodeURIComponent(since)}&select=id&order=score.desc.nullslast&limit=200`,
  ).catch((e) => {
    console.log(`Looking for parked jobs failed: ${String(e?.message ?? e).slice(0, 120)}`);
    return null;
  });
  if (!stale?.length) return;

  let done = 0;
  for (let i = 0; i < stale.length; i += 50) {
    const ids = stale.slice(i, i + 50).map((r) => r.id);
    const ok = await db(`jobs?id=in.(${ids.join(",")})`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        status: "queued",
        attempts: 0,
        help_reason: null,
        updated_at: new Date().toISOString(),
      }),
    })
      .then(() => true)
      .catch((e) => {
        console.log(`Requeueing parked jobs failed: ${String(e?.message ?? e).slice(0, 120)}`);
        return false;
      });
    if (!ok) break;
    done += ids.length;
  }
  if (done) {
    console.log(`Requeued ${done} job(s) parked before the applier's last change.`);
  }
}

const heartbeat = (patch) =>
  db("agent?id=eq.1", {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      last_seen: new Date().toISOString(),
      version: "cloud-agent",
      ...patch,
    }),
  }).catch(() => {});

// ---------------------------------------------------------------------------
// Field matching — shared logic with the extension.
//
// Word-boundary matching is not a nicety here. Plain substring matching put
// "FL" into "Are you legally authorized to work in the United States?"
// (because "state" is inside "States") and "Tampa" into "Race / ethnicity"
// (because "city" is inside "ethnicity"). Both went onto live applications.
// ---------------------------------------------------------------------------
let SAID_NO_ETHNICITY = false;

function has(label, ...needles) {
  return needles.some((n) => {
    const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![a-z])${escaped}(?![a-z])`, "i").test(label);
  });
}

/**
 * What a group of checkboxes or radios is actually asking, and what it offers.
 *
 * An individual box's label is an OPTION ("White or European"), not the
 * question; the question sits on the container. The completeness check keyed
 * groups by the name attribute, which on a Greenhouse demographic question is
 * "question_18670892008[]" — that identifies the field to the server and to
 * nobody else, so three runs reported a blocking field by a number.
 *
 * Climbs to the element that holds more than one box of the same name (or a
 * fieldset / role=group), then reads its legend, or its own text with every
 * option label subtracted out.
 */
const readGroupQuestion = (n) => {
  const name = n.getAttribute("name");
  let box = n.parentElement;
  for (let d = 0; box && d < 6; d++, box = box.parentElement) {
    const same = name
      ? box.querySelectorAll(`input[name="${name.replace(/["\\]/g, "")}"]`).length
      : 0;
    if (!(same >= 2 || box.tagName === "FIELDSET" || box.getAttribute("role") === "group")) {
      continue;
    }
    const options = Array.from(box.querySelectorAll("label"))
      .map((l) => (l.innerText || "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 10);

    let ask = (box.querySelector("legend")?.innerText ?? "").replace(/\s+/g, " ").trim();
    if (!ask) {
      ask = (box.innerText || "").replace(/\s+/g, " ").trim();
      for (const t of options) if (t) ask = ask.split(t).join(" ");
      ask = ask.replace(/\s+/g, " ").trim();
    }
    return { ask: ask.slice(0, 140), options, count: same };
  }
  return null;
};

/** Questions the form is ASKING. Checked before field-name matching. */
function answerQuestion(label, p) {
  if (has(label, "authorized to work", "legally authorized", "work authorization",
                 "legal authorization", "authorization to work", "authorised to work",
                 "eligible to work", "right to work")) return p.work_authorized;
  if (has(label, "sponsorship", "visa", "h-1b", "h1b", "work permit")) return p.needs_sponsorship;
  if (has(label, "18 years", "over 18", "age of majority", "at least 18")) return p.over_18;
  if (has(label, "background check", "drug screen", "drug test")) return p.can_background_check;
  // Commuting is the premise of this whole system — it only ever offers jobs
  // inside the radius the user set — so yes is their own stated position.
  if (has(label, "commute", "commuting")) return "Yes";
  // A blank preference blocks the whole application, so answer it the way
  // the search itself is set up — this system only ever offers jobs inside
  // the radius the user chose, so not relocating is already their position.
  // Recorded as a question either way, so it can be changed in the panel.
  if (has(label, "relocate", "relocation", "relocating", "relocated")) return p.willing_to_relocate ?? "No";
  if (has(label, "veteran", "protected veteran", "veterans", "military service")) {
    return p.veteran_status;
  }
  if (has(label, "disability", "disabled", "disabilities", "impairment")) {
    return p.disability_status;
  }
  if (has(label, "gender", "genders", "sex", "pronouns", "gender identity")) return p.gender;
  // "Are you Hispanic/Latino?" is a yes/no question and the answer on file is
  // a race, so it was offered "White" against Yes / No / Decline. Only what
  // the profile actually says becomes a yes or a no; anything else falls
  // through to the race answer, which matches nothing there, and the
  // self-identification fallback then declines rather than guesses.
  //
  // Workday asks it on its own — "Hispanic or Latino?", Yes or No, required —
  // beside a separate race question. The standard categories are exclusive:
  // an answer on file of "White" is the category "White (Not Hispanic or
  // Latino)", so the applicant has already said no. That is their answer
  // being entered in the shape this form wants it, not a guess about them;
  // with nothing on file, or a declined answer, nothing is said here either.
  if (
    /\bare you (of )?(hispanic|latin)/i.test(String(label)) ||
    (/\b(hispanic|latin[oax]?)\b/i.test(String(label)) && !/\b(race|racial|ethnicit\w*|ethnic|background|heritage)\b/i.test(String(label)))
  ) {
    const r = String(p.race_ethnicity ?? "").toLowerCase();
    if (/not hispanic|non-?hispanic/.test(r)) return "No";
    if (/hispanic|latin/.test(r)) return "Yes";
    if (/\b(white|black|african|asian|native|pacific|islander|american indian|alaska|two or more|middle eastern)\b/.test(r)) return "No";
    // Said once: this is the one answer that only the owner can give.
    if (!SAID_NO_ETHNICITY) {
      SAID_NO_ETHNICITY = true;
      console.log(`    "hispanic or latino" has no answer on file — the profile's race/ethnicity is ${r ? "not one this can read as yes or no" : "empty"}`);
    }
    return null;
  }
  // "How would you describe your racial/ethnic background?" contains neither
  // the word race nor the word ethnicity, and those were the only two this
  // knew. Two rounds went into widget theories — a multi-select, an array
  // field — for a question the answer table had simply never matched.
  if (has(label, "race", "racial", "ethnic", "ethnicity", "ethnic background",
                 "hispanic", "latino", "heritage")) {
    return p.race_ethnicity;
  }
  // "Do you meet all of the basic qualifications for this role as specified
  // in the job description?" Applying is that assertion, and nothing reaches
  // this point that the scoring did not already judge a fit for the resume.
  if (/\bmeet (all (of )?)?the (basic|minimum|required) qualifications\b|\bmeet (all (of )?)?(the )?(basic|minimum) (qualifications|requirements)\b/i.test(String(label))) {
    return "Yes";
  }
  // "Were you referred by a current Carvana employee?" is yes or no. It was
  // being read as "how did you hear about us" and offered "Company website"
  // against Yes / No. Nobody referred an application found by a search.
  if (/\b(were|was|are|have) you (been )?referred\b|referred by (a|an) (current|existing)/i.test(String(label))) {
    return "No";
  }
  // Asked a dozen ways, each naming the employer: "have you ever worked for
  // Airbnb", "have you ever been employed full-time at Block or its
  // subsidiaries", "have you ever provided any contract work for". All the
  // same question, and the rule only knew three phrasings.
  if (has(label, "previously worked", "former employee", "worked here before",
                 "previously interviewed", "interviewed with", "previously applied",
                 "previously been employed", "ever worked for", "ever worked at",
                 "employed full-time at", "been employed at", "been employed by",
                 "provided any contract work", "contract work for", "worked as a contractor",
                 "currently or have you ever worked", "current or previous",
                 "current or former", "ever been, employed", "ever been employed",
                 "currently, or have you ever been", "previously employed",
                 "do you currently work for", "currently work for")) {
    return "No";
  }

  // Policies and attestations: a box that must be acknowledged before an
  // application can be submitted at all. Reading one and agreeing to it is
  // what applying through this portal means.
  if (has(label, "privacy policy", "privacy notice", "candidate privacy", "terms of use",
                 "attestation", "acknowledge", "i acknowledge", "i agree", "i certify",
                 "i confirm", "have read", "read and understood", "code of conduct")) {
    return "Yes";
  }

  // Recording and transcription during interviews. Declining it here means
  // the application cannot be submitted; it is consent to their process, not
  // to anything about the candidate.
  if (has(label, "transcription", "record the interview", "recording", "ai notetaker",
                 "interview process", "how we interview")) {
    return "Yes";
  }
  // The resume says whether they graduated; the degree reader already knows.
  if (has(label, "did you graduate", "graduated", "degree completed", "complete your degree")) {
    return highestDegree(String(p.resume_text ?? "")) ? "Yes" : null;
  }
  if (has(label, "convicted", "felony", "criminal", "conviction")) return "No";
  // Non-compete, asked the long way round. Booz Allen words it "have you
  // entered into any agreement in connection with your current employment".
  if (has(label, "non-compete", "noncompete", "restrictive covenant",
                 "entered into any agreement", "non-solicitation")) {
    return "No";
  }

  // Post-government employment restrictions, which a federal contractor asks
  // of everyone and which apply only to former government employees.
  //
  // Zscaler's reads "Have you been involved in procurement or contract award
  // activities..." — the same screen for a seller to government. It is No for
  // anyone who has not worked in government, and that is checked against the
  // resume rather than assumed: where the resume mentions government work,
  // the question is left for the person.
  if (has(label, "federal government employment", "post-government",
                 "government employment", "federal employee", "public official",
                 "involved in procurement", "contract award", "government official",
                 "government employee", "procurement official", "contracting officer")) {
    const worked = /\b(federal|government|municipal|state agency|department of|u\.?s\.? (army|navy|air force)|contracting officer|GS-\d)/i;
    return worked.test(String(p.resume_text ?? "")) ? null : "No";
  }

  // Working arrangements. The search only ever offers jobs inside the radius
  // the user set, so being able to work at one of them is their own position;
  // business travel is ordinary for the roles this applies to. Both are
  // recorded as questions so either can be changed in the panel.
  if (has(label, "willing to travel", "able to travel", "travel for business",
                 "travel requirement")) {
    return "Yes";
  }
  if (has(label, "on-site", "onsite", "in the office", "five days a week",
                 "work from the office", "hybrid schedule")) {
    return "Yes";
  }

  // Screening questions a real Workday questionnaire asks, each with one
  // truthful answer that does not need to be guessed at.
  if (has(label, "relatives", "family members", "related to anyone", "immediate family")) {
    return "No";
  }
  // "In the event an offer of employment is made, are there any factors BMS
  // should consider when ..." — a question whose honest answer is no unless
  // the candidate says otherwise, and they can say so in the panel.
  if (has(label, "any factors", "anything else we should", "any other information")) {
    return "No";
  }
  // "To the best of your knowledge, are you ... ?" is a disclosure question,
  // and for someone with nothing to disclose the answer is no — which this
  // employer offers as "Not to my knowledge".
  if (has(label, "to the best of your knowledge", "best of my knowledge", "are you aware of")) {
    return "No";
  }

  // Consent, which comes in two kinds and deserves opposite answers.
  // Being assessed is the point of applying; being marketed to is not.
  if (has(label, "use of ai", "ai tools", "ai matching", "automated assessment",
                 "process my personal information", "processing of my personal")) {
    return "Yes";
  }
  if (has(label, "additional email", "marketing communications", "newsletter",
                 "talent community", "promotional")) {
    return "No";
  }

  // Regulatory screening, which a pharmaceutical employer asks a dozen ways.
  //
  // Each asks whether something adverse is true of the candidate, and the
  // truthful answer for nearly everyone is no — "debarment proceedings
  // pending" is the same question as "are you debarred", and missing the
  // noun form left it unanswered through four runs.
  if (has(label, "debarred", "debarment", "excluded", "exclusion list", "sanctions", "ofac",
                 "appeared on the", "disqualified", "pending inquiry", "licensing board",
                 "governmental entity", "investigated", "restricted by", "suspended",
                 "revoked", "barred from")) {
    return "No";
  }

  // Asked by every pharma employer, and the resume is what knows.
  if (has(label, "licensed physician", "licensed healthcare", "medical license",
                 "licensed practitioner")) {
    return /\b(m\.? ?d\.?|physician|doctor of medicine)\b/i.test(String(p.resume_text ?? ""))
      ? "Yes"
      : "No";
  }
  if (has(label, "background check", "reference check", "drug screening")) {
    return p.can_background_check ?? "Yes";
  }
  return null;
}

/**
 * One component of a date, because Workday splits a date into three boxes.
 *
 * "When are you available to start" came back as three required items —
 * dateSectionMonth-input, dateSectionDay-input, dateSectionYear-input — and
 * a rule returning "12/08/2026" filled none of them with anything usable.
 */
function datePart(label, d) {
  const l = String(label ?? "");
  const pad = (n) => String(n).padStart(2, "0");
  if (/datesectionmonth|\bmonth\b/i.test(l)) return String(d.getMonth() + 1);
  if (/datesectionday|\bday\b/i.test(l)) return String(d.getDate());
  if (/datesectionyear|\byear\b/i.test(l)) return String(d.getFullYear());
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`;
}

function fieldValue(label, p) {
  if (has(label, "first name", "given name", "forename")) return p.first_name;
  if (has(label, "last name", "surname", "family name")) return p.last_name;
  if (has(label, "preferred name", "nickname")) return p.preferred_name || p.first_name;
  if (has(label, "full name", "your name", "legal name")) return p.full_name;
  // Workday repeats a label into its own id, so a bare signature box reads
  // "name name name" and matched none of the rules above it.
  if (/^(name ?)+$/.test(String(label).trim())) return p.full_name;
  if (has(label, "email", "e-mail")) return p.email;
  // Before the generic phone rule, which matches on "phone" and would put the
  // phone NUMBER into a country-code box and an extension box alike. Workday
  // asks for all three next to each other, so this ordering is the difference
  // between a complete form and two wrong answers.
  if (has(label, "country phone code", "phone code", "dial code", "country code")) {
    // The option reads "United States of America (+1)", so "United States"
    // leaves two countries matching and nothing for Enter to accept. Spell it
    // the way the list spells it.
    const c = String(p.country ?? "").toLowerCase();
    if (!c || /^(us|usa|united states|united states of america)$/.test(c.trim())) {
      return "United States of America";
    }
    return p.country;
  }
  if (has(label, "extension")) return "";
  // "Phone Device Type" on Workday: Mobile, Home, Work, Pager, Fax. The
  // number on file is a mobile for virtually everyone, and leaving it blank
  // stopped a Johnson & Johnson application dead.
  if (has(label, "phone device type", "device type", "phone type")) return "Mobile";
  if (has(label, "phone", "mobile", "telephone", "cell")) return p.phone;
  if (has(label, "linkedin")) return p.linkedin_url;
  if (has(label, "github")) return p.github_url;
  if (has(label, "portfolio", "website", "personal site")) return p.portfolio_url;
  // Specific before general, always. "Address" matches a label that also
  // says postal code, and the generic rule sitting first meant a street
  // address went into the zip box.
  if (has(label, "zip", "zipcode", "postal", "postalcode", "postcode")) return p.postal_code;
  if (has(label, "city", "town", "municipality")) return p.city;
  if (has(label, "state", "province", "region", "countryregion") && !has(label, "united states")) {
    return stateOf(p);
  }
  if (has(label, "street", "address line 1", "address 1", "addressline1")) return p.address;
  if (has(label, "address") && !has(label, "email", "e-mail")) return p.address;
  if (has(label, "country")) return p.country;
  // "What annual salary do you expect for this role? Please answer using the
  // currency applicable to the role location." It ends in the word location,
  // and was answered with the applicant's town on three Live Nation forms.
  // What a question asks comes before what it happens to mention.
  if (
    /\b(salary|compensation|pay)\b[^?]{0,60}\b(expect|expecting|expectation|looking for|seeking|require|desire|want)|\b(expect|desired|required|target|anticipated)\w*\s+(annual |base |total |yearly )*(salary|compensation|pay)\b/i.test(label)
  ) {
    return p.salary_expectation != null ? String(p.salary_expectation) : null;
  }
  if (has(label, "location") && !has(label, "relocate", "relocating", "salary", "compensation", "currency")) {
    return [p.city, p.state].filter(Boolean).join(", ");
  }
  if (has(label, "current company", "current employer", "employer name", "company name")) {
    return p.current_company;
  }
  if (has(label, "current title", "current role", "job title", "position title")) return p.target_role;
  if (has(label, "years of experience", "years experience", "how many years")) return p.years_experience;
  if (has(label, "school", "university", "college")) return p.school;
  if (has(label, "degree", "education level", "highest level")) return p.education_level;
  // "desired BASE salary" is not "desired salary": has() matches whole words
  // in order, so the employer's extra word made the rule miss and the field
  // was left empty on an otherwise complete questionnaire.
  // Narrow, because the broad version answered "in the event an offer of
  // employment is made, ..." with "70000". A rule that fires on the word
  // salary alone will meet a yes/no question sooner or later.
  if (
    has(label, "desired salary", "desired base salary", "base salary", "salary expectation",
               "expected salary", "expected compensation", "salary requirement",
               "salary requirements", "desired compensation", "target salary",
               "desired pay", "expected pay") ||
    (/what (is|are) your/i.test(label) && has(label, "salary", "compensation", "pay"))
  ) {
    return p.salary_expectation != null ? String(p.salary_expectation) : null;
  }
  // "How much notice would you need before starting the position?"
  if (has(label, "notice period") || /\bhow (much|long)\b[^?]{0,30}\bnotice\b|\bnotice\b[^?]{0,40}\b(need|require|give|before starting)/i.test(label)) {
    return "2 weeks";
  }

  // The signature block that closes a Workday application: a name typed as a
  // signature, and today's date beside it. Five required items stopped an
  // application that was otherwise finished.
  if (has(label, "signature", "signed by", "please type your name", "electronic signature") || /\bbefore signing\b|\bsign (below|here)\b|\btype your (full |legal )?name\b/i.test(String(label))) {
    return p.full_name;
  }
  if (/\bdate ?signed\b|datesignedon|date of signature|today'?s date|date on which you (have )?(read|agreed|acknowledg|review)/i.test(String(label))) {
    return datePart(label, new Date());
  }
  // "Available" is only a date when the question is about WHEN. Datadog asks
  // "In what cities are you available to work?" and this offered it
  // 12/08/2026 — the bare word matched and nothing asked what kind of
  // availability was meant. It found no such option and left the box empty,
  // which was luck rather than judgment.
  const asksWhereOrHow = /\b(city|cities|locations?|offices?|where|shifts?|days|hours|weekends?|evenings?|nights?|overtime|travel|relocat\w*|on-?site|hybrid|in-?person)\b/i.test(
    String(label),
  );
  if (
    !asksWhereOrHow &&
    (has(label, "start date", "when can you start", "available to start", "availability date",
                "date available", "earliest start", "when are you available") ||
      (has(label, "available", "earliest", "availability") &&
        /\b(start|date|when|begin|join|soon)\b/i.test(String(label))))
  ) {
    // A blank start date blocks the whole application, and two weeks out is
    // what the notice-period rule already answers in words.
    const d = p.earliest_start ? new Date(p.earliest_start) : new Date(Date.now() + 14 * 86_400_000);
    return datePart(label, Number.isNaN(d.getTime()) ? new Date(Date.now() + 14 * 86_400_000) : d);
  }
  // Zscaler asks "How did you learn about this job?" — same question, and
  // "hear" was the only verb this knew.
  if (
    has(label, "how did you hear", "referral source", "referred by", "how did you learn",
               "how did you find", "where did you hear", "where did you find",
               "how did you come across", "how did you discover", "source of application")
  ) {
    return "Company website";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Read a control's label the way a person reads it
// ---------------------------------------------------------------------------
// The label a human reads beside a field.
//
// This MUST be a real function, not a string. `element.evaluate("(el) => …")`
// evaluates the string to a function object, which cannot be serialised back
// across the boundary, so it returns undefined — every field on every ATS
// then counted as having no label, and the applier filled nothing, ever.
// Greenhouse was sending `aria-label="First Name"` the whole time.
const readLabel = (el) => {
  const parts = [];
  if (el.id) {
    const lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
    if (lab) parts.push(lab.innerText);
  }
  const wrap = el.closest("label");
  if (wrap) parts.push(wrap.innerText);
  for (const a of ["aria-label", "placeholder", "name", "id", "data-qa", "title"]) {
    let v = el.getAttribute && el.getAttribute(a);
    if (!v) continue;
    // Workday names a field "section--field": "address--countryRegion" is
    // the STATE box, and pushing the whole id in put the word "address"
    // into the label of every field in that section. The lookup then
    // answered the state box, and the postal code box, with the street
    // address — which is why a portal kept rejecting "enter a postal code
    // in the correct format" against a profile that was perfectly correct.
    if (typeof v === "string" && v.includes("--")) v = v.split("--").pop();
    parts.push(v);
  }
  const lb = el.getAttribute && el.getAttribute("aria-labelledby");
  if (lb) {
    for (const id of lb.split(/\s+/)) {
      const n = document.getElementById(id);
      if (n) parts.push(n.innerText);
    }
  }
  let probe = el.parentElement;
  for (let d = 0; probe && d < 3; d++, probe = probe.parentElement) {
    const t = Array.from(probe.childNodes)
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent.trim())
      .filter((x) => x.length > 2 && x.length < 160)
      .join(" ");
    if (t) {
      parts.push(t);
      break;
    }
  }
  let out = parts.join(" ").replace(/\s+/g, " ").replace(/\*/g, "").trim().toLowerCase();

  // Workday names a questionnaire field by GUID, so the walk above returns
  // "select one required 81f3933c840d10015472" and nothing a person could
  // answer. The question itself sits in the formField container around it —
  // the completeness check read "What is your desired base salary?* Error"
  // from exactly there. A long run of hex is the tell, and no ordinary label
  // has one.
  if (/[0-9a-f]{12,}/i.test(out) || !out) {
    const box = el.closest(
      '[data-automation-id^="formField"], [data-automation-id^="questionItem"], [data-automation-id^="question-"]',
    );
    if (box) {
      const q = (box.innerText || "")
        .replace(/\s+/g, " ")
        .replace(/\berror\b[\s\S]*$/i, "")
        .replace(/\bselect one\b/gi, "")
        .replace(/\*/g, "")
        .trim();
      if (q.length > 3) out = q.slice(0, 160).toLowerCase();
    }
  }
  return out;
};



// ---------------------------------------------------------------------------
// The resume file
// ---------------------------------------------------------------------------
//
// Scoring writes a tailored resume per job, as plain text. The applier used
// to write that straight to /tmp/resume_<id>.txt and attach it — a .txt file
// with no formatting at all.
//
// That is bad in two ways that are easy to miss. Plenty of ATS reject .txt
// outright, so the attachment silently fails. And where it is accepted, a
// recruiter opens an unformatted wall of text.
//
// Chromium is already running, so it can print a real PDF. No library, no
// service, no cost.

/**
 * Turn renderResume()'s layout back into markup.
 *
 * One column of real text under ordinary headings, which is what a screener
 * reads cleanly: no tables, no text boxes, no graphics. The look comes from
 * type and spacing alone — a strong name, one accent colour, dates set to
 * the right of each role.
 *
 * `pt` is the body size; everything else is sized from it, so the whole
 * sheet can be made a little smaller or larger to sit on exactly one page.
 */
function resumeHtml(text, name, opts = {}) {
  const pt = Number(opts.pt) || 10.2;
  const margin = Number(opts.margin) || 0.55;
  const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = String(text).split("\n");
  const body = [];
  let inList = false;
  let section = "";
  let headDone = false;
  const closeList = () => {
    if (inList) {
      body.push("</ul>");
      inList = false;
    }
  };

  // The lines above the first heading: the name, a headline, the contact line.
  const firstHeading = lines.findIndex((l) => /^[A-Z][A-Z &]{2,}$/.test(l.trim()));
  const head = (firstHeading > 0 ? lines.slice(0, firstHeading) : lines.slice(0, 3)).map((l) => l.trim()).filter(Boolean);
  const rest = firstHeading > 0 ? lines.slice(firstHeading) : lines.slice(3);
  if (head.length) {
    body.push(`<header><h1>${esc(head[0])}</h1>`);
    for (const h of head.slice(1)) {
      if (/@|\|\s|\d{3}[\s.-]?\d{3}[\s.-]?\d{4}/.test(h)) {
        body.push(`<p class="contact">${h.split(/\s*\|\s*/).filter(Boolean).map(esc).join('<span class="dot"> &middot; </span>')}</p>`);
      } else {
        body.push(`<p class="headline">${esc(h)}</p>`);
      }
    }
    body.push("</header>");
    headDone = true;
  }

  for (const raw of rest) {
    const line = raw.trim();
    if (!line) {
      closeList();
      continue;
    }
    // SUMMARY, SKILLS, EXPERIENCE, EDUCATION
    if (/^[A-Z][A-Z &]{2,}$/.test(line)) {
      closeList();
      section = line;
      body.push(`<h2>${esc(line)}</h2>`);
      continue;
    }
    if (/^[-•*–·▪◦‣]\s+/.test(line)) {
      if (!inList) {
        body.push("<ul>");
        inList = true;
      }
      body.push(`<li>${esc(line.replace(/^[-•*–·▪◦‣]\s+/, ""))}</li>`);
      continue;
    }
    closeList();
    // "Company - Title (Jan 2019 - Present)": the title leads, the employer
    // follows, and the dates sit at the right edge of the same line.
    const role = line.match(/^(.*?)\s*\(([^()]*\d{4}[^()]*)\)\s*$/);
    if (role) {
      const parts = role[1].split(/\s+[-–—]\s+/);
      const isJob = /EXPERIENCE|EMPLOYMENT|WORK/.test(section);
      const lead = isJob && parts.length > 1 ? parts.slice(1).join(" - ") : parts[0];
      const follow = isJob && parts.length > 1 ? parts[0] : parts.slice(1).join(" - ");
      body.push(
        `<div class="role"><span class="what"><b>${esc(lead)}</b>${follow ? `<span class="at">, ${esc(follow)}</span>` : ""}</span>` +
          `<span class="when">${esc(role[2])}</span></div>`,
      );
      continue;
    }
    // "Sales: CRM, forecasting, …" in the skills section.
    const skill = /SKILL|COMPETENC|TOOLS/.test(section) ? line.match(/^([^:]{2,40}):\s*(.+)$/) : null;
    if (skill) {
      body.push(`<p class="skill"><b>${esc(skill[1])}:</b> ${esc(skill[2])}</p>`);
      continue;
    }
    body.push(`<p>${esc(line)}</p>`);
  }
  closeList();
  if (!headDone) body.unshift(`<header><h1>${esc(name)}</h1></header>`);

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(name)}</title>
<style>
  @page { size: Letter; margin: ${margin}in; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { font-family: "Helvetica Neue", Helvetica, Arial, "Liberation Sans", sans-serif;
         font-size: ${pt}pt; line-height: 1.33; color: #1b1f24; }
  #sheet { width: ${8.5 - 2 * margin}in; }
  header { border-bottom: 1.6pt solid #1f3a5f; padding-bottom: ${(pt * 0.5).toFixed(1)}pt; margin-bottom: ${(pt * 0.2).toFixed(1)}pt; }
  h1 { font-size: ${(pt * 2.15).toFixed(1)}pt; line-height: 1.1; margin: 0; color: #1f3a5f; letter-spacing: .2pt; font-weight: 700; }
  p.headline { margin: ${(pt * 0.2).toFixed(1)}pt 0 0; font-size: ${(pt * 1.08).toFixed(1)}pt; color: #3d4a59; font-weight: 600; }
  p.contact { margin: ${(pt * 0.25).toFixed(1)}pt 0 0; font-size: ${(pt * 0.93).toFixed(1)}pt; color: #4a5562; }
  .dot { color: #9aa5b1; }
  h2 { font-size: ${(pt * 0.95).toFixed(1)}pt; text-transform: uppercase; letter-spacing: 1.3pt; color: #1f3a5f;
       margin: ${(pt * 0.95).toFixed(1)}pt 0 ${(pt * 0.35).toFixed(1)}pt; padding-bottom: 1.5pt; border-bottom: .6pt solid #c5ccd4; font-weight: 700; }
  p { margin: 0 0 ${(pt * 0.3).toFixed(1)}pt; }
  p.skill { margin-bottom: ${(pt * 0.15).toFixed(1)}pt; }
  .role { display: flex; justify-content: space-between; align-items: baseline; gap: 10pt;
          margin: ${(pt * 0.6).toFixed(1)}pt 0 ${(pt * 0.15).toFixed(1)}pt; break-after: avoid; }
  .role:first-of-type { margin-top: 0; }
  .role .at { color: #3d4a59; }
  .role .when { white-space: nowrap; color: #4a5562; font-size: ${(pt * 0.93).toFixed(1)}pt; }
  ul { margin: 0 0 ${(pt * 0.25).toFixed(1)}pt ${(pt * 1.25).toFixed(1)}pt; padding: 0; }
  li { margin-bottom: ${(pt * 0.14).toFixed(1)}pt; padding-left: 1pt; }
  li::marker { color: #1f3a5f; }
</style></head><body><div id="sheet">${body.join("\n")}</div></body></html>`;
}

/**
 * A little shorter: one bullet fewer, from the last group that can spare one.
 *
 * Bullets are grouped under whatever line comes before them, in any section
 * and with any bullet mark, because the resume on file is in the owner's own
 * layout and not the one the panel writes. If there are no bullets left to
 * take, the longest paragraph in the lower half loses its last sentence.
 */
function trimResumeText(text) {
  const lines = String(text).split("\n");
  const isBullet = (t) => /^[-•*–·▪◦‣]\s+/.test(t);
  const groups = [];
  let cur = null;
  lines.forEach((l, i) => {
    const t = l.trim();
    if (isBullet(t)) {
      if (!cur) groups.push((cur = []));
      cur.push(i);
    } else if (t) {
      cur = null;
    }
  });
  for (const floor of [3, 2, 1]) {
    for (let g = groups.length - 1; g >= 0; g--) {
      if (groups[g].length > floor) {
        lines.splice(groups[g][groups[g].length - 1], 1);
        return lines.join("\n");
      }
    }
  }
  // No bullet to spare: shorten the longest paragraph below the top third.
  let longest = -1;
  for (let i = Math.floor(lines.length / 3); i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.length < 160 || /^[A-Z][A-Z &]{2,}$/.test(t)) continue;
    if (longest < 0 || t.length > lines[longest].trim().length) longest = i;
  }
  if (longest >= 0) {
    const parts = lines[longest].trim().split(/(?<=[.!?;])\s+/);
    if (parts.length > 1) {
      lines[longest] = parts.slice(0, -1).join(" ");
      return lines.join("\n");
    }
  }
  // Last of all, a whole bullet from the end, down to none.
  for (let g = groups.length - 1; g >= 0; g--) {
    if (groups[g].length > 0) {
      lines.splice(groups[g][groups[g].length - 1], 1);
      return lines.join("\n");
    }
  }
  return null;
}

/**
 * Print the resume as exactly one page.
 *
 * The largest size at which everything fits is used, so a short resume is
 * not left floating in the top half and a long one is not pushed onto a
 * second sheet. If it will not fit even at the smallest readable size, the
 * least recent roles give up a bullet at a time until it does — nothing is
 * cut from the summary, the skills or the most recent role first.
 *
 * Returns the PDF as a buffer (and writes it to `path` when one is given).
 */
async function renderResumePdf(page, text, name, path) {
  const margin = 0.5;
  const room = (11 - 2 * margin) * 96 * 0.985; // CSS px of printable height, less a hair
  const fits = async (t, pt) => {
    await page.setContent(resumeHtml(t, name, { pt, margin }), { waitUntil: "load" });
    const h = await page.evaluate(() => document.getElementById("sheet")?.getBoundingClientRect().height ?? 0);
    return h > 0 && h <= room;
  };
  let body = String(text);
  let used = null;
  let trimmed = 0;
  for (let round = 0; round < 90 && !used; round++) {
    for (const pt of round === 0 ? [11, 10.6, 10.2, 9.8, 9.4, 9.0, 8.7, 8.4] : [8.4]) {
      if (await fits(body, pt)) {
        used = pt;
        break;
      }
    }
    if (used) break;
    const shorter = trimResumeText(body);
    if (!shorter) break;
    body = shorter;
    trimmed++;
  }
  if (!used) await page.setContent(resumeHtml(body, name, { pt: 8.4, margin }), { waitUntil: "load" });
  const pdf = await page.pdf({ format: "Letter", printBackground: true, ...(path ? { path } : {}) });
  const pages = (pdf.toString("latin1").match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
  console.log(`    resume: ${pages || "?"} page(s) at ${used ?? 8.4}pt${trimmed ? `, ${trimmed} bullet(s) left off the older roles to fit` : ""}`);
  return pdf;
}

/**
 * Print the resume to a PDF and return its path.
 *
 * The filename is what a recruiter sees in the attachment list, so it carries
 * the candidate's name rather than a row id.
 */
async function buildResumePdf(context, text, profile, jobId) {
  const name = (profile.full_name || "Resume").trim();
  const safe = name.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "Resume";
  const path = `/tmp/${safe}_Resume_${jobId}.pdf`;

  const sheet = await context.newPage();
  try {
    await renderResumePdf(sheet, text, name, path);
    return path;
  } catch {
    return null;
  } finally {
    await sheet.close().catch(() => {});
  }
}


// ---------------------------------------------------------------------------
// Registering on an employer portal
// ---------------------------------------------------------------------------
//
// Workday will not show a form until you have an account, and it scopes that
// account to its tenant — so applying to five Target jobs needs one Target
// account, not five. The applier used to stop at the first password field and
// park the job, which ruled out most large employers.
//
// Each site gets its OWN generated password. Reusing the panel's password is
// the one shortcut not to take: the panel holds the resume, the contact
// details and the inbox, employer systems get breached routinely, and one
// leak would hand over all of it. A generated password costs nothing and
// limits a breach to the single employer the resume went to anyway.

/** A password that satisfies the usual portal rules without a human reading it. */
/**
 * The password for a new portal account, or for one being reset.
 *
 * The owner asked for one password everywhere — the panel's own — so that
 * any portal can be signed in to by hand without looking anything up. That
 * is their decision about their own accounts, taken knowing the cost: a
 * portal that leaks it leaks the panel's. It is used wherever it satisfies
 * the usual rules; a portal that needs something it lacks gets a generated
 * one, saved in the panel as before. Never logged.
 */
function portalPassword() {
  const own = String(AP_PASSWORD ?? "");
  const fits = own.length >= 8 && own.length <= 64 && /[a-z]/.test(own) && /[A-Z]/.test(own) && /\d/.test(own) && /[^A-Za-z0-9]/.test(own);
  return fits ? own : generatePassword();
}

function generatePassword() {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const digit = "23456789";
  const symbol = "!@#$%^&*";
  const all = upper + lower + digit + symbol;
  const pick = (set) => set[crypto.randomInt(set.length)];
  // One of each class first, because portals reject anything missing one.
  const chars = [pick(upper), pick(lower), pick(digit), pick(symbol)];
  while (chars.length < 20) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

/** Is this a registration form rather than a sign-in one? */
async function looksLikeSignup(frame) {
  const passwords = await frame.$$('input[type=password]').catch(() => []);
  // Password plus confirm-password is the clearest signal there is.
  if (passwords.length >= 2) return true;

  const text = ((await frame.innerText("body").catch(() => "")) || "").toLowerCase();
  if (/create account|create an account|sign up|register|new to .{0,30}\?/.test(text)) {
    if (!/already have an account\s*\?\s*sign in\s*$/.test(text)) return true;
  }
  return false;
}

/**
 * Create or reuse an account on the portal the page is currently showing.
 *
 * Returns a status the caller can act on. Never invents a verification code:
 * when a portal insists on one, the job is parked with that reason rather
 * than left looking like a broken form.
 */
// Portals whose sign-in refused this run. Five Kohl's jobs each tried to
// register at the same wall, one after another, and five failed attempts at
// one tenant in six minutes is how an address gets locked out.
const WALLED_HOSTS = new Set();

/**
 * An account on a SuccessFactors portal.
 *
 * SAP serves every employer from the same few addresses — Colgate and a
 * hundred others are all "career4.successfactors.com" — and tells them apart
 * by the company named in the address. So the account is kept under the
 * address AND the company; kept under the address alone, the second employer
 * would be signed in to with the first one's password.
 *
 * Two screens, both read off real portals:
 *   sign in    #username, #password, "Sign In", and a link "Create an account"
 *   register   #fbclc_userName and #fbclc_emailConf (the email, twice),
 *              #fbclc_pwd and #fbclc_pwdConf, #fbclc_fName, #fbclc_lName,
 *              a country, a phone number, a privacy statement that has to be
 *              opened and accepted, then "Create Account".
 *
 * The notification boxes on the registration form are left as they are:
 * they offer job alerts and the like, which nobody asked for.
 */
async function successFactorsAccount(page, profile, job) {
  let company = "";
  let hostname = "";
  try {
    const u = new URL(page.url());
    hostname = u.hostname.toLowerCase();
    company = String(u.searchParams.get("company") ?? "").toLowerCase().replace(/[^a-z0-9_-]/g, "");
  } catch {
    return { ok: false, reason: "no host" };
  }
  const key = company ? `${hostname}/${company}` : hostname;
  if (WALLED_HOSTS.has(key)) {
    return { ok: false, reason: "this portal's sign-in already refused an earlier job in this run; not trying it again" };
  }
  const rows = (await db(`site_accounts?host=eq.${encodeURIComponent(key)}&select=*`)) ?? [];
  const existing = rows.find((r) => r.status !== "failed");
  const email = profile.email;
  const password = existing?.password ?? portalPassword();
  await dismissBanners(page).catch(() => {});

  const shown = async (sel) => {
    for (const f of page.frames()) {
      for (const c of await f.$$(sel).catch(() => [])) {
        if (await c.isVisible().catch(() => false)) return c;
      }
    }
    return null;
  };
  const pressNamed = async (re, sel = "a, button, input[type=submit], input[type=button], [role=button]") => {
    for (const f of page.frames()) {
      for (const c of await f.$$(sel).catch(() => [])) {
        if (!(await c.isVisible().catch(() => false))) continue;
        const t = plainWords(((await c.innerText().catch(() => "")) || (await c.getAttribute("value").catch(() => "")) || (await c.getAttribute("aria-label").catch(() => "")) || ""));
        if (!re.test(t)) continue;
        await c.click({ timeout: 5000 }).catch(() => c.evaluate((n) => n.click()).catch(() => {}));
        return true;
      }
    }
    return false;
  };
  const put = async (sel, value) => {
    const box = await shown(sel);
    if (!box || value === undefined || value === null || value === "") return false;
    await box.fill(String(value), { timeout: 5000 }).catch(() => {});
    return true;
  };
  const choose = async (sel, re) => {
    const box = await shown(sel);
    if (!box) return false;
    const value = await box
      .evaluate((n, src) => {
        const want = new RegExp(src, "i");
        const o = Array.from(n.options ?? []).find((x) => want.test((x.textContent || "").trim()));
        return o ? o.value : null;
      }, re.source)
      .catch(() => null);
    if (value === null) return false;
    await box.selectOption(value, { timeout: 4000 }).catch(() => {});
    return true;
  };
  // Where the page is now, by which of the two forms is on it.
  const where = async () => ((await shown("#fbclc_userName")) ? "register" : (await shown("#username")) ? "signin" : "other");

  const signIn = async () => {
    await put("#username", email);
    await put("#password", password);
    if (!(await pressNamed(/^(sign in|log in)$/i, "button, input[type=submit], input[type=button]"))) return "no Sign In button on the page";
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForTimeout(4500);
    return (await where()) === "signin" ? "the portal did not accept the saved sign-in" : null;
  };

  let at = await where();
  if (existing) {
    if (at === "register") {
      await pressNamed(/^(please sign in|sign in|already (a user|registered|have an account).*)$/i);
      await page.waitForTimeout(2500);
      at = await where();
    }
    if (at === "signin") {
      const why = await signIn();
      if (!why) {
        await saveAccount(key, email, password, "active", job.id, "signed in on SuccessFactors");
        console.log("    successfactors: signed in with the saved account");
        return { ok: true };
      }
      WALLED_HOSTS.add(key);
      return { ok: false, reason: why };
    }
    return { ok: false, reason: "the SuccessFactors sign-in page was not where it was expected" };
  }

  if (at === "signin") {
    if (!(await pressNamed(/^(create an account|create account|not a registered user.*|new user.*)$/i))) {
      return { ok: false, reason: "no Create an account link on the SuccessFactors sign-in page" };
    }
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    for (let i = 0; i < 20 && (await where()) !== "register"; i++) await page.waitForTimeout(500);
    at = await where();
  }
  if (at !== "register") return { ok: false, reason: "the SuccessFactors registration form did not open" };

  const filled = {
    email: await put("#fbclc_userName", email),
    again: await put("#fbclc_emailConf", email),
    password: await put("#fbclc_pwd", password),
    confirm: await put("#fbclc_pwdConf", password),
    first: await put("#fbclc_fName", profile.first_name),
    last: await put("#fbclc_lName", profile.last_name),
    country: await choose("#fbclc_country", /^united states( of america)?$/),
    code: await choose("#fbclc_ituCode", /united states|\(\+?1\)|^\+?1\b/),
    phone: await put("#fbclc_phoneNumber", String(profile.phone ?? "").replace(/^\+?1(?=\d{10}$)/, "").replace(/[^0-9]/g, "")),
  };

  // The privacy statement is behind a link and has to be opened and accepted
  // before the form will go.
  let privacy = "none seen";
  // Only the form's own link, by its own wording. A footer's "Privacy
  // Policy" is a different page, and following it leaves the form behind.
  // Colgate's is called "Terms of Use" and says so only when the form is
  // refused: "Please open the Terms of Use". So every such link INSIDE the
  // registration form is opened and accepted, by position rather than by a
  // list of names — the form's own links, never the page's footer.
  const formLinks = await (await shown("#fbclc_userName"))
    .evaluateHandle((n) => {
      let box = n.parentElement;
      for (let k = 0; box && k < 12; k++, box = box.parentElement) {
        if (box.tagName === "FORM" || (box.querySelector("#fbclc_pwd") && box.querySelector("#fbclc_lName"))) break;
      }
      const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      return Array.from((box ?? document.body).querySelectorAll("a, button"))
        .filter(vis)
        .filter((e) => /terms of use|privacy|data protection|consent statement|read and accept/i.test((e.innerText || "").replace(/\s+/g, " ")));
    })
    .catch(() => null);
  const links = formLinks ? await formLinks.getProperties().catch(() => new Map()) : new Map();
  let opened = 0;
  let accepted = 0;
  for (const h of links.values()) {
    const link = h.asElement();
    if (!link) continue;
    await link.click({ timeout: 4000 }).catch(() => link.evaluate((n) => n.click()).catch(() => {}));
    opened++;
    await page.waitForTimeout(1500);
    if (await pressNamed(/^(accept|i accept|agree|i agree|ok)$/i, "button, a, input[type=button]")) accepted++;
    await page.waitForTimeout(1200);
  }
  if (opened) privacy = `${accepted} of ${opened} statement(s) accepted`;
  else if (await pressNamed(/read and accept|accept the (data )?privacy|data privacy (statement|consent)/i, "a, button")) {
    await page.waitForTimeout(1500);
    privacy = (await pressNamed(/^(accept|i accept|agree|i agree)$/i, "button, a, input[type=button]")) ? "accepted" : "opened, no Accept found";
    await page.waitForTimeout(1200);
  }
  console.log(`    successfactors: registration form filled ${JSON.stringify(filled)}; privacy statement ${privacy}`);

  const created =
    (await (async () => {
      const own = await shown("#fbclc_createAccountButton");
      if (!own) return false;
      await own.click({ timeout: 5000 }).catch(() => own.evaluate((n) => n.click()).catch(() => {}));
      return true;
    })()) || (await pressNamed(/^(create account|create an account|register|sign up)$/i, "button, input[type=submit], input[type=button], a"));
  if (!created) {
    // Coty's portal has no separate registration: the account boxes are the
    // top of the application itself, and the one button at the bottom is
    // "Apply". There is nothing to create here; the application is filled
    // in below, on this same page, and the account comes into being when it
    // is sent. The password is kept now so that it is known then.
    for (const f of page.frames()) {
      for (const c of await f.$$("button, input[type=submit], input[type=button], a").catch(() => [])) {
        if (!(await c.isVisible().catch(() => false))) continue;
        const t = plainWords(((await c.innerText().catch(() => "")) || (await c.getAttribute("value").catch(() => "")) || ""));
        if (!/^(apply|apply now|submit|submit application)$/i.test(t)) continue;
        await saveAccount(key, email, password, "active", job.id, "SuccessFactors: the account is made by the application itself");
        console.log("    successfactors: this portal registers and applies on one page; carrying on with the application");
        return { ok: true, created: true };
      }
    }
    return { ok: false, reason: "no Create Account button on the SuccessFactors registration form" };
  }
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(6000);

  if ((await where()) === "register") {
    // What the form objects to, in its own words and by which boxes it
    // marks. The email address is taken out before anything is printed.
    const said = [];
    for (const f of page.frames()) {
      const part = await f
        .evaluate(() => {
          const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
          return {
            words: Array.from(document.querySelectorAll('[class*="error" i], [class*="invalid" i], [role=alert], .feedback, [id*="error" i]'))
              .filter(vis)
              .map((e) => (e.innerText || "").replace(/\s+/g, " ").trim().slice(0, 110))
              .filter(Boolean)
              .slice(0, 6),
            empty: Array.from(document.querySelectorAll("input, select"))
              .filter((e) => e.type !== "hidden" && vis(e) && !String(e.value ?? "").trim() && (e.required || e.getAttribute("aria-required") === "true"))
              .map((e) => String(e.id || e.getAttribute("name") || "?").replace(/\d{4,}/g, "N").slice(0, 24))
              .slice(0, 8),
          };
        })
        .catch(() => null);
      if (part && (part.words.length || part.empty.length)) said.push(part);
    }
    const text = JSON.stringify(said).split(String(email)).join("[email]").slice(0, 700);
    console.log(`    successfactors: the registration form is still up; it says ${text}`);
    if (/already (exists|registered|in use)|account with this|is already/i.test(text)) {
      await saveAccount(key, email, password, "failed", job.id, "an account already exists for this email on this SuccessFactors portal");
      WALLED_HOSTS.add(key);
      return { ok: false, reason: "account already exists" };
    }
    WALLED_HOSTS.add(key);
    return { ok: false, reason: "the SuccessFactors registration form did not go through" };
  }

  await saveAccount(key, email, password, "active", job.id, "registered on SuccessFactors");
  console.log("    successfactors: registered");
  return { ok: true, created: true };
}

async function ensureAccount(page, profile, job) {
  const host = hostOf(page.url());
  if (!host) return { ok: false, reason: "no host" };
  // SAP's portals have their own two screens and their own way of telling
  // employers apart.
  if (/(^|\.)(successfactors\.(com|eu)|sapsf\.(com|eu))$/i.test(host)) return await successFactorsAccount(page, profile, job);
  if (WALLED_HOSTS.has(host)) {
    return { ok: false, reason: "this portal's sign-in already refused an earlier job in this run; not trying it again" };
  }

  // A row marked failed is not an account. Treating it as one meant a portal
  // whose registration never completed could only ever be signed into, with a
  // password that belongs to nothing — forever, because the host is unique so
  // nothing would replace it.
  const rows = (await db(`site_accounts?host=eq.${encodeURIComponent(host)}&select=*`)) ?? [];
  const existing = rows.find((r) => r.status !== "failed");
  const email = profile.email;
  const password = existing?.password ?? portalPassword();

  // Again here: the sign-in screen is reached by navigation, so a banner that
  // was dismissed on the job page can be back on this one.
  await dismissBanners(page).catch(() => {});

  // Some tenants open on a CHOOSER, not a form.
  //
  // Nine applications reported "no Create Account button on the page" against
  // a screen whose buttons were Sign In, Sign in with Google and Sign in with
  // LinkedIn, and whose field count was zero. There is no form there to fill;
  // the email form is behind the plain "Sign In" button. Press it and look
  // again — and never press the Google or LinkedIn one, which hands the
  // account to a third party the user did not choose.
  const noFieldsYet = async () =>
    (await page.$$("input[type=password], input[type=email]").catch(() => [])).length === 0;

  if (await noFieldsYet()) {
    // "Sign in with email" is the button, and it matched none of the five
    // spellings this knew — not "sign in", not "use email", not "continue
    // with email". Three Workday tenants reported no Create Account button
    // while the way in was sitting on the page: the bare header "Sign In"
    // matched, revealed nothing, and there was no second candidate to try.
    //
    // So: anything that offers email, or a plain sign in, and NEVER a
    // third-party identity button. That guard is the point of doing this by
    // name at all — pressing "Sign in with Google" would hand the account to
    // a provider the user did not choose, and both sit on this same screen.
    const WANTS_EMAIL =
      /^(sign|log)\s*(in|up)?\s*(with\s+|using\s+)?e-?mail$|^(continue|proceed|use)\s+(with\s+|using\s+)?e-?mail$|^(sign in|log in|sign up)$|^e-?mail$/i;
    const THIRD_PARTY = /google|linkedin|apple|facebook|microsoft|github|okta|sso|single[- ]sign/i;
    // Found afresh each round, and the button that names email before the
    // bare "Sign In".
    //
    // The first version collected every button once and worked down the
    // list. The header's "Sign In" came first; pressing it re-rendered the
    // page, and the handle it was still holding for "Sign in with email" was
    // dead by the time it got there. Kohl's and Cushman & Wakefield stopped
    // at this wall with the way through printed in their own failure note.
    const EMAIL_FIRST = [/e-?mail/i, /./];
    let through = false;
    for (const prefer of EMAIL_FIRST) {
      if (through) break;
      for (let round = 0; round < 2 && !through; round++) {
        let target = null;
        let label = "";
        for (const el of (await page.$$("button, a, [role=button]").catch(() => [])).slice(0, 80)) {
          const t = ((await el.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
          if (!t || THIRD_PARTY.test(t) || !WANTS_EMAIL.test(t) || !prefer.test(t)) continue;
          if (!(await el.isVisible().catch(() => false))) continue;
          target = el;
          label = t;
          break;
        }
        if (!target) break;
        try {
          await target.click({ timeout: 3000 });
        } catch {
          await target.click({ timeout: 3000, force: true }).catch(() => target.evaluate((b) => b.click()).catch(() => {}));
        }
        await until(async () => ((await noFieldsYet()) ? null : true), 6000);
        if (!(await noFieldsYet())) {
          console.log(`    pressed "${label.slice(0, 20)}" on the chooser; the sign-in form is up now`);
          through = true;
        }
      }
    }
  }

  let frame = (await richestFrame(page)).frame;
  const signup = !existing && (await looksLikeSignup(frame));

  // BOTH panels are on the page at once.
  //
  // The run log settled an argument I had been having with myself for an
  // hour: "3 password field(s)", "emailFilled: [true,false]". Workday renders
  // Sign In AND Create Account together — one email box and one password box
  // for signing in, another email and two passwords for registering.
  //
  // So there was never a panel to switch to, and counting password boxes to
  // work out which one was showing was meaningless. Worse, filling "the
  // frame" scattered the values across both forms: the email into one, the
  // passwords into the other, the consent box in neither. Each form was
  // individually incomplete, which is exactly why no error ever appeared —
  // neither was ever submitted with enough to complain about.
  //
  // The fix is to stop treating the page as one form. Find the button for
  // the errand, take the form AROUND it, and fill only inside that.
  // To sign in, first get to the sign-in panel.
  //
  // The page opens on Create Account, and offers the other one as "Already
  // have an account? Sign In". The header carries a button reading exactly
  // "Sign In" as well, which is not it — and that is the one every text match
  // has been finding, so the run pressed the header while the registration
  // form sat filled underneath.
  //
  // The page's own wording is the way to tell them apart.
  if (existing) {
    const switcher = await frame
      .evaluateHandle(() => {
        const all = Array.from(document.querySelectorAll("a, button, [role=button]"));
        return (
          all.find((e) => {
            if (!/^sign[\s-]?in$/i.test((e.innerText || "").trim())) return false;
            const near = (
              e.closest("div, p, section, li")?.innerText ?? ""
            ).toLowerCase();
            return near.includes("already have an account");
          }) ?? null
        );
      })
      .catch(() => null);
    const el = switcher?.asElement();
    if (el) {
      await el.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(2500);
      frame = (await richestFrame(page)).frame;
    }
  }

  // Workday says "Create Account"; SuccessFactors "Create an account";
  // others "Register" or "Sign up".
  const wantText = existing
    ? /^(sign[\s-]?in|log[\s-]?in)$/i
    : /^(create (an |my |your |new )?account|register( now)?|sign[\s-]?up|create (a |my )?profile)$/i;
  let action = null;
  for (const el of await frame.$$("button, input[type=submit]").catch(() => [])) {
    try {
      if (!(await el.isVisible().catch(() => false))) continue;
      if (!(await el.isEnabled().catch(() => false))) continue;
      const t = (
        (await el.innerText().catch(() => "")) ||
        (await el.getAttribute("value").catch(() => "")) ||
        ""
      )
        .replace(/\s+/g, " ")
        .trim();
      if (!wantText.test(t)) continue;
      // A button in the header is not a form's button, whatever it is called.
      // Requiring an ancestor that also holds a password field rules it out
      // by structure rather than by hoping "submit" is set.
      const inAForm = await el
        .evaluate((node) => {
          let n = node.parentElement;
          for (let i = 0; n && i < 12; i++) {
            if (n.querySelector("input[type=password]")) return true;
            n = n.parentElement;
          }
          return false;
        })
        .catch(() => false);
      if (!inAForm) continue;
      const type = await el.getAttribute("type").catch(() => null);
      if (!action || type === "submit") action = el;
      if (type === "submit") break;
    } catch {
      /* ignore */
    }
  }
  if (!action) {
    // What kind of wall this is, by shape: where it is, what its boxes are
    // called and what can be pressed. The portal's own page, nothing of the
    // owner's — and how the next portal's sign-in gets learned.
    try {
      const where = new URL(page.url());
      const shape = [];
      for (const f of page.frames()) {
        const part = await f
          .evaluate(() => {
            const shown = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
            return {
              boxes: Array.from(document.querySelectorAll("input, select"))
                .filter((e) => e.type !== "hidden" && shown(e))
                .slice(0, 14)
                .map((e) => `${String(e.id || e.getAttribute("name") || "?").replace(/\d{4,}/g, "N").slice(0, 26)}:${e.type || e.tagName.toLowerCase()}`),
              press: Array.from(document.querySelectorAll("button, a, input[type=submit], [role=button]"))
                .filter(shown)
                .map((e) => (e.innerText || e.value || "").replace(/\s+/g, " ").trim())
                .filter((t) => t && t.length < 40 && /sign|log|account|regist|creat|continue|next|apply|password|forgot|accept|agree/i.test(t))
                .slice(0, 14),
            };
          })
          .catch(() => null);
        if (part && (part.boxes.length || part.press.length)) shape.push(part);
      }
      console.log(`    the wall at ${where.hostname}${where.pathname.slice(0, 50)}: ${JSON.stringify(shape).slice(0, 900)}`);
    } catch {
      /* a description of the wall is a help, never a requirement */
    }
    return {
      ok: false,
      reason: existing
        ? "no Sign In button on the page"
        : "no Create Account button on the page (the page offered: " +
          (await page
            .$$eval("button, a, [role=button]", (els) =>
              els
                .map((e) => (e.innerText || "").replace(/\s+/g, " ").trim())
                .filter((t) => t && t.length < 28)
                .slice(0, 8)
                .join(", "),
            )
            .catch(() => "nothing readable")) +
          ")",
    };
  }

  // Everything below works inside this form, not the whole page.
  // Climb until the ancestor actually holds the fields this button submits.
  //
  // closest("form") is null here — Workday is a React app and does not use
  // form elements — so the first version fell back to the button's own
  // wrapper and then could not find an email field at all. The question is
  // not "what tag is this" but "what is the smallest thing containing this
  // button AND an email box AND a password box", and that can be asked
  // directly. With both panels on the page, the answer is the panel this
  // button belongs to.
  const scopeHandle = await action
    .evaluateHandle((el) => {
      const emailish = (i) =>
        i.offsetParent !== null &&
        ["text", "email", ""].includes(i.type) &&
        /e-?mail|username/i.test(
          `${i.getAttribute("aria-label") ?? ""} ${i.name ?? ""} ` +
            `${i.getAttribute("data-automation-id") ?? ""} ` +
            `${i.labels?.[0]?.innerText ?? ""} ${i.placeholder ?? ""}`,
        );
      let node = el.parentElement;
      for (let i = 0; node && i < 12; i++) {
        const inputs = Array.from(node.querySelectorAll("input"));
        if (inputs.some(emailish) && inputs.some((x) => x.type === "password")) return node;
        node = node.parentElement;
      }
      return null;
    })
    .catch(() => null);

  let scope = scopeHandle?.asElement() ?? frame;
  if (!scopeHandle?.asElement()) {
    console.log("    could not isolate the form around the button; filling the whole frame");
  }

  const fill = async (selector, value) => {
    const el = await scope.$(selector).catch(() => null);
    if (!el) return false;
    if (!(await el.isVisible().catch(() => false))) return false;
    await el.fill(String(value), { timeout: 5000 }).catch(() => {});
    return true;
  };

  // The email box, which has never once been filled.
  //
  // The selector below looked reasonable and matched nothing: Workday draws
  // its email field as a plain type="text" input identified by
  // data-automation-id, with no "mail" in the name or id. So every
  // registration was submitted with an empty email, and Workday refused it
  // without putting a word on the page — which is why four rounds of fixing
  // panels, buttons, banners and consent changed nothing.
  let emailDone = await fill(
    'input[type=email], input[name*="mail" i], input[id*="mail" i], ' +
      'input[data-automation-id*="mail" i], input[autocomplete="username"]',
    email,
  );

  // Still nothing: ask the labels instead of the attributes. readLabel is
  // what the form filler uses, and it reads this page correctly — the run log
  // has been printing "email address input-4" all day.
  if (!emailDone) {
    for (const el of await scope.$$("input").catch(() => [])) {
      try {
        const type = (await el.getAttribute("type")) || "text";
        if (!["text", "email", ""].includes(type)) continue;
        if (!(await el.isVisible().catch(() => false))) continue;
        const l = ((await el.evaluate(readLabel).catch(() => "")) || "").toLowerCase();
        if (!/e-?mail|username|user name/.test(l)) continue;
        await el.fill(String(email), { timeout: 5000 }).catch(() => {});
        emailDone = true;
        break;
      } catch {
        /* one unreadable field must not end the attempt */
      }
    }
  }
  if (!emailDone) {
    return { ok: false, reason: "could not find the email field on the sign-in screen" };
  }

  const passwordFields = await scope.$$("input[type=password]").catch(() => []);
  for (const field of passwordFields.slice(0, 2)) {
    await field.fill(password, { timeout: 5000 }).catch(() => {});
  }

  // Portals that ask twice sometimes label the second one "verify".
  await fill('input[name*="verify" i][type=password], input[id*="confirm" i][type=password]', password);

  // And sometimes the second box is not where the first one is.
  //
  // Kohl's and State Street show "Verify New Password", the log counted one
  // password box, and the registration was dropped without a word — while no
  // reset email came, so there was no existing account to blame. The form
  // was going in with its confirmation empty. Any box on the page that asks
  // for the password again and is still empty gets it.
  for (const box of await frame.$$("input").catch(() => [])) {
    try {
      if (!(await box.isVisible().catch(() => false))) continue;
      if (String(await box.inputValue().catch(() => "x"))) continue;
      const what = (
        ((await box.evaluate(readLabel).catch(() => "")) || "") + " " +
        ((await box.getAttribute("data-automation-id").catch(() => "")) || "") + " " +
        ((await box.getAttribute("name").catch(() => "")) || "") + " " +
        ((await box.getAttribute("id").catch(() => "")) || "")
      ).toLowerCase();
      if (!/verify|confirm|re-?enter|retype|repeat/.test(what) || !/password/.test(what)) continue;
      await box.fill(password, { timeout: 5000 }).catch(() => {});
      console.log("    registering: filled the password confirmation box, which sat outside the form");
    } catch {
      /* one unreadable box must not end the attempt */
    }
  }

  // The consent box, which nothing here has ever ticked.
  //
  // The registration screen listed it plainly — "candidate consent required"
  // — and Workday will not create an account without it. So the account was
  // never created, "Account created" was another unverified success, and the
  // password saved against this host belongs to no account at all. Signing in
  // with it later could not have worked whatever the button logic did.
  // Both the real thing and whatever a framework drew in its place — the same
  // lesson the email field just taught, applied before it costs another four
  // rounds.
  for (const box of await scope
    .$$('input[type=checkbox], [role=checkbox]')
    .catch(() => [])) {
    try {
      if (!(await box.isVisible().catch(() => false))) continue;
      if (await box.isChecked().catch(() => false)) continue;
      const boxLabel = (await box.evaluate(readLabel).catch(() => "")) || "";
      const required =
        (await box.getAttribute("required")) !== null ||
        (await box.getAttribute("aria-required")) === "true";
      // Required, or clearly a consent. Never anything else: ticking a random
      // box on a registration form is how you opt into marketing mail.
      if (!required && !/consent|agree|terms|privacy|acknowledge|accept/i.test(boxLabel)) continue;
      await box
        .check({ timeout: 3000 })
        .catch(() => box.click({ timeout: 3000 }).catch(() => {}));
    } catch {
      /* one unreadable box must not end the attempt */
    }
  }

  // The button was chosen before any of this, because the form around it is
  // what everything above was filled into.

  // Which button was actually pressed, and how many fields it had to work
  // with. "Registration did not complete" has been true three times without
  // ever saying what was attempted.
  {
    const t = ((await action.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
    // State, not contents. The repository is public, so what the fields HOLD
    // never goes in a log — only whether they hold anything.
    const state = await frame
      .evaluate(() => {
        const q = (s) => Array.from(document.querySelectorAll(s));
        return {
          // By label, not by attribute. The attribute version reported an
          // empty list while the field was being filled perfectly well by the
          // label path, which made this line actively misleading.
          emailFilled: q("input")
            .filter((e) => e.offsetParent !== null && ["text", "email", ""].includes(e.type))
            .filter((e) =>
              /e-?mail|username/i.test(
                `${e.getAttribute("aria-label") ?? ""} ${e.getAttribute("name") ?? ""} ` +
                  `${e.getAttribute("data-automation-id") ?? ""} ` +
                  `${e.labels?.[0]?.innerText ?? ""} ${e.getAttribute("placeholder") ?? ""}`,
              ),
            )
            .map((e) => e.value.length > 0),
          passwordsFilled: q('input[type=password]')
            .filter((e) => e.offsetParent !== null)
            .map((e) => e.value.length > 0),
          checkboxes: q('input[type=checkbox]')
            .filter((e) => e.offsetParent !== null)
            .map((e) => ({ checked: e.checked, required: e.required })),
          // A custom control Workday draws itself would not be an <input>.
          ariaCheckboxes: q('[role=checkbox]').map((e) => e.getAttribute("aria-checked")),
          buttons: q("button")
            .filter((e) => e.offsetParent !== null)
            .slice(0, 6)
            .map((e) => ({
              text: (e.innerText || "").trim().slice(0, 24),
              disabled: e.disabled,
              ariaDisabled: e.getAttribute("aria-disabled"),
              type: e.getAttribute("type"),
            })),
        };
      })
      .catch(() => null);
    console.log(
      `    ${existing ? "signing in" : "registering"}: pressing "${t || "(unnamed)"}" ` +
        `with ${passwordFields.length} password field(s)`,
    );
    console.log(`    form state: ${JSON.stringify(state)}`);
  }

  // Say whether the click actually landed.
  //
  // This was `.catch(() => {})`, which is the fourth swallowed catch today to
  // hide the fault underneath it. Playwright refuses a click it cannot
  // deliver — an element covering the button, a target that moves, a
  // disabled control — and throws saying which. All of that was being thrown
  // away, leaving "the page did not change" as the only symptom of a button
  // that was never really pressed.
  // Three ways to press it, because the ordinary one does not work here.
  //
  // Playwright reported the button "visible, enabled and stable" and then hung
  // on "scrolling into view" until the timeout — so the click was never
  // delivered, on every tenant, all day. Workday's layout defeats the scroll
  // it does before clicking.
  //
  // So: scroll it in by hand first, then ask Playwright to click without
  // repeating that work, and if it still will not, dispatch the click on the
  // element itself. React listens for real click events at the document root,
  // so a dispatched one reaches its handler.
  const press = async () => {
    await action.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    const direct = await action
      .click({ timeout: 6000 })
      .then(() => null)
      .catch((e) => String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 160));
    if (!direct) return null;

    const forced = await action
      .click({ timeout: 6000, force: true })
      .then(() => null)
      .catch((e) => String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 160));
    if (!forced) {
      console.log("    pressed it the second way (force), the ordinary click would not land");
      return null;
    }

    const dispatched = await action
      .evaluate((el) => {
        el.click();
        return true;
      })
      .then(() => null)
      .catch((e) => String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 160));
    if (!dispatched) {
      console.log("    pressed it the third way (dispatched), neither click would land");
      return null;
    }
    return `${direct} | forced: ${forced} | dispatched: ${dispatched}`;
  };

  const clickError = await press();
  if (clickError) {
    console.log(`    the click did not land: ${clickError}`);
    return { ok: false, reason: `could not press the button: ${clickError}` };
  }
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(4000);

  // The "Create Account" that was pressed may have been the way TO the form.
  //
  // State Street, Capital Health and Kohl's open on Sign In — one email box,
  // one password box — with "Create Account" beneath it. That button passed
  // every test for being a form's own (it sits beside a password box), so the
  // sign-in form was filled and it was pressed: which did not register
  // anything, it opened the registration form. The log said so each time
  // without being heard — "pressing Create Account with 1 password field(s)",
  // then a page asking for "Verify New Password" — and the run reported that
  // the portal had dropped a complete registration.
  //
  // A registration form that has just appeared, with its password boxes
  // empty, is that form: fill it and press its own button.
  if (!existing && passwordFields.length < 2) {
    const fresh = (await richestFrame(page)).frame;
    const boxes = [];
    for (const b of await fresh.$$("input[type=password]").catch(() => [])) {
      if (await b.isVisible().catch(() => false)) boxes.push(b);
    }
    let empty = 0;
    for (const b of boxes) if (!String(await b.inputValue().catch(() => "x"))) empty++;
    if (!(boxes.length >= 2 && empty >= 1)) {
      // Why the registration form was not recognised, when it was not: every
      // box in every frame, by what it is and whether it shows and holds
      // anything. Never what it holds.
      const seen = [];
      for (const f of page.frames()) {
        const part = await f
          .evaluate(() =>
            Array.from(document.querySelectorAll("input"))
              .filter((e) => !["hidden", "checkbox", "radio", "file", "submit"].includes(e.type))
              .slice(0, 12)
              .map((e) => {
                const r = e.getBoundingClientRect();
                const name = String(e.getAttribute("data-automation-id") || e.getAttribute("name") || e.id || "?").replace(/\d{3,}/g, "N").slice(0, 22);
                return `${name}:${e.type}:${r.width > 0 && r.height > 0 ? "shown" : "hidden"}:${e.value ? "set" : "empty"}`;
              }),
          )
          .catch(() => []);
        if (part.length) seen.push(part);
      }
      console.log(`    registering: after the press, ${boxes.length} password box(es) show, ${empty} empty; boxes by frame ${JSON.stringify(seen).slice(0, 900)}`);
    }
    if (boxes.length >= 2 && empty >= 1) {
      console.log(`    registering: that button opened the registration form (${boxes.length} password boxes, ${empty} empty); filling it`);
      let emailBoxes = 0;
      for (const el of await fresh.$$("input").catch(() => [])) {
        try {
          const type = (await el.getAttribute("type")) || "text";
          if (!["text", "email", ""].includes(type)) continue;
          if (!(await el.isVisible().catch(() => false))) continue;
          const l = (
            ((await el.evaluate(readLabel).catch(() => "")) || "") + " " +
            ((await el.getAttribute("data-automation-id").catch(() => "")) || "") + " " +
            ((await el.getAttribute("name").catch(() => "")) || "") + " " +
            ((await el.getAttribute("autocomplete").catch(() => "")) || "")
          ).toLowerCase();
          if (!/e-?mail|username|user name/.test(l)) continue;
          await el.fill(String(email), { timeout: 5000 }).catch(() => {});
          emailBoxes++;
        } catch {
          /* one unreadable field must not end the attempt */
        }
      }
      for (const b of boxes) await b.fill(password, { timeout: 5000 }).catch(() => {});
      for (const box of await fresh.$$('input[type=checkbox], [role=checkbox]').catch(() => [])) {
        try {
          if (!(await box.isVisible().catch(() => false))) continue;
          if (await box.isChecked().catch(() => false)) continue;
          const boxLabel = (await box.evaluate(readLabel).catch(() => "")) || "";
          const required =
            (await box.getAttribute("required")) !== null ||
            (await box.getAttribute("aria-required")) === "true";
          // The same rule as above: required, or plainly a consent.
          if (!required && !/consent|agree|terms|privacy|acknowledge|accept/i.test(boxLabel)) continue;
          await box.check({ timeout: 3000 }).catch(() => box.click({ timeout: 3000 }).catch(() => {}));
        } catch {
          /* one unreadable box must not end the attempt */
        }
      }
      // This form's own button: "Create Account" with the password boxes
      // around it, a submit where there is one.
      let own = null;
      for (const el of await fresh.$$("button, input[type=submit]").catch(() => [])) {
        try {
          if (!(await el.isVisible().catch(() => false))) continue;
          if (!(await el.isEnabled().catch(() => false))) continue;
          const t = ((await el.innerText().catch(() => "")) || (await el.getAttribute("value").catch(() => "")) || "").replace(/\s+/g, " ").trim();
          if (!/^create account$/i.test(t)) continue;
          const beside = await el
            .evaluate((node) => {
              let n = node.parentElement;
              for (let i = 0; n && i < 12; i++) {
                if (n.querySelectorAll("input[type=password]").length >= 2) return true;
                n = n.parentElement;
              }
              return false;
            })
            .catch(() => false);
          if (!beside) continue;
          const type = await el.getAttribute("type").catch(() => null);
          if (!own || type === "submit") own = el;
          if (type === "submit") break;
        } catch {
          /* ignore */
        }
      }
      if (own) {
        action = own;
        scope = fresh;
        console.log(`    registering: pressing the registration form's own "Create Account" (email boxes filled: ${emailBoxes})`);
        const again = await press();
        if (again) console.log(`    the click did not land: ${again}`);
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        await page.waitForTimeout(4000);

        // Capital Health and State Street: the form was filled, the button
        // was pressed the forceful way, and the page did not move and did not
        // complain — which is a press that never reached anything, not a
        // registration refused. Workday lays a cover over its buttons and
        // listens there; a forced click aimed at the button beneath can miss
        // both. So while the form is still up, press it the other ways a
        // person's click could arrive, one at a time, and stop at the first
        // that moves the page.
        const shownPasswords = async () => {
          const out = [];
          for (const b of await fresh.$$("input[type=password]").catch(() => [])) {
            if (await b.isVisible().catch(() => false)) out.push(b);
          }
          return out;
        };
        let up = await shownPasswords();
        if (up.length >= 2) {
          let refilled = 0;
          for (const b of up) {
            if (String(await b.inputValue().catch(() => "x"))) continue;
            await b.fill(password, { timeout: 5000 }).catch(() => {});
            refilled++;
          }
          if (refilled) console.log(`    registering: ${refilled} password box(es) had been emptied by the page; filled again`);
          const ways = [
            [
              "the cover Workday lays over the button",
              async () => {
                const cover = (await own.evaluateHandle((b) => b.parentElement?.querySelector('[data-automation-id="click_filter"]') ?? null)).asElement();
                if (!cover) return false;
                await cover.click({ timeout: 4000 });
                return true;
              },
            ],
            ["a click sent to the button itself", async () => { await own.evaluate((b) => b.click()); return true; }],
            ["Enter in the last password box", async () => { await up[up.length - 1].press("Enter", { timeout: 4000 }); return true; }],
          ];
          for (const [name, go] of ways) {
            if (!(await go().catch(() => false))) continue;
            await page.waitForLoadState("domcontentloaded").catch(() => {});
            await page.waitForTimeout(3500);
            up = await shownPasswords();
            console.log(`    registering: the form had not moved; tried ${name} — ${up.length >= 2 ? "still there" : "it moved"}`);
            if (up.length < 2) break;
          }
        }
      } else {
        console.log("    registering: the registration form has no Create Account button of its own that could be found");
      }
    }
  }

  let after = ((await page.innerText("body").catch(() => "")) || "").toLowerCase();

  // "Error: Please check the box to continue" — Comcast, in as many words.
  //
  // The checkbox pass ticks what is marked required or reads as consent, and
  // deliberately leaves anything else alone: ticking an unknown box on a
  // registration form is how someone gets signed up for marketing in their
  // own name. Comcast's box is neither marked required nor worded like
  // consent, so it stayed empty and the form refused.
  //
  // Asking the form first keeps both properties. Nothing is ticked blindly;
  // it is ticked because the page said, in response to a real attempt, that
  // a box is what it is waiting for.
  if (/check the box|must agree|accept the terms|please consent|required to continue/i.test(after)) {
    let ticked = 0;
    for (const box of await scope.$$('input[type=checkbox], [role=checkbox]').catch(() => [])) {
      try {
        if (!(await box.isVisible().catch(() => false))) continue;
        if (await box.isChecked().catch(() => false)) continue;
        await box.check({ timeout: 3000 }).catch(() => box.click({ timeout: 3000, force: true }).catch(() => {}));
        ticked++;
      } catch {
        /* one box must not end the attempt */
      }
    }
    if (ticked) {
      console.log(`    the form asked for a box to be ticked; ticked ${ticked} and tried again`);
      await press();
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await page.waitForTimeout(4000);
      after = ((await page.innerText("body").catch(() => "")) || "").toLowerCase();
    }
  }

  // Verification by email. No longer a hard stop: the inbox is wired up.
  //
  // Workday sends a LINK, not a code — "Click this link to confirm your email
  // address and complete setup for your candidate account", good for 24
  // hours. So the panel is asked for it, which reads the connected mailbox,
  // and the link is opened here.
  if (/verify your email|verification (code|email)|check your (email|inbox)|we sent you a|confirm your email/.test(after)) {
    const link = await waitForVerificationLink(host);
    if (link) {
      console.log("    opening the verification link from the inbox");
      await page.goto(link, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
      await page.waitForTimeout(4000);
      await dismissBanners(page).catch(() => {});
      if (signup) await saveAccount(host, email, password, "active", job.id, "verified by email link");
      return { ok: true, created: signup, verified: true };
    }

    if (signup) {
      await saveAccount(host, email, password, "pending_verification", job.id,
        "portal emailed a verification link; it had not arrived in time");
    }
    return { ok: false, reason: "email_verification" };
  }

  if (/password (does not|doesn't) meet|invalid password|password must/.test(after)) {
    return { ok: false, reason: "password rejected by portal" };
  }
  if (/already (exists|registered)|account with this email/.test(after)) {
    // Someone (or an earlier run) registered already and we lack the password.
    if (!RESET_TRIED.has(host)) {
      RESET_TRIED.add(host);
      const fresh = portalPassword();
      await page.goto(page.url(), { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
      await page.waitForTimeout(2500);
      if (await resetPassword(page, host, email, fresh)) {
        await saveAccount(host, email, fresh, "active", job.id, "password reset through the portal's own email link");
        return await signInAfterReset(page, profile, job);
      }
    }
    await saveAccount(host, email, password, "failed", job.id,
      "an account already exists for this email");
    return { ok: false, reason: "account already exists" };
  }

  // Did it actually get past the wall?
  //
  // Nothing above proves it did. The checks are all for KNOWN failures, so
  // anything unrecognised fell through to "ok" — and that is how twenty-five
  // AT&T postings each reported "signed in with the saved account", were
  // requeued, met the same login screen, and spent thirty-three minutes
  // doing it. It is the same mistake the submit path made this morning:
  // absence of a known error is not evidence of success.
  //
  // A password box still on screen is evidence of the opposite.
  const after2 = (await richestFrame(page)).frame;
  const stillThere = await after2.$("input[type=password]").catch(() => null);
  if (stillThere && (await stillThere.isVisible().catch(() => false))) {
    const texts = [];
    for (const el of (await after2.$$("a, button, [role=button]").catch(() => [])).slice(0, 40)) {
      const t = ((await el.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
      if (t && texts.length < 14) texts.push(t.slice(0, 40));
    }
    // What is the form objecting to? Three attempts have now ended here with
    // nothing but a list of buttons, and a registration form that refuses a
    // submission almost always says why somewhere on the page.
    const complaints = [];
    for (const sel of [
      "[role=alert]",
      '[aria-invalid="true"]',
      '[class*="error" i]',
      '[data-automation-id*="error" i]',
      '[id*="error" i]',
    ]) {
      for (const el of (await after2.$$(sel).catch(() => [])).slice(0, 10)) {
        try {
          if (!(await el.isVisible().catch(() => false))) continue;
          const t = (
            (await el.innerText().catch(() => "")) ||
            (await el.getAttribute("aria-label").catch(() => "")) ||
            ""
          )
            .replace(/\s+/g, " ")
            .trim();
          if (t && t.length < 160 && !complaints.includes(t)) complaints.push(t);
        } catch {
          /* ignore */
        }
      }
    }
    // Registered, and Workday has moved on to its sign-in screen.
    //
    // The registration screen asks for "Verify New Password". The sign-in one
    // does not. A password box still being on screen was read as failure,
    // when for a registration that SUCCEEDED this is exactly what success
    // looks like: the account exists, and the portal now wants it signed
    // into. Two of the last four did this and were reported as failures.
    const bodyNow = ((await page.innerText("body").catch(() => "")) || "").toLowerCase();
    if (signup && !/verify new password/.test(bodyNow)) {
      console.log("    registered; the portal moved on to its sign-in screen");
      await saveAccount(host, email, password, "active", job.id,
        "registered, signing in on the next pass");
      return { ok: true, created: true };
    }

    console.log(`    still on the login screen; controls: ${JSON.stringify(texts)}`);
    console.log(`    page complaints: ${JSON.stringify(complaints.slice(0, 8))}`);

    // Nothing in the error elements, three times running. So read the page's
    // own words — the sentences that mention the things a registration form
    // refuses over — rather than inferring from its silence a seventh time.
    //
    // The address is redacted before anything is logged: this repository is
    // public and its run logs are public with it.
    const body = ((await page.innerText("body").catch(() => "")) || "")
      .split(String(email))
      .join("[email]");
    const lines = body
      .split(/\n+/)
      .map((l) => l.replace(/\s+/g, " ").trim())
      .filter(
        (l) =>
          l.length > 8 &&
          l.length < 180 &&
          /password|email|address|required|must|invalid|already|unable|cannot|try again|sorry|error/i.test(
            l,
          ),
      );
    console.log(`    page says: ${JSON.stringify([...new Set(lines)].slice(0, 10))}`);
    // An account that exists and will not open: reset its password.
    //
    // Prudential has an account under this address whose password is not the
    // one on file, and every posting there ended at this screen. The portal
    // offers its own way out, and the inbox it writes to is connected.
    //
    // The same goes for a registration the portal drops without a word:
    // Kohl's, CarMax and Cushman & Wakefield each took a complete form —
    // address, both passwords, consent — and simply showed it again. A portal
    // that will not say "this address is already registered" behaves exactly
    // like that, and asking for a reset answers the question: the email only
    // comes if the account is there.
    if (
      !RESET_TRIED.has(host) &&
      (signup || existing || /wrong email|incorrect|invalid|locked|does not match/i.test(bodyNow))
    ) {
      RESET_TRIED.add(host);
      const fresh = portalPassword();
      if (await resetPassword(page, host, email, fresh)) {
        await saveAccount(host, email, fresh, "active", job.id, "password reset through the portal's own email link");
        return await signInAfterReset(page, profile, job);
      }
    }

    // Mark it failed so the next run registers afresh instead of signing in
    // forever with a password that may belong to no account.
    if (existing) {
      await saveAccount(host, existing.email ?? email, existing.password ?? password, "failed",
        job.id, "signing in with this did not get past the login screen");
    }
    WALLED_HOSTS.add(host);
    return {
      ok: false,
      reason: signup
        ? "registration did not complete — the password screen is still showing"
        : "sign-in did not complete — the password screen is still showing",
    };
  }

  // Some tenants verify silently. They let the sign-in through, say nothing
  // on the page, and email an activation link anyway — Bristol Myers Squibb
  // did exactly that: the mail arrived while the applier was already filling
  // the form, the screen never asked for it, so nothing opened it and the
  // account stayed unverified. Look for a link whenever we have just got in,
  // not only when the screen tells us to.
  let verifiedNow = false;
  // Once per host per run. This was costing seventeen seconds on every
  // single job and finding nothing almost every time: a portal emails the
  // link when the account is made, not each time it is used.
  if (!/verified/i.test(String(existing?.note ?? "")) && !CHECKED_INBOX.has(host)) {
    CHECKED_INBOX.add(host);
    const quiet = await waitForVerificationLink(host, signup ? 3 : 1, 6000);
    if (quiet) verifiedNow = await openVerificationLink(page, quiet);
  }

  if (signup || verifiedNow) {
    await saveAccount(
      host,
      email,
      password,
      "active",
      job.id,
      verifiedNow ? "verified by email link" : null,
    );
  } else if (existing) {
    await db(`site_accounts?host=eq.${encodeURIComponent(host)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ last_used_at: new Date().toISOString() }),
    }).catch(() => {});
  }

  return { ok: true, created: signup, verified: verifiedNow };
}

const RESET_TRIED = new Set();

/**
 * The portal's own "Forgot your password?" route, start to finish: ask for
 * the email, read the link from the connected inbox, set a new password.
 * True only when the portal has accepted the new password.
 */
async function resetPassword(page, host, email, fresh) {
  const startUrl = page.url();
  // The first element that is actually on screen, not merely first in the
  // markup: Workday keeps both panels' fields in the page at once.
  const firstShown = async (frame, selector, test) => {
    for (const el of (await frame.$$(selector).catch(() => [])).slice(0, 60)) {
      try {
        if (!(await el.isVisible().catch(() => false))) continue;
        if (test && !(await test(el))) continue;
        return el;
      } catch {
        /* keep looking */
      }
    }
    return null;
  };
  const textOf = async (el) =>
    (
      (await el.innerText().catch(() => "")) ||
      (await el.getAttribute("aria-label").catch(() => "")) ||
      (await el.getAttribute("value").catch(() => "")) ||
      ""
    )
      .replace(/\s+/g, " ")
      .trim();
  const pressIt = async (el) => {
    await el.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    await el
      .click({ timeout: 4000 })
      .catch(() => el.click({ force: true, timeout: 4000 }).catch(() => el.evaluate((n) => n.click()).catch(() => {})));
  };

  try {
    let frame = (await richestFrame(page)).frame;
    const findForgot = async () =>
      await firstShown(frame, "a, button, [role=button], [role=link]", async (el) =>
        /forgot.{0,12}password|reset.{0,6}password/i.test(await textOf(el)),
      );
    let forgot = await findForgot();
    if (!forgot) {
      // The link lives on the sign-in panel, and a registration that was
      // dropped leaves the page on the other one: "Already have an account?
      // Sign In" is the way across.
      const across = await frame
        .evaluateHandle(() => {
          const all = Array.from(document.querySelectorAll("a, button, [role=button], [role=link]"));
          return (
            all.find((e) => {
              if (!/^sign[\s-]?in$/i.test((e.innerText || "").trim())) return false;
              const near = (e.closest("div, p, section, li")?.innerText ?? "").toLowerCase();
              return near.includes("already have an account");
            }) ?? null
          );
        })
        .catch(() => null);
      const el = across?.asElement();
      if (el) {
        await pressIt(el);
        await page.waitForTimeout(2500);
        frame = (await richestFrame(page)).frame;
        forgot = await findForgot();
      }
    }
    if (!forgot) {
      console.log("    password reset: no forgot-password control on this screen");
      return false;
    }
    await pressIt(forgot);
    await page.waitForTimeout(2500);

    frame = (await richestFrame(page)).frame;
    const box = await firstShown(frame, "input", async (el) => {
      const type = ((await el.getAttribute("type").catch(() => "")) || "text").toLowerCase();
      if (!["text", "email"].includes(type)) return false;
      const l = (
        ((await el.evaluate(readLabel).catch(() => "")) || "") +
        " " +
        ((await el.getAttribute("data-automation-id").catch(() => "")) || "") +
        " " +
        ((await el.getAttribute("name").catch(() => "")) || "")
      ).toLowerCase();
      return /e-?mail|user ?name/.test(l);
    });
    if (!box) {
      console.log("    password reset: the forgot-password screen has no email box");
      return false;
    }
    await box.fill(String(email), { timeout: 4000 }).catch(() => {});
    const send = await firstShown(frame, "button, input[type=submit], [role=button]", async (el) =>
      /^(reset password|reset|send( reset)?( link| email)?|submit|continue|next)$/i.test(await textOf(el)),
    );
    if (send) await pressIt(send);
    else await box.press("Enter").catch(() => {});
    console.log(`    password reset: asked the portal for the email (${send ? "button" : "Enter"})`);
    await page.waitForTimeout(3000);

    const link = await waitForVerificationLink(host, 9, 9000, "reset");
    if (!link) {
      // No mail means no account under this address, or a portal that will
      // not say. Either way there is nothing to reset.
      console.log("    password reset: no reset email arrived");
      await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
      await page.waitForTimeout(2500);
      return false;
    }
    await page.goto(link, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(4500);
    await dismissBanners(page).catch(() => {});

    frame = (await richestFrame(page)).frame;
    const shownPasswords = async () => {
      const out = [];
      for (const b of await (await richestFrame(page)).frame.$$("input[type=password]").catch(() => [])) {
        if (await b.isVisible().catch(() => false)) out.push(b);
      }
      return out;
    };
    const boxes = await shownPasswords();
    if (!boxes.length) {
      // Structure and wording only; the address never goes in a public log.
      const says = ((await page.innerText("body").catch(() => "")) || "")
        .split(String(email)).join("[email]")
        .replace(/\s+/g, " ")
        .slice(0, 140);
      console.log(`    password reset: the reset link opened a page with no password box — it says: ${JSON.stringify(says)}`);
      return false;
    }
    // Some tenants ask for the address again on this screen.
    const again = await firstShown(frame, "input", async (el) => {
      const type = ((await el.getAttribute("type").catch(() => "")) || "text").toLowerCase();
      if (!["text", "email"].includes(type)) return false;
      if (String(await el.inputValue().catch(() => "x")).trim()) return false;
      const l = ((await el.evaluate(readLabel).catch(() => "")) || "").toLowerCase();
      return /e-?mail|user ?name/.test(l);
    });
    if (again) await again.fill(String(email), { timeout: 4000 }).catch(() => {});
    for (const b of boxes.slice(0, 2)) await b.fill(fresh, { timeout: 4000 }).catch(() => {});

    const done = await firstShown(frame, "button, input[type=submit], [role=button]", async (el) =>
      /^(submit|reset password|reset|save|change password|continue|confirm|update password|set password)$/i.test(await textOf(el)),
    );
    if (done) await pressIt(done);
    else await boxes[boxes.length - 1].press("Enter").catch(() => {});
    await page.waitForTimeout(5000);

    const text = ((await page.innerText("body").catch(() => "")) || "").toLowerCase();
    const refused = /does not meet|must contain|expired|not valid|no longer valid|do not match|cannot be (the same|reused)|previously used/.test(text);
    // Two password boxes still showing is the reset form still waiting.
    const still = (await shownPasswords()).length;
    if (refused || still >= 2) {
      console.log(`    password reset: the portal refused the new password (${still} password box(es) still showing)`);
      return false;
    }
    console.log("    password reset: the portal took the new password");
    // Back to where the application was, to sign in.
    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(3500);
    await dismissBanners(page).catch(() => {});
    return true;
  } catch (e) {
    console.log(`    password reset did not complete: ${String(e?.message ?? e).split("\n")[0].slice(0, 100)}`);
    return false;
  }
}

/**
 * After a reset: sign in with the new password, unless the portal has already
 * let us in — a signed-in page has no password box and no Sign In to press.
 */
async function signInAfterReset(page, profile, job) {
  const frame = (await richestFrame(page)).frame;
  let wall = false;
  for (const b of await frame.$$("input[type=password]").catch(() => [])) {
    if (await b.isVisible().catch(() => false)) wall = true;
  }
  if (!wall) {
    for (const el of (await frame.$$("button, a, [role=button]").catch(() => [])).slice(0, 80)) {
      const t = ((await el.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
      if (/^(sign|log)\s*in( with e-?mail)?$/i.test(t) && (await el.isVisible().catch(() => false))) { wall = true; break; }
    }
  }
  if (!wall) {
    console.log("    password reset: already signed in after the reset");
    return { ok: true, created: false };
  }
  return await ensureAccount(page, profile, job);
}

/**
 * Oracle Recruiting's first screen: an email address, a terms box, Next —
 * and then a code sent to that address before the application itself opens.
 *
 * There is no account and no password. The code is read from the connected
 * inbox the same way Greenhouse's is.
 */
/**
 * Oracle's address boxes: the zip, the street, the city.
 *
 * Each offers suggestions and keeps only a suggestion that was chosen; text
 * that was merely typed is shown in the box and then rejected at submit
 * ("The Address Line 1 field is required"). The suggestions arrive from the
 * portal's server, sometimes after several seconds, so they are waited for
 * and the typing is done once more if none come. The zip goes first because
 * its suggestion writes the city and state as the portal spells them.
 */
async function oracleAddress(page, form, profile) {
  let done = 0;
  // The country leads: the zip and street suggestions are looked up within
  // it, and a country that was typed but not chosen yields none.
  const parts = [
    ["country", "United States"],
    ["addressLine1", profile?.address],
    ["city", profile?.city],
    // The zip last: choosing a city after it emptied the zip again, and
    // Oracle then refused the form for "ZIP Code is required".
    ["postalCode", profile?.postal_code],
  ];
  for (const [stem, value] of parts) {
    if (!value) continue;
    // By the whole id. "country-" alone also matched the phone number's
    // dialling-code box, country-codes-dropdownphoneNumber, and the country
    // was being typed into that.
    let box = null;
    for (const c of await form.$$(`input[id^="${stem}-"]`).catch(() => [])) {
      const id = (await c.getAttribute("id").catch(() => "")) ?? "";
      if (new RegExp(`^${stem}-\\d+$`).test(id) && (await c.isVisible().catch(() => false))) { box = c; break; }
    }
    if (!box) continue;
    const held = String(await box.inputValue().catch(() => "")).trim();
    const chosenBefore = await box.getAttribute("data-applypilot-chosen").catch(() => null);
    if (held && chosenBefore) continue;
    // A country the portal itself is showing, and not complaining about, is
    // left alone.
    if (stem === "country" && /^united states$/i.test(held) && (await box.getAttribute("aria-invalid").catch(() => null)) !== "true") continue;

    await box.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    const listId = String((await box.getAttribute("aria-controls").catch(() => null)) ?? "").replace(/["\\]/g, "");
    // The list says "loading" for a while after the typing stops; its items
    // are rows of the portal's own, not ordinary options.
    const items = async () =>
      listId
        ? await form.$$(`[id="${listId}"] .cx-select__list-item:not(.cx-select__list-item--loading), [id="${listId}"] [role=option], [id="${listId}"] li[role=row], [id="${listId}"] [role=gridcell]`).catch(() => [])
        : [];
    let found = [];
    for (let attempt = 0; attempt < 2 && !found.length; attempt++) {
      await box.click({ timeout: 3000 }).catch(() => {});
      await box.fill("", { timeout: 3000 }).catch(() => {});
      await box.type(String(value), { delay: 60 + attempt * 60 }).catch(() => {});
      found = (await until(async () => { const l = await items(); return l.length ? l : null; }, 9000, 400)) ?? [];
    }

    let took = false;
    if (found.length) {
      // The item that says what was typed, exactly for the country — "United
      // States Minor Outlying Islands" is also on that list — and otherwise
      // the first that contains it.
      const want = String(value).trim().toLowerCase();
      let pick = null;
      for (const it of found.slice(0, 12)) {
        const t = ((await it.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim().toLowerCase();
        if (stem === "country" ? t === want : t.includes(want)) {
          // "Princeton" is a town in more than one state.
          const st = String(profile?.state ?? "").trim().toLowerCase();
          if (stem === "city" && st && !new RegExp(`\\b${st}\\b`).test(t) && !pick) { pick = it; continue; }
          pick = it;
          break;
        }
      }
      if (!pick && stem !== "country") pick = found[0];
      if (pick) {
        await pick.click({ timeout: 3000 }).catch(() => pick.click({ timeout: 3000, force: true }).catch(() => {}));
        await box.evaluate((n) => n.setAttribute("data-applypilot-chosen", "1")).catch(() => {});
        took = true;
      }
    }
    if (!took) await page.keyboard.press("Tab").catch(() => {});
    // Choosing the country redraws the address section under it.
    await page.waitForTimeout(stem === "country" ? 3500 : 1500);
    const kept = String(await box.inputValue().catch(() => "")).trim();
    console.log(`    oracle: ${stem} ${took ? `chose 1 of ${found.length} suggestion(s)` : `had ${found.length} suggestion(s), none chosen`}; ${kept ? "holds a value" : "is empty"}`);
    if (kept) done++;
  }
  return done;
}

/**
 * Oracle's screening questions: a row of pill buttons per question, which the
 * general pass does not see because they are neither inputs nor dropdowns.
 * Sherwin-Williams refused an application over seven of them.
 *
 * Answered with the same rules as every other question. A form of address
 * ("Title: Dr / Miss / Mr") and anything with no answer on file are left.
 */
async function oraclePills(page, form, profile, job, lookupSaved = () => null) {
  let done = 0;
  // The questions are drawn as the page is scrolled: one was on screen when
  // this first looked and six more were further down. So look, scroll to the
  // last one seen, and look again until nothing new turns up.
  let seen = 0;
  let hidden = 0;
  const tally = { already: 0, unlabelled: 0, address: 0 };
  for (let round = 0; round < 5; round++) {
  let groups = (await form.$$('[role=radiogroup]:has(button[role=radio].cx-select-pill-section):not([data-applypilot-seen])').catch(() => [])).slice(0, 40);
  if (!groups.length) {
    // Four of Sherwin-Williams' seventeen were not in the page until it was
    // scrolled to the end; Oracle's issue list then stopped on each of them
    // with neither pill chosen.
    await form.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
      for (const e of document.querySelectorAll("main, [class*=scroll i], [class*=content i]")) {
        if (e.scrollHeight > e.clientHeight + 40) e.scrollTop = e.scrollHeight;
      }
    }).catch(() => {});
    await page.keyboard.press("End").catch(() => {});
    await page.waitForTimeout(1500);
    groups = (await form.$$('[role=radiogroup]:has(button[role=radio].cx-select-pill-section):not([data-applypilot-seen])').catch(() => [])).slice(0, 40);
  }
  if (!groups.length) break;
  hidden = 0;
  seen = 0;
  for (const group of groups) {
    try {
      seen++;
      await group.scrollIntoViewIfNeeded({ timeout: 2500 }).catch(() => {});
      // A question on a later screen is in the page already, unseen. It is
      // only counted as dealt with once it has actually been on screen.
      if (!(await group.isVisible().catch(() => false))) { hidden++; continue; }
      await group.evaluate((g) => g.setAttribute("data-applypilot-seen", "1")).catch(() => {});
      const pills = await group.$$('button[role=radio]').catch(() => []);
      if (!pills.length) continue;
      let already = false;
      for (const b of pills) {
        if ((await b.getAttribute("aria-checked").catch(() => null)) === "true") { already = true; break; }
      }
      if (already) { tally.already++; continue; }
      const label = String(
        (await group
          .evaluate((g) => {
            const row = g.closest(".input-row");
            const l = row?.querySelector("label");
            return (l?.innerText ?? g.getAttribute("aria-label") ?? "").replace(/\s+/g, " ").replace(/\*\s*$/, "").trim();
          })
          .catch(() => "")) || "",
      );
      if (!label) { tally.unlabelled++; continue; }
      const l = label.toLowerCase();
      if (/^(title|prefix|salutation|suffix)\b/.test(l)) { tally.address++; continue; }
      const texts = [];
      for (const b of pills) texts.push(((await b.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim());
      const want = answerQuestion(l, profile) ?? lookupSaved(l) ?? lastResort(l, profile, job);
      if (want === null || want === undefined || want === "") {
        console.log(`    oracle question "${label.slice(0, 70)}" has no answer on file; offered ${JSON.stringify(texts.slice(0, 6))}`);
        continue;
      }
      const picks = texts.map((t, k) => ({ el: pills[k], text: t }));
      const chosen = bestOption(picks, want, l);
      if (!chosen) {
        console.log(`    oracle question "${label.slice(0, 50)}" wanted ${JSON.stringify(String(want).slice(0, 20))}; offered ${JSON.stringify(texts.slice(0, 6))}`);
        continue;
      }
      await chosen.el.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
      await chosen.el.click({ timeout: 3000 }).catch(() => chosen.el.click({ timeout: 3000, force: true }).catch(() => {}));
      await page.waitForTimeout(350);
      const on = (await chosen.el.getAttribute("aria-checked").catch(() => null)) === "true";
      console.log(`    oracle question "${label.slice(0, 50)}" -> "${chosen.text.slice(0, 20)}"${on ? "" : " (did not take)"}`);
      if (on) done++;
    } catch (e) {
      // One question failing must not stop the rest — but say so: a missing
      // name in here once skipped every question in silence.
      console.log(`    oracle question skipped: ${String(e?.message ?? e).slice(0, 60)}`);
    }
  }
  await page.waitForTimeout(700);
  }
  if (seen || done) console.log(`    oracle: pill questions — ${done} answered now, ${hidden} on other screens, ${JSON.stringify(tally)}`);
  return done;
}

/**
 * Type into one of Oracle's lookup boxes and click the item `pick` chooses
 * from what it offers. Returns the chosen item's words, or null.
 */
async function oracleLookup(page, form, box, typed, pick) {
  await box.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
  const listId = String((await box.getAttribute("aria-controls").catch(() => null)) ?? "").replace(/["\\]/g, "");
  const items = async () =>
    listId ? await form.$$(`[id="${listId}"] .cx-select__list-item:not(.cx-select__list-item--loading)`).catch(() => []) : [];
  let found = [];
  for (let attempt = 0; attempt < 2 && !found.length; attempt++) {
    await box.click({ timeout: 3000 }).catch(() => {});
    await box.fill("", { timeout: 3000 }).catch(() => {});
    await box.type(String(typed), { delay: 60 + attempt * 60 }).catch(() => {});
    found = (await until(async () => { const l = await items(); return l.length ? l : null; }, 9000, 400)) ?? [];
  }
  const texts = [];
  for (const it of found.slice(0, 40)) texts.push(((await it.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim());
  const k = texts.length ? pick(texts) : -1;
  if (k < 0 || !found[k]) {
    await page.keyboard.press("Escape").catch(() => {});
    return null;
  }
  await found[k].click({ timeout: 3000 }).catch(() => found[k].click({ timeout: 3000, force: true }).catch(() => {}));
  await page.waitForTimeout(900);
  return texts[k];
}

/**
 * Press the SAVE of the entry that is open. Every entry on the page has one,
 * most of them hidden, and the first in the page is rarely the one on screen.
 * Returns true when no SAVE is left showing afterwards.
 */
async function oracleSave(page, form) {
  const showing = async () => {
    const out = [];
    for (const b of await form.$$("button").catch(() => [])) {
      if (!(await b.isVisible().catch(() => false))) continue;
      const t = ((await b.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
      if (/^save$/i.test(t)) out.push(b);
    }
    return out;
  };
  const buttons = await showing();
  if (!buttons.length) return false;
  const b = buttons[buttons.length - 1];
  await b.scrollIntoViewIfNeeded({ timeout: 2500 }).catch(() => {});
  await b.click({ timeout: 3000 }).catch(() => b.evaluate((n) => n.click()).catch(() => {}));
  await page.waitForTimeout(2500);
  const left = (await showing()).length;
  if (left) {
    // What the entry still objects to, by what the boxes are.
    const still = await form
      .evaluate(() => {
        const shown = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        return Array.from(document.querySelectorAll('input, select, textarea'))
          .filter((c) => shown(c) && (c.getAttribute("aria-invalid") === "true" || ((c.required || c.getAttribute("aria-required") === "true") && !String(c.value ?? "").trim())))
          .map((c) => String(c.id || c.getAttribute("name") || c.tagName).replace(/\d+/g, "N").slice(0, 34))
          .slice(0, 8);
      })
      .catch(() => []);
    console.log(`    oracle entry: SAVE pressed and the entry stayed open; it still marks ${JSON.stringify(still)}`);
  }
  return left === 0;
}

/**
 * The half of "title, employer" a portal's reader of the resume lost, found
 * beside the half it kept.
 *
 * Every portal that reads a resume into boxes does this: an employer with no
 * title, or a title with no employer, and a form that will not go on until
 * both are there. The missing half is on the same line of the resume as the
 * half that was kept, or — where the resume gives one field to a line — on
 * the line beside it. Returns "" when the resume does not show it; nothing
 * is ever made up to fill the box.
 */
function otherHalfOnResume(resumeText, kept, want) {
  const anchor = String(kept ?? "").trim();
  if (!anchor || !resumeText) return "";
  const low = anchor.toLowerCase();
  const lines = String(resumeText).split(/\r?\n/).map((x) => x.trim());
  let at = lines.findIndex((x) => x.toLowerCase().includes(low));
  let key = low;
  if (at < 0) {
    // "Staples, Inc." in the box and "Staples" on the resume.
    const w = low.replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((x) => x.length > 2 && !/^(inc|llc|ltd|corp|the|and|company)$/.test(x));
    for (const cand of [w.slice(0, 2).join(" "), w[0]]) {
      if (!cand || cand.length < 4) continue;
      at = lines.findIndex((x) => x.toLowerCase().includes(cand));
      if (at >= 0) { key = cand; break; }
    }
  }
  if (at < 0) return "";
  const DATE = /\b(19|20)\d{2}\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\b|present|current/gi;
  const clean = (b) => b.replace(DATE, " ").replace(/[()]/g, " ").replace(/\s+/g, " ").replace(/^[-–—|•·,\s]+|[-–—|•·,\s]+$/g, "").trim();
  const usable = (b) => b.length > 1 && b.length < 70 && !b.toLowerCase().includes(key) && !low.includes(b.toLowerCase()) && !/^[-•*]/.test(b) && !/^(experience|work history|employment|education|skills|summary)\b/i.test(b);
  // A place ("Princeton, NJ") is on these lines too and is neither half.
  const notPlace = (b) => !/^[A-Z]{2}$/.test(b) && !/\b(nj|ny|pa|ct|new jersey|new york|remote)\b/i.test(b);
  const bits = lines[at].split(/\s*(?:\||•|·|–|—|\sat\s|,|\s-\s)\s*/i).map(clean).filter(usable);
  const onLine = bits.find(notPlace);
  if (onLine) return onLine;
  // One field to a line — title, place, employer, dates — puts the title two
  // lines above the employer and the employer two below.
  const order = want === "employer" ? [1, 2, -1, -2] : [-1, -2, 1, 2];
  for (const near of order.map((d) => lines[at + d])) {
    const c = clean(String(near ?? ""));
    if (!usable(c) || !notPlace(c)) continue;
    if (/^(present|current)?$/i.test(c)) continue;
    return c.split(/\s*(?:\||•|·|,)\s*/)[0];
  }
  return "";
}

/**
 * Workday's work history, where its reader of the resume left an entry with
 * a title and no company, or a company and no title.
 *
 * Merck's form filled twenty-four boxes and stopped on one: "Company" on the
 * fifth entry. The missing half is taken from the resume, beside the half
 * that is there. Where the resume does not show it, the entry is removed —
 * it is one the portal mis-read, the resume itself is attached, and a form
 * that cannot be finished sends nothing at all.
 */
async function workdayWorkHistory(page, form, profile) {
  let done = 0;
  const resume = String(profile?.resume_text ?? "");
  const boxes = await form.$$('input[id^="workExperience-"]').catch(() => []);
  const seen = new Set();
  for (const box of boxes) {
    const id = String((await box.getAttribute("id").catch(() => "")) || "");
    const m = id.match(/^(workExperience-\d+)--(companyName|jobTitle)$/);
    if (!m || seen.has(m[1])) continue;
    if (!(await box.isVisible().catch(() => false))) continue;
    const partnerId = `${m[1]}--${m[2] === "companyName" ? "jobTitle" : "companyName"}`;
    const partner = await form.$(`[id="${partnerId}"]`).catch(() => null);
    if (!partner) continue;
    const mine = String(await box.inputValue().catch(() => "")).trim();
    const theirs = String(await partner.inputValue().catch(() => "")).trim();
    if ((mine && theirs) || (!mine && !theirs)) { if (mine && theirs) seen.add(m[1]); continue; }
    seen.add(m[1]);
    const empty = mine ? partner : box;
    const want = (mine ? partnerId : id).endsWith("companyName") ? "employer" : "title";
    const value = otherHalfOnResume(resume, mine || theirs, want);
    if (value) {
      await empty.click({ timeout: 3000 }).catch(() => {});
      await empty.fill(value, { timeout: 4000 }).catch(() => {});
      await page.keyboard.press("Tab").catch(() => {});
      console.log(`    work history: the ${want === "employer" ? "company" : "job title"} an entry lacked was taken from the resume`);
      done++;
      continue;
    }
    // Not on the resume beside what the entry has: the entry goes.
    const gone = await box
      .evaluate((n, stem) => {
        let block = n.parentElement;
        for (let k = 0; block && k < 12; k++, block = block.parentElement) {
          const marks = `${block.getAttribute("data-automation-id") || ""} ${block.getAttribute("data-fkit-id") || ""} ${block.id || ""}`;
          if (marks.includes(stem) && block.querySelectorAll("input").length >= 2) break;
        }
        if (!block) return false;
        const del = Array.from(block.querySelectorAll("button")).find(
          (b) => /^(delete|remove)$/i.test((b.innerText || "").trim()) || /delete|remove/i.test(b.getAttribute("data-automation-id") || "") || /^(delete|remove)\b/i.test(b.getAttribute("aria-label") || ""),
        );
        if (!del) return false;
        del.click();
        return true;
      }, m[1])
      .catch(() => false);
    console.log(`    work history: an entry with no ${want === "employer" ? "company" : "job title"}, and none beside it on the resume — ${gone ? "the entry was removed" : "no way to remove it was found"}`);
    if (gone) {
      done++;
      await page.waitForTimeout(800);
    }
  }
  return done;
}

/**
 * A licence or certification entry: one box, chosen from the employer's list.
 *
 * Oracle's reader makes one of these for each certification it finds on the
 * resume, and the form refuses to go on until each holds a choice from the
 * list. There are only two honest things to do with one:
 *
 *   - choose the list's entry for a certification the resume actually names,
 *     where the list has it; or
 *   - take the entry off the application, where the list does not. The
 *     certification is still on the resume that is attached.
 *
 * What is never done is choose something near it. A list of licences is a
 * list of claims, and "the closest one" is a claim the owner did not make.
 * An entry found already holding something the resume does not name — which
 * is what the first version of this left behind — is treated the same way:
 * corrected if it can be, removed if it cannot.
 *
 * Returns "chosen", "removed", "kept" or "left".
 */
async function oracleCertificate(page, form, profile, resume, tileText, tileButton) {
  let box = null;
  for (const c of await form.$$('input[id^="contentItemId-"]').catch(() => [])) {
    if (await c.isVisible().catch(() => false)) { box = c; break; }
  }
  if (!box) return "left";
  // What the box is for, in the form's own word for it.
  const label = (
    await box
      .evaluate((n) => {
        const byFor = n.id ? document.querySelector(`label[for="${CSS.escape(n.id)}"]`) : null;
        return (byFor?.innerText || n.getAttribute("aria-label") || n.closest("label")?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 60);
      })
      .catch(() => "")
  ).toLowerCase();
  if (/degree|education/.test(label) && !/licen[cs]|certif/.test(label)) {
    console.log(`    oracle entry: a "${label.slice(0, 30)}" box with no school beside it; left as it is`);
    return "left";
  }

  const words = (t) => String(t).toLowerCase().split(/[^a-z0-9+#]+/).filter((w) => w.length > 2 && !/^(the|and|for|certification|certificate|certified|license|licence|licensed)$/.test(w));
  const source = String(resume ?? "").toLowerCase();
  const named = (structureResume(profile?.resume_text, profile)?.certifications ?? []).map((c) => String(c.name ?? "")).filter(Boolean);
  const current = String(await box.inputValue().catch(() => "")).trim();
  // What it holds already is fine when the resume says it in so many words.
  const held = words(current);
  if (current && held.length > 0 && held.every((w) => source.includes(w))) return "kept";

  // Which of the resume's certifications this entry is: the one whose own
  // words are on the entry's summary. One entry, one certification.
  const about = `${tileText} ${current}`.toLowerCase();
  const mine = named.filter((n) => words(n).length > 0 && words(n).every((w) => about.includes(w)));
  const want = mine.length === 1 ? mine[0] : null;

  let got = null;
  let offered = 0;
  if (want) {
    const keys = words(want);
    for (const q of [want.slice(0, 40), keys.slice(0, 2).join(" "), keys[0]].filter((q, k, all) => q && q.length >= 3 && all.indexOf(q) === k)) {
      got = await oracleLookup(page, form, box, q, (texts) => {
        offered = Math.max(offered, texts.length);
        // The list's entry has to carry every word of the certification's
        // name. Part of it is another certification.
        return texts.findIndex((t) => keys.every((w) => t.toLowerCase().includes(w)));
      });
      if (got) break;
    }
  }
  if (got) {
    console.log(`    oracle certification: chosen from the list as the resume names it${current ? " (replacing what was there)" : ""}`);
    return "chosen";
  }

  // Not on the list, or not one of the resume's: off the application.
  console.log(
    `    oracle certification: ${want ? `the list does not offer it (${offered} item(s) seen)` : `the entry is not one the resume names (${named.length} on the resume)`}` +
      `${current ? "; what it held is not on the resume" : ""}; taking the entry off the application`,
  );
  const press = async (scope, re) => {
    for (const b of await scope.$$("button, a, [role=button]").catch(() => [])) {
      if (!(await b.isVisible().catch(() => false))) continue;
      const t = `${(await b.innerText().catch(() => "")) || ""} ${(await b.getAttribute("aria-label").catch(() => "")) || ""} ${(await b.getAttribute("title").catch(() => "")) || ""}`.replace(/\s+/g, " ").trim();
      const cls = String((await b.getAttribute("class").catch(() => "")) || "");
      if (!re.test(t) && !(re === REMOVE && /delete|remove|trash/i.test(cls))) continue;
      await b.click({ timeout: 3000 }).catch(() => b.evaluate((n) => n.click()).catch(() => {}));
      return true;
    }
    return false;
  };
  const REMOVE = /^(delete|remove)\b|\b(delete|remove) (entry|item|this)\b/i;
  let removed = await press(form, REMOVE);
  if (!removed) {
    // The delete control is on the closed entry, beside its edit button.
    for (const c of await form.$$("button").catch(() => [])) {
      if (!(await c.isVisible().catch(() => false))) continue;
      if (!/^cancel$/i.test(((await c.innerText().catch(() => "")) || "").trim())) continue;
      await c.click({ timeout: 2500 }).catch(() => {});
      break;
    }
    await page.waitForTimeout(900);
    const tile = tileButton
      ? (await tileButton
          .evaluateHandle((b) => {
            for (let n = b.parentElement, k = 0; n && k < 6; n = n.parentElement, k++) {
              if (n.querySelector('button[class*="delete" i], button[class*="remove" i], button[aria-label*="delete" i], button[aria-label*="remove" i]')) return n;
            }
            return null;
          })
          .catch(() => null))?.asElement?.() ?? null
      : null;
    if (tile) removed = await press(tile, REMOVE);
    if (!removed) {
      // What there was to press, by its own name — the portal's, not the
      // owner's — so the next version knows where the control is.
      const seen = await form
        .evaluate(() => {
          const kinds = new Set();
          for (const x of document.querySelectorAll("button, a[role=button]")) {
            const cls = String(x.className || "").split(/\s+/).filter((c) => /icon|delete|remove|edit|tile|timeline/i.test(c)).slice(0, 2).join(".");
            const name = (x.getAttribute("aria-label") || x.title || "").replace(/\d+/g, "N").replace(/[A-Z][a-z]+ [A-Z][a-z]+.*/, "…").slice(0, 20);
            if (cls) kinds.add(`${cls}|${name}`);
          }
          return [...kinds].slice(0, 14);
        })
        .catch(() => []);
      console.log(`    oracle certification: no way to remove the entry was found; buttons near it ${JSON.stringify(seen).slice(0, 500)}`);
      return "left";
    }
  }
  await page.waitForTimeout(900);
  // "Are you sure?"
  await press(page, /^(yes|delete|remove|ok|confirm)$/i);
  await page.waitForTimeout(1200);
  console.log("    oracle certification: entry removed");
  return "removed";
}

/**
 * The school and the degree on an education entry, each chosen from Oracle's
 * own list. The entry it imports from the resume holds the words but not a
 * choice from the list, and the form refuses it until there is one.
 */
async function oracleEducation(page, form, profile, resume, tileText = "") {
  let done = 0;
  const visible = async (stem) => {
    for (const c of await form.$$(`input[id^="${stem}-"]`).catch(() => [])) {
      if (await c.isVisible().catch(() => false)) return c;
    }
    return null;
  };
  // A visible box by the words of its own label, for the portals that name
  // their boxes some other way.
  const labelled = async (re) => {
    const h = await form
      .evaluateHandle((src) => {
        const want = new RegExp(src, "i");
        const shown = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        for (const l of Array.from(document.querySelectorAll("label")).filter(shown)) {
          if (!want.test((l.innerText || "").replace(/\s+/g, " ").trim())) continue;
          const c = (l.htmlFor && document.getElementById(l.htmlFor)) || l.parentElement?.querySelector("input, [role=combobox]") || l.closest("div")?.parentElement?.querySelector("input, [role=combobox]");
          if (c && shown(c)) return c;
        }
        return null;
      }, re.source)
      .catch(() => null);
    return h?.asElement?.() ?? null;
  };
  const school = (await visible("educationalEstablishmentId")) ?? (await visible("educationalEstablishment")) ?? (await labelled(/^(school|institution|college|university)\b/));
  // WHICH of the owner's schools this entry is. A resume with a bachelor's
  // from one and an associate's from another has two entries here, and each
  // must get its own school and its own degree — the highest degree on the
  // resume is right for one of them and wrong for the other. The entry is
  // matched by what Oracle's reader already put in its boxes; if it cannot
  // be matched and there is more than one school, nothing is chosen.
  const schools = (structureResume(profile?.resume_text, profile)?.education ?? []).filter((e) => e.school);
  // Everything this one entry shows: what is typed in its boxes and what is
  // printed around them, up to the form that holds its SAVE — not the page,
  // which names every school.
  const shownHere = await form
    .evaluate(() => {
      const shown = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const save = Array.from(document.querySelectorAll("button")).filter(shown).filter((b) => /^save$/i.test((b.innerText || "").trim())).pop();
      let box = save?.parentElement ?? null;
      for (let n = 0; n < 8 && box && box.querySelectorAll("input, textarea").length < 1; n++) box = box.parentElement;
      const scope = box ?? document.body;
      const boxes = Array.from(scope.querySelectorAll("input, textarea")).filter(shown);
      return {
        around: box ? scope.innerText ?? "" : "",
        typed: boxes.map((c) => String(c.value ?? "")).join(" \n "),
        boxes: boxes.length,
        filled: boxes.filter((c) => String(c.value ?? "").trim()).length,
      };
    })
    .catch(() => ({ around: "", typed: "", boxes: 0, filled: 0 }));
  // What the entry says in its own words — typed in its boxes, printed on its
  // summary — apart from the labels and lists printed around them.
  const own = `${shownHere.typed} \n ${String(tileText)}`.toLowerCase();
  const inBoxes = `${shownHere.around} \n ${own}`.toLowerCase();
  const keyWords = (t) => String(t).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !/^(university|college|institute|school|state|community|arts|science|studies|bachelor|associate|master)$/.test(w));
  // Exactly one school may answer to a test; two answering is no answer.
  const only = (test) => {
    const hits = schools.filter(test);
    return hits.length === 1 ? hits[0] : null;
  };
  const levelWord = { doctorate: /doctor|ph\.?\s?d/i, master: /master/i, bachelor: /bachelor/i, associate: /associate/i, highschool: /high school|ged/i };
  const found = (words) => words.filter((w) => inBoxes.includes(w)).length;
  const yearsOf = (e) => String(e.dates ?? "").match(/(19|20)\d{2}/g) ?? [];
  let entry =
    only((e) => keyWords(e.school).length > 0 && keyWords(e.school).every((w) => inBoxes.includes(w))) ??
    only((e) => keyWords(e.degree).length > 0 && keyWords(e.degree).every((w) => inBoxes.includes(w))) ??
    // "Bachelor of Arts" typed in the degree box says which of the two it is.
    only((e) => levelWord[highestDegree(e.degree)]?.test(inBoxes)) ??
    // The years it was attended, where the two schools' years differ.
    only((e) => {
      const years = yearsOf(e);
      return years.length > 0 && years.every((y) => inBoxes.includes(y));
    }) ??
    // Not every word of a school's line is on the entry — the resume's line
    // may carry a town or a campus the entry dropped. The school with clearly
    // the most of its own words here is the one; a tie is no answer.
    (() => {
      const ranked = schools
        .map((e) => [found([...new Set([...keyWords(e.school), ...keyWords(e.degree), ...yearsOf(e)])]), e])
        .sort((a, b) => b[0] - a[0]);
      return ranked.length > 1 && ranked[0][0] > 0 && ranked[0][0] > ranked[1][0] ? ranked[0][1] : null;
    })() ??
    (schools.length === 1 ? schools[0] : null);
  // Failing all of that, the entry may still say its own level in so many
  // words — "Associate of Science" on its summary. Then the degree asked for
  // is the one the entry itself names, whichever school it belongs to, and
  // the school is left exactly as the employer's reader set it.
  const stated = Object.entries(levelWord).filter(([, re]) => re.test(own)).map(([k]) => k);
  const ownLevel = !entry && schools.length > 1 && stated.length === 1 ? stated[0] : null;
  if (ownLevel) console.log("    oracle education: the entry names its own level; its degree is chosen from that and its school is left as it is");
  // And where even that fails, the owner's rule: an entry with an empty
  // school box that could be either school is filled in whole as the school
  // of the higher degree ("if it will only take one, the bachelor's"). An
  // entry already naming a school that could not be recognised is still left
  // alone: a degree is never put beside a school it may not belong to.
  //
  // An entry with no school box at all is not handled here. AutoZone's were
  // taken for education entries that held only a degree, and given degrees —
  // and they were licence entries, whose list of "Licensed Bachelor Social
  // Worker" and the like answered to the word "bachelor". Those belong to
  // oracleCertificate, which chooses only what the resume itself names.
  const rank = (e) => {
    const at = DEGREES.findIndex(([name]) => name === highestDegree(e.degree));
    return at < 0 ? 99 : at;
  };
  const byLevel = schools.filter((e) => rank(e) < 99).sort((a, b) => rank(a) - rank(b));
  if (!school) {
    console.log("    oracle education: this entry has no school box; it is not treated as education");
    return 0;
  }
  if (!entry && !ownLevel && schools.length > 1 && byLevel.length) {
    if (!String(await school.inputValue().catch(() => "")).trim()) {
      entry = byLevel[0];
      console.log("    oracle education: an empty entry that could be either school is filled in as the school of the higher degree");
    }
  }
  if (schools.length > 1 && !entry && !ownLevel) {
    // How near each school came, in counts only — never the words.
    const near = schools.map(
      (e) =>
        `${found(keyWords(e.school))}/${keyWords(e.school).length} name word(s), ${found(keyWords(e.degree))}/${keyWords(e.degree).length} degree word(s), ` +
        `${found(yearsOf(e))}/${yearsOf(e).length} year(s), level ${highestDegree(e.degree) ? "known" : "not known"}`,
    );
    console.log(
      `    oracle education: how near each school came ${JSON.stringify(near)}; the entry shows ${shownHere.filled} of ${shownHere.boxes} box(es) filled, ` +
        `${stated.length} level word(s), ${/(19|20)\d{2}/.test(own) ? "a year" : "no year"}`,
    );
    console.log(
      `    oracle education: this entry could not be matched to one of the ${schools.length} schools on the resume; left as it is ` +
        `(its summary: ${String(tileText).trim() ? `${String(tileText).trim().split(/\s+/).length} word(s)` : "none read"})`,
    );
    return 0;
  }
  const name = String(entry?.school ?? profile?.school ?? parseSchoolFromResume(resume) ?? "").trim();
  if (school && name && !ownLevel) {
    const low = name.toLowerCase();
    const words = low.split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !/^(university|college|institute|school|state)$/.test(w));
    // Its own name on the list — asked for in full, then by fewer of its
    // words, since a list that holds "Rutgers University" answers nothing to
    // "Rutgers University, New Brunswick" — and failing that, the list's own
    // entry for a school it does not hold.
    const match = (texts) => {
      const exact = texts.findIndex((t) => t.toLowerCase() === low);
      if (exact >= 0) return exact;
      return texts.findIndex((t) => t.toLowerCase().includes(low) || (words.length > 0 && words.every((w) => t.toLowerCase().includes(w))));
    };
    const asks = [name.slice(0, 40), name.split(/[,(|–—-]/)[0].trim().slice(0, 40), words.slice(0, 2).join(" "), words[0]]
      .filter((q, k, all) => q && q.length >= 4 && all.indexOf(q) === k);
    let got = null;
    let offered = 0;
    for (const q of asks) {
      got = await oracleLookup(page, form, school, q, (texts) => { offered = Math.max(offered, texts.length); return match(texts); });
      if (got) break;
    }
    for (const q of got ? [] : ["Other", "Not Listed", "Unlisted", "Not Found"]) {
      got = await oracleLookup(page, form, school, q, (texts) => { offered = Math.max(offered, texts.length); return texts.findIndex((t) => /^(other|not listed|unlisted|school not|not found|not on)/i.test(t)); });
      if (got) break;
    }
    if (!got) console.log(`    oracle education: the school list offered at most ${offered} item(s) for ${asks.length} wording(s) of the name`);
    console.log(`    oracle education: school ${got ? (/^(other|not |unlisted|school not)/i.test(got) ? "not on the list; chose the list's own entry for that" : "chosen from the list") : "could not be chosen"}`);
    if (got) done++;
  }
  const degree = (await visible("contentItemId")) ?? (await visible("degree")) ?? (await labelled(/^degree\b/));
  if (!degree) {
    // Asked for and not found: what stands beside the word, by shape.
    const near = await form
      .evaluate(() => {
        const shown = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const out = [];
        for (const l of Array.from(document.querySelectorAll("label, span, div")).filter(shown)) {
          if (!/^degree\b/i.test((l.innerText || "").trim()) || (l.innerText || "").length > 30) continue;
          const row = l.closest('[class*="row" i], [class*="field" i]') ?? l.parentElement;
          out.push(Array.from(row?.querySelectorAll("input, button, select, [role]") ?? []).slice(0, 6).map((c) => `${c.tagName}${c.getAttribute("role") ? `[${c.getAttribute("role")}]` : ""}:${String(c.id || c.className || "").replace(/\d+/g, "N").slice(0, 30)}`));
          if (out.length >= 2) break;
        }
        return out;
      })
      .catch(() => null);
    console.log(`    oracle education: no degree box was found; beside the word "Degree": ${JSON.stringify(near).slice(0, 400)}`);
  }
  // This entry's own degree where it was matched; the resume's highest only
  // when there is a single school.
  const level = ownLevel ?? (entry ? highestDegree(entry.degree) ?? highestDegree(resume) : highestDegree(resume));
  if (degree && level) {
    // Each employer words its list its own way: "Bachelor's Degree",
    // "Bachelors", "BA/BS", "4 Year Degree", "College Degree".
    const WORDING = {
      doctorate: { ask: ["Doctor", "PhD", "JD"], re: /doctor|ph\.?\s?d|juris|\bj\.?d\b|\bm\.?d\b/i },
      master: { ask: ["Master", "MBA", "MS", "Graduate"], re: /master|\bmba\b|\bm\.?[as]\.?\b|graduate degree/i },
      bachelor: { ask: ["Bachelor", "BA", "BS", "4", "College", "Undergrad"], re: /bachelor|\bb\.?[as]\.?\b|4[- ]?year|four[- ]year|undergraduate|college degree|university degree/i },
      associate: { ask: ["Associate", "AA", "AS", "2", "Community"], re: /associate|\ba\.?[as]\.?\b|2[- ]?year|two[- ]year|community college/i },
      highschool: { ask: ["High School", "GED", "Diploma", "Secondary"], re: /high school|\bged\b|secondary|diploma/i },
    }[level];
    let got = null;
    let offered = [];
    for (const q of WORDING.ask) {
      got = await oracleLookup(page, form, degree, q, (texts) => {
        if (texts.length > offered.length) offered = texts;
        // The plainest wording of the level: "Bachelor's Degree" before
        // "Bachelor of Science in Nursing". Never a higher level's "post-".
        let best = -1;
        texts.forEach((t, k) => {
          if (!WORDING.re.test(t) || /post[- ]?(graduate|bachelor|bacc)|some college|no degree|not complete|incomplete/i.test(t)) return;
          // A licence or a certificate with the level's word in its name is
          // not the degree: "Licensed Bachelor Social Worker".
          if (/licen[cs]|certif|registered|social work|\bnurs/i.test(t)) return;
          if (best < 0 || t.length < texts[best].length) best = k;
        });
        return best;
      });
      if (got) break;
    }
    // The list's own words are the employer's, not the owner's, so they can
    // be shown: this is how the next wording gets learned.
    if (!got) console.log(`    oracle education: no ${level} wording matched; the list offered ${JSON.stringify(offered.slice(0, 12).map((t) => t.slice(0, 30)))}`);
    console.log(`    oracle education: ${level} degree ${got ? `chosen ("${got.slice(0, 28)}")` : "could not be chosen"}`);
    if (got) done++;
  }
  return done;
}

/**
 * Walk Oracle's issue list after a refused submit and put right what can be.
 *
 * With `onlyReport`, nothing is changed: it says where each issue is, by the
 * kind of control and the form's own label, never by what a box holds.
 */
async function oracleRepair(page, form, profile, job, onlyReport = false, lookupSaved = () => null) {
  let fixed = 0;
  let eduDone = false;
  const comboTried = new Set();
  let shapesShown = 0;
  const report = [];
  const resume = String(job?.tailored_resume || profile?.resume_text || "");
  for (let k = 0; k < 14; k++) {
    const next = await form.$('button:has-text("Next Issue"), a:has-text("Next Issue")').catch(() => null);
    if (!next) break;
    await next.click({ timeout: 2500 }).catch(() => {});
    await page.waitForTimeout(700);
    const at = await form.evaluateHandle(() => document.activeElement).catch(() => null);
    const el = at?.asElement?.();
    if (!el) continue;
    const about = await el
      .evaluate((a) => {
        const row = a.closest(".input-row") ?? a.parentElement;
        return {
          role: a.getAttribute("role"),
          cls: typeof a.className === "string" ? a.className.trim().split(/\s+/)[0].slice(0, 44) : "",
          id: String(a.id || "").replace(/\d+/g, "N").slice(0, 30),
          label: (row?.querySelector("label, legend")?.innerText ?? "").replace(/\s+/g, " ").replace(/\*\s*$/, "").trim(),
          inGroup: !!a.closest("[role=radiogroup]"),
        };
      })
      .catch(() => null);
    if (!about) continue;
    report.push(`${about.role ?? "button"}:${about.cls}:${about.id}:${about.label.slice(0, 44)}`);
    if (onlyReport) continue;

    // A question: two or more pills, none chosen.
    if (about.role === "radio" && about.inGroup && about.label) {
      const l = about.label.toLowerCase();
      if (/^(title|prefix|salutation|suffix)\b/.test(l)) continue;
      const group = await el.evaluateHandle((a) => a.closest("[role=radiogroup]")).catch(() => null);
      const pills = (await group?.asElement?.()?.$$("[role=radio]").catch(() => [])) ?? [];
      let chosenAlready = false;
      const picks = [];
      for (const b of pills) {
        if ((await b.getAttribute("aria-checked").catch(() => null)) === "true") chosenAlready = true;
        picks.push({ el: b, text: ((await b.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim() });
      }
      if (chosenAlready || !picks.length) continue;
      const want = answerQuestion(l, profile) ?? lookupSaved(l) ?? lastResort(l, profile, job);
      let chosen = want === null || want === undefined || want === "" ? null : bestOption(picks, want, l);
      // How much travel, offered as percentages with nothing on file: the
      // least on offer, which promises nothing the owner has not agreed to.
      if (!chosen && /travel/.test(l) && picks.every((x) => /^\d{1,3}\s*%$/.test(x.text))) {
        chosen = [...picks].sort((x, y) => parseInt(x.text, 10) - parseInt(y.text, 10))[0];
        console.log(`    oracle question "${about.label.slice(0, 50)}": nothing on file, so the least travel on offer`);
      }
      if (!chosen) {
        console.log(`    oracle question "${about.label.slice(0, 70)}" has no answer on file; offered ${JSON.stringify(picks.map((x) => x.text).slice(0, 5))}`);
        continue;
      }
      await chosen.el.click({ timeout: 3000 }).catch(() => chosen.el.click({ timeout: 3000, force: true }).catch(() => {}));
      await page.waitForTimeout(400);
      const on = (await chosen.el.getAttribute("aria-checked").catch(() => null)) === "true";
      console.log(`    oracle question "${about.label.slice(0, 50)}" -> "${chosen.text.slice(0, 20)}"${on ? "" : " (did not take)"}`);
      if (on) fixed++;
      continue;
    }

    // The country, or the dialling code beside the phone number, that the
    // form stops at: typed and not chosen, or never set. Chosen from the
    // portal's own list here, whatever that list is built from.
    if (about.role === "combobox" && /^(country|phone number)$/i.test(about.label) && !comboTried.has(about.id)) {
      comboTried.add(about.id);
      const code = /phone/i.test(about.label);
      const listId = String((await el.getAttribute("aria-controls").catch(() => null)) ?? "").replace(/["\\]/g, "");
      const rows = async () =>
        listId
          ? await form.$$(`[id="${listId}"] .cx-select__list-item:not(.cx-select__list-item--loading), [id="${listId}"] [role=option], [id="${listId}"] li, [id="${listId}"] [role=gridcell]`).catch(() => [])
          : [];
      let took = false;
      let seen = 0;
      for (const typed of ["United States", "United", "US"]) {
        await el.click({ timeout: 3000 }).catch(() => {});
        await el.fill("", { timeout: 3000 }).catch(() => {});
        await el.type(typed, { delay: 80 }).catch(() => {});
        const list = (await until(async () => { const l = await rows(); return l.length ? l : null; }, 7000, 400)) ?? [];
        seen = Math.max(seen, list.length);
        for (const it of list.slice(0, 20)) {
          const t = ((await it.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim().toLowerCase();
          if (code ? /^(\+?1\b.*united states|united states\b.*\+?1\b|united states( of america)?|us \+1|\+1)$/.test(t) : /^united states( of america)?$/.test(t)) {
            await it.click({ timeout: 3000 }).catch(() => it.click({ timeout: 3000, force: true }).catch(() => {}));
            took = true;
            break;
          }
        }
        if (took) break;
      }
      if (!took && listId === "") {
        // No list of its own to read: take the first suggestion by key.
        await page.keyboard.press("ArrowDown").catch(() => {});
        await page.keyboard.press("Enter").catch(() => {});
      }
      await page.waitForTimeout(code ? 800 : 3000);
      const bad = (await el.getAttribute("aria-invalid").catch(() => null)) === "true";
      console.log(`    oracle ${code ? "dialling code" : "country"}: ${took ? "chosen from the list" : `not chosen (the list showed ${seen} row(s)${listId ? "" : ", and names no list"})`}; the form ${bad ? "still marks it" : "does not mark it"}`);
      if (took && !bad) fixed++;
      continue;
    }

    // A question answered in words, left empty. "Please list the names,
    // relationship and work location of relatives working here" has one
    // truthful answer for someone who has said they have none.
    if (!about.role && about.label && !/edit/i.test(about.cls)) {
      const tag = await el.evaluate((a) => `${a.tagName}:${a.getAttribute("type") ?? ""}`).catch(() => "");
      if (/^(TEXTAREA:|INPUT:(text)?$)/.test(tag) && !String(await el.inputValue().catch(() => "x")).trim()) {
        const l = about.label.toLowerCase();
        let say = null;
        if (/relative|family member|related to/.test(l) && /list|name|describe|explain|specify|provide/.test(l)) say = "None";
        else say = lookupSaved(l);
        if (say) {
          await el.fill(String(say).slice(0, 400), { timeout: 3000 }).catch(() => {});
          await page.keyboard.press("Tab").catch(() => {});
          console.log(`    oracle question in words "${about.label.slice(0, 40)}" answered`);
          fixed++;
        } else {
          console.log(`    oracle question in words "${about.label.slice(0, 60)}" has no answer on file`);
        }
        continue;
      }
    }

    // The school or degree box of an education entry that is already open.
    if (/^(educationalEstablishmentId|contentItemId)-N$/.test(about.id)) {
      if (!eduDone) {
        eduDone = true;
        const n = await oracleEducation(page, form, profile, resume);
        if (n && (await oracleSave(page, form))) fixed += n;
      }
      continue;
    }

    // An entry imported from the resume, opened by its edit button.
    if (/edit/i.test(about.cls)) {
      // What the entry says about itself while it is still closed — "Bachelor
      // of Arts, Rutgers University" — which is the plainest way to tell one
      // school's entry from another's. Read now, because the summary gives
      // way to the form once the entry is opened. Never printed.
      const tileText = await el
        .evaluate((b) => {
          for (let n = b.parentElement, k = 0; n && k < 7; n = n.parentElement, k++) {
            const t = (n.innerText || "").replace(/\s+/g, " ").trim();
            if (t.length > 20) return t.slice(0, 600);
          }
          return "";
        })
        .catch(() => "");
      await el.click({ timeout: 3000 }).catch(() => el.evaluate((b) => b.click()).catch(() => {}));
      await page.waitForTimeout(2200);
      // Which boxes this entry's own form marks, by what they are.
      const need = await form
        .evaluate(() => {
          const shown = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
          const save = Array.from(document.querySelectorAll("button")).filter(shown).find((b) => /^save$/i.test((b.innerText || "").trim()));
          let box = save?.parentElement ?? null;
          for (let n = 0; n < 8 && box && box.querySelectorAll("input, textarea").length < 2; n++) box = box.parentElement;
          const scope = box ?? document;
          return Array.from(scope.querySelectorAll("input, select, textarea"))
            .filter(shown)
            .filter((c) => ((c.required || c.getAttribute("aria-required") === "true") && !String(c.value ?? "").trim()) || c.getAttribute("aria-invalid") === "true")
            .map((c) => `${String(c.id || c.getAttribute("name") || c.tagName).replace(/\d+/g, "N").slice(0, 34)}${c.getAttribute("aria-invalid") === "true" ? "!" : ""}`)
            .slice(0, 10);
        })
        .catch(() => []);
      console.log(`    oracle entry needs ${JSON.stringify(need)}`);

      let done = false;
      // An entry with a school box is education. One with the list box and
      // no school is a licence or certification, and is looked at whether or
      // not the form marks it: an entry that holds something the resume does
      // not name has to be put right even though the form is content.
      const shownBox = async (stem) => {
        for (const c of await form.$$(`input[id^="${stem}-"]`).catch(() => [])) {
          if (await c.isVisible().catch(() => false)) return c;
        }
        return null;
      };
      const hasSchool = !!((await shownBox("educationalEstablishmentId")) ?? (await shownBox("educationalEstablishment")));
      // "The Degree field is required", said beside an entry whose own boxes
      // are marked with nothing.
      const wantsDegree = hasSchool && (await form.evaluate(() => /degree field is required/i.test(document.body.innerText || "")).catch(() => false));
      const hasList = !!(await shownBox("contentItemId"));
      if (hasList && !hasSchool) {
        const did = await oracleCertificate(page, form, profile, resume, tileText, el);
        if (did === "chosen") {
          done = await oracleSave(page, form);
          console.log(`    oracle certification entry: ${done ? "saved" : "not saved"}`);
        } else if (did === "removed") {
          fixed++;
          continue;
        }
      } else if (wantsDegree || need.some((n) => /^(educationalEstablishment|contentItemId|degree)/i.test(n))) {
        const n = await oracleEducation(page, form, profile, resume, tileText);
        if (n) {
          done = await oracleSave(page, form);
          console.log(`    oracle education entry: ${done ? "saved" : "not saved"}`);
          eduDone = true;
        }
      } else if (!need.length && shapesShown < 2) {
        // The form stopped here and marks nothing. What the entry is made
        // of, by shape, so that the reason can be found.
        shapesShown++;
        const shape = await form
          .evaluate(() => {
            const shown = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
            const save = Array.from(document.querySelectorAll("button")).filter(shown).find((b) => /^save$/i.test((b.innerText || "").trim()));
            let box = save?.parentElement ?? null;
            for (let n = 0; n < 8 && box && box.querySelectorAll("input, textarea, select").length < 2; n++) box = box.parentElement;
            const scope = box ?? document;
            return {
              boxes: Array.from(scope.querySelectorAll("input, select, textarea"))
                .filter(shown)
                .slice(0, 14)
                .map((c) => `${String(c.id || c.getAttribute("name") || c.tagName).replace(/\d+/g, "N").slice(0, 26)}:${c.required || c.getAttribute("aria-required") === "true" ? "req" : "opt"}:${String(c.value ?? "").trim() ? "set" : "empty"}`),
              complaints: Array.from(scope.querySelectorAll('[class*="error" i], [class*="invalid" i], [role=alert]'))
                .filter(shown)
                .map((e) => (e.innerText || "").replace(/\s+/g, " ").trim().slice(0, 60))
                .filter((t) => t && /required|invalid|must|select|enter|missing|format/i.test(t))
                .slice(0, 4),
            };
          })
          .catch(() => null);
        if (shape) console.log(`    oracle entry that marks nothing: ${JSON.stringify(shape).slice(0, 700)}`);
      }
      // Oracle's reader of the resume keeps one half of "Title, Employer" and
      // loses the other: AutoZone's copy had employers with no job title and
      // Sherwin-Williams' had titles with no employer. Whichever is missing
      // is on the same line of the resume as the half that was kept, or on
      // the line beside it.
      const boxOf = async (stem) => {
        const b = await form.$(`input[id^="${stem}-"]`).catch(() => null);
        return b && (await b.isVisible().catch(() => false)) ? b : null;
      };
      const employer = await boxOf("employerName");
      const jobTitle = await boxOf("jobTitle");
      const has = async (b) => (b ? String(await b.inputValue().catch(() => "")).trim() : "");
      const haveEmployer = await has(employer);
      const haveTitle = await has(jobTitle);
      const missing = employer && !haveEmployer && haveTitle ? employer : jobTitle && !haveTitle && haveEmployer ? jobTitle : null;
      const anchor = missing === employer ? haveTitle : haveEmployer;
      if (missing && anchor && resume) {
        const low = anchor.toLowerCase();
        const lines = resume.split(/\r?\n/).map((x) => x.trim());
        let at2 = lines.findIndex((x) => x.toLowerCase().includes(low));
        // "Staples, Inc." on the entry and "Staples" in the resume: the
        // name's first two words, then its first alone.
        let key = low;
        if (at2 < 0) {
          const w = low.replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((x) => x.length > 2 && !/^(inc|llc|ltd|corp|the|and|company)$/.test(x));
          for (const cand of [w.slice(0, 2).join(" "), w[0]]) {
            if (!cand || cand.length < 4) continue;
            at2 = lines.findIndex((x) => x.toLowerCase().includes(cand));
            if (at2 >= 0) { key = cand; break; }
          }
        }
        let value = "";
        if (at2 >= 0) {
          const DATE = /\b(19|20)\d{2}\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\b|present|current/gi;
          const clean = (b) => b.replace(DATE, " ").replace(/[()]/g, " ").replace(/\s+/g, " ").replace(/^[-–—|•·,\s]+|[-–—|•·,\s]+$/g, "").trim();
          const usable = (b) => b.length > 1 && b.length < 70 && !b.toLowerCase().includes(key) && !low.includes(b.toLowerCase()) && !/^[-•*]/.test(b) && !/^(experience|work history|employment|education|skills|summary)\b/i.test(b);
          const bits = lines[at2].split(/\s*(?:\||•|·|–|—|\sat\s|,|\s-\s)\s*/i).map(clean).filter(usable);
          // A place ("Princeton, NJ") is on these lines too and is neither.
          const notPlace = (b) => !/^[A-Z]{2}$/.test(b) && !/\b(nj|ny|pa|ct|new jersey|new york|remote)\b/i.test(b);
          value = bits.find(notPlace) ?? "";
          if (!value) {
            // One field to a line — title, place, employer, dates — puts the
            // title two lines above the employer and the employer two below.
            const order = missing === employer ? [1, 2, -1, -2] : [-1, -2, 1, 2];
            for (const near of order.map((d) => lines[at2 + d])) {
              const c = clean(String(near ?? ""));
              if (!usable(c) || !notPlace(c)) continue;
              if (/^(present|current)?$/i.test(c)) continue;
              value = c.split(/\s*(?:\||•|·|,)\s*/)[0];
              break;
            }
          }
        }
        if (value) {
          await missing.click({ timeout: 3000 }).catch(() => {});
          await missing.fill(value, { timeout: 4000 }).catch(() => {});
          await page.keyboard.press("Tab").catch(() => {});
          done = await oracleSave(page, form);
          console.log(`    oracle entry: ${missing === employer ? "employer" : "job title"} taken from the resume; ${done ? "saved" : "not saved"}`);
        } else {
          const shapeOf = (x) => {
            const t = String(x ?? "");
            return !t ? "blank" : `${t.length}c${/^[-•*]/.test(t) ? " bullet" : ""}${/\b(19|20)\d{2}\b/.test(t) ? " date" : ""}${/[|•·–—]|\s-\s|,/.test(t) ? " split" : ""}${/^[A-Z][A-Z &]{2,}$/.test(t) ? " heading" : ""}`;
          };
          const around = at2 >= 0 ? [-2, -1, 0, 1, 2].map((d) => shapeOf(lines[at2 + d])) : [];
          console.log(`    oracle entry: the resume does not show the ${missing === employer ? "employer" : "job title"} beside what the entry has (its line ${at2 >= 0 ? "found" : "not found"}; lines around it: ${JSON.stringify(around)})`);
        }
      } else if (employer || jobTitle) {
        console.log(`    oracle entry: title ${haveTitle ? "set" : "empty"}, employer ${haveEmployer ? "set" : "empty"} — nothing to complete from the resume`);
      }
      if (done) fixed++;
      else {
        for (const c of await form.$$("button").catch(() => [])) {
          if (!(await c.isVisible().catch(() => false))) continue;
          if (!/^cancel$/i.test(((await c.innerText().catch(() => "")) || "").trim())) continue;
          await c.click({ timeout: 2500 }).catch(() => {});
          break;
        }
        await page.waitForTimeout(1000);
      }
    }
  }
  console.log(`    oracle issue stops: ${JSON.stringify(Array.from(new Set(report)).slice(0, 10))}`);
  return fixed;
}

/**
 * Which required Oracle boxes are still empty, by what they are — never by
 * what they hold. Oracle reports "1 out of 9 issues" at submit and names only
 * the first.
 */
async function oracleOpenItems(form) {
  const open = await form
    .evaluate(() => {
      const shown = (e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      return Array.from(document.querySelectorAll("input, select, textarea"))
        .filter((c) => shown(c) && (c.required || c.getAttribute("aria-required") === "true" || c.getAttribute("aria-invalid") === "true"))
        .filter((c) => (c.type === "checkbox" || c.type === "radio" ? !c.checked : !String(c.value ?? "").trim()) || c.getAttribute("aria-invalid") === "true")
        .slice(0, 14)
        .map((c) => `${String(c.id || c.name || c.tagName).replace(/\d+/g, "N").slice(0, 44)}${c.getAttribute("aria-invalid") === "true" ? "!" : ""}`);
    })
    .catch(() => []);
  console.log(`    oracle: required and still open ${JSON.stringify(open)}`);
}

const HOST_LOCKS = new Map();
/** Run `fn` when nothing else is running for this host; others queue behind it. */
async function withHostLock(host, fn) {
  const before = HOST_LOCKS.get(host) ?? Promise.resolve();
  let release;
  const mine = new Promise((r) => (release = r));
  HOST_LOCKS.set(host, before.then(() => mine));
  await before;
  try {
    return await fn();
  } finally {
    release();
  }
}

async function oracleStart(page, profile, job) {
  const host = hostOf(page.url());
  const shown = async (el) => await el.isVisible().catch(() => false);
  const say = async (when) => {
    // What the screen is made of, never what is in it.
    const shape = await page
      .evaluate(() => {
        const vis = (e) => {
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        return {
          heads: Array.from(document.querySelectorAll("h1, h2, h3")).filter(vis).map((h) => (h.innerText || "").trim().slice(0, 40)).slice(0, 5),
          inputs: Array.from(document.querySelectorAll("input, select, textarea")).filter(vis).map((i) => `${i.tagName.toLowerCase()}:${i.type || ""}:${(i.id || i.name || "").replace(/\d+/g, "N").slice(0, 28)}`).slice(0, 14),
          buttons: Array.from(document.querySelectorAll("button, [role=button]")).filter(vis).map((b) => (b.innerText || b.getAttribute("aria-label") || "").trim().slice(0, 22)).filter(Boolean).slice(0, 12),
        };
      })
      .catch(() => null);
    console.log(`    oracle ${when}: ${JSON.stringify(shape).slice(0, 700)}`);
  };

  let email = null;
  for (const el of await page.$$('input[id^="primary-email"], input[type=email], input[name*="email" i]').catch(() => [])) {
    if (await shown(el)) { email = el; break; }
  }
  if (!email) {
    await say("has no email box");
    return {};
  }
  await email.fill(String(profile.email), { timeout: 5000 }).catch(() => {});

  // The terms box. Oracle draws its own, so the real input may be hidden
  // behind it; the label is what a person presses.
  for (const box of await page.$$('input[type=checkbox]').catch(() => [])) {
    try {
      if (await box.isChecked().catch(() => false)) continue;
      const text = ((await box.evaluate(readLabel).catch(() => "")) || "").toLowerCase();
      if (!/agree|terms|acknowledge|privacy|consent/.test(text)) continue;
      await box.check({ timeout: 2500 }).catch(async () => {
        const id = await box.getAttribute("id").catch(() => null);
        const label = id ? await page.$(`label[for="${id}"]`).catch(() => null) : null;
        if (label) await label.click({ timeout: 2500 }).catch(() => {});
        else await box.click({ force: true, timeout: 2500 }).catch(() => {});
      });
    } catch {
      /* one box must not end the attempt */
    }
  }

  if (await visibleCaptcha(page)) return { stop: { status: "needs_help", help_reason: "captcha" } };

  const press = async (re) => {
    for (const b of await page.$$("button, [role=button], input[type=submit]").catch(() => [])) {
      if (!(await shown(b))) continue;
      const t = ((await b.innerText().catch(() => "")) || (await b.getAttribute("value").catch(() => "")) || "").replace(/\s+/g, " ").trim();
      if (!re.test(t)) continue;
      await b.click({ timeout: 4000 }).catch(() => b.click({ force: true, timeout: 4000 }).catch(() => {}));
      return t;
    }
    return null;
  };
  // From here on, a code that arrives is one this application asked for.
  const askedAt = Date.now();
  let went = await press(/^(next|continue)$/i);
  await page.waitForTimeout(3500);
  // Some portals put the terms in a dialog of their own, with AGREE on it,
  // and Next does nothing until that has been pressed.
  if (await press(/^(agree|i agree|accept)$/i)) {
    await page.waitForTimeout(2000);
    went = (await press(/^(next|continue)$/i)) ?? went;
    await page.waitForTimeout(4000);
  }
  if (await visibleCaptcha(page)) return { stop: { status: "needs_help", help_reason: "captcha" } };

  const codeBox = async () => {
    for (const el of await page.$$('input[autocomplete="one-time-code"], input[id*="pin" i], input[id*="code" i], input[maxlength="1"]').catch(() => [])) {
      if ((await shown(el)) && !/postal|zip|honey/i.test((await el.getAttribute("id").catch(() => "")) || "")) return el;
    }
    return null;
  };
  const body = ((await page.innerText("body").catch(() => "")) || "").toLowerCase();
  if ((await codeBox()) && /code|verif|pin/.test(body)) {
    console.log("    oracle: the portal emailed a code; reading it from the inbox");
    const code = await waitForVerificationCode(host, job.company, 6, 10_000, askedAt);
    if (!code) {
      await say("code never arrived");
      return { stop: { status: "needs_help", help_reason: "email_verification", note: "Oracle emailed a verification code and it could not be read from the inbox." } };
    }
    // One box, or one per character; typing at the first works for both.
    const first = await codeBox();
    if (!first) {
      await say("code box not found");
      return { stop: { status: "needs_help", help_reason: "email_verification", note: "Oracle asked for a code and no box for it was found." } };
    }
    await first.click({ timeout: 3000 }).catch(() => {});
    await page.keyboard.type(String(code), { delay: 60 }).catch(() => {});
    await page.waitForTimeout(800);
    await press(/^(verify|next|continue|submit|confirm)$/i);
    await page.waitForTimeout(5000);
  }
  await say(`after "${went ?? "no next button"}"`);
  return { ok: true };
}

/**
 * Open an activation link without losing the page we are on.
 *
 * In its own tab, because this is called after a sign-in that has already
 * landed somewhere useful — navigating the main page away would throw that
 * away to visit a link that only needs to be fetched.
 */
async function openVerificationLink(page, link) {
  const tab = await page.context().newPage().catch(() => null);
  if (!tab) return false;
  try {
    await tab.goto(link, { waitUntil: "domcontentloaded", timeout: 45000 });
    await tab.waitForTimeout(3000);
    const text = ((await tab.innerText("body").catch(() => "")) || "").toLowerCase();
    // An already-used link means the account IS verified, which is the
    // outcome we wanted; only expiry or an outright rejection is a failure.
    const dead = /expired|no longer valid|invalid link|link is not valid/.test(text);
    console.log(
      `    opened the verification link from the inbox${dead ? " — the portal says it has expired" : ""}`,
    );
    return !dead;
  } catch (e) {
    console.log(`    could not open the verification link: ${String(e?.message ?? e).slice(0, 80)}`);
    return false;
  } finally {
    await tab.close().catch(() => {});
  }
}

/**
 * Wait for the portal's verification link to reach the connected mailbox.
 *
 * Polled rather than asked once: the mail takes a few seconds to tens of
 * seconds to arrive, and asking immediately would always come back empty.
 * The panel does the reading — the applier has no Gmail credentials and
 * should not have any.
 */
/** The security code a portal has just emailed, polled the same way. */
const USED_CODES = new Set();

async function waitForVerificationCode(host, company, attempts = 6, gapMs = 10_000, since = null) {
  const base = (process.env.APP_URL || "https://applynow.lol").replace(/\/+$/, "");
  const key = process.env.ENGINE_API_KEY;
  if (!key) {
    console.log("    no ENGINE_API_KEY on this run, so the code cannot be read");
    return null;
  }

  for (let i = 0; i < attempts; i++) {
    // The mailbox has to receive it first; asking immediately always misses.
    await new Promise((r) => setTimeout(r, i === 0 ? 8000 : gapMs));
    try {
      const res = await fetch(`${base}/api/public/email/verify-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-engine-key": key },
        // `since`: only a message that arrived after this application asked
        // for its code. An employer's earlier codes — thirty of them, on a
        // day of testing — name the same company and look the same.
        body: JSON.stringify({ host, company, ...(since ? { since: new Date(since - 20_000).toISOString() } : {}) }),
        signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) { console.log(`    asking for the code: HTTP ${res.status}`); continue; }
      const data = await res.json();
      if (data?.error) console.log(`    the code lookup said: ${String(data.error).slice(0, 110)}`);
      if (data?.code) {
        const code = String(data.code);
        // The email names the employer and nothing else, so two applications
        // to the same company cannot be told apart by it. A code another
        // application in this run has already typed is not this one's;
        // keep waiting for a newer message.
        if (USED_CODES.has(code)) {
          console.log("    the newest code was already used by another application; waiting for the next");
          continue;
        }
        USED_CODES.add(code);
        console.log(`    got the code from the inbox`);
        return code;
      }
    } catch (e) {
      console.log(`    could not ask for the code: ${String(e?.message ?? e).slice(0, 90)}`);
    }
  }
  console.log(`    no security code for ${host} after ${attempts} checks`);
  return null;
}

async function waitForVerificationLink(host, attempts = 8, gapMs = 8000, kind = "activate") {
  const base = (process.env.APP_URL || "https://applynow.lol").replace(/\/+$/, "");
  const key = process.env.ENGINE_API_KEY;
  if (!key) {
    console.log("    no ENGINE_API_KEY on this run, so the inbox cannot be read for the link");
    return null;
  }

  for (let i = 0; i < attempts; i++) {
    await new Promise((r) => setTimeout(r, i === 0 ? 4000 : gapMs));
    try {
      const res = await fetch(`${base}/api/public/email/verify-link`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-engine-key": key },
        body: JSON.stringify({ host, kind }),
        signal: AbortSignal.timeout(25000),
      });
      if (!res.ok) {
        console.log(`    asking for the verification link: HTTP ${res.status}`);
        continue;
      }
      const data = await res.json();
      if (data?.error) console.log(`    verification link lookup said: ${String(data.error).slice(0, 120)}`);
      if (data?.url) {
        // A panel that predates "kind" answers every request with an
        // activation link; that is not the one a reset is waiting for.
        const looksReset = /reset|forgot|password/i.test(String(data.url).replace(host, ""));
        if ((kind === "reset") === looksReset) return String(data.url);
      }
    } catch (e) {
      console.log(`    could not ask for the verification link: ${String(e?.message ?? e).slice(0, 100)}`);
    }
  }
  console.log(`    no verification link for ${host} after ${attempts} checks`);
  return null;
}

async function saveAccount(host, email, password, status, jobId, note) {
  // on_conflict=host, and it matters more than it looks.
  //
  // Without it PostgREST resolves a merge-duplicates upsert against the
  // PRIMARY KEY, which here is a generated uuid and can never collide. So
  // every update tried to INSERT a second row for the same host, hit the
  // unique constraint, returned 409 — and the catch below threw the error
  // away. This function has never once updated an existing row.
  //
  // That is why marking a dead account "failed" did nothing, why the same
  // bogus password was retried run after run, and why a registration that
  // had already been attempted could never be attempted again.
  try {
    await db("site_accounts?on_conflict=host", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify([
        { host, email, password, status, job_id: jobId, note,
          last_used_at: new Date().toISOString() },
      ]),
    });
  } catch (e) {
    // Said out loud. A silent failure here is invisible and permanent.
    console.log(`    could not save the account for ${host}: ${String(e?.message ?? e).slice(0, 120)}`);
  }
}

// ---------------------------------------------------------------------------
// Getting to the form
// ---------------------------------------------------------------------------
//
// The first real run filled 0 fields on both jobs and reported "no submit
// button". Neither posting was broken — the form was never on screen.
//
// Two reasons, and every major ATS has at least one of them:
//
//  1. The job URL shows the DESCRIPTION. Greenhouse, Lever, Ashby and Workday
//     all keep the form behind an "Apply" button, so a page that has just
//     loaded genuinely has no inputs on it.
//  2. The form is in an IFRAME. Company careers pages routinely embed the ATS
//     rather than redirect to it, and page.$$ only ever sees the top frame.
//
// A fixed 2.5 second wait made both worse: these are React apps, and the
// fields often render after it has elapsed.

/** Every frame on the page, the main one first. */
function framesOf(page) {
  const main = page.mainFrame();
  return [main, ...page.frames().filter((f) => f !== main)];
}

/** Count the fields a human would actually be asked to fill. */
async function fieldCount(frame) {
  return frame
    .$$eval("input, select, textarea", (els) =>
      els.filter((e) => {
        const t = (e.getAttribute("type") || "").toLowerCase();
        if (["hidden", "submit", "button", "image", "reset"].includes(t)) return false;
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }).length,
    )
    .catch(() => 0);
}

/** Whichever frame holds the most fields — that is the application form. */
async function richestFrame(page) {
  let best = page.mainFrame();
  let bestCount = -1;
  for (const frame of framesOf(page)) {
    const n = await fieldCount(frame);
    if (n > bestCount) {
      best = frame;
      bestCount = n;
    }
  }
  return { frame: best, count: Math.max(0, bestCount) };
}

const SUBMIT_SELECTOR =
  'button:has-text("Submit"), button:has-text("Submit Application"), ' +
  'button:has-text("Send Application"), button:has-text("Submit application"), ' +
  'input[type=submit], button[type=submit]';

/**
 * The submit control, looked for in the form's frame first and the page
 * second. Reporting "no submit button" while looking at the wrong frame is
 * what turned two perfectly ordinary postings into needs_help.
 */
async function findSubmit(page, frame) {
  // A sentence is not a button's name.
  //
  // "Submit" is matched anywhere in a button's text, and Workday lists each
  // error at the top of the screen as a button: "Error-Prologis uses
  // HiredScore … applications submitted …". That was taken for the submit
  // button, pressed, and the application filed as sent-but-unconfirmed when
  // nothing had been sent at all.
  for (const root of [frame, page]) {
    for (const el of (await root.$$(SUBMIT_SELECTOR).catch(() => [])).slice(0, 15)) {
      try {
        const text = (
          (await el.innerText().catch(() => "")) ||
          (await el.getAttribute("value").catch(() => "")) ||
          ""
        )
          .replace(/\s+/g, " ")
          .trim();
        if (text.length > 44 || /^error\b/i.test(text)) continue;
        const inErrors = await el
          .evaluate((n) => !!n.closest('[data-automation-id="errorHeading"], [data-automation-id*="errorMessage" i], [role=alert]'))
          .catch(() => false);
        if (inErrors) continue;
        return el;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

// Workday names its wizard button in markup; everyone else only in words.
const NEXT_SELECTORS = [
  '[data-automation-id="bottom-navigation-next-button"]',
  '[data-automation-id="pageFooterNextButton"]',
  'button:has-text("Save and Continue")',
  'button:has-text("Save and continue")',
  'button:has-text("Continue")',
  'button:has-text("Next")',
];

// "Continue with LinkedIn" is not the next page of the form, and clicking it
// hands the application to a third party. "Back" is the next page in the
// wrong direction.
const NOT_NEXT_RE =
  /sign in|log in|linkedin|indeed|google|facebook|apple|guest|autofill|upload|cancel|back|previous|cookie|accept|decline/i;

/**
 * What screen we are looking at, cheaply. Compared before and after a click
 * to tell "advanced" from "clicked and nothing happened" — two outcomes the
 * old code could not distinguish, which is how six identical passes over
 * Workday page one were reported as one pass over a form with no submit.
 */
async function screenSignature(frame) {
  return await frame
    .evaluate(() => {
      const head = (document.querySelector("h1, h2")?.innerText ?? "").trim().slice(0, 60);
      const ids = Array.from(document.querySelectorAll("input, select, textarea"))
        .map((e) => e.getAttribute("data-automation-id") || e.id || e.name || "")
        .filter(Boolean)
        .slice(0, 40)
        .join(",");
      return `${location.pathname}|${head}|${ids}`;
    })
    .catch(() => "");
}

/** Move to the next page of a multi-page application. True only if it moved. */
async function advanceStep(page, form, stepNo) {
  let found = null;
  for (const sel of NEXT_SELECTORS) {
    for (const el of (await form.$$(sel).catch(() => [])).slice(0, 6)) {
      const text = ((await el.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
      const aria = (await el.getAttribute("aria-label").catch(() => "")) || "";
      const words = `${text} ${aria}`.trim();
      if (NOT_NEXT_RE.test(words)) continue;
      if (!(await el.isVisible().catch(() => false))) continue;
      found = {
        el,
        words: words.slice(0, 40) || sel,
        enabled: await el.isEnabled().catch(() => false),
      };
      break;
    }
    if (found) break;
  }

  if (!found) {
    console.log(`    step ${stepNo}: no submit and no next button on this screen`);
    return { ok: false, rejected: [] };
  }

  const before = await screenSignature(form);
  await found.el.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});

  // force, because an ordinary click on a Workday control hangs on
  // "scrolling into view" — the fault that blocked registration for hours.
  const clicked = await found.el
    .click({ timeout: 8000, force: true })
    .then(() => true)
    .catch((e) => String(e?.message ?? e).split("\n")[0].slice(0, 90));

  if (clicked !== true) {
    console.log(`    step ${stepNo}: clicking "${found.words}" failed: ${clicked}`);
    return { ok: false, rejected: [] };
  }

  const after =
    (await until(
      async () => {
        const now = await screenSignature(form);
        return now && now !== before ? now : null;
      },
      12000,
      350,
    )) ?? before;

  // An unreadable signature is not evidence either way, so give the click the
  // benefit of the doubt and let the next pass judge the screen it finds.
  if (!before || !after) {
    console.log(`    step ${stepNo}: clicked "${found.words}", could not read the screen`);
    return { ok: true, rejected: [] };
  }

  if (after === before) {
    // The click landed and nothing moved, which means the page rejected
    // something. Say what, rather than reporting a dead end.
    // The innerText of a rejected widget is its own placeholder — "Select
    // One", "Yes No" — which names nothing. The LABEL is what says which
    // question was left unanswered, so read that and the markup around it.
    const errs = [];
    for (const el of (
      await form.$$('[aria-invalid="true"], [data-automation-id*="error" i]').catch(() => [])
    ).slice(0, 6)) {
      const about = await el
        .evaluate((n) => ({
          tag: n.tagName,
          id: n.getAttribute("data-automation-id") ?? n.id ?? null,
          role: n.getAttribute("role") ?? n.getAttribute("aria-haspopup") ?? null,
          shows: (n.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 40),
          // What is INSIDE it. A pass written for role="radio" found nothing
          // in the group this portal keeps rejecting and could not say what
          // it had instead, so describe the children rather than guess a
          // fourth time at markup nobody has looked at.
          kids: Array.from(n.querySelectorAll("*"))
            .slice(0, 8)
            .map(
              (c) =>
                `${c.tagName}${c.getAttribute("role") ? `[${c.getAttribute("role")}]` : ""}` +
                `${c.getAttribute("type") ? `:${c.getAttribute("type")}` : ""}` +
                `${c.getAttribute("data-automation-id") ? `#${c.getAttribute("data-automation-id")}` : ""}`,
            ),
        }))
        .catch(() => null);
      const label = (await el.evaluate(readLabel).catch(() => "")) || "";
      errs.push({ label: String(label).slice(0, 90), ...(about ?? {}) });
    }
    console.log(
      `    step ${stepNo}: clicked "${found.words}"${found.enabled ? "" : " (disabled)"} ` +
        `and the screen did not change${errs.length ? ` — rejected ${JSON.stringify(errs)}` : ""}`,
    );
    return { ok: false, rejected: errs };
  }

  console.log(`    step ${stepNo}: advanced with "${found.words}"`);
  return { ok: true, rejected: [] };
}

/**
 * What a Workday widget is for, read from its id rather than its words.
 *
 * "address--countryRegion" is the state box; its label came back as "state
 * state select one required countryr", which matches nothing on purpose.
 */
function stateOf(p) {
  const direct = String(p.state ?? "").trim();
  if (STATE_NAMES[direct.toUpperCase()]) return STATE_NAMES[direct.toUpperCase()];
  const named = Object.values(STATE_NAMES).find((n) => n.toLowerCase() === direct.toLowerCase());
  if (named) return named;

  // The state box does not hold a state. It happened: the applier offered a
  // state dropdown "52 langeveld drive". Look for a real one in the other
  // location fields rather than typing an address into it.
  const hay = [p.state, p.location, p.city, p.address].filter(Boolean).join(" ");
  const byName = Object.values(STATE_NAMES).find((n) => new RegExp(`\\b${n}\\b`, "i").test(hay));
  if (byName) return byName;
  const byCode = hay.toUpperCase().match(/\b([A-Z]{2})\b/);
  if (byCode && STATE_NAMES[byCode[1]]) return STATE_NAMES[byCode[1]];
  return null;
}

function answerFromWidgetId(id, p) {
  const k = String(id ?? "").toLowerCase();
  if (!k) return null;
  if (/countryregion|\bregion\b|\bstate\b|province/.test(k)) return stateOf(p);
  if (/postalcode|postcode|\bzip\b/.test(k)) return p.postal_code || null;
  if (/addressline1|address1|\bstreet\b/.test(k)) return p.address || null;
  if (/\bcity\b|municipality/.test(k)) return p.city || null;
  if (/\bcountry\b/.test(k)) return p.country || "United States of America";
  return null;
}

/**
 * The options of the dropdown that is open right now, scoped to the widget
 * that opened it.
 *
 * Asking the page at large for [role=option] offered a "How did you hear
 * about us?" box the country-code list, and it very nearly clicked it. The
 * button or input names its own popup; failing that, only a VISIBLE list
 * counts, and only one can be open just after we clicked into this field.
 */
async function popupOptions(form, el) {
  const owns =
    (await el.getAttribute("aria-controls").catch(() => null)) ??
    (await el.getAttribute("aria-owns").catch(() => null));

  let handles = [];
  if (owns) {
    const id = String(owns).replace(/["\\]/g, "");
    // Wait for the list to fill, not just to exist.
    //
    // Greenhouse's location box is a react-select that searches as you
    // type: it reported aria-expanded="true" with an EMPTY listbox, because
    // this looked the instant the typing stopped and the results had not
    // come back yet. Everything it then found belonged to a hidden
    // phone-country list of 244 entries sitting elsewhere on the page.
    handles =
      (await until(async () => {
        const found = await form
          .$$(`[id="${id}"] [role=option], [id="${id}"] [data-automation-id="promptOption"]`)
          .catch(() => []);
        return found.length ? found : null;
      }, 4000)) ?? [];
  }

  if (!handles.length) {
    const lists = await form.$$("[role=listbox]").catch(() => []);
    for (const box of lists.reverse()) {
      if (!(await box.isVisible().catch(() => false))) continue;
      handles = await box
        .$$('[role=option], [data-automation-id="promptOption"]')
        .catch(() => []);
      if (handles.length) break;
    }
  }

  // Workday renders prompt options without a listbox around them. Safe only
  // because we have just clicked into this field, which closes any other
  // popup, and because invisible leftovers are excluded.
  if (!handles.length) {
    for (const o of (
      await form.$$('[data-automation-id="promptOption"]').catch(() => [])
    ).slice(0, 60)) {
      if (await o.isVisible().catch(() => false)) handles.push(o);
    }
  }

  // Workday renders each option twice, and one copy is the hidden twin. A
  // click on that one does nothing and looks like a click that worked.
  const out = [];
  const seen = new Set();
  for (const h of handles.slice(0, 80)) {
    if (!(await h.isVisible().catch(() => false))) continue;
    const text = ((await h.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push({ el: h, text });
  }
  return out;
}

/**
 * One Workday multiselect, found by the question written around it.
 *
 * Looked up afresh on every call — the portal re-renders as it is used, and a
 * handle or a tag from a moment ago may be gone. `mark` tags the widget and
 * says what it holds; `input` and `options` work from the tag.
 */
function workdayWidget(form, label, fallbackId) {
  // The question's own words. "search" and what follows it come from the
  // box's attributes, not from anything written on the page.
  const key = label.toLowerCase().replace(/\bsearch\b.*$/, "").trim().split(/\s+/).slice(0, 4).join(" ");
  const mark = async () =>
    await form
      .evaluate(
        ({ k, id }) => {
          const W = '[data-automation-id="multiselectInputContainer"]';
          let found = null;
          for (const box of document.querySelectorAll(W)) {
            let ctx = box.closest('[data-automation-id^="formField"]');
            if (!ctx) {
              ctx = box.parentElement;
              for (let d = 0; ctx && d < 6; d++, ctx = ctx.parentElement) {
                if ((ctx.innerText ?? "").toLowerCase().includes(k)) break;
              }
            }
            if (ctx && ctx.querySelectorAll(W).length === 1 && (ctx.innerText ?? "").toLowerCase().includes(k)) {
              found = box;
              break;
            }
          }
          if (!found && id) found = document.querySelector(`[id="${id}"]`)?.closest(W) ?? null;
          if (!found) return null;
          document.querySelectorAll("[data-ap-src]").forEach((e) => e.removeAttribute("data-ap-src"));
          found.setAttribute("data-ap-src", "1");
          const field = found.closest('[data-automation-id^="formField"]') ?? found.parentElement ?? found;
          const m = (found.innerText ?? "").match(/(\d+)\s+items?\s+selected/i);
          const pills = field.querySelectorAll('[data-automation-id="selectedItem"]').length;
          const input = found.querySelector("input");
          return {
            n: m ? Number(m[1]) : null,
            pills,
            open: input?.getAttribute("aria-expanded") ?? null,
          };
        },
        { k: key, id: fallbackId ?? null },
      )
      .catch(() => null);
  const held = (st) => Math.max(st?.n ?? 0, st?.pills ?? 0);
  const input = async () => await form.$('[data-ap-src="1"] input').catch(() => null);

  // This widget's own list, and nobody else's.
  //
  // The general reader falls back to "whatever list is showing", which is
  // right for a page with one dropdown and wrong here: Ryder's skills search
  // was handed the field-of-study list from the box above it, and a click
  // meant for a skill landed on "African-American Studies". Workday marks the
  // list that is open for the prompt in use, and the box names the list it
  // controls; a list that is neither is somebody else's.
  const options = async (loose = false) => {
    const el = await input();
    if (!el) return [];
    const controls =
      (await el.getAttribute("aria-controls").catch(() => null)) ??
      (await el.getAttribute("aria-owns").catch(() => null));
    const id = controls ? String(controls).replace(/["\\]/g, "") : null;
    let handles = [];
    for (let wait = 0; wait < 5 && !handles.length; wait++) {
      handles = await form
        .$$('[data-automation-id="activeListContainer"] [role=option], [data-automation-id="activeListContainer"] [data-automation-id="menuItem"]')
        .catch(() => []);
      if (!handles.length && id) {
        handles = await form.$$(`[id="${id}"] [role=option], [id="${id}"] [data-automation-id="promptOption"]`).catch(() => []);
      }
      if (!handles.length) await new Promise((r) => setTimeout(r, 300));
    }
    const out = [];
    const seen = new Set();
    for (const h of handles.slice(0, 80)) {
      if (!(await h.isVisible().catch(() => false))) continue;
      const text = ((await h.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      out.push({ el: h, text });
    }
    // Asked for loosely — a second-level list, or search results — the
    // general reader may be used when the marked list is not there, but a
    // list of dial codes is never this widget's.
    if (!out.length && loose) {
      const any = await popupOptions(form, el);
      return any.some((o) => /\(\+\d+\)/.test(o.text)) ? [] : any;
    }
    return out;
  };
  return { mark, held, input, options };
}

/** Skills the resume itself names, the ones the posting asks for first. */
function skillTerms(profile, job) {
  const resume = String(job?.tailored_resume || profile?.resume_text || "").toLowerCase();
  const posting = String(job?.description ?? "").toLowerCase();
  const KNOWN = [
    "Customer Service", "Microsoft Excel", "Microsoft Office", "Sales", "Inventory Management", "Scheduling",
    "Vendor Management", "Project Management", "Data Analysis", "Operations Management", "Logistics",
    "Supply Chain", "Team Leadership", "Leadership", "Training", "Budgeting", "Reporting", "Negotiation",
    "Marketing", "Merchandising", "Retail", "Account Management", "Process Improvement", "Quality Assurance",
    "Recruiting", "Payroll", "Bookkeeping", "QuickBooks", "Salesforce", "SQL", "Python", "Data Entry",
    "Problem Solving", "Time Management", "Communication",
  ];
  const has = KNOWN.filter((k) => resume.includes(k.toLowerCase()));
  const wanted = has.filter((k) => posting.includes(k.toLowerCase()));
  const rest = has.filter((k) => !wanted.includes(k));
  const out = [...wanted, ...rest];
  // Something every working adult's resume supports, if it names none of these.
  for (const k of ["Customer Service", "Communication"]) if (!out.includes(k)) out.push(k);
  return out;
}

/**
 * Workday's "Type to Add Skills", required on some tenants.
 *
 * It is a search, and it searches when Enter is pressed: until then it shows
 * "No Items." however exactly the skill is typed, which is where Target
 * stopped a form with every other field filled. Each skill is typed, searched
 * and chosen from what comes back; up to three are added.
 */
async function workdaySkillsPrompt(form, page, label, terms) {
  const w = workdayWidget(form, label, "skills--skills");
  const trace = [];
  await closePopups(page, form);
  let st = await w.mark();
  if (!st) return null;
  let have = w.held(st);
  if (have > 0) return have;
  const real = (o) => o.filter((x) => x.text && !/^no (items|results|matches|options)\b/i.test(x.text));

  let misses = 0;
  for (const term of terms.slice(0, 6)) {
    if (have >= 3) break;
    // One skill satisfies a required box; two searches that add nothing
    // after that are time better spent on the rest of the form.
    if (have >= 1 && misses >= 2) break;
    const box = await w.input();
    if (!box) break;
    await box.click({ timeout: 3000 }).catch(() => box.click({ force: true, timeout: 3000 }).catch(() => {}));
    await box.fill("", { timeout: 3000 }).catch(() => {});
    await box.type(term, { delay: 35 }).catch(() => {});
    await box.press("Enter").catch(() => {});

    let found = [];
    for (let i = 0; i < 7 && !found.length; i++) {
      await page.waitForTimeout(600);
      st = await w.mark();
      if (w.held(st) > have) break; // a single match is taken outright
      found = real(await w.options(true));
    }
    if (w.held(st) > have) {
      have = w.held(st);
      trace.push(`"${term}" taken on Enter`);
      continue;
    }
    if (!found.length) {
      misses++;
      trace.push(`"${term}": nothing found`);
      continue;
    }
    // Only a result that is about the skill searched for. "Whatever came
    // back first" is how a click meant for a skill reached another list.
    const t = norm(term);
    const words = t.split(" ").filter((x) => x.length >= 4);
    const pick =
      found.find((o) => norm(o.text) === t) ??
      found.find((o) => norm(o.text).startsWith(t)) ??
      found.find((o) => words.length > 0 && words.every((x) => norm(o.text).includes(x))) ??
      null;
    if (!pick) {
      misses++;
      trace.push(`"${term}": ${found.length} result(s), none about it`);
      continue;
    }
    const inner = (await pick.el.$('[data-automation-id="promptOption"]').catch(() => null)) ?? pick.el;
    await inner.click({ timeout: 3000 }).catch(() => inner.click({ force: true, timeout: 3000 }).catch(() => {}));
    await page.waitForTimeout(900);
    st = await w.mark();
    if (w.held(st) <= have) {
      // The row took the click and the box did not: tick its checkbox.
      const tick = await pick.el.$('input[type=checkbox], [role=checkbox], [data-automation-id="checkboxPanel"]').catch(() => null);
      if (tick) await tick.click({ force: true, timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(800);
      st = await w.mark();
    }
    trace.push(`"${term}" -> "${pick.text.slice(0, 24)}" of ${found.length}: n=${st?.n},pills=${st?.pills}`);
    have = Math.max(have, w.held(st));
  }
  await closePopups(page, form);
  st = await w.mark();
  console.log(`    skills trace: ${trace.join(" > ").slice(0, 900)} => ${w.held(st)} held`);
  return w.held(st);
}

/**
 * Workday's field-of-study search: several hundred subjects, shown only once
 * a word is searched for. Each meaningful word of the resume's subject is
 * searched in turn and the closest offered subject taken.
 */
async function workdayStudyPrompt(form, page, label, want) {
  const w = workdayWidget(form, label, null);
  await closePopups(page, form);
  let st = await w.mark();
  if (!st) return null;
  const trace = [];
  const words = String(want)
    .split(/[^A-Za-z]+/)
    .filter((x) => x.length > 2 && !/^(studies|study|general|science|sciences|arts|and|the)$/i.test(x));
  const about = (text) => words.some((x) => new RegExp(`\\b${x}`, "i").test(text));
  if (w.held(st) > 0) {
    // A subject already in the box stays only if it is the resume's. One
    // attempt, finding nothing under the resume's own words, fell back to
    // "Business" and took the first result — "Agricultural Business" — which
    // is a degree nobody holds, saved in a draft.
    const sitting = await form
      .evaluate(() => {
        const box = document.querySelector('[data-ap-src="1"]');
        const field = box?.closest('[data-automation-id^="formField"]') ?? box?.parentElement ?? box;
        return Array.from(field?.querySelectorAll('[data-automation-id="selectedItem"]') ?? []).map((e) => (e.innerText || "").trim()).filter(Boolean);
      })
      .catch(() => []);
    if (!sitting.length || sitting.every(about)) return w.held(st);
    trace.push(`held ${JSON.stringify(sitting.map((t) => t.slice(0, 30)))} is not the resume's; removing`);
    for (let i = 0; i < 3 && w.held(st) > 0; i++) {
      const x = await form.$('[data-ap-src="1"] [data-automation-id="DELETE_charm"]').catch(() => null);
      if (x) await x.click({ timeout: 3000 }).catch(() => x.click({ force: true, timeout: 3000 }).catch(() => {}));
      else {
        const b = await w.input();
        if (b) { await b.click({ force: true, timeout: 3000 }).catch(() => {}); await page.keyboard.press("Backspace").catch(() => {}); }
      }
      await page.waitForTimeout(700);
      st = await w.mark();
    }
    if (w.held(st) > 0) { console.log(`    skills trace: study ${trace.join(" > ")} — could not remove`); return 0; }
  }
  // The resume's own words, then the nearest names for the same subject.
  // Never a subject merely because the list had one.
  const kin = /law|justice|legal|crimin/i.test(want) ? ["Criminal Justice", "Criminology", "Legal Studies", "Pre-Law"] : [];
  for (const term of [...words.reverse(), ...kin]) {
    const box = await w.input();
    if (!box) break;
    await box.click({ timeout: 3000 }).catch(() => box.click({ force: true, timeout: 3000 }).catch(() => {}));
    await box.fill("", { timeout: 3000 }).catch(() => {});
    await box.type(term, { delay: 35 }).catch(() => {});
    await box.press("Enter").catch(() => {});
    let found = [];
    for (let i = 0; i < 6 && !found.length; i++) {
      await page.waitForTimeout(600);
      st = await w.mark();
      if (w.held(st) > 0) break;
      found = (await w.options(true)).filter((o) => o.text && !/^no (items|results|matches)/i.test(o.text) && new RegExp(`\\b${term.split(" ")[0]}`, "i").test(o.text));
    }
    if (w.held(st) > 0) { trace.push(`"${term}" taken on Enter`); break; }
    if (!found.length) { trace.push(`"${term}": nothing`); continue; }
    // Shortest first: "Law" before "Law Enforcement Administration".
    const pick = bestOption(found, want, label) ?? [...found].sort((x, y) => x.text.length - y.text.length)[0];
    const inner = (await pick.el.$('[data-automation-id="promptOption"]').catch(() => null)) ?? pick.el;
    await inner.click({ timeout: 3000 }).catch(() => inner.click({ force: true, timeout: 3000 }).catch(() => {}));
    await page.waitForTimeout(900);
    st = await w.mark();
    trace.push(`"${term}" -> "${pick.text.slice(0, 26)}": ${w.held(st)} held`);
    if (w.held(st) > 0) break;
  }
  await closePopups(page, form);
  console.log(`    skills trace: study ${trace.join(" > ").slice(0, 600)}`);
  return w.held(await w.mark());
}

/**
 * Workday's "How did you hear about us?" prompt, handled on its own terms.
 *
 * It is the one field that has stopped finished applications at Target,
 * Johnson & Johnson, Live Nation and Xylem, and the general combobox code has
 * failed at it six different ways while reporting almost nothing. This walks
 * the prompt the way a person does — open it, choose, go one level down if it
 * turns out to be a folder — checks what the widget holds after every single
 * action, and writes the whole sequence to the log as one line, so a failure
 * says where it failed.
 *
 * Returns how many values the widget holds at the end.
 */
async function workdaySourcePrompt(form, page, label, want) {
  const trace = [];
  const { mark, held, input, options } = workdayWidget(form, label, "source--source");
  const names = (o) => o.map((x) => x.text).filter(Boolean);
  const step = async (what) => {
    const st = await mark();
    trace.push(`${what}:${st ? `n=${st.n},pills=${st.pills},open=${st.open}` : "widget gone"}`);
    return st;
  };
  const finish = (n) => {
    console.log(`    source trace: ${trace.join(" > ").slice(0, 1100)}`);
    return n;
  };

  let st = await step("start");
  if (!st) return finish(null);
  if (held(st) > 0) {
    // Something is already chosen — by an earlier attempt, saved in the
    // portal's draft. Keep it only if it is an answer this would give: one
    // attempt chose an agency, and a draft remembers.
    const sitting = await form
      .evaluate(() => {
        const box = document.querySelector('[data-ap-src="1"]');
        const field = box?.closest('[data-automation-id^="formField"]') ?? box?.parentElement ?? box;
        return Array.from(field?.querySelectorAll('[data-automation-id="selectedItem"]') ?? [])
          .map((e) => (e.innerText || "").replace(/\s+/g, " ").trim())
          .filter(Boolean);
      })
      .catch(() => []);
    const wrong = sitting.filter((t) => NEVER_SOURCE.test(t) || !SOURCE_OURS.test(t));
    trace.push(`holds ${JSON.stringify(sitting.map((t) => t.slice(0, 40)))}`);
    if (!sitting.length || !wrong.length) return finish(held(st));
    trace.push(`held ${JSON.stringify(sitting.map((t) => t.slice(0, 30)))} is not ours; removing`);
    for (let i = 0; i < 4 && held(st) > 0; i++) {
      const x = await form
        .$('[data-ap-src="1"] [data-automation-id="DELETE_charm"], [data-ap-src="1"] [data-automation-id="selectedItem"] [role=button]')
        .catch(() => null);
      if (x) await x.click({ timeout: 3000 }).catch(() => x.click({ force: true, timeout: 3000 }).catch(() => {}));
      else {
        const b = await input();
        if (b) {
          await b.click({ force: true, timeout: 3000 }).catch(() => {});
          await page.keyboard.press("Backspace").catch(() => {});
        }
      }
      await page.waitForTimeout(700);
      st = await mark();
    }
    st = await step("after removing");
    // Could not be removed: say so, and do not call the field answered.
    if (held(st) > 0) return finish(0);
  }
  await closePopups(page, form);

  // Open it.
  let box = await input();
  if (!box) return finish(null);
  await box.fill("", { timeout: 3000 }).catch(() => {});
  await box.click({ timeout: 4000 }).catch(() => box.click({ force: true, timeout: 4000 }).catch(() => {}));
  await page.waitForTimeout(1200);
  let offered = await options();
  if (!offered.length) {
    const icon = await form
      .$('[data-ap-src="1"] [data-automation-id="promptIcon"], [data-ap-src="1"] [data-automation-id="promptSearchButton"]')
      .catch(() => null);
    if (icon) await icon.click({ timeout: 3000 }).catch(() => icon.click({ force: true, timeout: 3000 }).catch(() => {}));
    await page.waitForTimeout(1200);
    offered = await options();
    trace.push(`icon:${offered.length} opts`);
  }
  // A list that is not marked as this prompt's is used only if it plainly
  // holds an answer to this question.
  if (!offered.length) {
    const any = await options(true);
    if (any.length && bestOption(any, want, label)) {
      offered = any;
      trace.push("unmarked list");
    }
  }
  trace.push(`opened:${JSON.stringify(names(offered).slice(0, 6))}`);

  let lastHit = null;
  for (let depth = 0; depth < 3 && offered.length; depth++) {
    // Dial codes are the country list, not sources.
    if (offered.some((o) => /\(\+\d+\)/.test(o.text))) {
      trace.push("that is the phone-code list; not choosing from it");
      break;
    }
    const hit = chooseSource(offered, want, label);
    if (!hit) {
      trace.push(`nothing true to choose in ${JSON.stringify(names(offered).slice(0, 6))}`);
      break;
    }
    lastHit = hit.text;
    const before = names(offered).join("|");

    // Each way of choosing, in turn, stopping at the first that changes
    // anything: a value held, or a different list (a folder opened).
    const ways = [
      ["click", async () => {
        const inner = (await hit.el.$('[data-automation-id="promptOption"]').catch(() => null)) ?? hit.el;
        await inner.click({ timeout: 3000 });
      }],
      ["radio", async () => {
        const r = await hit.el
          .$('input[type=radio], input[type=checkbox], [role=radio], [role=checkbox], [data-automation-id="radioBtn"], [data-automation-id="checkboxPanel"]')
          .catch(() => null);
        if (!r) throw new Error("none");
        await r.click({ force: true, timeout: 3000 });
      }],
      ["mouse", async () => {
        const b = await hit.el.boundingBox();
        if (!b) throw new Error("no box");
        await page.mouse.click(b.x + Math.min(b.width / 2, 60), b.y + b.height / 2);
      }],
      ["enter", async () => {
        await hit.el.focus().catch(() => {});
        await page.keyboard.press("Enter");
      }],
      ["row", async () => {
        const row = await hit.el.evaluateHandle((n) => n.closest('[role=option], [data-automation-id="menuItem"]') ?? n);
        await row.asElement().click({ force: true, timeout: 3000 });
      }],
    ];

    let moved = false;
    for (const [name, act] of ways) {
      const err = await act().then(() => null).catch((e) => String(e?.message ?? e).split("\n")[0].slice(0, 40));
      await page.waitForTimeout(1000);
      st = await mark();
      const now = await options(true);
      const changed = names(now).join("|") !== before;
      trace.push(
        `d${depth} ${name} "${hit.text.slice(0, 22)}"${err ? ` ERR ${err}` : ""}:` +
          `${st ? `n=${st.n},pills=${st.pills}` : "gone"},${now.length ? (changed ? `list->${JSON.stringify(names(now).slice(0, 5))}` : "same list") : "list closed"}`,
      );
      if (held(st) > 0) return finish(held(st));
      if (changed && now.length) { offered = now; moved = true; break; }
      // Closed with nothing held: reopen before trying the next way.
      if (!now.length) {
        box = await input();
        if (box) await box.click({ timeout: 3000 }).catch(() => box.click({ force: true, timeout: 3000 }).catch(() => {}));
        await page.waitForTimeout(1000);
        const again = await options(depth > 0);
        if (!again.length) break;
        const same = again.find((o) => o.text === hit.text);
        if (!same) { offered = again; moved = true; break; }
        hit.el = same.el;
      }
    }
    if (!moved) break;
  }

  // Last: search for it. Workday searches on Enter and takes a single match.
  box = await input();
  if (box && lastHit) {
    await box.click({ force: true, timeout: 3000 }).catch(() => {});
    await box.fill("", { timeout: 3000 }).catch(() => {});
    await box.type(lastHit, { delay: 40 }).catch(() => {});
    await box.press("Enter").catch(() => {});
    await page.waitForTimeout(2200);
    st = await step(`typed "${lastHit.slice(0, 20)}"+Enter`);
    if (held(st) > 0) return finish(held(st));
    const found = await options(true);
    trace.push(`results:${JSON.stringify(names(found).slice(0, 5))}`);
    if (found.length) {
      const pick = chooseSource(found, want, label);
      if (!pick) return finish(held(await mark()));
      const inner = (await pick.el.$('[data-automation-id="promptOption"]').catch(() => null)) ?? pick.el;
      await inner.click({ timeout: 3000 }).catch(() => inner.click({ force: true, timeout: 3000 }).catch(() => {}));
      await page.waitForTimeout(1200);
      st = await step(`clicked result "${pick.text.slice(0, 20)}"`);
      if (held(st) > 0) return finish(held(st));
    }
  }

  // Nothing worked: what the open prompt is made of, structure only.
  const skeleton = await form
    .evaluate(() => {
      const shown = (e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const first = Array.from(document.querySelectorAll('[data-automation-id="promptOption"], [role=option]')).find(shown);
      let root = first;
      for (let d = 0; root?.parentElement && d < 5; d++) root = root.parentElement;
      const widget = document.querySelector('[data-ap-src="1"]');
      const draw = (e, depth) => {
        if (!e || depth > 7) return "";
        const a = ["data-automation-id", "role", "aria-selected", "aria-checked", "aria-expanded", "aria-haspopup", "type", "tabindex"]
          .map((k) => (e.getAttribute(k) !== null ? `${k.replace("data-automation-", "").replace("aria-", "")}=${e.getAttribute(k)}` : null))
          .filter(Boolean)
          .join(",");
        const kids = Array.from(e.children).filter(shown).slice(0, 3).map((c) => draw(c, depth + 1)).join("");
        return `<${e.tagName.toLowerCase()}${a ? " " + a : ""}>${kids}`;
      };
      return { widget: draw(widget, 0).slice(0, 500), popup: root ? draw(root, 0).slice(0, 700) : null };
    })
    .catch(() => null);
  console.log(`    source prompt skeleton: ${JSON.stringify(skeleton)}`);
  await page.keyboard.press("Escape").catch(() => {});
  return finish(held(await mark()));
}


// How employers word "I found you on your own website". No two agree, and
// the answer has to be one of the options actually on offer.
const SOURCE_PREFS = [
  /company (career )?(web)?site|career site|corporate (web)?site|company website/i,
  // Datadog's list has no "website" in it at all, and the next rule down took
  // "LinkedIn (Job Posting)" for the words "job posting" — naming a source
  // these applications did not come from. They come from the careers page.
  /careers? ?(page|site|portal|web)|company careers|our (web)?site/i,
  /^(company|employer)\b/i,
  // "BMS Website" is how Bristol Myers Squibb words it, and no list of
  // company names can be written in advance — match the word itself.
  /\bweb ?site\b/i,
  // Capital One's whole list is events, recruiters, agencies — and "Internet".
  /^internet$|\bonline\b|\binternet search\b|company web/i,
  /job (board|posting|search)|search engine|google/i,
  /linkedin|indeed/i,
  /\bother\b/i,
];

// What "how did you hear about us" may never be answered with. These
// applications come from the employer's own careers site; an agency, a
// referral, an event or an advertisement is a statement about how the
// applicant arrived that is simply not true — and an agency named on an
// application can be owed a fee for it.
const NEVER_SOURCE =
  /agenc|recruit|staffing|headhunt|search firm|referr|employee|colleague|friend|relative|family|\bevents?\b|\bfair\b|campus|universit|college|school|alumni|military|veteran|\bunion\b|vendor|rehire|internal|contingent|conference|association|radio|newspaper|television|\btv\b|billboard|signage|\bprint\b|magazine|direct mail|e-?mail|\btext\b/i;

// A source already sitting in the box is kept only if it is one of ours.
const SOURCE_OURS =
  /career|web ?site|\.com\b|\.jobs\b|\.org\b|corporate|company|internet|online|job ?(board|site|posting)s?|search engine|google|linkedin|indeed|\bother\b/i;

/**
 * The option to answer a source question with, or null when the list holds
 * nothing true to say. Never "whatever comes first": Prudential's list opens
 * on "Recruiting Agency" and "Source", and the first of those leads to a
 * directory of agencies.
 */
function chooseSource(offered, want, label) {
  const ok = offered.filter((o) => !NEVER_SOURCE.test(o.text));
  if (!ok.length) return null;
  const hit = bestOption(ok, want, label);
  if (hit && !NEVER_SOURCE.test(hit.text)) return hit;
  // A folder that only holds the real list.
  const folder = ok.find((o) => /^(sources?|other sources?|general|all sources?)$/i.test(o.text.trim()));
  if (folder) return folder;
  // One thing left that is not ruled out: under "Company Web Site" the only
  // entry is the site's own address, whatever it is called.
  return ok.length === 1 ? ok[0] : null;
}

/** Is there a captcha a person would have to operate, in any frame? */
async function visibleCaptcha(page) {
  for (const frame of page.frames()) {
    const shown = await frame
      .evaluate(() => {
        const big = (e) => {
          const r = e.getBoundingClientRect();
          const st = getComputedStyle(e);
          return r.width > 40 && r.height > 40 && st.visibility !== "hidden" && st.display !== "none" && st.opacity !== "0";
        };
        const sel =
          ".g-recaptcha, .h-captcha, .cf-turnstile, iframe[src*='recaptcha'], iframe[src*='hcaptcha'], iframe[src*='turnstile'], iframe[title*='challenge' i]";
        for (const e of document.querySelectorAll(sel)) {
          if (e.getAttribute("data-size") === "invisible") continue;
          if (e.closest(".grecaptcha-badge")) continue;
          const src = e.getAttribute("src") || "";
          if (/size=invisible/.test(src)) continue;
          // reCAPTCHA's own frames: "anchor" is the checkbox, "bframe" the
          // picture challenge. Anything else it loads is plumbing.
          if (/recaptcha/.test(src) && !/anchor|bframe/.test(src)) continue;
          if (big(e)) return true;
        }
        return false;
      })
      .catch(() => false);
    if (shown) return true;
  }
  return false;
}

/**
 * A yes or no for a question nothing on file answers.
 *
 * The owner's instruction is that no question waits for them: answers come
 * from the resume, and where the resume cannot say, from what an applicant
 * for this job would ordinarily answer. So this is tried last — after the
 * profile, every saved answer and the resume readers — and every answer it
 * gives is printed as assumed, so none of them is silent. Anything saved in
 * the panel overrides it.
 *
 * Self-identification is never answered here; that is declined elsewhere.
 */
function defaultYesNo(label, p) {
  const l = String(label ?? "").toLowerCase().replace(/\s+/g, " ");
  const resume = String(p?.resume_text ?? "").toLowerCase();
  // Two notices are worded as statements and still want a Yes or a No.
  const STATED = /public accounting firm|immigration reform and control act/;
  if (!/\?|^(are|do|does|did|have|has|can|will|would|is|were) /.test(l) && !STATED.test(l)) return null;
  if (/\b(race|ethnic|gender|sex|veteran|disabilit|hispanic|latin|religion|orientation|pronoun)/.test(l)) return null;
  // "In accordance with the Immigration Reform and Control Act… you will be
  // asked to provide proof of identity and eligibility to work." Whether
  // that can be done, which follows from being authorized to work.
  if (/immigration reform and control act/.test(l) && /proof|document|verif|eligib/.test(l)) {
    return /^(no|false)$/i.test(String(p?.work_authorized ?? p?.authorized_to_work ?? "").trim()) ? null : "Yes";
  }

  // Read off the resume where it can be.
  if (/familiar with|experience (with|in|using)|knowledge of|proficien|worked with|have you used/.test(l)) {
    const subject = l.match(/(?:familiar with|experience (?:with|in|using)|knowledge of|proficient (?:in|with)|worked with|have you used)\s+([a-z0-9 .+#/&-]{2,40})/)?.[1] ?? "";
    const words = subject.split(/[^a-z0-9+#]+/).filter((w) => w.length > 2 && !/^(the|and|regulations?|requirements?|compliance|software|tools?|systems?)$/.test(w));
    if (words.length) return words.some((w) => new RegExp(`\\b${w.replace(/[+#]/g, "\\$&")}\\b`).test(resume)) ? "Yes" : "No";
  }
  if (/second job|outside (business|employment|activit)|other employment|moonlight/.test(l)) {
    return /\b(owner|founder|self-employed|freelance)\b[^\n]{0,80}\b(present|current)\b/.test(resume) ? "Yes" : "No";
  }

  // "Are you currently, or have you been, a contractor with Target?"
  if (/\b(contractor|contingent worker|consultant|temporary worker|temp worker|agency worker|vendor)\b[^?]{0,40}\b(with|for|at)\b/.test(l) && /\b(are you|have you|were you)\b/.test(l)) {
    return "No";
  }
  // "As a Ryder employee, would you have your own business or work for
  // another company?" The resume shows whether one is being run now.
  if (/your own business|work for another (company|employer|organi[sz]ation)|another job|other (job|employer)s?\b|outside of [a-z0-9&' .-]{2,30} while/.test(l)) {
    return /\b(owner|founder|co-founder|self-employed|freelance|proprietor)\b[^\n]{0,80}\b(present|current)\b/.test(resume) ? "Yes" : "No";
  }
  // "May we text your mobile phone?" About the application; being reachable
  // is the point of having applied.
  if (/\b(may|can) we (text|sms|message|contact you (by|via) text)|receive (text|sms) messages|text message[^?]{0,40}(about|regarding)[^?]{0,30}(application|interview|job|opportunit)/.test(l)) {
    return "Yes";
  }
  // "Do you possess a bachelor's degree or equivalent professional experience?"
  if (/\b(possess|have|hold|earned|completed)\b[^?]{0,20}\b(bachelor|associate|master|high school|college|university|ged)\b/.test(l)) {
    const level = /\bbachelor|\bb\.?[as]\.?\b|\bmaster|\bm\.?b\.?a\b|\bph\.?d/.test(resume) ? 3 : /\bassociate/.test(resume) ? 2 : 1;
    const asked = /\bmaster/.test(l) ? 4 : /\bbachelor|college|university/.test(l) ? 3 : /\bassociate/.test(l) ? 2 : 1;
    if (level >= asked || (/equivalent[^?]{0,30}experience/.test(l) && Number(p?.years_experience ?? 0) >= 4)) return "Yes";
    return "No";
  }
  // "Do you have a minimum of five years of foodservice sales experience?"
  // The years come from the profile and the kind of work from the resume;
  // both have to be there.
  {
    const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
    const m = l.match(/\b(?:minimum of|at least|have)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\+?\s*(?:or more\s+)?years?(?:'| of)?\s+(?:of\s+)?([a-z0-9 /&,-]{3,60}?)\s+experience\b/);
    if (m) {
      const need = Number(m[1]) || WORDS[m[1]] || 0;
      const subject = m[2].split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !/^(related|relevant|professional|progressive|prior|previous|direct|experience|work|working|with|years?)$/.test(w));
      const shows = (w) =>
        /^supervis|^manag|^leader/.test(w)
          ? /\b(supervis\w*|manag\w*|owner|led|lead|director)\b/.test(resume)
          : resume.includes(w.replace(/(ing|s)$/, ""));
      const years = Number(p?.years_experience ?? 0);
      return subject.every(shows) && (!years || years >= need) ? "Yes" : "No";
    }
  }
  // "Do you have at least one (1) year of experience in outside sales?" and
  // "Do you have previous work experience conducting sales calls?" The same
  // question with the kind of work named after the word rather than before
  // it. Kept beside the rule above, which is left as it was.
  {
    const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
    const plain = l.replace(/\s*\(\d+\)/g, "");
    const m =
      plain.match(/\b(?:minimum of|at least|have)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\+?\s*(?:or more\s+)?years?(?:'|s')?\s+(?:of\s+)?(?:[a-z-]+\s+){0,2}experience\s+(?:in|with|of|as|doing|working|selling|managing|using|[a-z]+ing)?\s*([^?.]{3,120})/) ??
      plain.match(/\b(?:do you have|have you had|have you)\s+(?:any\s+)?()(?:previous|prior|past)\s+(?:work\s+|working\s+)?experience\s+([^?.]{3,120})/);
    if (m) {
      const need = Number(m[1]) || WORDS[m[1]] || 0;
      const STOP = /^(related|relevant|professional|progressive|prior|previous|direct|experience|work|working|with|years?|that|this|such|similar|environment|setting|role|position|industry|field|within|other|from|have|your|their|about|and\/or)$/;
      const subject = m[2].split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !STOP.test(w));
      const shows = (w) =>
        /^supervis|^manag|^leader/.test(w)
          ? /\b(supervis\w*|manag\w*|owner|led|lead|director)\b/.test(resume)
          : resume.includes(w.replace(/(ing|s)$/, ""));
      const years = Number(p?.years_experience ?? 0);
      if (subject.length) {
        const hits = subject.filter(shows).length;
        return hits * 2 >= subject.length && (!years || years >= need) ? "Yes" : "No";
      }
    }
  }
  // Auditor independence: "employed with a public accounting firm that has
  // dealings with TD Bank", of the applicant or their family.
  if (/public accounting firm|external auditor|audit firm/.test(l)) {
    return /\b(deloitte|pwc|pricewaterhouse|ernst|kpmg|public accounting)\b/.test(resume) ? "Yes" : "No";
  }
  // "Do you reside in the same household with someone employed at Lowe's?"
  if (/same household|household member|live with (someone|anyone)/.test(l)) return "No";
  // "…may be asked to submit to a screening test to detect the presence of…"
  if (/screening test|submit to a (drug|screening)|pre-?employment (drug|screen)/.test(l)) return "Yes";
  // The tax-credit questionnaire some employers offer before an application.
  // Optional, about the employer's taxes, and it leads off the form.
  if (/work opportunity tax credit|\bwotc\b/.test(l)) return "No";
  // "Answer Yes if you have personally participated in any type of service
  // for Prudential…": prior work for the employer, by another name.
  if (/\b(participated in|performed|provided|rendered)\b[^?]{0,30}\bservices?\b[^?]{0,10}\b(for|to)\b/.test(l)) {
    return "No";
  }
  // "Are you currently a Ryder employee?" The resume says who the employer is.
  {
    const m = l.match(/are you (?:currently |presently |now )?(?:a|an) (?:current |active )?([a-z0-9&.' -]{2,40}?) (?:employee|associate|team member|contractor|contingent worker|intern)\b/);
    if (m) {
      const name = m[1].trim().split(/\s+/)[0] ?? "";
      const current = new RegExp(`${name.replace(/[^a-z0-9]/g, ".")}[^\\n]{0,80}\\b(present|current)\\b`).test(resume);
      return name.length > 2 && current ? "Yes" : "No";
    }
  }
  // The Open Payments question: is the applicant a practising clinician.
  if (/medicare and medicaid|open payments|sunshine act|licensed (physician|health ?care)|health ?care (professional|provider|practitioner)/.test(l)) {
    return /\b(physician|registered nurse|nurse practitioner|pharmacist|dentist|doctor of (medicine|osteopath\w*)|physician assistant)\b/.test(resume) ? "Yes" : "No";
  }
  // "Do you have any agreement that would restrict you from working here?"
  if (/\bany (agreements?|contracts?|obligations?|restrictions?) (that|which|with)\b|restrict(s|ed|ing)? (you|your)\b|prevent you from|prohibit you from/.test(l)) {
    return "No";
  }
  // "Are you a career returner?" — someone back from a multi-year break.
  if (/career returner|returnship|career break/.test(l)) return "No";
  // "Have you worked for PricewaterhouseCoopers?" The resume lists employers.
  {
    const m = l.match(/have you (?:ever |previously )?(?:worked|been employed) (?:for|at|by) ([a-z0-9&.' -]{3,40})/);
    if (m) {
      const name = m[1].replace(/\b(or|and|any|its|the|a|an|before|previously|in the past)\b.*$/, "").trim().split(/\s+/)[0] ?? "";
      return name.length > 2 && resume.includes(name) ? "Yes" : "No";
    }
  }

  // Conflicts, restrictions and adverse history: No.
  if (/relationship|relative|related to|family member|financial interest|conflict of interest|non-?compete|restrictive covenant|subject to any|convicted|felony|misdemeanor|terminated|discharged|dismissed|disciplin|debarr|sanction|suspended|revoked|lawsuit|bankrupt|government official|require (visa )?sponsorship|represented by|recruiting agency|staffing agency|third.party recruiter/.test(l)) {
    return "No";
  }

  // Able, willing, eligible, licensed, available: Yes. Applying for the job
  // is already a claim to these.
  if (/\b(flexible schedule|part.time work|travel (domestically|internationally)|work (nights|weekends|holidays|overtime|evenings))\b/.test(l)) return "Yes";
  if (/\b(able to|willing to|comfortable|available|can you|eligible|licen[sc]e|reliable transportation|at least \d+|years of age|background check|drug (test|screen)|lift|stand|on-?site|in-?person|shift|weekend|overtime|schedule|commute|travel|relocat|start|understand|agree|acknowledge|certify|confirm|hourly rate|pay rate|starting (pay|rate|salary)|salary range|compensation|within your|acceptable|meets? your|work for you|interested in)\b/.test(l)) {
    return "Yes";
  }
  return null;
}

/**
 * Answers that come from the posting or from plain evidence, tried only after
 * the profile and every saved answer have had their say — so anything the
 * user has set in the panel always wins over these.
 */
function lastResort(label, p, job) {
  const l = String(label ?? "");

  // "In what cities are you available to work?" over a list of offices. The
  // posting was chosen because it is within reach, so its own city is the
  // answer; a posting with no city falls back to the profile's.
  if (
    /\b(city|cities|offices?|locations?)\b/i.test(l) &&
    /\b(available|prefer\w*|willing|interested|work from|based|apply\w* for)\b/i.test(l)
  ) {
    const city = String(job?.location ?? "").split(/[,;|(/]/)[0].trim();
    if (city && !/remote|multiple|various|anywhere/i.test(city)) return city;
    return p.city ?? null;
  }

  // "Which best represents the size of the teams you have led?" The resume
  // gives a number or it does not; without one, the smallest is the claim
  // that cannot be wrong.
  if (/\b(size of the teams?|how many (people|employees|direct reports|associates|team members)|number of (direct reports|people|employees) (you|that you))\b/i.test(l) && /\b(led|lead|manage|managed|supervis\w*|direct reports)\b/i.test(l)) {
    const r = String(job?.tailored_resume || p?.resume_text || "");
    const m =
      r.match(/\b(?:team|staff|crew|group) of (\d{1,4})\b/i) ??
      r.match(/\b(?:led|managed|supervised|oversaw|directed)\s+(?:a\s+)?(?:team of\s+)?(\d{1,4})\+?\s+(?:employees|people|associates|team members|staff|direct reports|reps|technicians|workers)/i) ??
      r.match(/\b(\d{1,4})\+?\s+(?:direct reports|employees|team members|associates)\b/i);
    return m ? String(Number(m[1])) : "1";
  }
  // "What type of leadership experience do you have?"
  if (/\b(type|kind) of leadership experience\b/i.test(l)) {
    const r = String(job?.tailored_resume || p?.resume_text || "").toLowerCase();
    if (/\b(army|navy|air force|marine corps|marines|coast guard|national guard|military)\b/.test(r)) return "Military";
    if (/\b(retail|store|shop|merchandis\w*|restaurant|franchise)\b/.test(r)) return "Retail";
    return "Other";
  }

  // "Prologis uses HiredScore, an AI-enabled tool…" over "I agree" and "I opt
  // out". The resume was written to be read against the posting, so having
  // it read that way is agreed to.
  if (/hiredscore|ai-enabled|ai-powered|artificial intelligence|automated (tool|screening|decision|processing|assessment)/i.test(l)) {
    return "Yes";
  }

  // "Type to add skills", required. A skill the resume actually names.
  if (/\bskills?\b/i.test(l) && /\b(add|search|select|type)\b/i.test(l)) {
    const resume = String(job?.tailored_resume || p?.resume_text || "").toLowerCase();
    const known = ["Customer Service", "Microsoft Excel", "Sales", "Inventory Management", "Scheduling", "SQL",
                   "Vendor Management", "Microsoft Office", "Project Management", "Data Analysis", "Leadership", "Communication"];
    return known.find((k) => resume.includes(k.toLowerCase())) ?? "Communication";
  }

  // "What is your highest level of education?" as a search box. The resume
  // says, and the level's own word finds it in whatever list is offered.
  if (/highest (level of )?education|highest degree|education level|level of education/i.test(l)) {
    const word = { doctorate: "Doctorate", master: "Master", bachelor: "Bachelor", associate: "Associate", highschool: "High School" }[
      highestDegree(job?.tailored_resume || p?.resume_text) ?? ""
    ];
    if (word) return word;
  }

  const assumed = defaultYesNo(l, p);
  if (assumed) {
    console.log(`    assumed "${assumed}" for "${l.replace(/\s+/g, " ").slice(0, 60)}"`);
    return assumed;
  }

  // "Select all the languages you speak fluently." The resume and every
  // answer on file are in English, so English is the one language there is
  // evidence for. More can be added in the panel and will be used instead.
  if (/\blanguages?\b/i.test(l) && /\b(speak|spoken|fluen\w*|proficien\w*|comfortable)\b/i.test(l)) {
    return "English";
  }
  return null;
}

/** The option to click: an exact answer if the list has one, else the first
 *  wording the employer offers that means the same thing. */
function bestOption(offered, want, label) {
  const texts = offered.map((o) => norm(o.text));
  const target = norm(want);
  const names = [target, norm(STATE_NAMES[String(want ?? "").trim().toUpperCase()])].filter(Boolean);

  for (const n of names) {
    const i = texts.indexOf(n);
    if (i >= 0) return offered[i];
  }
  // "Yes, they have been employed…" / "No, they have not…": a yes or a no
  // with the question repeated after it. Taken only when exactly one option
  // opens with the word, so two different kinds of "no" are never chosen
  // between.
  if (/^(yes|no)$/.test(target)) {
    const opens = offered.filter((o) => new RegExp(`^${target}\\b`, "i").test(String(o.text).trim()));
    if (opens.length === 1) return opens[0];
  }
  // "BA/BS/BSN", "MA/MS/MBA": the level by its letters.
  if (/^(bachelor|master|associate)/.test(target)) {
    const letters =
      /^bachelor/.test(target) ? /(^|[^a-z])b\.?[as]\.?([^a-z]|$)/i
      : /^master/.test(target) ? /(^|[^a-z])(m\.?[as]\.?|mba)([^a-z]|$)/i
      : /(^|[^a-z])a\.?[as]\.?([^a-z]|$)|associates?/i;
    const named = offered.filter((o) => new RegExp(`\\b${target.split(" ")[0]}`, "i").test(o.text));
    if (!named.length) {
      const i = offered.findIndex((o) => letters.test(String(o.text)));
      if (i >= 0) return offered[i];
    }
  }
  // Two weeks' notice, against whatever periods the employer lists.
  if (/\bnotice\b/i.test(String(label ?? "")) && /^2 weeks$/i.test(String(want ?? "").trim())) {
    for (const re of [/^(2|two) weeks?\b/i, /\b(2|two) weeks?\b/i, /\b14 days\b/i, /less than (1|one|a) month|within (1|one|a) month|up to (1|one|a) month/i, /^(1|one) month\b|\b30 days\b/i, /immediate/i]) {
      const i = offered.findIndex((o) => re.test(String(o.text).trim()));
      if (i >= 0) return offered[i];
    }
  }
  // "Indicate your proficiency of the English language" over Basic … Fluent.
  // The resume and every answer on file are written in it.
  if (/\benglish\b/i.test(String(label ?? "")) && /proficien|fluen|level|speak|spoken|written|verbal|read|command/i.test(String(label ?? ""))) {
    for (const re of [/native/i, /fluent/i, /bilingual/i, /advanced|full professional|proficient/i]) {
      const i = offered.findIndex((o) => re.test(o.text) && !/^(non|not|no)\b/i.test(String(o.text).trim()));
      if (i >= 0) return offered[i];
    }
  }
  // "What is your willingness to travel?" answered Yes, against a list of
  // percentages: the smallest amount on offer that is not a refusal.
  if (/\btravel/i.test(String(label ?? "")) && /^(yes|true)$/i.test(String(want ?? "").trim())) {
    const i = offered.findIndex((o) => /\d/.test(o.text) && !/^(0%?|none|no|not)\b/i.test(String(o.text).trim()));
    if (i >= 0) return offered[i];
  }
  // A number against a list of ranges. The profile says 5 years and the form
  // offers "0-1 year", "1-3 years", "3+ years": the answer is in there, just
  // not spelled as a 5.
  const asNumber = String(want ?? "").trim().replace(/[$,\s]/g, "").replace(/^(\d+(?:\.\d+)?)k$/i, (_, n) => String(Number(n) * 1000));
  if (/^\d+(\.\d+)?$/.test(asNumber)) {
    const v = Number(asNumber);
    let hit = -1;
    offered.forEach((o, i) => {
      // "50,000 - 75,000" is one range, not the numbers 000 and 75.
      const t = String(o.text).toLowerCase().replace(/[$£€]/g, "").replace(/(\d),(?=\d{3}\b)/g, "$1").replace(/(\d+)\s*k\b/g, "$1000");
      let lo = null;
      let hi = null;
      let m;
      if ((m = t.match(/(\d+)\s*(?:-|–|—|to)\s*(\d+)/))) [lo, hi] = [Number(m[1]), Number(m[2])];
      else if ((m = t.match(/(\d+)\s*\+|(\d+)\s*(?:years?\s*)?or more|(?:more than|over|at least)\s*(\d+)/))) [lo, hi] = [Number(m[1] ?? m[2] ?? m[3]), Infinity];
      else if ((m = t.match(/(?:less than|under|fewer than|up to)\s*(\d+)/))) [lo, hi] = [0, Number(m[1])];
      else if (/^(none|no experience)/.test(t)) [lo, hi] = [0, 0];
      // A value on a shared edge ("1-3", "3+") goes to the higher band.
      if (lo !== null && v >= lo && v <= hi) hit = i;
    });
    if (hit >= 0) return offered[hit];
  }

  // For "how did you hear about us", the known wordings come before the loose
  // match below. Xylem offers both "Website" and "Xylem Corporate Website";
  // "company website" CONTAINS "website", so the loose match took the short
  // one — a category heading that selects nothing — and the required field
  // stayed empty on a 53-field application.
  const aboutSource = /hear about|learn about|find (out )?about|come across|discover|source|referr/i.test(String(label));
  if (aboutSource) {
    for (const re of SOURCE_PREFS.slice(0, 4)) {
      const i = offered.findIndex((o) => re.test(o.text));
      if (i >= 0) return offered[i];
    }
  }

  for (const n of names) {
    if (n.length < 4) continue;
    const i = texts.findIndex((t) => t.includes(n) || n.includes(t));
    if (i >= 0) return offered[i];
  }

  // "High School/GED, College/University, Graduate School, Other" — the level
  // named by where it was earned rather than by the degree.
  if (/education|degree/i.test(String(label))) {
    const place =
      /^bachelor/.test(target) ? /college|university|undergraduate|4.?year/i
      : /^(master|doctorate)/.test(target) ? /graduate|post.?grad/i
      : /^associate/.test(target) ? /associate|2.?year|some college|community college/i
      : /^high school/.test(target) ? /high school|ged|secondary/i
      : null;
    if (place) {
      const i = offered.findIndex((o) => place.test(o.text) && !(/^bachelor/.test(target) && /graduate school|post/i.test(o.text)));
      if (i >= 0) return offered[i];
    }
  }

  // A field of study is whatever the school called it, and no employer's list
  // has that exact name: the resume says "Law & Justice Studies" and Ryder
  // offers several hundred subjects, none spelled that way. Take the offered
  // subject sharing the most of its meaningful words — the first-named word
  // breaking ties — which is what a person scrolling the list would do.
  if (/field of study|major|discipline|area of study|concentration|course of study/i.test(String(label))) {
    const FILLER = new Set(["studies", "study", "and", "the", "of", "in", "general", "science", "sciences", "arts"]);
    const words = target.split(" ").filter((w) => w.length > 2 && !FILLER.has(w));
    let best = null;
    texts.forEach((t, i) => {
      const have = new Set(t.split(" "));
      const shared = words.filter((w) => have.has(w));
      if (!shared.length) return;
      const rank = [shared.length, -words.indexOf(shared[0]), -t.length];
      if (!best || rank[0] > best.rank[0] || (rank[0] === best.rank[0] && (rank[1] > best.rank[1] || (rank[1] === best.rank[1] && rank[2] > best.rank[2])))) {
        best = { i, rank };
      }
    });
    if (best) return offered[best.i];
  }

  // "No" is not always spelled "No".
  //
  // A questionnaire offers "I have never been employed by the U.S. Federal
  // Government." and "Not to my knowledge" where the answer on file is No,
  // and five applications stopped on exactly that. The answer is the same
  // answer; only the employer's words differ.
  const NEGATIVE =
    /\b(never|not to my knowledge|none of the above|i have not|i do not|i am not|i'm not|does not|neither|^no\b)/i;
  // "Yes" is not always spelled Yes either. An attestation offers one
  // option and it reads "I agree"; the portal then says the field is
  // required while the answer table had already decided to agree to it.
  const POSITIVE =
    /\b(i am currently|i have been|currently employed|^yes\b)|^i (agree|accept|consent|acknowledge|certify|confirm|understand|have read)/i;

  if (/^no$/i.test(target)) {
    const i = offered.findIndex((o) => NEGATIVE.test(o.text));
    if (i >= 0) return offered[i];
  }
  // A notice that only asks to be acknowledged: "I have read and acknowledge
  // this notice." beside "Continue", or beside "Resident of Maine – Does Not
  // Apply". Lowe's has eight of them, and whatever was on file for the
  // question — nothing, usually — the acknowledgement is the answer.
  if (!/\b(race|racial|ethnic\w*|hispanic|latin\w*|gender|sex|veteran|disabilit\w*)\b/i.test(String(label))) {
    const acks = offered.filter((o) => /^i have read and (acknowledge|agree|understand)/i.test(String(o.text).trim()));
    if (acks.length === 1) return acks[0];
  }
  if (/^yes$/i.test(target)) {
    const i = offered.findIndex((o) => POSITIVE.test(o.text));
    if (i >= 0) return offered[i];
    // Consent to the employer's own screening tool, however many ways the
    // list words it: the first that consents.
    if (/use of ai\b|hiredscore|ai-enabled|ai-powered|artificial intelligence/i.test(String(label))) {
      const c = offered.findIndex((o) => /\b(consent|agree)\b/i.test(o.text) && !/\b(do not|don'?t|opt out|decline|withhold)\b/i.test(o.text));
      if (c >= 0) return offered[c];
    }
    // One thing to choose, and it is a consent: "By checking this box, I
    // consent to…" is what yes looks like on that list.
    const real = offered.filter((o) => o.text && !/^select one$/i.test(o.text.trim()));
    if (real.length === 1 && /\bi (consent|agree|accept|acknowledge|understand)\b/i.test(real[0].text)) return real[0];
    // Or two, one consenting and one not, each behind the same preamble:
    // "By checking this box, I consent…" / "…I do not consent…".
    const gives = real.filter((o) => /\bi (consent|agree|accept)\b/i.test(o.text) && !/\b(do not|don'?t|decline to|refuse to)\s+(consent|agree|accept)\b/i.test(o.text));
    if (gives.length === 1) return gives[0];
  }

  // The answer on file is rarely the bare word "no".
  //
  // A self-identification is stored the way the question is usually worded —
  // "I am not a protected veteran" — and the portal offers "No, I am not a
  // veteran or active member". Neither string contains the other, so the
  // literal and substring passes both miss, and the two branches above never
  // fire because they require the target to BE the word yes or no. Three
  // applications stopped one field short on exactly this.
  //
  // So where the stored answer itself carries a polarity, take the offered
  // option with the same one — but only when exactly one option has it. A
  // list holding two negatives ("No, I do not have a disability" and "I do
  // not want to answer") has no single right answer, and guessing between
  // them would put an answer nobody chose on a real application. Returning
  // null there is what happens today anyway, so this only ever adds matches.
  for (const [polarity, re] of [["negative", NEGATIVE], ["positive", POSITIVE]]) {
    if (!re.test(target)) continue;
    const hits = offered.filter((o) => re.test(o.text));
    if (hits.length === 1) {
      console.log(`      matched on ${polarity} wording: "${hits[0].text.slice(0, 48)}"`);
      return hits[0];
    }
    break;
  }

  // A self-identification that matches nothing is declined, not guessed —
  // the rule the Workday picker has had all along and this path never got.
  // Declining is an answer the candidate is entitled to give; choosing among
  // options they never chose is not.
  if (/\b(race|racial|ethnic\w*|hispanic|latin\w*|gender|sex|veteran|disabilit\w*)\b/i.test(String(label))) {
    const i = offered.findIndex((o) =>
      /prefer not|decline|don'?t wish|do not wish|choose not|not to answer|rather not|not disclose/i.test(o.text),
    );
    if (i >= 0) {
      console.log(`      declined "${String(label).slice(0, 30)}" — nothing offered matches what is on file`);
      return offered[i];
    }
  }

  // Only fall back to a synonym where the question is the one we know has no
  // agreed wording. Guessing at an arbitrary question would put an answer on
  // a real application that nobody chose.
  if (/hear about|learn about|find (out )?about|come across|discover|source|referr/i.test(String(label))) {
    for (const re of SOURCE_PREFS) {
      const i = offered.findIndex((o) => re.test(o.text));
      if (i >= 0) return offered[i];
    }
  }
  return null;
}

// Questions never answered from the resume, whatever it appears to say.
//
// Self-identification is the candidate's to make and nobody else's: a guess
// at someone's disability status, race, gender or veteran status is wrong
// even when it is accurate, because they did not make it. Convictions and
// sponsorship carry legal weight. Salary and willingness to relocate or
// commute are preferences a resume does not hold.
const NEVER_INFER =
  /disabilit|veteran|\brace\b|ethnic|hispanic|latino|gender|\bsex\b|pronoun|felony|convict|criminal|sponsorship|\bvisa\b|salary|compensation|relocat|commut|willing to|desired|expected pay/i;

// What the resume says about education, read from its own words. No model
// call, so it still works on a day when Gemini is returning 503 — which is
// most of today.
const DEGREES = [
  ["doctorate", /\b(ph\.? ?d|doctorate|doctoral|juris doctor|\bj\.?d\.?\b|\bm\.?d\.?\b)\b/i],
  ["master", /\b(master'?s?|m\.? ?s\.?|m\.? ?b\.? ?a\.?|m\.? ?a\.?|msc|mfa|meng)\b/i],
  ["bachelor", /\b(bachelor'?s?|b\.? ?s\.?|b\.? ?a\.?|bsc|beng|undergraduate degree)\b/i],
  ["associate", /\b(associate'?s?|a\.? ?a\.?\b|a\.? ?s\.?\b)\b/i],
  ["highschool", /\b(high school|ged|secondary school)\b/i],
];

// How an option list words each level. Ordered longest-first inside each
// level so "No Diploma or Degree" never satisfies a search for "degree".
const DEGREE_OPTION = {
  doctorate: /\b(doctorate|doctoral|ph\.? ?d|juris|\bm\.?d\.?\b)\b/i,
  master: /\bmaster/i,
  bachelor: /\bbachelor|\b4[- ]year degree\b/i,
  associate: /\bassociate|\b2[- ]year degree\b/i,
  highschool: /\b(high school|ged|secondary)\b/i,
};

/**
 * The option for the resume's highest degree, in a list that may spell it out
 * or abbreviate it.
 *
 * Ryder's list reads HS, GED, A.S., A.A., B.S.C., B.E., B.B.A., B.A., B.S. …
 * and "bachelor" appears nowhere in it, so a search for the word found
 * nothing and a required box stayed on "Select One". The resume's own
 * abbreviation is tried first — B.A. is not B.S. — then the usual ones for
 * that level.
 */
function degreeOption(options, resume) {
  const level = highestDegree(resume);
  if (!level) return null;
  const spelled = options.find((o) => DEGREE_OPTION[level]?.test(o));
  if (spelled) return spelled;

  const squash = (v) => String(v ?? "").toLowerCase().replace(/[^a-z]/g, "");
  const ABBR = {
    doctorate: ["phd", "jd", "md", "edd"],
    master: ["ms", "ma", "mba", "msc", "meng"],
    bachelor: ["bs", "ba", "bsc", "bba", "beng"],
    associate: ["as", "aa", "aas"],
    highschool: ["hs", "ged", "highschool", "highschooldiploma"],
  };
  const own = String(resume ?? "").match(
    /\b(Ph\.?\s?D\.?|M\.?B\.?A\.?|B\.?B\.?A\.?|B\.?\s?S\.?|B\.?\s?A\.?|M\.?\s?S\.?|M\.?\s?A\.?|A\.?\s?S\.?|A\.?\s?A\.?)(?=[\s,;:)]|$)/,
  );
  // Spelled out on the resume, abbreviated in the list: "Bachelor of Arts"
  // is B.A., and offering B.S. for it would be a different degree.
  const SPELLED = [
    [/bachelor of business/i, "bba"], [/bachelor of arts/i, "ba"], [/bachelor of science/i, "bs"],
    [/master of business/i, "mba"], [/master of arts/i, "ma"], [/master of science/i, "ms"],
    [/associate of arts/i, "aa"], [/associate of (applied )?science/i, "as"],
  ];
  const named = SPELLED.find(([re]) => re.test(String(resume ?? "")))?.[1];
  const mine = [own ? squash(own[1]) : null, named].filter((a) => a && ABBR[level].includes(a));
  for (const a of [...mine, ...ABBR[level]]) {
    const hit = options.find((o) => squash(o) === a);
    if (hit) return hit;
  }
  return null;
}

function highestDegree(resume) {
  for (const [level, re] of DEGREES) if (re.test(String(resume ?? ""))) return level;
  return null;
}

// The most recent job, read from the resume once per run and reused.
let WORK;

// Hosts whose inbox has already been checked for a verification link.
const CHECKED_INBOX = new Set();

/**
 * Wait for something to be true, not for a number to elapse.
 *
 * The applier spent 46 seconds per pass on fixed sleeps chosen to be long
 * enough for the slowest case, and a form with fifteen dropdowns paid that
 * fifteen times over. Polling costs the time the page actually needs.
 */
async function until(check, timeoutMs = 2000, stepMs = 100) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const got = await check().catch(() => null);
    if (got) return got;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

const CONTEXT_OPTIONS = {
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  viewport: { width: 1440, height: 900 },
  locale: "en-US",
};

// Which job a line belongs to.
//
// Several jobs now run at once and their output interleaves. Every log line
// this project has ever been debugged from would become unreadable without
// a tag saying which application it describes.
const TAG = new AsyncLocalStorage();
const plainLog = console.log.bind(console);
// The lines that explain a failure, kept per job so the recap can repeat them.
//
// A run's log is several hundred interleaved lines and only its tail can be
// read from outside. "1 required item is still empty: how did you hear about
// us" is the verdict; the line that says WHY — what the list offered — is
// two hundred lines up. Keeping the few that matter beside each job turns
// two rounds into one.
const EVIDENCE = new Map();
const EVIDENCE_RE =
  /offered \[|offers \[|offering \[|-> empty|did not take|refused|missing "|no options|never enabled|no box was found|what the form shows|own verdict|what was clicked|page offered|no form here|registering at|source trace|skills trace|prompt skeleton|password reset|    oracle |oracle:|resume reader|from the resume|is yes\/no but|self-identified|opened a second|pressed "|pressing "|pressed it|form state|click did not land|asked for a box|still on the login|page complaints|assumed "|wall|code lookup|no security code|has no answer|required but no answer|page says|second list|found a subject|code in the boxes|after the code/;
console.log = (...parts) => {
  const n = TAG.getStore();
  if (n === undefined) return plainLog(...parts);
  if (typeof parts[0] === "string" && EVIDENCE_RE.test(parts[0])) {
    const kept = EVIDENCE.get(n) ?? [];
    kept.push(parts[0].trim().slice(0, /source trace|skills trace|prompt skeleton/.test(parts[0]) ? 1300 : 300));
    // The source trace is the one line that explains that field; never let
    // later lines push it out.
    const sticky = kept.filter((k) => /source trace|skills trace|prompt skeleton/.test(k)).slice(-3);
    EVIDENCE.set(n, [...sticky, ...kept.filter((k) => !/source trace|skills trace|prompt skeleton/.test(k)).slice(-8)]);
  }
  const [first, ...rest] = parts;
  return plainLog(typeof first === "string" ? `[${n}]${first}` : `[${n}]`, ...(typeof first === "string" ? rest : parts));
};

const MONTHS = ["January","February","March","April","May","June",
                "July","August","September","October","November","December"];

/**
 * The most recent job, read out of the resume with no model call.
 *
 * Gemini's free tier has a DAILY cap and today's testing reached it, so the
 * model-backed reader returns nothing for the rest of the day — and a
 * feature that only works while a quota lasts is not a feature. Resumes
 * state this in a handful of shapes and the first dated block is almost
 * always the current job.
 */
/**
 * The subject the degree was in, for the education section's own box.
 *
 * "Field of Study" stopped four applications, and the resume states it on
 * the same line as the degree: "B.S. in Biology", "Bachelor of Arts,
 * Economics".
 */
function parseFieldOfStudy(resume) {
  const text = String(resume ?? "");
  // Case-insensitive, because a resume writes "B.S." and the pattern was
  // written in lower case — it matched nothing at all until this was noticed
  // in a direct test rather than in a run.
  const patterns = [
    /\b(?:b\.?s\.?|b\.?a\.?|bachelor(?:'?s)?|master(?:'?s)?|m\.?s\.?|m\.?a\.?|associate(?:'?s)?|ph\.?d)\.?\s*(?:of science|of arts|of business administration)?\s*(?:degree)?\s*(?:in|,|:)\s+([A-Za-z][A-Za-z&' -]{2,48})/i,
    /\bmajor(?:ed)?\s*(?:in|:)\s+([A-Za-z][A-Za-z&' -]{2,48})/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;
    const name = m[1].replace(/\s+/g, " ").replace(/[,.;].*$/, "").trim();
    // A subject is a proper noun on a resume. Requiring that back, now the
    // pattern itself no longer can, keeps "in the" and "in a" out.
    if (!/^[A-Z]/.test(name)) continue;
    if (name.length > 2 && !/^(The|And|At|From|Progress|Candidate)\b/.test(name)) return name;
  }
  return null;
}

/**
 * What the candidate did in their most recent job, in their own words.
 *
 * A "Role Description" box on a work-history screen is answered by the
 * bullets already written under that job on the resume — and with the model
 * quota gone there is nothing else to answer it with.
 */
function parseRoleDescription(resume) {
  const lines = String(resume ?? "").split("\n").map((l) => l.trim());

  const take = (isWanted) => {
    const out = [];
    let seen = false;
    for (const line of lines) {
      if (isWanted(line)) {
        seen = true;
        out.push(line.replace(/^[-•*\u2022]\s*/, ""));
        if (out.length >= 4) break;
      } else if (seen && !line) break;
    }
    return out.join(" ").replace(/\s+/g, " ").trim();
  };

  // Bulleted first, because that is unambiguous.
  let text = take((l) => /^[-•*\u2022]\s*\S/.test(l));

  // Not every resume uses bullet characters. Four applications stopped on
  // "role description" against a resume that simply writes its duties as
  // sentences, so take those instead: prose lines long enough to be a duty
  // and not a heading, date or contact line.
  if (text.length <= 20) {
    text = take(
      (l) =>
        l.length > 35 &&
        l.length < 300 &&
        /[a-z]{3}/.test(l) &&
        !/^[A-Z\s&]+$/.test(l) &&
        !/@|https?:|\(\d{3}\)|^\d/.test(l) &&
        !/^(experience|education|skills|summary|objective|work history)\b/i.test(l),
    );
  }

  return text.length > 20 ? text.slice(0, 900) : null;
}

/** The school named in the resume, for the education section's own box. */
function parseSchoolFromResume(resume) {
  for (const raw of String(resume ?? "").split("\n")) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (!line || line.length > 90) continue;
    if (!/\b(university|college|institute of technology|polytechnic)\b/i.test(line)) continue;
    // Strip a degree, a date or a location tacked onto the same line.
    const name = line
      .split(/\s*(?:\||•|·|–|—|,|\u2013)\s*/)
      .find((b) => /\b(university|college|institute|polytechnic)\b/i.test(b));
    if (name && name.trim().length > 3) return name.trim();
  }
  return null;
}

function parseWorkFromResume(resume) {
  const text = String(resume ?? "").replace(/\r/g, "");
  if (!text.trim()) return null;

  const MON = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*";
  const range = new RegExp(
    `(?:(${MON})\\.?\\s+)?((?:19|20)\\d{2})\\s*(?:-|–|—|to|through)\\s*` +
      `(?:(Present|Current|Now)|(?:(${MON})\\.?\\s+)?((?:19|20)\\d{2}))`,
    "i",
  );

  const lines = text.split("\n").map((l) => l.trim());
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(range);
    if (!m) continue;

    // The title and employer sit on this line beside the dates, or on the
    // line above it. Take whichever has words left once the dates are gone.
    const here = lines[i].replace(m[0], " ").replace(/[|•·,–—-]+\s*$/, "").trim();
    const above = (lines[i - 1] ?? "").trim();
    const block = here.replace(/\s{2,}/g, " ").length > 3 ? here : above;

    const bits = block
      .split(/\s*(?:\||•|·|–|—|\sat\s|,)\s*/i)
      .map((b) => b.replace(/\s+/g, " ").trim())
      .filter((b) => b.length > 1 && b.length < 80);

    const title = bits[0] ?? "";

    // The employer is beside the title, or on its own line just above or
    // below. A run read the title and left company empty, and the portal
    // stopped on it.
    let company = bits[1] ?? "";
    if (!company) {
      for (const near of [lines[i - 1], lines[i + 1], lines[i - 2]]) {
        const c = String(near ?? "").replace(range, " ").replace(/\s+/g, " ").trim();
        if (!c || c.length > 70 || c === title) continue;
        if (/^[-•*]/.test(c)) continue;                       // a bullet, not a name
        if (/^(experience|work history|employment|education)\b/i.test(c)) continue;
        company = c;
        break;
      }
    }
    if (!title) continue;

    return {
      title,
      company,
      start_month: m[1] ? MONTHS.find((x) => x.toLowerCase().startsWith(m[1].toLowerCase())) ?? "" : "",
      start_year: m[2] ?? "",
      end_month: m[4] ? MONTHS.find((x) => x.toLowerCase().startsWith(m[4].toLowerCase())) ?? "" : "",
      end_year: m[5] ?? "",
      current: Boolean(m[3]),
    };
  }
  return null;
}

/**
 * The most recent job, from the two layouts this system itself knows.
 *
 * parseWorkFromResume looks for a date range and takes the words beside it,
 * which suits a resume written "Title, Employer   2021 - 2024". It does not
 * suit either resume the applier actually holds. The one written for a
 * posting says "Employer - Title (dates)", and was read as a title of
 * "Employer - Title (" with no employer at all — Merck's form stopped on the
 * empty Company box. The one on file gives a field to a line, and was read
 * as a title of the employer's name. Both are read properly here, by the
 * code that wrote the first and already understands the second.
 */
function latestRoleFrom(job, profile) {
  const MON = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*";
  const range = new RegExp(
    `(?:(${MON})\\.?\\s+)?((?:19|20)\\d{2})\\s*(?:-|–|—|to|through)\\s*(?:(Present|Current|Now)|(?:(${MON})\\.?\\s+)?((?:19|20)\\d{2}))`,
    "i",
  );
  const month = (m) => (m ? MONTHS.find((x) => x.toLowerCase().startsWith(m.toLowerCase())) ?? "" : "");
  const when = (dates) => {
    const m = String(dates ?? "").match(range);
    return m
      ? { start_month: month(m[1]), start_year: m[2] ?? "", end_month: month(m[4]), end_year: m[5] ?? "", current: Boolean(m[3]) }
      : { start_month: "", start_year: "", end_month: "", end_year: "", current: /present|current|now/i.test(String(dates ?? "")) };
  };
  // A resume written for a posting: under EXPERIENCE, "Employer - Title (dates)".
  const written = String(job?.tailored_resume ?? "");
  const at = written.search(/^EXPERIENCE\s*$/m);
  if (at >= 0) {
    const line = written.slice(at).split("\n").slice(1).find((l) => l.trim());
    const m = String(line ?? "").trim().match(/^(.+?) - (.+?)(?: \((.+)\))?$/);
    if (m && m[1].trim() && m[2].trim()) return { company: m[1].trim(), title: m[2].trim(), ...when(m[3]) };
  }
  // The resume on file, read into its roles.
  const first = structureResume(profile?.resume_text, profile)?.experience?.[0];
  if (first?.title && first?.company) return { company: String(first.company).trim(), title: String(first.title).trim(), ...when(first.dates) };
  return null;
}

async function workHistory(profile, job) {
  if (WORK !== undefined) return WORK;
  WORK = null;
  const resume = job?.tailored_resume || profile?.resume_text;

  // The layouts this system knows, first; then the general reader. No quota,
  // no outage, no waiting.
  WORK = latestRoleFrom(job, profile);
  if (!WORK && resume) WORK = parseWorkFromResume(resume);
  // A title with no employer is half an answer, and the form will stop on
  // the other half: better the profile's own two fields, below.
  if (WORK && !WORK.company && profile?.current_company) WORK.company = profile.current_company;

  if (!WORK && resume && process.env.GEMINI_API_KEY) {
    WORK = await resumeFacts({ resume, apiKey: process.env.GEMINI_API_KEY }).catch(() => null);
  }
  // The profile knows these two even when the resume reader is unavailable,
  // which on a day of Gemini 503s is most of the time.
  if (!WORK && (profile?.current_company || profile?.target_role)) {
    WORK = {
      title: profile.target_role ?? "",
      company: profile.current_company ?? "",
      start_month: "", start_year: "", end_month: "", end_year: "", current: true,
    };
  }
  if (!WORK) {
    console.log(
      "    no work history available: the resume could not be parsed and the " +
        "profile has no company or role on it",
    );
  }
  if (WORK) {
    console.log(
      `    work history read: ${JSON.stringify({
        title: WORK.title ? "set" : "empty",
        company: WORK.company ? "set" : "empty",
        start: WORK.start_year ? "set" : "empty",
        current: WORK.current,
      })}`,
    );
  }
  return WORK;
}

/**
 * The work-experience boxes an ATS asks for one at a time.
 *
 * Booz Allen stopped on "job title", "company", and four separate month and
 * year boxes — every one of them stated in the resume that had just been
 * uploaded alongside the form.
 */
async function workAnswer(label, profile, job) {
  const l = String(label ?? "").toLowerCase();
  if (
    !/job title|position title|\btitle\b|company|employer|start date|end date|from date|to date|startdate|enddate|school|university|college|institution|field of study|major|course of study|discipline|role description|job description|describe your role|responsibilities|duties/.test(
      l,
    )
  ) {
    return null;
  }

  const w = await workHistory(profile, job);
  if (!w) return null;

  const isEnd = /end ?date|to date|enddate/.test(l);
  const wantsMonth = /month/.test(l);
  const wantsYear = /year/.test(l);

  if (/field of study|major|course of study|discipline/.test(l)) {
    return parseFieldOfStudy(job?.tailored_resume || profile?.resume_text);
  }
  if (/role description|job description|describe your role|responsibilities|duties/.test(l)) {
    return parseRoleDescription(job?.tailored_resume || profile?.resume_text);
  }
  if (/school|university|college|institution/.test(l)) {
    return (
      profile?.school ||
      parseSchoolFromResume(job?.tailored_resume || profile?.resume_text) ||
      null
    );
  }
  if (/company|employer/.test(l) && !/website|hear about/.test(l)) return w.company || null;
  if (/job title|position title|\btitle\b/.test(l)) return w.title || null;

  if (wantsMonth) {
    // A "datesection" box is a spinner that takes 3, not "March".
    const asNumber = (name) => {
      const i = MONTHS.findIndex((x) => x.toLowerCase() === String(name).toLowerCase());
      return i < 0 ? null : /datesection|spinner/.test(l) ? String(i + 1) : MONTHS[i];
    };
    if (isEnd) return w.current ? null : asNumber(w.end_month);
    return asNumber(w.start_month);
  }
  if (wantsYear) {
    if (isEnd) return w.current ? null : w.end_year || null;
    return w.start_year || null;
  }
  return null;
}

/**
 * An answer taken from the resume rather than waited for.
 *
 * The resume states most of this in plain words — "B.S., Rutgers University"
 * is the answer to "what is your highest level of education" — and waiting
 * for someone to retype it into a settings field is the system asking a
 * person for something it already has.
 */
const MODEL_FAILURES = new Set();
const selfIdSeen = new Set();

async function answerFromResume(question, options, profile, job) {
  const q = String(question ?? "");
  if (!q || NEVER_INFER.test(q)) return null;
  const resume = job?.tailored_resume || profile?.resume_text;
  if (!resume) return null;

  if (/education|degree|highest level|qualification/i.test(q) && options.length) {
    const hit = degreeOption(options, resume);
    if (hit) {
      console.log(`    from the resume: "${q.slice(0, 28)}" -> "${hit.slice(0, 26)}"`);
      return hit;
    }
  }

  if (!process.env.GEMINI_API_KEY || !options.length) return null;

  const reply = await chooseOption({
    question: q,
    options,
    resume,
    apiKey: process.env.GEMINI_API_KEY,
  }).catch((e) => {
    // Said, a few times a run: a reader that has stopped answering looks
    // exactly like a resume that does not say, and needs the opposite fix.
    const why = String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 150);
    if (MODEL_FAILURES.size < 3 && !MODEL_FAILURES.has(why)) {
      MODEL_FAILURES.add(why);
      console.log(`    the resume reader failed: ${why}`);
    }
    return null;
  });
  if (!reply) return null;

  // Accept it only if it is literally one of the employer's own options.
  // Anything else is the model writing its own answer onto a real
  // application, which is the one thing this must never do.
  const hit = options.find((o) => norm(o) === norm(reply));
  if (!hit) {
    console.log(`    the resume reader offered "${String(reply).slice(0, 24)}", which is not on the list`);
    return null;
  }
  console.log(`    from the resume: "${q.slice(0, 28)}" -> "${hit.slice(0, 26)}"`);
  return hit;
}

/**
 * Fold the differences that make two spellings of the same answer miss.
 *
 * BMS offers "Bachelor’s Degree" with a curly apostrophe. Anyone typing
 * the answer into the panel types a straight one, the match fails, the field
 * stays empty and NOTHING says why — the person is left believing they
 * answered it. Same for stray punctuation, double spaces and smart dashes.
 */
function norm(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc\u00b4`]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[^a-z0-9'+\-/ ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// A profile stores "NJ"; a dropdown offers "New Jersey". Neither matches the
// other as text, and that is why a state picker came back "no answer on file"
// with New Jersey sitting in its own list.
const STATE_NAMES = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan",
  MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota",
  OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee",
  TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
  WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", PR: "Puerto Rico",
};

/**
 * Answer one of Workday's button-dropdowns — the control that reads
 * "Select One" and opens a listbox.
 *
 * It is a <button>, not a <select>, so the walk over inputs, selects and
 * textareas never sees it and the completeness check calls the form
 * complete. Workday then rejects "Save and Continue" with the widget marked
 * invalid and nothing in the log to say which question it was.
 */
/**
 * Shut any dropdown list that is still open, and make sure it is shut.
 *
 * Escape closes a Workday list only while the focus is inside it. Left open,
 * the list of one question hangs over the next question's button: AIG's
 * "highest level of education" was offered the notice periods from the
 * question above it, and "career returner" was offered the education levels.
 * Worse than a wrong reading, a click aimed at the covered button lands on
 * whatever option of the stale list is on top of it.
 */
async function closePopups(page, form) {
  const open = async () =>
    await form
      .evaluate(() => {
        const shown = (e) => {
          const r = e.getBoundingClientRect();
          const st = getComputedStyle(e);
          return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
        };
        return Array.from(document.querySelectorAll("[role=listbox]")).filter(
          // A listbox drawn in the page as the control itself is not a popup.
          (b) => shown(b) && b.querySelector("[role=option]") && !b.closest("select"),
        ).length;
      })
      .catch(() => 0);

  await page.keyboard.press("Escape").catch(() => {});
  if (!(await open())) return;
  await page.waitForTimeout(250);
  if (!(await open())) return;
  // What a person does: click somewhere that is not the list. Sent to the
  // page body itself, so it cannot land on a link or a button.
  await form
    .evaluate(() => {
      for (const type of ["mousedown", "mouseup", "click"]) {
        document.body.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
    })
    .catch(() => {});
  await page.waitForTimeout(250);
  if (!(await open())) return;
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(250);
}

async function pickFromListbox(page, form, btn, want, label) {
  // Close whatever is already open first. Clicking a second picker while the
  // first one's list is up opens nothing, and the log filled with "opened no
  // options" for widgets that were perfectly willing to answer.
  await closePopups(page, form);
  await btn.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});
  // An ordinary click first: it refuses to press through something lying
  // over the button. Forced only when the ordinary one will not land.
  await btn
    .click({ timeout: 1500 })
    .catch(() => btn.click({ timeout: 5000, force: true }).catch(() => {}));

  // Scope the options to THIS widget's popup. Asking the whole form for
  // [role=option] returned another dropdown's leftovers — a state picker was
  // offered "United States of America (+1)" twice, from the phone-code box
  // beside it. The button names its own listbox; fall back to the last
  // visible one only when it does not.
  const owns =
    (await btn.getAttribute("aria-controls").catch(() => null)) ??
    (await btn.getAttribute("aria-owns").catch(() => null));

  const collect = async () => {
    let found = [];
    if (owns) {
      const id = String(owns).replace(/["\\]/g, "");
      found = await form
        .$$(`[id="${id}"] [role=option], [id="${id}"] [data-automation-id="menuItem"]`)
        .catch(() => []);
    }
    if (!found.length) {
      // The popup that belongs to THIS button, judged by where it is on the
      // screen. Taking whichever list happened to be open offered "Phone
      // Device Type" the country-code list — twice — and it very nearly
      // answered the question with a dial code.
      const anchor = await btn.boundingBox().catch(() => null);
      let best = null;
      let bestGap = Infinity;
      for (const box of await form.$$("[role=listbox]").catch(() => [])) {
        if (!(await box.isVisible().catch(() => false))) continue;
        const r = await box.boundingBox().catch(() => null);
        if (!r || !anchor) { best = best ?? box; continue; }
        const gap = Math.abs(r.y - (anchor.y + anchor.height)) + Math.abs(r.x - anchor.x);
        if (gap < bestGap) { bestGap = gap; best = box; }
      }
      if (best) {
        found = await best.$$('[role=option], [data-automation-id="menuItem"]').catch(() => []);
      }
    }
    return found;
  };

  const openList = async (ms) =>
    ((await until(async () => {
      const found = await collect();
      return found.length ? found : null;
    }, ms)) ?? []).slice(0, 60);

  let options = await openList(2500);

  // One more try before giving up: these open late as often as they refuse.
  if (!options.length) {
    await btn.click({ timeout: 4000, force: true }).catch(() => {});
    options = await openList(2000);
  }

  // And a third, by keyboard. "Opened no options" has been reported for
  // widgets that were perfectly willing to answer, and a listbox that
  // ignores a synthetic click will still open to the key a person would
  // press on it.
  if (!options.length) {
    await btn.focus().catch(() => {});
    for (const key of ["Enter", "ArrowDown"]) {
      await page.keyboard.press(key).catch(() => {});
      options = await openList(1200);
      if (options.length) break;
    }
  }

  if (!options.length) {
    console.log(`    picker "${label.slice(0, 30)}" opened no options`);
    await closePopups(page, form);
    return false;
  }

  // Workday renders each option twice and one copy is a hidden twin; a click
  // on that one does nothing while looking like a click that worked.
  const kept = [];
  const texts = [];
  const seenText = new Set();
  for (const o of options) {
    if (!(await o.isVisible().catch(() => false))) continue;
    const t = ((await o.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
    if (!t || seenText.has(t)) continue;
    seenText.add(t);
    kept.push(o);
    texts.push(t);
  }
  options = kept;

  // "NJ" is how a profile stores a state and "New Jersey" is how a dropdown
  // offers it, so a plain substring match finds nothing — and a two-letter
  // code matched loosely is worse than nothing, since "NJ" appears inside
  // other words. Try the code's full name as well as the code itself.
  const target = String(want ?? "").trim().toLowerCase();

  // A yes/no question cannot be answered with anything else, whatever the
  // lookup came back with. This caught "70000" on its way into "in the event
  // an offer of employment is made...", and the next one will be something
  // else; the shape of the list is the check that holds either way.
  const yesNoOnly =
    texts.length <= 4 && texts.every((t) => /^(select one|yes|no|n\/a)$/i.test(t.trim()));
  if (yesNoOnly && target && !/^(yes|no)$/.test(target)) {
    console.log(
      `    picker "${label.slice(0, 30)}" is yes/no but the answer on file is ` +
        `${JSON.stringify(String(want).slice(0, 20))} — left for you`,
    );
    await closePopups(page, form);
    return { offered: ["Yes", "No"] };
  }

  const wanted = [target, STATE_NAMES[String(want ?? "").trim().toUpperCase()]].filter(Boolean);

  // One matcher, shared with the combo path.
  //
  // This had its own, and so never learned the employer-wording fallback:
  // Church & Dwight offers "Church & Dwight Co., Inc. website" and the
  // profile says "Company website", which the combo path resolves and this
  // path left unanswered on an otherwise finished form.
  const picks = texts.map((t, i) => ({ el: options[i], text: t }));
  const chosen = bestOption(picks, want, label);
  let idx = chosen ? picks.indexOf(chosen) : -1;

  // Nothing on file. Many of these are the legally-neutral declarations where
  // declining is itself an offered answer, and declining is honest; inventing
  // a disability status or an ethnicity on the user's behalf is not.
  // Self-identification that cannot be matched is DECLINED, not guessed.
  //
  // The profile says "I am not a protected veteran". BMS offers "I AM NOT A
  // VETERAN" and "I IDENTIFY AS A VETERAN, JUST NOT A PROTECTED VETERAN" —
  // both satisfy that sentence and they mean different things. Picking one
  // would put a claim about military service on a federal form that the
  // candidate never made. Declining is an answer they are entitled to give,
  // and the question is recorded so they can set it exactly, once.
  if (idx < 0) {
    idx = texts.findIndex((t) =>
      /prefer not|decline|don'?t wish|do not wish|choose not|not to answer|rather not|not disclose/i.test(
        t,
      ),
    );
    if (idx >= 0) {
      console.log(`    picker "${label.slice(0, 30)}" declined — no option matches what is on file`);
    }
  }

  if (idx < 0) {
    // Say what was looked for as well as what was on offer. "No answer on
    // file" could mean the label was unreadable or the profile field is
    // simply blank, and those need opposite fixes.
    console.log(
      // The whole question when nothing was on file for it: thirty characters
      // of "as a ryder employee, would you" says a rule is missing and not
      // which one.
      `    picker "${label.slice(0, want ? 30 : 150)}" wanted ${JSON.stringify(want ?? null)}; offered ` +
        `${JSON.stringify(texts.filter(Boolean).slice(0, 8))}`,
    );
    await closePopups(page, form);
    // Hand the choices back so they reach the panel, where answering once
    // is the whole point.
    return { offered: texts.filter((t) => t && !/^select one$/i.test(t)) };
  }

  await options[idx].click({ timeout: 4000, force: true }).catch(() => {});
  await until(
    async () =>
      !/^select one$/i.test(((await btn.innerText()) || "").replace(/\s+/g, " ").trim()),
    1500,
  );
  const now = ((await btn.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
  console.log(`    picker "${label.slice(0, 30)}" -> "${texts[idx].slice(0, 30)}" (shows "${now.slice(0, 24)}")`);
  return !/^select one$/i.test(now);
}

/**
 * Fill a field, and count it only if it took.
 *
 * `fill(...).catch(() => {}); filled++` counted a field that threw as
 * filled, so "filled 20 fields" could describe a form with twenty empty
 * boxes. Four separate faults hid behind exactly this one line today.
 */
async function fillField(el, value, label) {
  const outcome = await el
    .fill(String(value), { timeout: 5000 })
    .then(() => true)
    .catch((e) => String(e?.message ?? e).split("\n")[0].slice(0, 70));
  if (outcome === true) return true;
  console.log(`    could not fill "${String(label).slice(0, 34)}": ${outcome}`);
  return false;
}

/**
 * Tick a consent box or a radio, and confirm it took.
 *
 * Three ways, because each fails on a different portal: check() is refused
 * on a control Playwright considers invisible, an ordinary click hangs on
 * "scrolling into view" on Workday, and where the native input is hidden
 * behind a styled sibling the thing a person actually clicks is the label.
 */
async function checkBox(el, label) {
  const ways = [
    () => el.check({ timeout: 3000 }),
    () => el.click({ timeout: 3000, force: true }),
    () =>
      el.evaluate((n) => {
        const lab =
          (n.id ? document.querySelector(`label[for="${CSS.escape(n.id)}"]`) : null) ??
          n.closest("label") ??
          n.parentElement;
        if (!lab) throw new Error("nothing clickable around it");
        lab.click();
      }),
  ];

  let last = "not attempted";
  for (const attempt of ways) {
    last = await attempt()
      .then(() => true)
      .catch((e) => String(e?.message ?? e).split("\n")[0].slice(0, 70));
    if (last === true && (await el.isChecked().catch(() => true))) return true;
    if (last === true) last = "the click landed but the box stayed clear";
  }
  console.log(`    could not tick "${String(label).slice(0, 34)}": ${last}`);
  return false;
}

/**
 * Write the resume to disk and attach it, if this screen asks for a file.
 *
 * Every step here used to fail silently: a swallowed catch, and nothing in
 * the log either way. So a run that attached no resume at all looked
 * identical to one that did, and an ATS rejecting the submission for a
 * missing resume looked like no reason at all.
 */
async function attachResume(context, page, form, profile, job) {
  let fileInputs = await form.$$("input[type=file]").catch(() => []);

  // Workday's upload lives on screen two and renders after the navigation
  // settles, so a look taken the instant the screen changed finds nothing
  // and the portal then refuses to advance with "Upload a file (5MB max)".
  // Only wait when this screen is asking for a file at all — a blind wait on
  // every step of every job is minutes of nothing.
  if (!fileInputs.length) {
    const asks = /resume|résumé|\bcv\b|upload|attach|drop files/i.test(
      (await form.evaluate(() => document.body?.innerText?.slice(0, 4000) ?? "").catch(() => "")) || "",
    );
    if (!asks) return { wanted: false, note: "no file input on this form" };
    // A file already on the screen is a file attached.
    const there = await form
      .evaluate(() => /successfully uploaded/i.test(document.body?.innerText ?? ""))
      .catch(() => false);
    // Said as "attached", so that it is remembered: Merck's second screen
    // showed the file kept from an earlier visit, nothing was noted, and the
    // third screen — questions that happen to mention a resume — was then
    // taken for a screen still waiting for one.
    if (there) return { wanted: true, note: "resume attached" };

    await form
      .waitForSelector("input[type=file]", { state: "attached", timeout: 8000 })
      .catch(() => null);
    fileInputs = await form.$$("input[type=file]").catch(() => []);

    // Some of these only create the input once the button is pressed.
    if (!fileInputs.length) {
      for (const b of (
        await form.$$('button, [role=button], [data-automation-id*="upload" i]').catch(() => [])
      ).slice(0, 25)) {
        const t = ((await b.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
        if (!/select files?|upload|attach|choose file|add file/i.test(t)) continue;
        // Not the file that is already there. "…Resume_459.pdf Successfully
        // Uploaded!" contains the word upload, and pressing that chip — which
        // is also where its delete button lives — is how a finished upload
        // was prodded seven times on one form.
        if (/uploaded|successfully|\.(pdf|docx?)\b|delete|remove/i.test(t)) continue;
        if (!(await b.isVisible().catch(() => false))) continue;
        // The words of the button only when they are a button's words: this
        // log is public, and a file's name carries the applicant's.
        console.log(`    pressing "${/^[A-Za-z ]{3,24}$/.test(t) ? t : "an upload control"}" to bring out the file input`);
        await b.click({ force: true, timeout: 4000 }).catch(() => {});
        await page.waitForTimeout(1500);
        fileInputs = await form.$$("input[type=file]").catch(() => []);
        if (fileInputs.length) break;
      }
    }

    // A resume that is ALREADY there is not a missing resume.
    //
    // The portal keeps what was uploaded on an earlier attempt, so the
    // second visit shows the filename and no input at all — and this
    // reported a required item still empty on a screen the portal itself
    // had just accepted.
    if (!fileInputs.length) {
      const shows = (
        (await form.evaluate(() => document.body?.innerText?.slice(0, 4000) ?? "").catch(() => "")) || ""
      );
      if (/successfully uploaded|\.pdf\b|\.docx?\b|remove file|delete file/i.test(shows)) {
        return { wanted: true, note: "resume attached" };
      }
      // The words "resume" or "upload" somewhere on a page are not a request
      // for a file. A question that reads "as shown on your resume" set this
      // off on a screen with nothing to upload to, and the application was
      // stopped for a missing file the screen had never asked for. A screen
      // is asking only when it shows something to upload with.
      const control = await form
        .evaluate(() => {
          const shown = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
          return Array.from(
            document.querySelectorAll('[data-automation-id*="upload" i], [data-automation-id*="attachment" i], [class*="dropzone" i], [class*="file-upload" i], [class*="fileupload" i], button, [role=button], label'),
          )
            .filter(shown)
            .some(
              (e) =>
                /upload|attachment/i.test(e.getAttribute("data-automation-id") || "") ||
                /dropzone|file-?upload/i.test(String(e.className || "")) ||
                /^(select files?|upload( a)?( file| resume| cv| document)?|choose( a)? file|browse( files?)?|attach( a)?( file| resume| cv| document)?|add( a)? (file|attachment)|drop files? here)\b/i.test((e.innerText || "").replace(/\s+/g, " ").trim()),
            );
        })
        .catch(() => true);
      if (!control) return { wanted: false, note: "the page mentions a resume but shows nothing to upload one with" };
      return { wanted: true, note: "this screen asks for a file but has no file input to set" };
    }
  }

  // Prefer the resume written for THIS job; fall back to the profile's own
  // text so a job that was never tailored still attaches something real.
  // The resume on file is text taken from an uploaded PDF, often with no
  // headings and no bullet marks; printed as it stands it is a column of
  // loose lines. When there is no resume written for this job it is put
  // into the standard layout first.
  const resumeText = job.tailored_resume || standardResume(profile.resume_text, profile);
  if (!resumeText) {
    return { wanted: true, note: "form wants a file but the profile has no resume text" };
  }

  // Say what this resume looks like to a keyword screener, and close the
  // part of the gap that is honestly closable: the employer's own wording
  // for experience the resume already evidences. Nothing is added that the
  // candidate's own text does not prove, and what is missing is reported as
  // a gap rather than written in.
  const aligned = alignToPosting(resumeText, job.description ?? "", job.company ?? "");
  if (aligned.added.length || aligned.before !== undefined) {
    console.log(
      `    ATS match ${aligned.before}% -> ${aligned.after}%` +
        (aligned.added.length ? `, their wording for: ${aligned.added.slice(0, 6).join(", ")}` : "") +
        (aligned.gaps.length ? ` | not evidenced: ${aligned.gaps.slice(0, 4).join(", ")}` : ""),
    );
  }

  const pdf = await buildResumePdf(context, aligned.text || resumeText, profile, job.id);
  if (!pdf) return { wanted: true, note: "resume PDF could not be built" };

  const outcome = await fileInputs[0]
    .setInputFiles(pdf)
    .then(() => true)
    .catch((e) => String(e?.message ?? e).slice(0, 80));
  if (outcome !== true) return { wanted: true, note: `attaching the resume failed: ${outcome}` };

  await page.waitForTimeout(3000); // ATS parse the upload
  return { wanted: true, note: "resume attached" };
}

// Aggregators list jobs and link out; they never host the form. A run
// against remoteok.com found 51 inputs on the page — all of them its own
// search and filter widgets — and zero to fill.
const AGGREGATOR_RE =
  /(^|\.)(remoteok\.com|arbeitnow\.com|remotive\.(com|io)|weworkremotely\.com|indeed\.com|ziprecruiter\.com|glassdoor\.com|linkedin\.com|simplyhired\.com|monster\.com|dice\.com|jooble\.org|adzuna\.)/i;

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/**
 * Follow a link that leaves this page for the employer's real application.
 *
 * Worth doing whenever there is no form here, not just on known aggregators:
 * plenty of company job pages are a description with an "Apply" link to the
 * ATS on another host.
 */
async function followExternalApply(page) {
  const here = hostOf(page.url());
  // Not just <a>. An aggregator's "Apply for this job" is often a button that
  // navigates with JavaScript, and a link-only search walked straight past a
  // control sitting in the middle of the page.
  const candidates = await page
    .$$('a[href], button, [role=button], input[type=button]')
    .catch(() => []);

  for (const link of candidates) {
    const href =
      (await link.getAttribute("href").catch(() => null)) ??
      (await link.getAttribute("data-href").catch(() => null));
    const text = ((await link.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();

    // A control with no href can only be judged by its words, and only a
    // clear apply label is worth a click — clicking the wrong thing navigates
    // away from the posting entirely.
    if (!href) {
      if (!APPLY_RE.test(plainWords(text))) continue;
      if (!(await link.isVisible().catch(() => false))) continue;
      const popupPromise = page.waitForEvent("popup", { timeout: 8000 }).catch(() => null);
      await link.click({ timeout: 8000 }).catch(() => {});
      const popup = await popupPromise;
      if (popup) {
        await popup.waitForLoadState("domcontentloaded").catch(() => {});
        return popup;
      }
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      if (hostOf(page.url()) !== here) return page;
      continue;
    }

    let target;
    try {
      target = new URL(href, page.url());
    } catch {
      continue;
    }
    if (!/^https?:$/.test(target.protocol)) continue;
    if (target.hostname === here) continue;

    const looksLikeApply =
      APPLY_RE.test(plainWords(text)) ||
      /\bapply\b/i.test(text) ||
      /(greenhouse|lever\.co|ashbyhq|myworkdayjobs|smartrecruiters|workable|icims|taleo)/i.test(
        target.hostname,
      );
    if (!looksLikeApply) continue;

    // Some of these open a new tab; most navigate in place.
    const popupPromise = page.waitForEvent("popup", { timeout: 8000 }).catch(() => null);
    await link.click({ timeout: 8000 }).catch(() => {});
    const popup = await popupPromise;

    if (popup) {
      await popup.waitForLoadState("domcontentloaded").catch(() => {});
      return popup;
    }
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    if (hostOf(page.url()) !== here) return page;
  }
  return null;
}

// Step one of getting to a form: the control that says "apply".
// "Continue Application" is what Workday shows in place of Apply once one
// has been started — and three Booz Allen postings came back "no fields at
// all" on five consecutive runs because of it. The half-finished application
// was sitting right there behind a button nobody was looking for.
const APPLY_RE =
  /^(apply|apply now|apply for this job|apply to this job|apply here|start application|start your application|continue application|continue my application|resume application|submit application|i'?m interested|apply online)$/i;

/**
 * A button's words without its decoration. "APPLY »", "Apply now ›" and
 * "→ Apply" are all "apply"; anchored patterns saw none of them, and a
 * SuccessFactors posting sat there with its Apply button unpressed.
 */
const plainWords = (t) => String(t ?? "").replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "").replace(/\s+/g, " ").trim();

// Step two, which only Workday insists on, and which this missed entirely.
//
// Clicking Apply on a Workday posting does not open a form. It offers a
// choice — "Autofill with Resume" or "Apply Manually" — and neither of those
// matches APPLY_RE, so the applier clicked Apply, found no fields, and
// reported "no submit button" while looking at a menu. That is every one of
// the 25 Workday attempts in the last run.
//
// Manual is preferred over autofill: autofill uploads a resume and waits for
// Workday to parse it into fields, which is slower, and leaves the fields it
// guessed wrong in place.
const APPLY_STEP_RE =
  /^(apply manually|manual|start manually|autofill with resume|apply with resume|use my last application|create account|next|continue)$/i;

/** Workday's choice screen, in the order worth trying. */
const STEP_PRIORITY = ["apply manually", "manual", "start manually", "use my last application"];

/**
 * Bring the application form on screen, and return the frame holding it.
 *
 * Clicks an Apply control only when there is nothing to fill yet, so a page
 * that already shows its form is never disturbed.
 */
/**
 * Get the cookie banner out of the way.
 *
 * It is an overlay, and an overlay eats clicks. That is the whole shape of
 * the AT&T failure: every click "succeeded" — Playwright hit the banner —
 * and the page never changed, so sign-in, registration and the panel switch
 * all reported success while doing nothing at all.
 *
 * Accept rather than decline. This is a portal the user is choosing to apply
 * to, acceptance is what keeps a login session working, and a declined
 * banner on some Workday tenants simply reappears on the next page.
 */
async function dismissBanners(page) {
  const WORDS =
    /^(accept( all)?( cookies)?|allow all( cookies)?|i accept|agree|i agree|ok|got it|continue)$/i;
  for (const frame of framesOf(page)) {
    for (const el of (await frame.$$("button, a, [role=button]").catch(() => [])).slice(0, 60)) {
      try {
        const t = ((await el.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
        if (!WORDS.test(t)) continue;
        if (!(await el.isVisible().catch(() => false))) continue;
        // Forced, like every other click on these portals. An ordinary one
        // hangs on "scrolling into view" and the catch swallowed it, so six
        // applications reported a page with no fields on it while a cookie
        // banner sat over the sign-in form saying "Accept Cookies".
        const landed = await el
          .click({ timeout: 3000, force: true })
          .then(() => true)
          .catch(() => false);
        if (landed) {
          console.log(`    dismissed a banner: "${t.slice(0, 24)}"`);
          await page.waitForTimeout(600);
        }
      } catch {
        /* a banner that will not close must not end the application */
      }
    }
  }
}

/**
 * Whether the boxes in a frame are an application's.
 *
 * Counting boxes cannot tell a form from a page: a careers site's posting
 * page has a search bar, filters and a newsletter signup, and that is more
 * boxes than some real applications have. What an application has that a
 * page does not is a request for the applicant: a name, an email address, a
 * phone number, a resume, or a password to sign in with. Two of those, or a
 * file box or a password box on its own, and it is one. An email box by
 * itself is a mailing list.
 */
async function applicationLike(frame) {
  return await frame
    .evaluate(() => {
      const shown = (e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const boxes = Array.from(document.querySelectorAll("input, textarea, select")).filter((e) => e.type !== "hidden");
      if (boxes.some((e) => e.type === "password" && shown(e))) return true;
      // A file box is usually hidden behind a styled button; its presence is enough.
      if (boxes.some((e) => e.type === "file")) return true;
      const about = (e) =>
        [
          e.getAttribute("name"),
          e.id,
          e.getAttribute("autocomplete"),
          e.getAttribute("aria-label"),
          e.getAttribute("placeholder"),
          e.labels?.[0]?.innerText,
          e.getAttribute("data-automation-id"),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
      const signals = new Set();
      for (const e of boxes) {
        if (!shown(e)) continue;
        const a = about(e);
        if (/first.?name|given.?name|last.?name|family.?name|surname|full.?name|legal.?name|\byour name\b|(^|[^a-z])name([^a-z]|$)/.test(a) && !/user.?name|company|search|keyword/.test(a)) signals.add("name");
        // An email box alone is a signup; beside a name or a phone it is a form.
        if (e.type === "email" || /e-?mail/.test(a)) signals.add("email");
        if (/phone|mobile|\btel\b/.test(a)) signals.add("phone");
        if (/resume|\bcv\b|cover.?letter|linkedin/.test(a)) signals.add("resume");
        if (/address.?line|street|postal|zip.?code|\bcity\b/.test(a)) signals.add("address");
      }
      return signals.size >= 2;
    })
    .catch(() => true); // unreadable: behave as before
}

async function revealForm(page) {
  // Before anything is clicked, because everything after this depends on
  // clicks actually reaching what they are aimed at.
  await dismissBanners(page).catch(() => {});

  // `page` may be reassigned below if the application lives on another tab.
  // Give a client-rendered form a chance to appear before concluding anything.
  await page
    .waitForSelector("input:not([type=hidden]), textarea, select", { timeout: 12000 })
    .catch(() => {});

  let found = await richestFrame(page);
  if (found.count >= 3) {
    if (await applicationLike(found.frame)) return { frame: found.frame, page };
    // Boxes, but not an application's. DuPont's posting page has a search
    // bar, a language picker and a "send me job alerts" signup — more than
    // three boxes — and the applier sat down and filled in the signup. An
    // application asks who you are. Where nothing on the page does, the
    // page is the posting, and its Apply button is the way in.
    console.log("    the boxes on this page are not an application's (no name, phone, resume or password among them); looking for the way to apply");
    const moved = await followExternalApply(page);
    if (moved) {
      await moved
        .waitForSelector("input:not([type=hidden]), textarea, select", { timeout: 12000 })
        .catch(() => {});
      const there = await richestFrame(moved);
      if (there.count >= 3 && (await applicationLike(there.frame))) return { frame: there.frame, page: moved };
      page = moved;
      found = there;
    }
  }

  // An aggregator never hosts the form, so go looking for the real one
  // before clicking anything here.
  if (AGGREGATOR_RE.test(hostOf(page.url()))) {
    const moved = await followExternalApply(page);
    if (moved) {
      await moved
        .waitForSelector("input:not([type=hidden]), textarea, select", { timeout: 12000 })
        .catch(() => {});
      const there = await richestFrame(moved);
      if (there.count >= 3) return { frame: there.frame, page: moved };
      page = moved;
      found = there;
    }
  }

  // Four passes, not two. Workday needs three clicks before a field exists —
  // Apply, then the manual-or-autofill choice, then past a sign-in wall — and
  // two attempts could never get there however good the selectors were.
  const seenControls = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    let clicked = false;
    const onPage = [];

    for (const frame of framesOf(page)) {
      const controls = await frame.$$("a, button, input[type=submit], [role=button]").catch(() => []);
      const matches = [];

      for (const control of controls) {
        const text = (
          (await control.innerText().catch(() => "")) ||
          (await control.getAttribute("value").catch(() => "")) ||
          (await control.getAttribute("aria-label").catch(() => "")) ||
          ""
        )
          .replace(/\s+/g, " ")
          .trim();
        if (!text) continue;
        if (!(await control.isVisible().catch(() => false))) continue;
        if (onPage.length < 14) onPage.push(text.slice(0, 40));
        const words = plainWords(text);
        if (APPLY_RE.test(words) || APPLY_STEP_RE.test(words)) matches.push({ control, text: words });
      }

      if (!matches.length) continue;

      // Prefer the manual route when Workday offers the choice; otherwise take
      // whatever matched first.
      matches.sort((a, b) => {
        const rank = (t) => {
          const i = STEP_PRIORITY.indexOf(t.toLowerCase());
          return i === -1 ? STEP_PRIORITY.length : i;
        };
        return rank(a.text) - rank(b.text);
      });

      const pick = matches[0];
      // Said, because "it pressed something and ended up somewhere else" is
      // not a thing a log should leave to be guessed at.
      console.log(`    pressed "${pick.text.slice(0, 30)}" to reach the application`);
      await pick.control.click({ timeout: 5000 }).catch(() => {});
      clicked = true;
      break;
    }

    // Kept so a run that still fails says what it was looking at, rather than
    // only that it found nothing. Guessing at a DOM that cannot be opened
    // from here is what made this take three attempts to find.
    if (onPage.length && seenControls.length === 0) seenControls.push(...onPage);

    if (!clicked) break;

    // The click may navigate, open the form in place, or reveal an iframe.
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page
      .waitForSelector("input:not([type=hidden]), textarea, select", { timeout: 12000 })
      .catch(() => {});

    found = await richestFrame(page);
    if (found.count >= 3) return { frame: found.frame, page };
  }

  // Still nothing. A description page that links out to the ATS is common
  // even off the aggregators, so try that before giving up.
  if (found.count < 3) {
    const moved = await followExternalApply(page);
    if (moved) {
      await moved
        .waitForSelector("input:not([type=hidden]), textarea, select", { timeout: 12000 })
        .catch(() => {});
      const there = await richestFrame(moved);
      if (there.count > found.count) return { frame: there.frame, page: moved };
    }
  }

  if (found.count < 3 && seenControls.length) {
    console.log(`    no form; buttons on page: ${JSON.stringify(seenControls)}`);
  }

  return { frame: found.frame, page };
}

// ---------------------------------------------------------------------------
// Apply to one job
// ---------------------------------------------------------------------------
let GREENHOUSE_BOARDS = null;
/** The employer's Greenhouse board name, from the companies list or its name. */
async function greenhouseBoard(company) {
  const key = (v) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!GREENHOUSE_BOARDS) {
    const rows = (await db("companies?ats=eq.greenhouse&select=name,token&limit=1000").catch(() => null)) ?? [];
    GREENHOUSE_BOARDS = new Map(rows.filter((r) => r?.token).map((r) => [key(r.name), String(r.token)]));
  }
  return GREENHOUSE_BOARDS.get(key(company)) ?? (key(company) || null);
}

/**
 * Apply, and where the employer's own page shows no form, apply through the
 * form Greenhouse hosts for the same job.
 *
 * Carvana's postings point at carvana.com/careers/apply?gh_jid=8360004, a page
 * of Carvana's own that sits behind a Cloudflare check and showed this
 * runner nothing but that check — seven jobs in one run. The application
 * itself is a Greenhouse form, and Greenhouse serves the same form for the
 * same job at its own address; the employer's page only embeds it. So when
 * the wrapper yields nothing, go to what it wraps.
 */
async function applyToJob(context, job, profile, answers) {
  const first = await applyToJobOnce(context, job, profile, answers);

  const at = String(job.apply_url || job.url || "");
  const jid = at.match(/[?&]gh_jid=(\d+)/)?.[1];
  const nothingThere =
    first.status === "needs_help" &&
    (first.help_reason === "no_form" ||
      first.help_reason === "captcha" ||
      // Elastic's own page is a careers search — three boxes and no submit —
      // so "no submit button" counts however many fields were on it.
      /No submit button found/.test(String(first.note ?? "")));
  if (!jid || !nothingThere || /greenhouse\.io/.test(at)) return first;

  const board = await greenhouseBoard(job.company);
  if (!board) return first;
  const direct = `https://boards.greenhouse.io/embed/job_app?for=${encodeURIComponent(board)}&token=${jid}`;
  console.log(`    no form on the employer's own page; trying the Greenhouse-hosted form for the same job`);
  const second = await applyToJobOnce(context, { ...job, url: direct, apply_url: direct }, profile, answers);

  // Still nothing there means the board name was wrong; report the first.
  const stillNothing =
    second.status === "needs_help" &&
    (second.help_reason === "no_form" || /after filling 0 fields/.test(String(second.note ?? "")));
  return stillNothing ? first : second;
}

// Every role the owner has entered in settings, read once a run.
let ROLES;
let ROLE_ROWS = [];
async function allRoles() {
  if (ROLES !== undefined) return ROLES;
  try {
    ROLE_ROWS = (await db("experience?select=company,title,location,start_date,end_date,details&order=created_at.desc&limit=40")) ?? [];
    ROLES = rolesText(ROLE_ROWS);
  } catch {
    ROLES = ""; // the table is not there yet, or is empty
  }
  return ROLES;
}

/**
 * Make sure this job has a resume written for it before anything else reads
 * the resume: the answers, the work history and the file that is attached
 * all come from the same text, so it has to exist first.
 *
 * Most jobs used to arrive here without one. The panel writes ten at a time
 * and the queue is in the hundreds, so the general resume went in instead.
 */
const TAILORED = { already: 0, written: 0, arranged: 0, general: 0 };
async function ensureTailored(job, profile) {
  if (job.tailored_resume) { TAILORED.already++; return true; }
  const made = await tailorResume({
    job,
    profile,
    roles: await allRoles(),
    apiKey: process.env.GEMINI_API_KEY,
  }).catch((e) => ({ text: null, why: String(e?.message ?? e).slice(0, 40) }));
  if (!made.text) {
    // The model could not write it. The resume is still made for this
    // posting, by choosing and ordering what is already on it — which needs
    // no model and so never runs out. Held for this run only and not saved,
    // so the written version takes its place when the model is free again.
    const arranged = arrangedResume(profile, job, ROLE_ROWS);
    if (arranged) {
      job.tailored_resume = arranged.text;
      job.resume_arranged = true;
      TAILORED.arranged++;
      console.log(
        `    resume: arranged for this posting without the model (${made.why}) — ${arranged.moved} bullet(s) reordered` +
          `${arranged.dropped ? `, ${arranged.dropped} less relevant left off` : ""}${arranged.leftOff ? `, ${arranged.leftOff} role(s) left off` : ""}`,
      );
      return true;
    }
    TAILORED.general++;
    console.log(`    resume: not written for this posting (${made.why}); the resume on file is used, in the posting's wording where it applies`);
    return false;
  }
  job.tailored_resume = made.text;
  TAILORED.written++;
  const cut = made.removed.roles + made.removed.bullets + made.removed.schools;
  console.log(
    `    resume: written for this posting — ${made.roles} role(s), ${made.bullets} bullet(s)` +
      (cut ? `; ${cut} line(s) the source did not support were taken out` : ""),
  );
  // Kept, so the email that follows an application carries the same page.
  await db(`jobs?id=eq.${job.id}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ tailored_resume: made.text, tailored_at: new Date().toISOString() }),
  }).catch(() => {});
  return true;
}

/**
 * The posting's own words, read from its page when the queue has none.
 *
 * Workday's listing feed carries a title and a place and no description, so
 * every Workday job arrived here with nothing to write a resume to — and
 * Workday is most of the queue. The page that is open at this moment has the
 * whole posting on it.
 */
async function readPosting(page, job) {
  if (String(job.description ?? "").trim().length >= 200) return;
  const text = await until(async () => {
    const t = await page
      .evaluate(() => {
        const pick = (sel) => {
          const el = document.querySelector(sel);
          return el ? (el.innerText || "").trim() : "";
        };
        for (const sel of [
          '[data-automation-id="jobPostingDescription"]',
          '[data-automation-id="job-posting-details"]',
          ".job__description", "#job-description", ".job-description", '[class*="jobDescription" i]', '[class*="job-description" i]',
          '[itemprop="description"]', "article", "main",
        ]) {
          const t = pick(sel);
          if (t.length >= 300) return t;
        }
        return "";
      })
      .catch(() => "");
    return t.length >= 300 ? t : null;
  }, 9000, 600);
  if (!text) return;
  job.description = text.replace(/\n{3,}/g, "\n\n").slice(0, 12000);
  console.log(`    posting: read from its page (${job.description.split(/\s+/).length} words)`);
  await db(`jobs?id=eq.${job.id}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ description: job.description }),
  }).catch(() => {});
}

async function applyToJobOnce(context, job, profile, answers) {
  let page = await context.newPage();
  const answerMap = new Map((answers || []).map((a) => [a.q_key, a.answer]));
  const lookupSaved = (label) => {
    const l = String(label ?? "").trim();
    if (!l) return null;
    if (answerMap.has(l)) return answerMap.get(l);

    // A saved answer may stand in only for very nearly the same question.
    //
    // The old rule accepted any saved key over twelve characters that was a
    // substring either way, and it answered "are you or have you ever
    // appeared on the exclusion list" with "Two Weeks". A fragment of one
    // question is not an answer to another, and on a live application that
    // is a wrong answer sent to an employer under the user's name.
    for (const [k, v] of answerMap) {
      if (k.length < 25) continue;
      if (!(l.includes(k) || k.includes(l))) continue;
      if (Math.min(k.length, l.length) / Math.max(k.length, l.length) < 0.8) continue;
      return v;
    }
    return null;
  };

  const unknown = [];
  let filled = 0;

  try {
    await page.goto(job.apply_url || job.url, {
      waitUntil: "domcontentloaded", timeout: 45000,
    });

    // --- blockers, before touching anything ---
    const body = (await page.innerText("body").catch(() => "")).toLowerCase();
    // A posting that is gone should be recorded as gone, not as an error.
    // remoteok says "this career opportunity is no longer available" and
    // arbeitnow says "this job posting has been removed"; neither matched, so
    // both arrived in the Attention Queue looking like applier faults.
    if (
      /no longer accepting|no longer available|has been removed|been taken down|position (has been )?filled|posting (is )?closed|expired|job not found|opportunity is no longer/.test(
        body,
      )
    ) {
      return { status: "skipped", skip_reason: "posting closed" };
    }
    // Workday's search results carry no date, so every Workday job arrives
    // undated — and the fourteen-day rule left nothing to apply to. The
    // posting page says it in words: "Posted 3 Days Ago", "Posted 30+ Days
    // Ago", "Posted Today". Read it here, record it, and hold to the rule.
    if (job.ats === "workday" && !job.posted_at) {
      const m = body.match(/posted\s+(today|yesterday|(\d+)(\+)?\s+days?\s+ago)/);
      const days = !m ? null : m[1] === "today" ? 0 : m[1] === "yesterday" ? 1 : Number(m[2]) + (m[3] ? 1 : 0);
      // The other half of the rule: recent, or closing soon. Workday says so
      // beside the end date — "End Date: December 5 (6 days left to apply)" —
      // and a posting in its last week is wanted however long it has been up.
      const left = body.match(/(\d+)\s+days?\s+left to apply/);
      const closingSoon = left !== null && Number(left[1]) <= 7;
      if (days !== null) {
        if (days > 14 && closingSoon) {
          // The date is left unrecorded: stored, it would rule the posting
          // out of every later claim, and this is the one case it must not.
          console.log(`    posted ${m[1]}, but closing in ${left[1]} day(s) — still wanted`);
        } else {
          const posted = new Date(Date.now() - days * 86_400_000).toISOString();
          await patchJob(job.id, { posted_at: posted }).catch(() => {});
          if (days > 14) {
            return { status: "skipped", skip_reason: `posted ${m[1]}, older than 14 days` };
          }
        }
      } else if (closingSoon) {
        console.log(`    no posted date, but closing in ${left[1]} day(s) — still wanted`);
      } else if (/job description|apply/.test(body)) {
        console.log("    this posting shows no posted date; not applying to one that cannot be shown to be recent");
        return { status: "skipped", skip_reason: "no posting date shown" };
      }
    }
    if (/already applied|you have applied/.test(body)) {
      return { status: "applied", note: "already applied previously" };
    }
    // A challenge on the screen, not a script on the page.
    //
    // This used to give up wherever any reCAPTCHA element existed, and most
    // sites load the invisible kind — a badge in the corner and a hidden
    // frame — without ever showing anyone a puzzle. Two Okta applications
    // were abandoned before a single field was looked at. Only a widget a
    // person would actually have to operate counts; if one appears later, the
    // submit path reports it then.
    if (await visibleCaptcha(page)) return { status: "needs_help", help_reason: "captcha" };
    // The form is usually behind an Apply button, and often inside an iframe.
    // Everything below works against the frame that actually holds it.
    // The posting, then the resume written to it, before anything reads the
    // resume: the answers, the work history and the attached file all come
    // from the same text.
    await readPosting(page, job);
    await ensureTailored(job, profile);

    // A SuccessFactors posting's Apply button opens a small menu first —
    // apply, apply with LinkedIn, apply with another site — and the entry
    // that is wanted is a plain link to a fixed address. Going to that
    // address is the same thing a person does with two clicks, without the
    // menu to misread.
    if (job.ats === "successfactors") {
      const here = page.url();
      const m = here.match(/^(https?:\/\/[^/]+(?:\/[^/?#]+)?)\/job\/[^/]+\/(\d{6,})\/?(?:[?#].*)?$/);
      if (!m) {
        // The shape of the address, so the pattern can be widened: letters
        // as "a", digits as "9". The employer's own public address.
        try {
          const u = new URL(here);
          console.log(`    successfactors: this posting's address is not the usual shape (${u.pathname.replace(/[A-Za-z]+/g, "a").replace(/\d+/g, "9").slice(0, 60)}${u.search ? "?…" : ""})`);
        } catch { /* nothing to say */ }
      }
      if (m) {
        await page.goto(`${m[1]}/talentcommunity/apply/${m[2]}/?locale=en_US`, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
        await page.waitForTimeout(3000);
        const landed = hostOf(page.url()) ?? "";
        const there = /successfactors\.|sapsf\./i.test(landed) || (await page.$("#username, #fbclc_userName, input[type=password]").catch(() => null));
        console.log(`    successfactors: went to the posting's own apply address; ${there ? "the portal's sign-in is up" : "it did not lead to the portal, going back to the posting"}`);
        if (!there) {
          await page.goto(here, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
          await page.waitForTimeout(2000);
        }
      }
    }

    let revealed = await revealForm(page);
    let form = revealed.frame;
    // The application may have opened in another tab; everything after this
    // must act on that one.
    page = revealed.page;

    // Oracle asks who is applying before it shows the application.
    if (/\.oraclecloud\.com$/i.test(hostOf(page.url()) ?? "")) {
      // One at a time per portal. The code Oracle emails names the employer
      // and nothing else, so with two AutoZone applications at this step
      // together, two codes arrive in the same minute and neither worker
      // can tell which is its own: one typed the other's and was refused,
      // the other waited for a "newer" code that never came. Taking turns,
      // the newest code is always the one just asked for.
      const start = await withHostLock(hostOf(page.url()) ?? "oracle", () => oracleStart(page, profile, job));
      if (start.stop) return start.stop;
      // The application draws itself after the code is accepted; a look
      // taken at once finds the three boxes that have arrived so far.
      await page.waitForSelector('input[id^="lastName"], input[type=file]', { state: "attached", timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2500);
      form = (await richestFrame(page)).frame;
    }

    // The sign-in wall is checked HERE, after the clicks, not before them.
    //
    // It used to be checked against the job description page, where there is
    // no password field to find — so it always concluded there was no wall
    // and ensureAccount never ran. revealForm then clicked through to
    // Workday's Create Account screen, and the generic fill loop met it with
    // no answer for "password": email filled, two required fields short,
    // every large employer stopping in the same place for the same reason.
    // Waited for, not asked once. A registration screen often paints its
    // email field first and its password field a beat later, and revealForm
    // returns the moment three fields exist — so an instant check can miss
    // the wall entirely and leave the fill loop to meet it with no answer for
    // "password". That is Church & Dwight stopping on "1 required item still
    // empty: password" while this check had already said there was no wall.
    const wall = await form
      .waitForSelector("input[type=password]", { timeout: 4000, state: "attached" })
      .catch(() => null);

    if (wall) {
      if (profile.create_accounts !== true) {
        return {
          status: "needs_help",
          help_reason: "login",
          note: "This portal needs an account. Turn on account creation in Settings to let the applier register.",
        };
      }
      const account = await ensureAccount(page, profile, job);
      if (!account.ok) {
        return {
          status: "needs_help",
          help_reason: account.reason === "email_verification" ? "email_verification" : "login",
          note:
            account.reason === "email_verification"
              ? "Registered, but the portal emailed a verification code. The account is saved in Settings."
              : `Could not get past the sign-in wall: ${account.reason}.`,
        };
      }
      // Registered or signed in. The application itself is a step further on,
      // so look for it again rather than filling the registration screen.
      await page.waitForTimeout(2000);
      revealed = await revealForm(page);
      form = revealed.frame;
      page = revealed.page;
    }

    // Why a field was passed over, counted rather than narrated. "filled 0
    // fields" says nothing about whether the form was wrong, the labels were
    // unreadable, or every answer was simply missing from the profile — and
    // those need completely different fixes.
    const skips = { no_label: 0, invisible: 0, disabled: 0, prefilled: 0, no_answer: 0 };
    const seenLabels = [];
    const unlabelled = [];
    const groupsSeen = new Set();
    const hidden = [];
    const unanswered = [];

    // --- resume file: write it to disk and attach it ---
    // A cloud browser CAN set a file input (unlike a Chrome extension, where
    // only a human gesture can). This is the main thing the cloud agent does
    // that the extension cannot.
    //
    // Every step here used to fail silently: a swallowed catch, and nothing
    // in the log either way. So a run that attached no resume at all looked
    // identical to one that did, and an ATS rejecting the submission for a
    // missing resume looked like no reason at all.
    // Tried again on every wizard step, not once per application. Workday's
    // file input lives on "My Experience", which is page TWO — a single check
    // before the first fill reports "no file input on this form" for every
    // Workday job there is, and then the application is rejected for having
    // no resume on it.
    let resumeNote = "no file input on this form";
    let resumeWanted = false;
    // Questions about who the owner is that ended up holding an answer other
    // than theirs. Nothing is sent while there is one.
    const wrongHeld = [];
    // What the portal itself refused to move past, in its own words. Worth
    // more than any guess the applier makes about whether a form is complete.
    let blockedBy = [];

    // --- fill, across multiple pages if needed ---
    let retries = 0;
    let settles = 0;
    let lastRefusal = null;
    // J&J advanced eight times and was still going when the loop ended.
    for (let step = 0; step < 14; step++) {
      const filledAtStart = filled;
      if (resumeNote !== "resume attached") {
        const r = await attachResume(context, page, form, profile, job);
        if (r.wanted) {
          resumeWanted = true;
          resumeNote = r.note;
          console.log(`    step ${step + 1}: ${r.note}`);
        }
      }
      // Entries Workday's reader of the resume left half-filled.
      if (/myworkdayjobs\.com$|myworkdaysite\.com$/i.test(hostOf(page.url()) ?? "")) {
        filled += await workdayWorkHistory(page, form, profile).catch(() => 0);
      }

      const controls = await form.$$("input, select, textarea");

      for (const el of controls) {
        try {
          const type = await el.getAttribute("type");
          if (["hidden", "submit", "button", "file", "image", "reset"].includes(type)) continue;
          // A radio or checkbox the user can plainly see is often invisible
          // to Playwright: Workday hides the native input and styles a
          // sibling, so isVisible() is false on a control that is right
          // there on the screen. Four such fields were skipped as "invisible"
          // on a form the portal then refused to advance. Judge those two by
          // whether their enclosing widget is on the screen.
          if (!(await el.isVisible().catch(() => false))) {
            const painted =
              (type === "radio" || type === "checkbox") &&
              (await el
                .evaluate((n) => {
                  const box = n.closest("label, [data-automation-id], [role=radiogroup]");
                  if (!box) return false;
                  const r = box.getBoundingClientRect();
                  return r.width > 0 && r.height > 0;
                })
                .catch(() => false));
            if (!painted) {
              skips.invisible++;
              // One of these is the "Have you worked here before?" group the
              // portal keeps rejecting, and counting them says nothing about
              // which. Record the first few so the next run names them.
              if (hidden.length < 5) {
                hidden.push(
                  await el
                    .evaluate((n) => ({
                      tag: n.tagName,
                      type: n.getAttribute("type"),
                      id: n.getAttribute("data-automation-id") ?? n.id ?? null,
                      parent:
                        n.parentElement?.getAttribute("data-automation-id") ??
                        n.parentElement?.tagName ??
                        null,
                    }))
                    .catch(() => ({ tag: "?" })),
                );
              }
              continue;
            }
          }
          if (!(await el.isEnabled().catch(() => false))) { skips.disabled++; continue; }

          const name = (await el.getAttribute("name")) || "";
          if (/honeypot|bot[-_]?field|leave[-_]?blank/i.test(name)) continue;

          const label = await el.evaluate(readLabel);

          // A honeypot that says so in words rather than in its name.
          //
          // Workday's reads "Enter website. This input is for robots only, do
          // not fill it in." The answer table maps any label containing
          // "website" to the portfolio URL, so this was being filled — with a
          // real URL, on a field whose entire purpose is to catch anything
          // that fills it. Every Workday registration would have been thrown
          // out as a bot the moment the passwords started working, and the
          // rejection would have looked like nothing at all.
          if (label && /robots? only|do not fill|don'?t fill|leave (this )?(field )?(blank|empty)/i.test(label)) {
            continue;
          }

          if (!label) {
            skips.no_label++;
            // A real Greenhouse form returned 30 fields and not one label, so
            // the extractor is missing something the markup does carry.
            // Record what the first few actually look like instead of
            // guessing at it from the outside.
            if (unlabelled.length < 4) {
              unlabelled.push(
                await el
                  .evaluate((e) => {
                    const a = {};
                    for (const n of e.getAttributeNames()) {
                      if (/^(class|style|value)$/.test(n)) continue;
                      a[n] = (e.getAttribute(n) || "").slice(0, 40);
                    }
                    return {
                      tag: e.tagName,
                      attrs: a,
                      parentText: (e.parentElement?.innerText || "").replace(/\s+/g, " ").slice(0, 60),
                    };
                  })
                  .catch(() => ({ tag: "?" })),
              );
            }
            continue;
          }
          // A box that says it is a trap is left alone. Oracle labels its
          // own "honeypot": filling it is how a form tells a script from a
          // person, and the application is then thrown away without a word.
          if (/honey-?pot/i.test(label)) continue;
          if (seenLabels.length < 12) seenLabels.push(label.slice(0, 48));

          const tag = await el.evaluate((e) => e.tagName);

          // checkboxes: only consent boxes
          if (type === "checkbox") {
            // Self-identification offered as "mark all that apply".
            //
            // "How would you describe your racial/ethnic background?" is a
            // row of checkboxes on Greenhouse, not a dropdown, so nothing
            // here touched it and the form stopped. The profile already
            // holds the answer the candidate gave, so this ticks the box
            // that matches what THEY said — it is their answer being
            // entered, not a guess about them. Where nothing matches it is
            // left alone, as every self-identification is.
            // The question, which is not on the box.
            //
            // `label` was doing two jobs here: naming the question ("does
            // this mention race?") and naming the option ("does this box say
            // White?"). On a Greenhouse demographic group the box's label IS
            // the option and the question is on the container, so one of the
            // two was always wrong. They are separate now.
            const grp =
              label && label.trim().length > 8 && !/^question_\d+|\[\]$/.test(label.trim()) &&
              !/^(none of|none apply|not applicable)/i.test(label.trim())
                ? null
                : await el.evaluate(readGroupQuestion).catch(() => null);
            const asks = grp?.ask ? `${grp.ask} ${label ?? ""}` : label;
            if (grp?.ask && groupsSeen.size < 6 && !groupsSeen.has(grp.ask)) {
              groupsSeen.add(grp.ask);
              console.log(
                `    group asks "${grp.ask.slice(0, 64)}" offering ${JSON.stringify(grp.options)}`,
              );
            }

            // "Please confirm whether any of the below applies to you. Select
            // all that apply" — a list of restrictions with "None of the
            // above" at the end, and a follow-up for anyone who ticked
            // something else. Two Databricks applications stopped on it.
            // None is the answer unless something on file says otherwise.
            if (
              /appl(y|ies) to you|select all that apply|prior question|previous question|any of the (below|following)/i.test(String(asks)) &&
              /^(none of the above|none of these|none apply|none|not applicable|n\/?a)\b/i.test(String(label ?? "").trim())
            ) {
              if (!(await el.isChecked().catch(() => false))) {
                console.log(`    assumed "${String(label).trim().slice(0, 24)}" for "${String(asks).slice(0, 50)}"`);
                if (await checkBox(el, label)) filled++;
              }
              continue;
            }

            // "What type of employment are you seeking? (Select all that
            // apply)" — Full-Time, Part-Time, Campus Program. TD Bank stopped
            // on it twice. The answer is the kind of job being applied for:
            // what the posting says it is, and full-time where it does not
            // say. Only that one box is ticked.
            if (
              /type of (employment|position|work|job)s? (are you|you are|you're) (seeking|looking|interested)|(seeking|looking for|interested in) (a )?(full|part)[- ]?time|employment (type|preference)s? .{0,40}(seeking|select)/i.test(String(asks)) &&
              !has(asks, "race", "ethnic", "gender", "veteran", "disability")
            ) {
              const exact = await el
                .evaluate((n) => {
                  const byFor = n.id ? document.querySelector(`label[for="${CSS.escape(n.id)}"]`) : null;
                  const t = (byFor?.innerText || n.labels?.[0]?.innerText || n.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
                  return t.length >= 2 && t.length < 80 ? t : "";
                })
                .catch(() => "");
              // Failing a label of its own, what follows the question.
              const own = (exact || String(label ?? "").split(/[?)]/).pop() || "").trim().toLowerCase();
              const posting = `${job?.title ?? ""} ${String(job?.description ?? "").slice(0, 6000)}`;
              const partOnly = /\bpart[- ]?time\b/i.test(posting) && !/\bfull[- ]?time\b/i.test(posting);
              if ((partOnly ? /^part[- ]?time\b/ : /^full[- ]?time\b/).test(own)) {
                if (!(await el.isChecked().catch(() => false))) {
                  console.log(`    the kind of employment sought: "${partOnly ? "Part-Time" : "Full-Time"}", as the posting is`);
                  if (await checkBox(el, label)) filled++;
                }
              }
              continue;
            }

            if (has(asks, "race", "racial", "ethnic", "ethnicity", "hispanic", "latino",
                           "gender", "veteran", "disability", "disabilities")) {
              const want = answerQuestion(asks, profile);
              // The box's OWN words. On Workday's disability form every box
              // reads back the whole group — all three options run together
              // — so matching against that text matches the first box
              // whatever the answer is. The label tied to this one box says
              // which option it is.
              const exact = await el
                .evaluate((n) => {
                  const byFor = n.id ? document.querySelector(`label[for="${CSS.escape(n.id)}"]`) : null;
                  const t = (byFor?.innerText || n.labels?.[0]?.innerText || n.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
                  return t.length >= 2 && t.length < 200 ? t : "";
                })
                .catch(() => "");
              const own = String(exact || label || "").toLowerCase();
              let target = norm(want);
              // A yes or a no ticks only the box that says yes or no. As a
              // loose match, "no" is also the last two letters of "Latino".
              // The panel's disability answer is the form's own sentence
              // ("No, I do not have a disability…") or the older bare word;
              // either way it is one of three things.
              const declines = /not (want|wish) to answer|decline|prefer not/.test(target);
              if (/disab/i.test(String(asks)) && !declines) {
                if (/^yes\b/.test(target)) target = "yes";
                else if (/^no\b/.test(target)) target = "no";
              }
              const yesNo = /^(yes|no)$/.test(target);
              const mine =
                target &&
                (declines && /disab/i.test(String(asks))
                  ? /not (want|wish) to answer|decline|prefer not/.test(own)
                  : yesNo
                  // The option is what follows the question: "Please check
                  // one of the boxes below: No, I do not have a disability".
                  ? new RegExp(`^${target}\\b`).test(norm(own.slice(Math.max(own.lastIndexOf(":"), own.lastIndexOf("?")) + 1)))
                  : norm(own).includes(target) ||
                  target.includes(norm(own)) ||
                  // "White (United States of America)" against a box reading
                  // "White": the first word carries the answer.
                  (target.split(" ")[0]?.length > 3 && norm(own).startsWith(target.split(" ")[0])));
              if (!mine && selfIdSeen.size < 8 && !selfIdSeen.has(own)) {
                selfIdSeen.add(own);
                // Shape only: whether there is an answer on file and how this
                // box ends, never what the answer is.
                console.log(`    self-identified: box ending "${own.slice(-34)}" does not match the answer on file (${target ? `${target.split(" ").length} word(s)` : "none"})`);
              }
              if (mine && !(await el.isChecked().catch(() => false))) {
                console.log(`    self-identified "${String(label).slice(0, 30)}" from the profile`);
                if (await checkBox(el, label)) filled++;
              }
              continue;
            }

            // "I currently work here" is what removes the end-date boxes the
            // portal then demands. Without it a current job is asked for an
            // end date that does not exist.
            if (has(asks, "currently work", "current position", "i currently",
                           "present position", "current job", "still work")) {
              const w = await workHistory(profile, job);
              if (w?.current && !(await el.isChecked().catch(() => false))) {
                if (await checkBox(el, label)) filled++;
              }
              continue;
            }
            // A question answered by ticking one box out of several.
            //
            // Ryder asks "What are your relocation preferences?" over a row of
            // checkboxes — "Not willing to relocate", and the ways of being
            // willing. Nothing here read that as a question at all, so a form
            // with every other field filled stopped on it. The question is
            // put to the same answer chain as any other; the box that says
            // what the answer says is the one ticked. A "No" ticks the
            // refusing option; anything else has to match the option's words.
            {
              const whole = String(label ?? "").trim();
              const cut = whole.match(/^(.{8,}?(?:\?|\((?:select|check|mark|choose|tick) all that apply\)|:))\s*(.{2,})$/i);
              const q = grp?.ask ?? cut?.[1] ?? null;
              const opt = grp?.ask ? whole : cut?.[2] ?? null;
              // "Please outline your general availability (select all that
              // apply)" over mornings, evenings, weekends. Applying is
              // already the claim to be available for the job's hours; every
              // real option is ticked and "none" is not.
              if (q && opt && /\bavailab/i.test(q) && /all that apply|general availability|which (days|shifts|times)|when (are|can) you/i.test(q)) {
                if (!/^(none|not available|unavailable|other|n\/?a)\b/i.test(opt.trim()) && !(await el.isChecked().catch(() => false))) {
                  console.log(`    assumed "${opt.slice(0, 30)}" for "${q.slice(0, 50)}"`);
                  if (await checkBox(el, label)) filled++;
                }
                continue;
              }
              if (
                q && opt &&
                // Anything that reads as a consent is left to the consent
                // rule below, which ticks it for what it is.
                !/agree|consent|acknowledg|certif|\bterms\b|privacy|attest|authoriz|accept|arbitration|\bpolicy\b|\bnotice\b/i.test(q)
              ) {
                const want = answerQuestion(q, profile) ?? lookupSaved(q) ?? lastResort(q, profile, job);
                if (want) {
                  const w = norm(want);
                  const o = norm(opt);
                  const refuses = /^(no|not|none|never|unwilling|unable|n\/a)\b|\b(not|never|unwilling|unable)\b/.test(o);
                  const mine =
                    o === w ||
                    (w === "no" && refuses) ||
                    (w !== "no" && w !== "yes" && w.length > 3 && (o.includes(w) || w.includes(o)));
                  if (mine && !(await el.isChecked().catch(() => false))) {
                    console.log(`    assumed "${opt.slice(0, 30)}" for "${q.slice(0, 50)}"`);
                    if (await checkBox(el, label)) filled++;
                  }
                  continue;
                }
              }
            }

            // The words an employer actually uses on the box that has to be
            // ticked before a form will submit. The portal said it plainly:
            // "Candidate AI Usage Attestation: * | I agree | This field is
            // required." — and "attestation" was in none of these.
            // Reading the GROUP here, not the box.
            //
            // The last Greenhouse blocker turned out to be this: a box whose
            // own label is the server's field name and whose text — "By
            // clicking accept, you agree that any disputes related to your
            // application..." — lives on the container. "agree" was already
            // in this list and matched nothing, because nothing was reading
            // the sentence that contains it. Splitting question from option
            // fixed the self-identification branch above and left this one
            // still looking at the box.
            // Agreeing to be sent things is not agreeing to the application.
            //
            // "I agree to receive DuPont careers alerts" has "agree" in it and
            // sits beside an email box on the posting page; ticking it signs
            // the owner up for a mailing list in their own name. A box that
            // offers alerts, a newsletter or texts is left alone unless the
            // form itself marks it as required.
            if (/\b(job|career)s? alerts?\b|newsletter|marketing|promotion|talent (community|network)|text messages?|\bsms\b|subscribe|receive (e-?mails?|updates|news|offers)/i.test(String(asks))) {
              const must =
                (await el.getAttribute("required").catch(() => null)) !== null ||
                (await el.getAttribute("aria-required").catch(() => null)) === "true";
              if (!must) continue;
            }

            if (has(asks, "agree", "consent", "acknowledge", "acknowledgement", "certify",
                           "terms", "privacy", "accurate", "attestation", "attest",
                           "policy", "notice", "understand", "have read", "authorize",
                           "disclosure", "confirm", "how we interview", "i accept",
                           "accept", "arbitration", "disputes", "dispute resolution")) {
              if (!(await el.isChecked())) {
                if (await checkBox(el, label)) filled++;
              }
            }
            continue;
          }

          if (type === "radio") {
            // A radio's own label is "Yes" or "No". The QUESTION is on the
            // group around it, so asking the input what it is asking gets
            // back "yes", which answers nothing — and that is why "have you
            // worked here before" was rejected on every single pass while
            // the radio for it sat right there in the walk, visible and
            // enabled. Climb to whatever carries the actual wording.
            let question = label;
            let groupId = null;
            if (!question || question.trim().length < 8 || /^(yes|no)\b/i.test(question.trim())) {
              const g = await el
                .evaluate((n) => {
                  let box = n.parentElement;
                  for (let d = 0; box && d < 6; d++, box = box.parentElement) {
                    const text = (box.getAttribute("aria-label") ?? box.innerText ?? "")
                      .replace(/\s+/g, " ")
                      .trim();
                    const id = box.getAttribute("data-automation-id") ?? box.id ?? null;
                    if (text.replace(/\b(yes|no)\b/gi, "").trim().length > 8) {
                      return { id, text: text.slice(0, 140) };
                    }
                    if (id && d >= 2) return { id, text: text.slice(0, 140) };
                  }
                  return null;
                })
                .catch(() => null);
              if (g) {
                groupId = g.id;
                question = g.text || question;
              }
            }

            const want =
              answerQuestion(question, profile) ??
              (/previousworker|previouslyworked|formeremployee|rehire/i.test(String(groupId ?? ""))
                ? "No"
                : null) ??
              lookupSaved(question) ??
              lastResort(question, profile, job);
            if (!want) continue;

            // Workday stores these as true/false and shows them as Yes/No.
            const val = String((await el.getAttribute("value")) || "").toLowerCase();
            const own = String(label || "").trim().toLowerCase();
            const target = String(want).trim().toLowerCase();
            const matches =
              own.startsWith(target) ||
              val === target ||
              (target === "no" && val === "false") ||
              (target === "yes" && val === "true");

            if (matches) {
              console.log(`    yes/no "${String(question).slice(0, 34)}" -> "${target}"`);
              if (await checkBox(el, label || question)) filled++;
            }
            continue;
          }

          if (tag === "SELECT") {
            const current = await el.inputValue().catch(() => "");
            if (current) continue;
            const want = answerQuestion(label, profile) ?? fieldValue(label, profile) ?? lookupSaved(label) ?? lastResort(label, profile, job);
            if (!want) {
              unknown.push({ question: label.slice(0, 200), type: "select" });
              continue;
            }
            let ok = await el
              .selectOption({ label: String(want) })
              .then(() => true)
              .catch(() => false);

            // The same matcher the dropdowns use, which knows that "No" can
            // read "Not to my knowledge" and an agreement can read "I
            // acknowledge". This branch had its own loose includes() and
            // nothing else, so a plain <select> asking to acknowledge an
            // interview policy stopped three Greenhouse applications while
            // the answer table had already decided to agree to it.
            if (!ok) {
              const texts = await el
                .evaluate((sel) => Array.from(sel.options).map((o) => o.text))
                .catch(() => []);
              const hit = bestOption(
                texts.map((t, i) => ({ el: i, text: String(t ?? "").trim() })),
                want,
                label,
              );
              if (hit) {
                ok = await el
                  .selectOption({ label: hit.text })
                  .then(() => true)
                  .catch(() => false);
                if (!ok) {
                  ok = await el
                    .evaluate((sel, t) => {
                      const o = Array.from(sel.options).find((o) => o.text.trim() === t);
                      if (!o) return false;
                      sel.value = o.value;
                      sel.dispatchEvent(new Event("change", { bubbles: true }));
                      return true;
                    }, hit.text)
                    .catch(() => false);
                }
                if (ok) console.log(`    select "${label.slice(0, 28)}" -> "${hit.text.slice(0, 28)}"`);
              }
            }

            if (ok) filled++;
            else unknown.push({ question: label.slice(0, 200), type: "select" });
            continue;
          }

          // text-ish
          const existing = await el.inputValue().catch(() => "");
          if (existing && existing.trim()) { skips.prefilled++; continue; }
          const want =
            answerQuestion(label, profile) ??
            fieldValue(label, profile) ??
            lookupSaved(label) ??
            (await workAnswer(label, profile, job)) ??
            lastResort(label, profile, job);
          if (want) {
            // A Workday "search" field is a combobox, not a text box.
            //
            // "How did you hear about us?" and "Country Phone Code" both
            // arrive as inputs with search in their label, and typing into
            // one leaves the question unanswered: the value is only taken
            // once an option from the dropdown is chosen. Those two were the
            // last required fields standing between a filled form and a
            // submitted one.
            const combo =
              (await el.getAttribute("role").catch(() => null)) === "combobox" ||
              (await el.getAttribute("aria-haspopup").catch(() => null)) === "listbox" ||
              (await el.getAttribute("aria-autocomplete").catch(() => null)) !== null ||
              /\bsearch\b/.test(label);

            // "Title: Doctor / Miss / Mr. / Mrs. / Ms." is a form of address,
            // not a job title. Given the job title, the chooser took the
            // first thing offered and a rehearsal wrote "Doctor". Nobody's
            // form of address is on file, so it is left empty, and emptied
            // if an earlier visit put something there.
            if (combo && /^(title|prefix|salutation|honorific|name prefix)\b/.test(label) && !/job|position|current|role|desired/.test(label)) {
              const held = String(await el.inputValue().catch(() => "")).trim();
              if (held) {
                await el.fill("", { timeout: 3000 }).catch(() => {});
                await page.keyboard.press("Tab").catch(() => {});
                console.log(`    "${label.slice(0, 20)}" is a form of address; cleared what was there`);
              }
              continue;
            }

            // Oracle's country box: typed into by the general chooser, it
            // offered nothing, and the keys pressed next took the first
            // country on the full list — "Afghanistan", in a rehearsal.
            // oracleAddress chooses it by its exact name instead.
            if (combo && /\.oraclecloud\.com$/i.test(hostOf(page.url()) ?? "") && /^country\b/.test(label) && !/phone|code/.test(label)) {
              continue;
            }

            // Oracle's address boxes offer suggestions but take what is
            // typed; the general chooser waits for a suggestion to pick and
            // leaves them empty.
            if (combo && /\.oraclecloud\.com$/i.test(hostOf(page.url()) ?? "") && /address|zip|postal|city/i.test(label)) {
              // Typed as a person types, then the first suggestion taken:
              // it is the portal's own spelling of the address just typed,
              // and the box keeps nothing until one is chosen.
              await el.click({ timeout: 3000 }).catch(() => {});
              await el.fill("", { timeout: 3000 }).catch(() => {});
              await el.type(String(want), { delay: 45 }).catch(() => {});
              await page.waitForTimeout(1800);
              const open = (await el.getAttribute("aria-expanded").catch(() => null)) === "true";
              if (open) {
                await page.keyboard.press("ArrowDown").catch(() => {});
                await page.keyboard.press("Enter").catch(() => {});
              } else {
                await page.keyboard.press("Tab").catch(() => {});
              }
              await page.waitForTimeout(700);
              const kept = String(await el.inputValue().catch(() => "")).trim();
              console.log(`    oracle: "${label.slice(0, 20)}" ${open ? "took a suggestion" : "had no suggestions"}; ${kept ? "holds a value" : "is empty"}`);
              if (kept) { filled++; continue; }
            }

            if (combo && /field of study|major|area of study|discipline/i.test(label)) {
              const got = await workdayStudyPrompt(form, page, label, String(want));
              if (got !== null) {
                console.log(`    combo "${label.slice(0, 34)}" study -> ${got} selected`);
                if (got > 0) { filled++; continue; }
              }
            }

            if (combo && /\bskills?\b/i.test(label)) {
              const got = await workdaySkillsPrompt(form, page, label, skillTerms(profile, job));
              if (got !== null) {
                console.log(`    combo "${label.slice(0, 34)}" skills -> ${got} selected`);
                if (got > 0) { filled++; continue; }
              }
            }

            if (combo && /hear about|source/i.test(label)) {
              const got = await workdaySourcePrompt(form, page, label, want);
              if (got !== null) {
                console.log(`    combo "${label.slice(0, 34)}" wanted "${String(want).slice(0, 24)}" -> ${got} selected`);
                if (got > 0) filled++;
                // Answered or not, it stops here. The general chooser below
                // ends by taking whatever a list offers first, and for this
                // question an empty box is better than an untrue one.
                continue;
              }
            }

            if (combo) {
              let node = el;
              // Chosen with the keyboard, not by hunting the page for options.
              //
              // Searching the whole form for [role=option] found ANOTHER
              // widget's list: "How did you hear about us?" was offered
              // "United States of America (+1)" — the country code
              // dropdown's options — and clicked it. That is worse than
              // leaving the field blank, and it would have gone out on a real
              // application.
              //
              // Looked up afresh every time, never through the handle we
              // started with.
              //
              // Workday re-renders this widget as you type, which detaches
              // that handle — and a detached handle makes every later press,
              // click and evaluate quietly do nothing. That is why the count
              // kept reading null here while the completeness check read
              // "0 items selected" from the same field moments later, and why
              // each fallback appeared to run and change nothing.
              // Identified by whichever of the two it actually carries.
              //
              // The last attempt looked only at data-automation-id, which
              // this input does not have — the descriptor's "source--source"
              // came from its plain id. So no selector was built, the count
              // never ran, and country phone code, which HAD been working,
              // started reporting nothing either.
              const autoId = await node.getAttribute("data-automation-id").catch(() => null);
              const domId = await node.getAttribute("id").catch(() => null);
              const sel = autoId
                ? `[data-automation-id="${autoId}"]`
                : domId
                  ? `[id="${domId}"]`
                  : null;

              // The element the field walk reached is not always the one the
              // widget listens to.
              //
              // This label appears twice on the page, and the copy being
              // typed into sits OUTSIDE the multiselect — which is why the
              // count could never be read from it, while the completeness
              // check, holding the other copy, reads "0 items selected"
              // perfectly well. Typing into the wrong twin explains every
              // attempt at this field.
              const insideWidget = await node
                .evaluate((n) => !!n.closest('[data-automation-id="multiselectInputContainer"]'))
                .catch(() => false);

              if (!insideWidget) {
                const key = label.toLowerCase().split(/\s+/).slice(0, 4).join(" ");
                const handle = await form
                  .evaluateHandle((k) => {
                    const boxes = Array.from(
                      document.querySelectorAll('[data-automation-id="multiselectInputContainer"]'),
                    );
                    for (const b of boxes) {
                      const ctx = (
                        b.parentElement?.innerText ??
                        b.innerText ??
                        ""
                      ).toLowerCase();
                      if (ctx.includes(k)) return b.querySelector("input");
                    }
                    return null;
                  }, key)
                  .catch(() => null);
                const twin = handle?.asElement();
                if (twin) {
                  console.log(`    using the widget's own input for "${label.slice(0, 28)}"`);
                  node = twin;
                }
              }

              // Of several elements sharing the id, the one inside the widget.
              const freshEl = async () => {
                if (!sel) return node;
                const all = await form.$$(sel).catch(() => []);
                for (const e of all) {
                  if (await e.evaluate((n) => !!n.closest('[data-automation-id="multiselectInputContainer"]')).catch(() => false)) return e;
                }
                return all[0] ?? null;
              };

              // The count is read from the widget, however it has to be found.
              //
              // Workday gives the source box and its twin the same id, so a
              // lookup by id lands on whichever comes first in the page — the
              // copy outside the widget — and reads nothing. The count then
              // came back null on a click that had selected, the code took
              // that for a miss, retyped, and pressed Enter over its own
              // answer. So: every element with that id, then the live handle,
              // then the widget whose surroundings carry the question.
              const labelKey = label.toLowerCase().split(/\s+/).slice(0, 4).join(" ");
              const chosenCount = async () => {
                const viaPage = await form
                  .evaluate(
                    ({ s, k }) => {
                      const read = (box) => {
                        const m = (box?.innerText ?? "").match(/(\d+)\s+items?\s+selected/i);
                        return m ? Number(m[1]) : null;
                      };
                      const W = '[data-automation-id="multiselectInputContainer"]';
                      if (s) {
                        for (const nd of document.querySelectorAll(s)) {
                          const n = read(nd.closest(W));
                          if (n !== null) return n;
                        }
                      }
                      for (const box of document.querySelectorAll(W)) {
                        let ctx = box.parentElement;
                        for (let d = 0; ctx && d < 3; d++, ctx = ctx.parentElement) {
                          if (ctx.querySelectorAll(W).length > 1) break;
                          if ((ctx.innerText ?? "").toLowerCase().includes(k)) {
                            const n = read(box);
                            if (n !== null) return n;
                            break;
                          }
                        }
                      }
                      return null;
                    },
                    { s: sel, k: labelKey },
                  )
                  .catch(() => null);
                if (viaPage !== null) return viaPage;
                return await node
                  .evaluate((n) => {
                    const box = n.closest('[data-automation-id="multiselectInputContainer"]');
                    const m = (box?.innerText ?? "").match(/(\d+)\s+items?\s+selected/i);
                    return m ? Number(m[1]) : null;
                  })
                  .catch(() => null);
              };

              // Arrow-down and Enter are handled by the widget that has
              // focus, so there is nothing to scope and nothing to mistake.
              await node.click({ force: true, timeout: 4000 }).catch(() => {});
              await node.fill("", { timeout: 3000 }).catch(() => {});
              await node.type(String(want), { delay: 40 }).catch(() => {});
              await page.waitForTimeout(1500);

              let clickedText = null;

              // Look at the list before pressing anything at it.
              //
              // Every failure on this field has been the keyboard acting on
              // a widget that was not listening, and the log could only say
              // "empty" afterwards. Reading the options says what the
              // employer actually offers — "Company website" is one
              // employer's wording, not every employer's — and clicking one
              // is a thing that either visibly works or visibly does not.
              let offered = await popupOptions(form, node);

              // A narrower term when the full one finds nothing. "Princeton
              // Township" is how a profile writes it and "Princeton" is how a
              // location picker lists it, and an async search that matches
              // nothing simply returns an empty list with no explanation.
              if (!offered.length) {
                const short = String(want).trim().split(/\s+/)[0];
                if (short && short.toLowerCase() !== String(want).trim().toLowerCase()) {
                  await node.fill("", { timeout: 3000 }).catch(() => {});
                  await node.type(short, { delay: 40 }).catch(() => {});
                  offered = await popupOptions(form, node);
                  if (offered.length) {
                    console.log(`    "${label.slice(0, 28)}" found options under "${short}"`);
                  }
                }
              }

              // A subject is searched by its words, one at a time.
              //
              // Ryder's subject list runs to hundreds and only shows what the
              // search matches. "Law & Justice Studies" matches nothing and
              // neither need its first word alone, while "Justice" finds
              // "Criminal Justice" at once.
              if (
                /field of study|major|discipline|area of study|concentration/i.test(label) &&
                !(offered.length && bestOption(offered, want, label))
              ) {
                const tries = String(want)
                  .split(/[^A-Za-z]+/)
                  .filter((w) => w.length > 3 && !/^(studies|study|general|science|sciences|arts)$/i.test(w));
                for (const word of tries) {
                  await node.fill("", { timeout: 3000 }).catch(() => {});
                  await node.type(word, { delay: 40 }).catch(() => {});
                  // Workday's list only searches when Enter is pressed; until
                  // then it goes on showing the top of the alphabet. A search
                  // with exactly one result selects it outright.
                  if ((await chosenCount()) !== null) {
                    await node.press("Enter").catch(() => {});
                    await page.waitForTimeout(1500);
                    if (((await chosenCount()) ?? 0) > 0) {
                      clickedText = word;
                      offered = [];
                      console.log(`    "${label.slice(0, 28)}" found a subject under "${word}" and the portal took it`);
                      break;
                    }
                  }
                  const seen = await popupOptions(form, node);
                  if (seen.length && bestOption(seen, want, label)) {
                    offered = seen;
                    console.log(`    "${label.slice(0, 28)}" found a subject under "${word}"`);
                    break;
                  }
                }
              }

              // Then with nothing typed at all.
              //
              // A search box filters, so typing an answer the list does not
              // contain hides every option there is. "How we interview..."
              // wants "I acknowledge" and the answer on file is "Yes":
              // typing Yes left no options, so nothing could be chosen and
              // the field reported empty for four rounds. Cleared, the list
              // shows everything and bestOption knows that an agreement can
              // read "I acknowledge".
              if (!offered.length && !clickedText) {
                await node.fill("", { timeout: 3000 }).catch(() => {});
                await node.click({ force: true, timeout: 3000 }).catch(() => {});
                offered = await popupOptions(form, node);
                if (offered.length) {
                  console.log(
                    `    "${label.slice(0, 28)}" shows ${offered.length} option(s) with the box cleared`,
                  );
                }
              }

              // Then by the toggle beside the box.
              //
              // "How we interview..." reports aria-expanded="false" with no
              // aria-controls after both of the attempts above: the list is
              // not hidden or filtered, it never opened. Greenhouse's newer
              // select is a text input next to a chevron button — the field
              // descriptor showed INPUT:text[combobox] and BUTTON:button in
              // the same container — and the list opens from the button.
              //
              // Only a button that looks like a disclosure is clicked: no
              // visible text, or it says so with aria-haspopup/aria-expanded,
              // and never a submit. A form container also holds "Remove file"
              // and the submit button, and clicking either of those here
              // would be worse than leaving the field empty.
              if (!offered.length && !clickedText) {
                const handle = await node
                  .evaluateHandle((input) => {
                    let box = input.parentElement;
                    for (let d = 0; box && d < 4; d++, box = box.parentElement) {
                      // Stay inside this field.
                      //
                      // A four-parent walk reaches the <form>, and querying
                      // buttons there returns every field's toggle in
                      // document order — so a combobox with no button of its
                      // own would open a DIFFERENT field's list, and the
                      // answer could land in the wrong field. A local test
                      // picked up exactly that. The field boundary is the
                      // point where a second control appears: the combobox
                      // and its hidden value input are two, a third means
                      // this container belongs to more than one question.
                      if (box.tagName === "FORM") break;
                      if (box.querySelectorAll("input, select, textarea").length > 2) break;
                      for (const b of box.querySelectorAll("button")) {
                        if ((b.getAttribute("type") || "").toLowerCase() === "submit") continue;
                        const text = (b.innerText || "").replace(/\s+/g, " ").trim();
                        const discloses =
                          b.hasAttribute("aria-haspopup") || b.hasAttribute("aria-expanded");
                        if (text.length <= 2 || discloses) return b;
                      }
                    }
                    return null;
                  })
                  .catch(() => null);
                const toggle = handle ? handle.asElement() : null;
                if (toggle) {
                  await toggle.click({ force: true, timeout: 3000 }).catch(() => {});
                  offered = await popupOptions(form, node);
                  console.log(
                    `    "${label.slice(0, 28)}" opened by its toggle: ${offered.length} option(s)`,
                  );
                }
              }

              if (offered.length) {
                console.log(
                  `    "${label.slice(0, 28)}" offers ${JSON.stringify(
                    offered.map((o) => o.text).filter(Boolean).slice(0, 8),
                  )}`,
                );
                // Clicking the option element did nothing at all — the run
                // said so outright: clicked "BMS Website" -> did not take.
                // So use the mechanism that already works on this very form
                // for country phone code, and simply give it the right word
                // to type. Reading the list was never about clicking it; it
                // was about learning that this employer says "BMS Website"
                // where the profile says "Company website".
                let hit = bestOption(offered, want, label);
                // A list with one thing in it, and that thing an
                // acknowledgement, is a notice to be acknowledged and not a
                // question: "Note to California residents — Acknowledge".
                // The answer on file for it is a yes or a no, which matches
                // nothing, and a finished application stopped over it.
                if (!hit) {
                  const real = offered.filter((o) => o.text);
                  if (real.length === 1 && /^(i\s+)?(acknowledge|acknowledged|understand|understood|agree|accept|confirm)\b/i.test(real[0].text.trim())) {
                    hit = real[0];
                    console.log(`    "${label.slice(0, 28)}" is a notice with one answer; acknowledging it`);
                  }
                }
                // What the chosen option is built from, on the question that
                // keeps selecting nothing. The prompt is shut again by the
                // time anything else looks, so it is described here, open.
                if (hit && /hear about|source/i.test(label)) {
                  const made = await hit.el
                    .evaluate((n) => {
                      const tag = (e) =>
                        [e.tagName, e.getAttribute("data-automation-id"), e.getAttribute("role"),
                         e.getAttribute("aria-checked") ?? e.getAttribute("aria-selected") ?? e.getAttribute("aria-expanded")]
                          .filter((v) => v !== null && v !== "")
                          .join("/");
                      const up = [];
                      for (let e = n.parentElement, d = 0; e && d < 4; d++, e = e.parentElement) up.push(tag(e));
                      return {
                        self: tag(n),
                        up,
                        inside: Array.from(n.querySelectorAll("*")).slice(0, 10).map(tag),
                      };
                    })
                    .catch(() => null);
                  console.log(`    source option anatomy: ${JSON.stringify(made)}`);
                }
                if (hit) {
                  // Click it first.
                  //
                  // Retyping the option's text was a Workday workaround,
                  // where clicking an option does nothing — and on a
                  // react-select it actively breaks: the list offers
                  // "United States +1", and typing that back in matches no
                  // country at all. So try the click, check whether it took,
                  // and only fall back to retyping if it did not.
                  // Workday's option is a row (menuItem) wrapping the thing
                  // that actually selects (promptOption). A forced click on the
                  // row highlights it — aria-selected goes true — and chooses
                  // nothing, which is where Target, Johnson & Johnson and Live
                  // Nation have each stopped a finished application. Click the
                  // inner element, with a real click first.
                  {
                    const inner = await hit.el.$('[data-automation-id="promptOption"]').catch(() => null);
                    const target = inner ?? hit.el;
                    try {
                      await target.click({ timeout: 3000 });
                    } catch {
                      await target.click({ force: true, timeout: 3000 }).catch(() => {});
                    }
                    if (inner) {
                      await page.waitForTimeout(700);
                      if ((await chosenCount()) === 0) {
                        // Highlighted but not taken: Enter takes the highlight.
                        await page.keyboard.press("Enter").catch(() => {});
                        await page.waitForTimeout(700);
                      }
                    }
                  }

                  // Check from the FORM, not through the input.
                  //
                  // A react-select re-renders when a value is chosen, which
                  // detaches the handle this code is holding — so asking the
                  // handle whether it worked answers false on a click that
                  // worked perfectly, and the fallback then retypes and
                  // undoes it. Looking the control up again by selector is
                  // immune to that.
                  // Two signals, because one widget shows its answer and
                  // another does not.
                  //
                  // A react-select writes the chosen text into its own box,
                  // so looking for it there works. An intl-tel-input shows a
                  // flag and a dial code — choosing "United States +1" leaves
                  // no "United States" anywhere to find — and the check
                  // failed on a click that had worked, after which the
                  // fallback retyped and undid it. Every one of these closes
                  // its list when a choice lands, so that is the signal that
                  // holds for both.
                  const needle = hit.text.toLowerCase().slice(0, 12);
                  // Read here rather than borrowed: popupOptions has its own
                  // copy of this and it is not in scope.
                  const controls =
                    (await node.getAttribute("aria-controls").catch(() => null)) ??
                    (await node.getAttribute("aria-owns").catch(() => null));
                  const listId = controls ? String(controls).replace(/["\\]/g, "") : null;

                  const took = await until(
                    async () =>
                      (await form
                        .evaluate(
                          ({ s, t, l }) => {
                            const input = s ? document.querySelector(s) : null;
                            if (input) {
                              let box = input.parentElement;
                              for (let i = 0; i < 5 && box; i++, box = box.parentElement) {
                                if ((box.innerText ?? "").toLowerCase().includes(t)) return true;
                              }
                              if ((input.value ?? "").toLowerCase().includes(t)) return true;
                              if (input.getAttribute("aria-expanded") === "false") return true;
                            }
                            if (l) {
                              const list = document.getElementById(l);
                              if (!list) return true; // the list went away
                              const r = list.getBoundingClientRect();
                              if (r.width === 0 || r.height === 0) return true;
                              if (!list.querySelector('[role=option]')) return true;
                            }
                            return false;
                          },
                          { s: sel, t: needle, l: listId },
                        )
                        .catch(() => false))
                        ? true
                        : null,
                    2000,
                  );

                  // Where the widget keeps a count, the count decides.
                  const counted = await chosenCount();
                  console.log(`    "${label.slice(0, 28)}" after the click: count ${counted}, list ${took ? "closed" : "still open"}`);
                  if (counted !== null ? counted > 0 || took : took) {
                    clickedText = hit.text;
                    console.log(`    "${label.slice(0, 28)}" chose "${hit.text.slice(0, 26)}"`);
                  } else if (hit.text.toLowerCase() !== String(want).trim().toLowerCase()) {
                    console.log(`    "${label.slice(0, 28)}" retyping as "${hit.text.slice(0, 24)}"`);
                    await node.fill("", { timeout: 3000 }).catch(() => {});
                    await node.type(hit.text, { delay: 40 }).catch(() => {});
                    await page.waitForTimeout(1200);
                  }
                }
              } else if (!clickedText) {
                // Say what IS there. This field is answered on five Workday
                // tenants and silent on Johnson & Johnson, and "offered no
                // options" cannot tell a list that did not open from one
                // rendered somewhere this does not look.
                // Greenhouse has 244 options sitting in two listboxes and this
                // found none of them, because it only ever looks at a VISIBLE
                // list. Report what the options and their lists actually look
                // like rather than guessing at the widget a second time.
                const around = await form
                  .evaluate(() => {
                    const boxes = Array.from(document.querySelectorAll("[role=listbox]"));
                    const opts = Array.from(document.querySelectorAll("[role=option]"));
                    const shown = (e) => {
                      const r = e.getBoundingClientRect();
                      const st = getComputedStyle(e);
                      return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
                    };
                    return {
                      listboxes: boxes.length,
                      listboxShown: boxes.map(shown),
                      listboxIds: boxes.map((b) => b.id || b.getAttribute("data-testid") || null),
                      options: opts.length,
                      optionShown: opts.slice(0, 3).map(shown),
                      firstOptions: opts.slice(0, 4).map((o) => (o.innerText || "").trim().slice(0, 24)),
                      optionInsideListbox: opts.slice(0, 3).map((o) => !!o.closest("[role=listbox]")),
                      combo: (() => {
                        const c = document.activeElement;
                        return c
                          ? {
                              tag: c.tagName,
                              controls: c.getAttribute("aria-controls"),
                              owns: c.getAttribute("aria-owns"),
                              expanded: c.getAttribute("aria-expanded"),
                            }
                          : null;
                      })(),
                    };
                  })
                  .catch(() => null);
                console.log(
                  `    "${label.slice(0, 28)}" offered no options after typing — page has ` +
                    `${JSON.stringify(around)}`,
                );
              }
              // Did the click settle it? If so, stop here.
              //
              // ArrowDown and Enter at a multiselect that has just taken a
              // value picks a SECOND one or clears the first, so this code
              // was faithfully undoing its own successful click: the option
              // list was read correctly, "BMS Website" was clicked, and the
              // keystrokes below threw it away before anything could see it.
              let settled = false;
              if (clickedText) {
                const n = await chosenCount();
                const shows = await node
                  .evaluate((nd, t) => {
                    const box =
                      nd.closest('[data-automation-id="multiselectInputContainer"]') ??
                      nd.parentElement;
                    const scope = box?.parentElement ?? box;
                    return (scope?.innerText ?? "").toLowerCase().includes(String(t).toLowerCase());
                  }, clickedText)
                  .catch(() => false);
                // Where the widget counts its own selections, the count is the
                // answer. "Shows the text" was also true while the option list
                // itself was still open under the box — Xylem's source read
                // "took" with 0 items selected, and nothing further was tried.
                // Or the box itself now reads what was clicked. SuccessFactors
                // writes the choice into the box and nowhere around it, so a
                // click that had worked was judged not to have, and the two
                // keystrokes below then moved it on to the next line of the
                // list: United States became Afghanistan, No became Yes, and
                // "I am not a protected veteran" became the line under it.
                const holds = await ((await freshEl()) ?? node).inputValue().catch(() => "");
                const flatOf = (t) => String(t).toLowerCase().replace(/\s+/g, " ").trim();
                const reads = !!holds && (flatOf(holds) === flatOf(clickedText) || flatOf(clickedText).startsWith(flatOf(holds)) || flatOf(holds).startsWith(flatOf(clickedText)));
                settled = n !== null ? n > 0 : shows || reads;
                console.log(
                  `    "${label.slice(0, 28)}" clicked "${clickedText.slice(0, 24)}" -> ` +
                    `${settled ? "took" : "did not take"}`,
                );
              }

              // A click that selected nothing may have opened a folder.
              //
              // Workday's "how did you hear about us" is often two levels: a
              // category, then the sources inside it. Choosing the category
              // selects nothing and shows the second list.
              if (clickedText && !settled && (await chosenCount()) === 0) {
                const sub = await popupOptions(form, (await freshEl()) ?? node);
                const names = sub.map((o) => o.text).filter(Boolean);
                const changed = names.join("|") !== offered.map((o) => o.text).filter(Boolean).join("|");
                if (sub.length) {
                  const aboutSource = /hear about|learn about|find (out )?about|source|referr/i.test(label);
                  const inner = aboutSource
                    ? chooseSource(sub, want, label)
                    : (changed ? bestOption(sub, want, label) ?? sub[0] : bestOption(sub, want, label)) ?? null;
                  if (inner) {
                    console.log(
                      `    "${label.slice(0, 28)}" ${changed ? "opened a second list" : "still shows its list"} ` +
                        `${JSON.stringify(names.slice(0, 8))}; choosing "${inner.text.slice(0, 30)}"`,
                    );
                    try {
                      await inner.el.click({ timeout: 3000 });
                    } catch {
                      await inner.el.click({ force: true, timeout: 3000 }).catch(() => {});
                    }
                    await page.waitForTimeout(900);
                    settled = ((await chosenCount()) ?? 0) > 0;
                    if (settled) clickedText = inner.text;
                  }
                }
              }

              // Re-read between keystrokes too: the list rendering is itself
              // a re-render, so the handle typed into may already be gone.
              if (!settled) {
                const t1 = (await freshEl()) ?? node;
                await t1.press("ArrowDown").catch(() => {});
                await page.waitForTimeout(300);
                const t2 = (await freshEl()) ?? t1;
                await t2.press("Enter").catch(() => {});
                await page.waitForTimeout(700);
              }

              // Did anything get chosen? The input still reading back exactly
              // what was typed means the list never narrowed to something
              // Enter could accept, so try once more from the highlighted
              // item rather than leaving a field that looks filled and is not.
              // The widget says how many it has, and that is the only honest
              // signal. These are Workday multiselects: the search box clears
              // when a choice lands, so an empty box means answered and text
              // left sitting in one means the opposite — the reverse of what
              // this code assumed for several runs.
              let chosen = settled ? ((await chosenCount()) ?? 1) : await chosenCount();

              // Text still sitting in the box is the signal, and it is the
              // one that is always available. The count comes from a
              // container this element cannot always reach at this moment —
              // it read null here while the completeness check read
              // "0 items selected" from the same field seconds later, so the
              // fallback below never fired.
              const stillTyped = String(await node.inputValue().catch(() => "")).trim().length > 0;

              // Nothing chosen means the typed term matched nothing in the
              // list — "Company website" is not how every employer words that
              // option. Clear it and take whatever the list offers first,
              // which is an answer rather than a blocked application.
              // Not for a source question: "whatever the list offers first"
              // there can be an agency or a referral nobody made.
              if (
                !settled &&
                (chosen === 0 || (chosen === null && stillTyped)) &&
                !/hear about|learn about|find (out )?about|source|referr/i.test(label)
              ) {
                // Clicked first. ArrowDown on an empty box that does not have
                // focus opens nothing, which is why the last attempt cleared
                // the field and still chose nothing: the box went empty, the
                // widget stayed shut, and "0 items selected" stayed true.
                const f1 = (await freshEl()) ?? node;
                await f1.fill("", { timeout: 3000 }).catch(() => {});
                await f1.click({ force: true, timeout: 4000 }).catch(() => {});
                await page.waitForTimeout(700);
                const f2 = (await freshEl()) ?? f1;
                await f2.press("ArrowDown").catch(() => {});
                await page.waitForTimeout(500);
                const f3 = (await freshEl()) ?? f2;
                await f3.press("Enter").catch(() => {});
                await page.waitForTimeout(800);
                chosen = await chosenCount();

                // Still nothing: some of these only open from the arrow
                // beside the box rather than from the box itself.
                if (chosen === 0) {
                  const opener = await node
                    .evaluateHandle((n) => {
                      const box = n.closest('[data-automation-id="multiselectInputContainer"]');
                      return box?.querySelector("button, [role=button], svg")?.closest("button, [role=button]") ?? null;
                    })
                    .catch(() => null);
                  const openEl = opener?.asElement();
                  if (openEl) {
                    await openEl.click({ force: true, timeout: 4000 }).catch(() => {});
                    await page.waitForTimeout(700);
                    await node.press("ArrowDown").catch(() => {});
                    await page.waitForTimeout(400);
                    await node.press("Enter").catch(() => {});
                    await page.waitForTimeout(800);
                    chosen = await chosenCount();
                  }
                }
              }

              // Whatever list is open now, choose from it.
              //
              // Johnson & Johnson, Live Nation and Xylem each filled more than
              // fifty fields and stopped on this one. Their source question is
              // two levels deep: "Company Web Site" is a heading, and choosing
              // it — by click or by Enter — opens the sources under it and
              // selects nothing. Every path above ends at that second list
              // and walks away from it. So while the widget still holds
              // nothing and a list is showing, take the best match in it, or
              // its first entry, up to two levels down.
              for (let depth = 0; depth < 2 && chosen === 0; depth++) {
                const sub = await popupOptions(form, (await freshEl()) ?? node);
                if (!sub.length) break;
                const inner = /hear about|learn about|find (out )?about|source|referr/i.test(label)
                  ? chooseSource(sub, want, label)
                  : bestOption(sub, want, label) ?? sub[0];
                if (!inner) break;
                console.log(
                  `    "${label.slice(0, 28)}" second list ` +
                    `${JSON.stringify(sub.map((o) => o.text).filter(Boolean).slice(0, 8))}; choosing "${String(inner.text).slice(0, 30)}"`,
                );
                try {
                  await inner.el.click({ timeout: 3000 });
                } catch {
                  await inner.el.click({ force: true, timeout: 3000 }).catch(() => {});
                }
                await page.waitForTimeout(1000);
                chosen = await chosenCount();
              }

              // Still nothing on a source question: say what the open prompt is
              // made of. Four employers stop here and the option list alone
              // has not explained why choosing from it selects nothing.
              if (!chosen && /hear about|source/i.test(label)) {
                const anatomy = await form
                  .evaluate(() => {
                    const shown = (e) => {
                      const r = e.getBoundingClientRect();
                      return r.width > 0 && r.height > 0;
                    };
                    const pop = Array.from(
                      document.querySelectorAll('[data-automation-id*="popup" i], [data-automation-id*="prompt" i], [role=listbox], [role=dialog]'),
                    ).filter(shown);
                    return pop.slice(0, 3).map((p) => ({
                      id: p.getAttribute("data-automation-id"),
                      role: p.getAttribute("role"),
                      items: Array.from(p.querySelectorAll("[data-automation-id], [role=option], [role=radio], [role=checkbox], input"))
                        .filter(shown)
                        .slice(0, 10)
                        .map((n) =>
                          [n.tagName, n.getAttribute("data-automation-id"), n.getAttribute("role"), n.getAttribute("type"),
                           n.getAttribute("aria-checked") ?? n.getAttribute("aria-selected"),
                           (n.innerText || n.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 24)]
                            .filter((v) => v !== null && v !== "")
                            .join("/"),
                        ),
                    }));
                  })
                  .catch(() => null);
                console.log(`    source prompt anatomy: ${JSON.stringify(anatomy)}`);
              }

              let after = await node.inputValue().catch(() => "");
              console.log(
                `    combo "${label.slice(0, 34)}" wanted "${String(want).slice(0, 24)}" -> ` +
                  `${chosen === null ? (after ? `"${after.slice(0, 30)}"` : "empty") : `${chosen} selected`}`,
              );
              // A list that takes the wrong line is worse than one that takes
              // none. Coty's veteran list was asked for "I am not a protected
              // veteran" and came to rest on "I identify as one or more of
              // the…" — the opposite, on a question about the owner. Where a
              // question of that kind holds anything but the answer given, it
              // is emptied, and the application is not sent until it is right.
              if (after && has(label, "race", "ethnic", "gender", "veteran", "disab", "hispanic", "latino")) {
                const flat = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
                const a = flat(after);
                const w = flat(want);
                const same = a === w || a.startsWith(w.slice(0, 14)) || w.startsWith(a.slice(0, 14));
                if (!same) {
                  await node.click({ timeout: 2000 }).catch(() => {});
                  await node.fill("", { timeout: 3000 }).catch(() => {});
                  await page.keyboard.press("Escape").catch(() => {});
                  after = await node.inputValue().catch(() => "");
                  wrongHeld.push(label.replace(/\s+\d+:_input.*$/, "").slice(0, 50));
                  console.log(`    that is not the answer on file; the box was ${after ? "not emptied" : "emptied"} and the application will wait`);
                }
              }
              filled++;
              continue;
            }

            if (await fillField(el, want, label)) filled++;
            continue;
          }

          // Nothing on file. For an open-ended question — "why do you want to
          // work at Target and why would you be a good fit for this role" —
          // write one from the resume and the posting. These are the
          // questions that otherwise stall an application, and asking a human
          // to fill them in is the thing this system exists to avoid.
          const maxLen = Number(await el.getAttribute("maxlength").catch(() => null)) || null;
          const looksOpenEnded = tag === "TEXTAREA" || (maxLen && maxLen >= 200);

          if (looksOpenEnded) {
            // The model is the better writer where it is available, and it is
            // not always available: the key can be absent and the daily quota
            // runs out. The whole block used to be gated on the key existing,
            // which meant that without one the model-free writer — the thing
            // built so this works at zero cost — never ran at all, and every
            // open-ended question stopped a finished application.
            const written = process.env.GEMINI_API_KEY
              ? await generateAnswer({
                  question: label,
                  job,
                  resume: profile?.resume_text,
                  profile,
                  apiKey: process.env.GEMINI_API_KEY,
                  maxLength: maxLen,
                }).catch(() => null)
              : null;

            // The model answers these well and has a daily quota that runs
            // out, after which every open-ended question stops an otherwise
            // finished application. So when it cannot answer, write one from
            // the resume and the posting instead of leaving the box empty.
            const fallback = written?.answer
              ? null
              : composeAnswer({
                  question: label,
                  job,
                  resume: job.tailored_resume || profile.resume_text,
                  profile,
                  maxLength: maxLen,
                });
            if (fallback) {
              console.log(`    wrote an answer for "${label.slice(0, 30)}" without the model`);
            }

            const answer = written?.answer ?? fallback;
            if (answer) {
              if (await fillField(el, answer, label)) filled++;

              // Save ONLY what is safe to reuse. An employer-specific answer
              // reused elsewhere submits praise for Target to a bank — one
              // wrong paragraph like that is worse than a hundred blank
              // fields, because a human reads it and it is unmistakable.
              // The composed one names this employer and this posting's
              // requirements, so it is never reusable.
              if (written?.cacheable) {
                await saveGeneratedAnswer(label, written.answer, tag === "TEXTAREA" ? "longtext" : "text");
              }
              continue;
            }
          }

          skips.no_answer++;
          // Which required field had no answer, by name.
          //
          // Three fields have blocked Greenhouse for four rounds and the
          // counts cannot say whether the fill loop reached them and found
          // nothing to say, or never reached them at all. Those need
          // opposite fixes and guessing between them has cost two rounds.
          if (unanswered.length < 6 && (await el.getAttribute("required")) !== null) {
            unanswered.push(String(label).slice(0, 44));
          }
          if (tag === "TEXTAREA") {
            // Not a question a person can answer once and reuse.
            //
            // "Block's purpose is economic empowerment, what does that mean
            // to you" belongs to one employer. Ninety-one of these had piled
            // up on the answers page, and the owner's reaction was the
            // diagnosis: they could not say what the role or company even
            // was. Nor could the table — it stores the question and not the
            // posting. And an answer written for Block and reused at a bank
            // is the one failure here that a human reads and cannot miss.
            //
            // So these are written per application, never banked. If the
            // writer could not manage one, that is a gap in the writer and
            // the run says so rather than quietly making it somebody's
            // homework.
            console.log(`    no answer written for the open question "${label.slice(0, 40)}"`);
          } else if (
            (await el.getAttribute("required")) !== null ||
            (await el.getAttribute("aria-required")) === "true"
          ) {
            unknown.push({ question: label.slice(0, 200), type: "text" });
          }
        } catch { /* one bad field must not end the application */ }
      }

      // Answering reveals more questions.
      //
      // This questionnaire grows as it is filled: two debarment questions
      // appeared in the rejection list only once the ones above them had
      // been answered. A single pass answers what was on screen when it
      // started and never sees the rest, so the portal keeps refusing over
      // questions that were not there to answer.
      for (let round = 0; round < 4; round++) {
        const before = filled;
        // Workday's button-dropdowns, which are not inputs and so were never
        // walked above. A run reported three of them rejected on one form while
        // the completeness check said nothing was missing.
        // Unanswered ones first, and no low cap.
      //
      // This used to take the first twelve listboxes on the screen and
      // filter the answered ones out afterwards. On a questionnaire with
      // more than twelve questions the ones at the bottom were never
      // examined at all — which is why the debarment questions went
      // unanswered through three passes while a rule for them sat ready.
      // Let a long questionnaire render all the way down before reading it.
      await form
        .evaluate(() => window.scrollTo(0, document.body.scrollHeight))
        .catch(() => {});
      await page.waitForTimeout(600);

      const pickers = [];
      for (const b of (
        await form.$$('button[aria-haspopup="listbox"], [role=listbox]').catch(() => [])
      ).slice(0, 60)) {
        if (!(await b.isVisible().catch(() => false))) continue;
        const shown = ((await b.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
        if (shown && !/^select one$/i.test(shown)) continue;
        pickers.push(b);
      }

      if (pickers.length) {
        console.log(`    round ${round + 1}: ${pickers.length} unanswered picker(s) on screen`);
      }

      for (const btn of pickers.slice(0, 30)) {
          try {
            const label = String((await btn.evaluate(readLabel).catch(() => "")) || "");
            const autoId =
              (await btn.getAttribute("data-automation-id").catch(() => null)) ??
              (await btn.getAttribute("id").catch(() => null));
            if (!label && !autoId) continue;
            // Workday's labels round-trip through the surrounding text and come
            // back as noise — the state dropdown read "state state select one
            // required countryr". Its id, address--countryRegion, says plainly
            // what it is, so use that when the words do not.
            // The id FIRST. Workday's label for the state box came back as
            // "state state select one required countryr", and the lookup that
            // reads labels answered it with the street address.
            const want =
              answerFromWidgetId(autoId, profile) ??
              answerQuestion(label, profile) ??
              fieldValue(label, profile) ??
              lookupSaved(label) ??
              lastResort(label, profile, job);
            let picked = await pickFromListbox(page, form, btn, want, label);

            // Nothing on file, but the resume may well say it: "B.S., Rutgers
            // University" answers "what is your highest level of education"
            // without anyone being asked to retype it into a settings field.
            const offered = Array.isArray(picked?.offered) ? picked.offered : [];
            // A list of Yes and No is a yes/no question, whether or not the
            // wording that reached us still ends in a question mark: long
            // ones are cut short, and the rules for them were declining to
            // answer what looked like a statement.
            if (picked !== true && offered.length === 2 && offered.every((o) => /^(yes|no)$/i.test(String(o).trim()))) {
              const plain = defaultYesNo(`${label} ?`, profile);
              if (plain) picked = await pickFromListbox(page, form, btn, plain, label);
            }
            if (picked !== true && offered.length) {
              const fromResume = await answerFromResume(label, offered, profile, job);
              if (fromResume) {
                picked = await pickFromListbox(page, form, btn, fromResume, label);
                if (picked === true) await saveGeneratedAnswer(label, fromResume, "select");
              }
            }

            if (picked === true) filled++;
            else {
              unknown.push({
                question: (label || String(autoId)).slice(0, 200),
                type: "select",
                options: offered.length
                  ? offered
                  : Array.isArray(picked?.offered)
                    ? picked.offered
                    : [],
              });
            }
          } catch {
            /* one widget must not end the application */
          }
        }

        // Workday's Yes/No groups, which are not inputs either.
        //
        // The portal rejected "previousWorker--candidateIsPreviousWorker" on
        // every pass while the field walk reported its four invisible fields as
        // three unnamed text boxes and an SMS opt-in. By elimination that group
        // has no <input> in it at all: it is divs with role="radio", which
        // nothing here has ever looked at.
        for (const group of (
          await form.$$('[role=radiogroup], [data-automation-id*="radio" i]').catch(() => [])
        ).slice(0, 12)) {
          try {
            if (!(await group.isVisible().catch(() => false))) continue;
            const buttons = await group.$$("[role=radio]").catch(() => []);
            if (!buttons.length) continue;

            let answered = false;
            for (const b of buttons) {
              if ((await b.getAttribute("aria-checked").catch(() => null)) === "true") answered = true;
            }
            if (answered) continue;

            const gid =
              (await group.getAttribute("data-automation-id").catch(() => null)) ??
              (await group.getAttribute("id").catch(() => null));
            const label = String((await group.evaluate(readLabel).catch(() => "")) || "");
            const want =
              answerQuestion(label, profile) ??
              (/previousworker|previouslyworked|formeremployee|rehire/i.test(String(gid ?? ""))
                ? "No"
                : null) ??
              lookupSaved(label) ??
              lastResort(label, profile, job) ??
              // A yes/no group is a question whatever its wording: Oracle's
              // read "work a flexible schedule" and "travel domestically",
              // with no question mark for the rules to recognise.
              (label && label.trim().split(/\s+/).length >= 2 ? defaultYesNo(`${label} ?`, profile) : null);

            if (!want) {
              console.log(`    yes/no "${(label || gid || "?").slice(0, 34)}" has no answer on file`);
              unknown.push({ question: String(label || gid).slice(0, 200), type: "text" });
              continue;
            }

            const target = String(want).trim().toLowerCase();
            for (const b of buttons) {
              const t = ((await b.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
              const aria = (await b.getAttribute("aria-label").catch(() => "")) || "";
              if (!`${t} ${aria}`.trim().toLowerCase().startsWith(target)) continue;
              await b.click({ force: true, timeout: 4000 }).catch(() => {});
              await page.waitForTimeout(300);
              const took = (await b.getAttribute("aria-checked").catch(() => null)) === "true";
              console.log(
                `    yes/no "${String(label || gid || "?").slice(0, 30)}" -> "${target}"` +
                  `${took ? "" : " (did not take)"}`,
              );
              if (took) filled++;
              break;
            }
          } catch {
            /* one widget must not end the application */
          }
        }

        // Nothing new was answered, so nothing new will be. Re-scanning a
        // screen that has already given up everything it has costs a minute
        // of a job's budget and changes nothing.
        if (filled === before) break;
        await page.waitForTimeout(1200);
      }

      // submit if we can, otherwise advance
      const submit = await findSubmit(page, form);
      if (submit) break;

      // Advancing is the NORMAL path on a Workday application, not a
      // fallback. "My Information" is page one of five and its button says
      // "Save and Continue"; there is no Submit until the review screen. The
      // old two-selector lookup with a swallowed click could neither find
      // that button reliably nor say when its click had failed, so six
      // identical passes over page one came back as "no submit button".
      // Oracle's address section is on its first screen and is drawn late;
      // it has to be filled before that screen is left, not at the end.
      if (/\.oraclecloud\.com$/i.test(hostOf(page.url()) ?? "")) {
        filled += await oracleAddress(page, form, profile);
        filled += await oraclePills(page, form, profile, job, lookupSaved);
      }
      const moved = await advanceStep(page, form, step + 1);
      if (moved.ok) await page.waitForTimeout(2500);
      if (moved.rejected?.length) {
        blockedBy = moved.rejected
          .map((r) => r.label || r.id || r.shows)
          .filter(Boolean)
          .slice(0, 4);
      }

      if (moved.ok) {
        retries = 0;
        settles = 0;
        continue;
      }

      // The refusal is itself a reveal.
      //
      // BMS renders its debarment and non-compete questions only once Save
      // and Continue has been refused once — they are not on the screen to
      // be answered before that, which is why they appeared in the rejection
      // list having never appeared in the question scan. So look at this
      // screen again rather than giving up on it, as long as the last look
      // actually answered something.
      // The same refusal twice is not a reveal. Booz Allen returned "Enter a
      // postal code in the correct format" three times running while this
      // dutifully refilled the screen and asked again.
      // A click that changed nothing and named nothing, on a screen where
      // nothing was found to answer, is more often a screen that had not
      // finished drawing than one that refused: three applications at one
      // employer stopped at step three with no question read, while a fourth
      // on the same portal found seven there. Say what is on the screen,
      // give it a moment, and look once more before calling it a dead end.
      if (!(moved.rejected ?? []).length && settles < 1) {
        settles++;
        const seen = await form
          .evaluate(() => {
            const text = (sel) => Array.from(document.querySelectorAll(sel)).map((n) => (n.innerText || "").replace(/\s+/g, " ").trim()).filter(Boolean);
            const shown = (sel) => Array.from(document.querySelectorAll(sel)).filter((n) => n.offsetParent !== null).length;
            return {
              step: text('[data-automation-id="progressBarActiveStep"]').map((t) => t.slice(0, 50))[0] ?? null,
              headings: text("h2, h3").slice(0, 5).map((t) => t.slice(0, 50)),
              alerts: text('[role=alert], [data-automation-id="errorBanner"], [data-automation-id*="errorMessage" i]').slice(0, 4).map((t) => t.slice(0, 140)),
              pickers: shown('button[aria-haspopup="listbox"]'),
              boxes: shown("input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea"),
              ticks: shown("input[type=checkbox], [role=checkbox]"),
              radios: shown("input[type=radio], [role=radio]"),
              busy: shown('[data-automation-id="loadingSpinner"], [aria-busy="true"]'),
            };
          })
          .catch(() => null);
        console.log(`    step ${step + 1}: nothing moved and nothing was named; the screen holds ${JSON.stringify(seen)}; looking again`);
        await page.waitForTimeout(4500);
        step--;
        continue;
      }

      const why = JSON.stringify(moved.rejected ?? []);
      if (why === lastRefusal) {
        console.log(`    step ${step + 1}: refused for the same reason again, so not retrying`);
        break;
      }
      lastRefusal = why;

      if (filled > filledAtStart && retries < 2) {
        retries++;
        console.log(
          `    step ${step + 1}: the refusal revealed more; answering again (try ${retries + 1})`,
        );
        step--;
        continue;
      }
      break;
    }

    // One line per job, enough to tell the three failure modes apart without
    // another round trip.
    console.log(
      `    form: ${form.url().slice(0, 70)} | filled ${filled} | ` +
        `skipped ${JSON.stringify(skips)} | ${resumeNote}`,
    );
    if (seenLabels.length) console.log(`    labels: ${JSON.stringify(seenLabels)}`);
    if (unlabelled.length) console.log(`    unlabelled: ${JSON.stringify(unlabelled)}`);
    if (hidden.length) console.log(`    skipped as invisible: ${JSON.stringify(hidden)}`);
    if (unanswered.length) console.log(`    required but no answer: ${JSON.stringify(unanswered)}`);

    if (unknown.length) await recordUnknowns(unknown);

    // Oracle draws its address boxes after the country is chosen, which is
    // after the pass above has already looked at the page.
    if (/\.oraclecloud\.com$/i.test(hostOf(page.url()) ?? "")) {
      filled += await oracleAddress(page, form, profile);
      filled += await oraclePills(page, form, profile, job, lookupSaved);
      await oracleOpenItems(form);
    }

    // Is the form actually complete before anything is clicked?
    //
    // An ATS rejects a submission with a required field empty, and the
    // applier had no way to see that: it clicked submit, saw no confirmation
    // page, and called it applied. Three fields were filled on a real Ashby
    // application that way. Checking first turns a silent rejection into a
    // job that says which field it stopped on.
    const missing = [];
    const groups = new Map();

    for (const el of await form.$$("input, select, textarea")) {
      try {
        const type = (await el.getAttribute("type")) || "";
        if (["hidden", "submit", "button", "image", "reset", "file"].includes(type)) continue;
        const required =
          (await el.getAttribute("required")) !== null ||
          (await el.getAttribute("aria-required")) === "true";
        if (!required) continue;
        if (!(await el.isVisible().catch(() => false))) continue;

        // A honeypot marked required would block every submission forever, on
        // a field that must never be filled. Some are marked exactly that way
        // on purpose, to catch anything that resolves the contradiction.
        const hpName = (await el.getAttribute("name")) || "";
        if (/honeypot|bot[-_]?field|leave[-_]?blank/i.test(hpName)) continue;
        const hpLabel = (await el.evaluate(readLabel).catch(() => "")) || "";
        if (/robots? only|do not fill|don'?t fill|leave (this )?(field )?(blank|empty)/i.test(hpLabel)) {
          continue;
        }

        if (type === "radio" || type === "checkbox") {
          // One answer satisfies a whole group, so the group is what counts.
          // "unnamed choice" names nothing. A required group with no name
          // attribute stopped an application and the report could not say
          // which question it was.
          const key =
            (await el.getAttribute("name")) ||
            (await el.evaluate(readLabel).catch(() => "")) ||
            "unnamed choice";
          // Keyed by name, because that is what makes two boxes one question.
          // Reported by what it ASKS, because a name is not a question.
          const prior = groups.get(key);
          const ask =
            prior?.ask ?? (await el.evaluate(readGroupQuestion).catch(() => null))?.ask ?? null;
          groups.set(key, {
            answered: (prior?.answered ?? false) || (await el.isChecked().catch(() => false)),
            ask,
          });
          continue;
        }

        if (String(await el.inputValue().catch(() => "")).trim()) continue;

        // A Workday multiselect keeps its answer beside the box, not in it,
        // and says so: "1 item selected, United States of America". Reading
        // the box alone called an answered field empty and blocked a form
        // that was complete.
        const selectedHere = await el
          .evaluate((node) => {
            const box = node.closest('[data-automation-id="multiselectInputContainer"]');
            if (!box) return null;
            const m = (box.innerText ?? "").match(/(\d+)\s+items?\s+selected/i);
            return m ? Number(m[1]) : null;
          })
          .catch(() => null);
        if (selectedHere !== null && selectedHere > 0) continue;

        // A react-select keeps its answer somewhere else entirely.
        //
        // The visible box is a SEARCH field and stays empty; the chosen
        // value lives in a hidden input beside it and is rendered as text in
        // the wrapper. Reading the box alone called country and location
        // empty on forms where the log had just recorded choosing "United
        // States +1" — the selection worked and the check could not see it.
        const chosenNearby = await el
          .evaluate((node) => {
            let box = node.parentElement;
            for (let d = 0; box && d < 4; d++, box = box.parentElement) {
              const hidden = box.querySelector('input[type=hidden], select');
              if (hidden && String(hidden.value ?? "").trim()) return true;
              // react-select renders the chosen label in its own element.
              if (box.querySelector('[class*="singleValue" i], [class*="multiValue" i]')) return true;
            }
            return false;
          })
          .catch(() => false);
        if (chosenNearby) continue;

        // "unnamed field" names nothing and cannot be acted on. Fall back to
        // whatever the markup does carry before giving up on it.
        const label =
          (await el.evaluate(readLabel)) ||
          (await el.getAttribute("data-automation-id").catch(() => null)) ||
          (await el.getAttribute("name").catch(() => null)) ||
          (await el.getAttribute("id").catch(() => null)) ||
          (await el
            .evaluate((n) => (n.closest("label, fieldset, [class*='field' i]")?.innerText ?? "")
              .replace(/\s+/g, " ").trim().slice(0, 60))
            .catch(() => "")) ||
          type ||
          "unnamed field";

        // Describe what is being rejected, because these two keep being named
        // while the log shows them handled. A Workday prompt clears its search
        // box once a value is chosen, so "empty" can mean answered — and the
        // label appearing twice in a form means one element can be filled
        // while a different one with the same label is not.
        const about = await el
          .evaluate((node) => {
            const near = node.closest("[data-automation-id]");
            const r = node.getBoundingClientRect();
            const st = getComputedStyle(node);
            // What a person would actually operate. Two guesses at these
            // fields were wrong — a native select, then a checkbox — and
            // both guesses were about an element nobody had looked at.
            const wrap = node.closest("div,fieldset,label") ?? node.parentElement;
            const controls = Array.from(
              wrap?.querySelectorAll('select,button,[role=combobox],[role=radio],[role=checkbox],input') ?? [],
            )
              .slice(0, 4)
              .map(
                (c) =>
                  `${c.tagName}${c.getAttribute("type") ? ":" + c.getAttribute("type") : ""}` +
                  `${c.getAttribute("role") ? "[" + c.getAttribute("role") + "]" : ""}`,
              );
            return {
              tag: node.tagName,
              type: node.getAttribute("type"),
              painted: r.width > 0 && r.height > 0 && st.visibility !== "hidden",
              required: node.getAttribute("required") !== null || node.getAttribute("aria-required") === "true",
              controls,
              id: node.getAttribute("data-automation-id") ?? node.id ?? null,
              widget: near?.getAttribute("data-automation-id") ?? null,
              // A chosen value usually lands in a sibling element rather than
              // back in the box that searched for it.
              chosen: (near?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 40),
              sameLabelCount: node.getAttribute("aria-label")
                ? document.querySelectorAll(
                    `[aria-label="${CSS.escape(node.getAttribute("aria-label"))}"]`,
                  ).length
                : null,
            };
          })
          .catch(() => null);
        console.log(`    missing "${String(label).slice(0, 34)}": ${JSON.stringify(about)}`);

        missing.push(String(label).slice(0, 60));
      } catch {
        // A field that cannot be read is not evidence that it is empty.
      }
    }
    for (const [key, g] of groups) {
      if (g.answered) continue;
      missing.push(g.ask ? `${g.ask.slice(0, 70)} [${String(key).slice(0, 28)}]` : String(key).slice(0, 60));
    }
    if (resumeWanted && resumeNote !== "resume attached") missing.push(resumeNote);
    for (const q of wrongHeld) missing.push(`a list would not take the answer on file for "${q}"`);

    // A password among the missing items is a sign-in wall that was not
    // caught above, not a form the applier failed to fill. Reporting it as
    // "1 required item is still empty: password" invites you to go and type
    // one, when the actual answer is that the applier should have registered.
    if (missing.some((m) => /password/i.test(m))) {
      if (profile.create_accounts !== true) {
        return {
          status: "needs_help",
          help_reason: "login",
          filled,
          note:
            "This portal needs an account. Turn on account creation in " +
            "Settings → applying to let the applier register.",
        };
      }

      // Register HERE rather than report a wall.
      //
      // The check after revealForm waits four seconds for a password field,
      // and these screens render later than that — AT&T's did. Widening that
      // timeout is guessing at a number; arriving at this line is proof. A
      // required password field that is still empty IS the wall, whenever it
      // chose to appear.
      const account = await ensureAccount(page, profile, job);
      if (!account.ok) {
        return {
          status: "needs_help",
          help_reason: account.reason === "email_verification" ? "email_verification" : "login",
          filled,
          note:
            account.reason === "email_verification"
              ? "Registered, and the portal emailed a verification code. The account is saved " +
                "in Settings → applying."
              : `Could not get past the sign-in wall: ${account.reason}.`,
        };
      }
      // Getting past the wall — by registering OR by signing in — earns
      // another pass, because the application itself is a screen further on
      // and this one is spent.
      //
      // I restricted this to newly created accounts a moment ago, out of a
      // worry about looping that turns out to be already handled: claim_next_job
      // only picks jobs with attempts < 3 and increments on every claim, so a
      // job gets three passes and then stops being offered whatever happens
      // here. That restriction meant a SUCCESSFUL sign-in parked the job,
      // which is the opposite of what it should do.
      return {
        status: "queued",
        help_reason: "registered",
        filled,
        note: account.created
          ? "Account created for this portal and saved in Settings → applying. " +
            "Requeued to apply with it."
          : "Signed in with the saved account for this portal. Requeued to apply.",
      };
    }

    if (missing.length) {
      const list = [...new Set(missing)].slice(0, 5).join("; ");
      return {
        status: "needs_help",
        help_reason: "incomplete",
        filled,
        note:
          `Filled ${filled} fields, but ${missing.length} required item` +
          `${missing.length === 1 ? " is" : "s are"} still empty — submitting would be ` +
          `rejected. Stopped before clicking: ${list}`.slice(0, 300),
      };
    }

    const submit = await findSubmit(page, form);

    if (!submit) {
      // A form with no submit button and a page with no form are different
      // failures needing opposite fixes — "we are on the application and
      // cannot finish it" versus "we never reached the application". Reporting
      // both as "no submit button found after filling 0 fields" is what made
      // 25 Workday postings look like one problem when they were another.
      const controls = await form.$$("input, textarea, select").catch(() => []);
      if (controls.length === 0) {
        // A page titled "Sign In" with nothing on it is a wall that did not
        // render, not a posting without a form. Registering is the answer to
        // that, and reporting "no fields at all" sent six of them to the
        // attention queue instead.
        const looksLikeWall = await page
          .evaluate(() => /sign ?in|log ?in|create account/i.test(document.title ?? ""))
          .catch(() => false);
        if (looksLikeWall) {
          console.log(
            `    the page is a sign-in wall with no fields rendered; ` +
              `account creation is ${profile.create_accounts === true ? "on" : "OFF"}`,
          );
          if (profile.create_accounts === true) {
            const account = await ensureAccount(page, profile, job);
            console.log(
              `    registering at that wall: ${account.ok ? "got in" : account.reason}`,
            );
            if (account.ok) {
              return {
                status: "queued",
                help_reason: "registered",
                note: "Signed in at a wall that had rendered no fields. Requeued to apply.",
              };
            }
            return {
              status: "needs_help",
              help_reason: "login",
              note: `This portal's sign-in rendered no fields at all: ${account.reason}`.slice(0, 300),
            };
          }
        }
        // Three Booz Allen postings came back this way run after run, and
        // "no fields at all" cannot tell a withdrawn posting from a wall.
        const where = await page
          .evaluate(() => ({
            title: (document.title ?? "").slice(0, 70),
            heading: (document.querySelector("h1, h2")?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 70),
            buttons: Array.from(document.querySelectorAll("a, button, [role=button]"))
              .map((b) => (b.innerText ?? "").replace(/\s+/g, " ").trim())
              .filter((t) => t && t.length < 30)
              .slice(0, 8),
          }))
          .catch(() => null);
        console.log(`    no form here: ${JSON.stringify(where)}`);

        return {
          status: "needs_help",
          help_reason: "no_form",
          note:
            "Never reached an application form — the page has no fields on it at all. " +
            "It is most likely still the job description, with the form behind an " +
            "Apply button or a sign-in.",
        };
      }
      // "No submit button" is only the truth when nothing stopped us on the
      // way. On a Workday wizard the real answer is almost always that a
      // screen refused to advance, and the portal named the fields it was
      // unhappy with — report THAT, not the absence of a button we were
      // never going to reach.
      if (blockedBy.length) {
        return {
          status: "needs_help",
          help_reason: "incomplete",
          filled,
          note:
            `Filled ${filled} fields, then the portal refused to move past this ` +
            `screen over: ${blockedBy.join("; ")}`.slice(0, 300),
        };
      }
      return { status: "needs_help", help_reason: "error",
               note: `No submit button found after filling ${filled} fields.` };
    }

    // Something with a submit button and one box is a search form.
    //
    // A MongoDB posting led to a careers page; the applier typed into its
    // one field, pressed the button beside it and reported an unconfirmed
    // application. An application takes a name and an email at the least, or
    // a resume, so anything short of that is not pressed at all.
    if (filled < 3 && !/attached/.test(String(resumeNote))) {
      return {
        status: "needs_help",
        help_reason: "no_form",
        note:
          `The page has a form with only ${filled} fillable field(s) and nowhere for a resume — ` +
          `that is not an application form, so nothing was submitted.`,
      };
    }

    if (DRY_RUN) {
      return { status: "needs_help", help_reason: "dry_run",
               note: `Dry run: filled ${filled} fields, did not submit.` };
    }

    const urlBefore = page.url();
    // force: true for the same reason as every other click in this file. This
    // was the last unforced one, and the cookie banner taught that lesson six
    // runs in a row: a submit button under a sticky footer does not fail
    // loudly, it just never gets clicked.
    // Wait for the portal to enable its own button.
    //
    // "Clicked submit, but nothing confirmed it" with the form still on
    // screen, three employers running: the button was disabled at the moment
    // it was clicked. Greenhouse keeps Submit disabled until it is satisfied
    // — most often while the resume is still uploading — and force: true
    // skips exactly the check that would have caught that, so a dead button
    // was clicked silently. That force was mine, added this morning for the
    // cookie banner, and it turned a loud failure into a quiet one.
    //
    // So force is right for an overlay and wrong for this. Wait for enabled,
    // then click normally; if it never enables, say THAT, because "nothing
    // confirmed it" sent me looking at validity, iframes and the server while
    // the button sat there greyed out.
    const enabled = await until(
      async () =>
        (await submit.isEnabled().catch(() => false)) &&
        (await submit.evaluate((b) => b.getAttribute("aria-disabled") !== "true").catch(() => true))
          ? true
          : null,
      15_000,
      500,
    );

    if (!enabled) {
      const state = await submit
        .evaluate((b) => ({
          disabled: b.disabled === true,
          ariaDisabled: b.getAttribute("aria-disabled"),
          text: (b.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 30),
        }))
        .catch(() => null);
      console.log(`    submit never enabled: ${JSON.stringify(state)}`);
      return {
        status: "needs_help",
        help_reason: "incomplete",
        filled,
        note:
          `Filled ${filled} fields, but the portal never enabled its own Submit button ` +
          `(it stayed disabled for 15s). Something on the form is still unsatisfied — ` +
          `most often a resume still uploading, or a field it wants in another format.`,
      };
    }

    // What the page was already saying before anything was submitted.
    //
    // Workday's review screen carries a role=alert reading "<file>
    // successfully uploaded" from the moment the resume went up. The watch
    // below stopped on ANY alert, so on Workday it stopped at once — before
    // the confirmation could render — and the report then offered that upload
    // notice as the error. Applications that had been walked through all five
    // screens and submitted were filed as failures. Only what appears AFTER
    // the click says anything about the click.
    const NOTICES =
      '[role=alert], [aria-invalid="true"], .error, .field-error, .error-message, [class*="error" i], [data-error]';
    const noticeTexts = () =>
      form
        .$$eval(NOTICES, (els) =>
          els.map((e) => (e.innerText || e.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim()),
        )
        .catch(() => []);
    // Click a button already known to be enabled.
    //
    // Playwright's own click also insists the element be "visible and
    // stable", and MongoDB's submit failed exactly that for ten seconds while
    // being perfectly pressable. Force is safe HERE and only here: it skips
    // the checks, and the one that matters — enabled — has just been made by
    // hand. Forcing before that check is what clicked a dead button all
    // afternoon.
    const press = async (btn) => {
      await btn.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
      try {
        await btn.click({ timeout: 4000 });
        return;
      } catch {}
      try {
        await btn.click({ timeout: 4000, force: true });
        return;
      } catch {}
      // MongoDB's button is "outside of the viewport" even after scrolling —
      // a tall form in a short frame — and a forced click still needs a point
      // on screen to aim at. The button is enabled and it is the right one,
      // so deliver the click to it directly; a submit button takes that the
      // same way it takes a finger.
      await btn.evaluate((b) => b.click());
    };
    const whenEnabled = (btn, ms = 15_000) =>
      until(
        async () =>
          (await btn.isEnabled().catch(() => false)) &&
          (await btn.evaluate((b) => b.getAttribute("aria-disabled") !== "true").catch(() => true))
            ? true
            : null,
        ms,
        500,
      );

    const before = await noticeTexts();
    const saidBefore = new Set(before.filter(Boolean));
    const invalidBefore = await form.$$('[aria-invalid="true"]').then((e) => e.length).catch(() => 0);
    // Never an error, whenever it appears.
    const BENIGN = /successfully uploaded|upload(ed)? (complete|success)|\.(pdf|docx?)\b/i;
    const freshNotices = async () =>
      (await noticeTexts()).filter((t) => t && t.length < 200 && !saidBefore.has(t) && !BENIGN.test(t));

    await press(submit);

    // Read the FORM's document, not the top one.
    //
    // Greenhouse embeds its application in an iframe at
    // job-boards.greenhouse.io/embed/job_app, so everything it answers with —
    // the thank-you, a rejected field, the security-code prompt — renders
    // inside that frame. Every read here used page.innerText("body"), which
    // is the top-level document, so a submission that worked looked exactly
    // like one that did nothing: the inputs were still there (form.$$ is
    // frame-scoped and could see them), the top URL had not changed (the
    // IFRAME navigated), and no confirmation text existed anywhere this
    // looked.
    //
    // A real submission to Block proved it: Greenhouse emailed a security
    // code at 1:06pm for an application this run had just filed, while the
    // run was recording that nothing confirmed it. It had already gone
    // through. The theory being tested at that moment — that the browser was
    // silently refusing the submit on validity — was wrong.
    const bodyText = async () => {
      const inFrame = await form
        .evaluate(() => document.body?.innerText ?? "")
        .catch(() => "");
      const inPage = await page.innerText("body").catch(() => "");
      return `${inFrame}\n${inPage}`.toLowerCase();
    };

    const landed = (t) =>
      // "Thanks for taking the time to apply to MongoDB!" — two applications
      // were submitted, verified by emailed code and accepted, and then filed
      // as unconfirmed because the thank-you was not one of four spellings.
      /thank you|thanks for (taking the time|applying|your (application|interest|submission)|submitting)|thanks,? we|application (has been )?(received|submitted|sent|complete)|we('ve| have) (received|got)|successfully (applied|submitted)|your application (is|was|has been) (in|received|submitted|sent)|submitted your application|application confirmation|we('ll| will) (be in touch|review your application)|while we review your application/.test(
        t,
      );

    // Poll instead of sleeping once. The old code waited exactly 5s and read
    // the page a single time, so a confirmation that rendered at 6s was
    // recorded as "nothing confirmed it" — the submission went through and
    // the job was parked for a human anyway. Greenhouse posts the form over
    // XHR and swaps in the thank-you after; the response time is not ours to
    // predict, so watch for whichever arrives first and stop there.
    let after = "";
    await until(async () => {
      after = await bodyText();
      if (landed(after)) return true;
      if (/security code|verification code|enter the code|resubmit your application/.test(after)) return true;
      if ((await freshNotices()).length > 0) return true;
      const invalidNow = await form.$$('[aria-invalid="true"]').then((e) => e.length).catch(() => 0);
      return invalidNow > invalidBefore;
    }, 25_000, 1000);
    if (!after) after = await bodyText();

    // A security code, emailed the moment the form was submitted.
    //
    // Greenhouse answers a submission with "Copy and paste this code into
    // the security code field on your application" and eight digits, then
    // waits. Without reading it the application stops one step from done —
    // everything filled, resume attached, and the last thing between it and
    // the employer sitting in a mailbox this system can already read.
    if (!landed(after) && /security code|verification code|enter the code|resubmit your application/.test(after)) {
      // Find the box by where it is, not by what it might be called.
      //
      // Datadog's form was valid, submitted, and showing the security-code
      // prompt — and the applier walked away, because it looked for an input
      // with "code" in its name and Greenhouse's has none. So: a one-time-code
      // input if the page declares one; otherwise the first empty text box
      // inside the smallest piece of the page that mentions the code. Never a
      // postal, country or dial code, which the old selector would have
      // happily typed a security code into.
      const found = await form
        .evaluateHandle(() => {
          const shown = (e) => {
            const r = e.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          };
          const usable = (i) =>
            shown(i) &&
            !i.value &&
            !i.disabled &&
            !/hidden|file|checkbox|radio|submit|button|search/.test(i.type || "") &&
            !/postal|zip|country|dial|area|phone|promo|referr/i.test(`${i.name} ${i.id} ${i.getAttribute("aria-label") || ""}`);

          const declared = Array.from(
            document.querySelectorAll(
              'input[autocomplete="one-time-code"], input[name*="security" i], input[id*="security" i], input[aria-label*="security code" i], input[name*="verif" i], input[id*="verif" i], input[name*="otp" i], input[id*="otp" i], input[name*="code" i], input[id*="code" i], input[placeholder*="code" i]',
            ),
          ).find(usable);
          if (declared) return declared;

          const mentions = Array.from(document.querySelectorAll("label, legend, p, span, div, h2, h3, h4"))
            .filter((e) => /security code|verification code/i.test(e.innerText || ""))
            .sort((a, b) => (a.innerText || "").length - (b.innerText || "").length)
            .slice(0, 8);
          for (const m of mentions) {
            let box = m;
            for (let d = 0; box && d < 4; d++, box = box.parentElement) {
              const input = Array.from(box.querySelectorAll("input")).find(usable);
              if (input) return input;
            }
          }
          return null;
        })
        .catch(() => null);
      const box = found ? found.asElement() : null;

      if (!box) {
        // Say what IS there, so this is the last run that cannot find it.
        const empties = await form
          .evaluate(() =>
            Array.from(document.querySelectorAll("input"))
              .filter((i) => {
                const r = i.getBoundingClientRect();
                return r.width > 0 && r.height > 0 && !i.value && !/hidden|file|checkbox|radio/.test(i.type || "");
              })
              .slice(0, 8)
              .map((i) => ({
                name: (i.name || "").slice(0, 30),
                id: (i.id || "").slice(0, 30),
                type: i.type,
                max: i.maxLength,
                aria: (i.getAttribute("aria-label") || "").slice(0, 30),
              })),
          )
          .catch(() => null);
        console.log(`    code prompt is showing but no box was found; empty inputs: ${JSON.stringify(empties)}`);
        return {
          status: "needs_help",
          help_reason: "email_verification",
          filled,
          note:
            "The application was submitted and the portal is asking for the security code it " +
            "emailed, but the box to type it into could not be found. Enter the code from the " +
            "email by hand to finish it.",
        };
      }

      const shape = await box
        .evaluate((i) => ({ name: (i.name || "").slice(0, 30), id: (i.id || "").slice(0, 30), max: i.maxLength }))
        .catch(() => ({}));
      console.log(`    the portal wants an emailed security code (box ${JSON.stringify(shape)}); waiting for it`);

      // The employer, so four workers applying at once cannot take each
      // other's codes: every Greenhouse form shares one host.
      const code = await waitForVerificationCode(hostOf(page.url()), job.company);
      if (!code) {
        return {
          status: "needs_help",
          help_reason: "email_verification",
          filled,
          note:
            "The form was complete and submitted, and the portal asked for a security " +
            "code it emailed. The code did not arrive in the connected mailbox in time.",
        };
      }

      // One box per character is typed, not filled: each box takes one
      // keystroke and passes focus on.
      if (shape.max === 1) {
        // Focus it, do not click it. MongoDB's form is taller than its frame
        // and a click there has nothing on screen to aim at — it failed
        // quietly, the typing went nowhere, and an application that had been
        // submitted and had its code in hand was resubmitted with empty boxes.
        await box.evaluate((b) => b.focus()).catch(() => {});
        await page.keyboard.type(code, { delay: 70 });

        const row = await box.evaluateHandle((b) => b.parentElement).catch(() => null);
        const cells = (await row?.asElement()?.$$("input").catch(() => [])) ?? [];
        const read = async () =>
          (await Promise.all(cells.map((c) => c.inputValue().catch(() => "")))).join("");
        if ((await read()) !== code && cells.length >= code.length) {
          // The keystrokes did not land; put each character in its own box.
          for (let k = 0; k < code.length; k++) await cells[k].fill(code[k]).catch(() => {});
        }
        const got = await read();
        console.log(`    code in the boxes: ${got.length} of ${code.length} characters${got === code ? "" : " — does not match"}`);
      } else {
        await fillField(box, code, "security code");
      }

      const again = (await findSubmit(page, form)) ?? submit;
      if (!(await whenEnabled(again, 10_000))) {
        console.log("    typed the code, but the submit button stayed disabled");
      }
      await press(again).catch(() => {});
      await until(async () => {
        after = await bodyText();
        return landed(after) ? true : null;
      }, 25_000, 1000);
      console.log(`    entered the code and resubmitted${landed(after) ? " — accepted" : " — no confirmation yet"}`);
      if (!landed(after)) {
        const now = await form
          .evaluate(() => {
            const t = (document.body?.innerText ?? "").toLowerCase();
            return {
              codePrompt: /security code|verification code/.test(t),
              rejected: /invalid|incorrect|expired|does not match|try again|not valid|wrong code/.test(t),
              thanks: /thank|received|submitted/.test(t),
              headings: Array.from(document.querySelectorAll("h1, h2, h3, [role=alert]"))
                .map((e) => (e.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 60))
                .filter(Boolean)
                .slice(0, 5),
              inputsLeft: document.querySelectorAll("input, select, textarea").length,
            };
          })
          .catch(() => null);
        console.log(`    what the form shows after the code: ${JSON.stringify(now)}`);
      }

      if (!landed(after)) {
        return {
          status: "needs_help",
          help_reason: "email_verification",
          filled,
          note:
            "The application was submitted and the emailed security code was entered, but the " +
            "portal did not confirm it" +
            (/invalid|incorrect|expired|does not match|try again/.test(after) ? " and says the code was not accepted." : "."),
        };
      }
    }

    if (landed(after)) return { status: "applied", filled };

    // Cast wider than [role=alert] alone. Greenhouse and Ashby mark a rejected
    // field with aria-invalid and render the message in their own class names,
    // so the original three selectors found nothing on the forms that failed —
    // which is how a rejected submission came back looking clean.
    const errors = (await freshNotices()).slice(0, 5);

    const invalid = await form
      .$$('[aria-invalid="true"]')
      .then((els) => els.length)
      .catch(() => 0);

    // Oracle says "1 out of 7 issues" and names one. Which boxes it marked,
    // by what they are, and the messages beside them — the form's wording
    // about a field, never what was typed into it.
    if (/\.oraclecloud\.com$/i.test(hostOf(page.url()) ?? "")) {
      const marked = await form
        .evaluate(() => {
          const ids = Array.from(document.querySelectorAll('[aria-invalid="true"]'))
            .map((c) => String(c.id || c.getAttribute("name") || c.tagName).replace(/\d+/g, "N").slice(0, 44));
          // Only the form's own sentence about a field, and the label of the
          // field it sits under. A tile summarising a job from the resume
          // also carries an error class, and this log is public.
          const SECTION = /experience|education|address|contact|licen[cs]e|certif|language|skill|question|disab|veteran|diversity|signature|document|attachment|profile|reference|preference|miscellaneous/i;
          const says = Array.from(document.querySelectorAll('[role=alert], [class*="error" i], [class*="invalid" i], [id*="error" i]'))
            .filter((e) => /^(this|the)\b[^.]{0,60}\b(required|invalid|not valid)\b/i.test((e.innerText ?? "").trim()))
            .map((e) => {
              let label = "";
              let section = "";
              for (let n = e, k = 0; n && k < 12; n = n.parentElement, k++) {
                if (!label) {
                  const l = n.querySelector?.("label, legend");
                  if (l) label = (l.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
                }
                if (!section) {
                  const h = n.querySelector?.("h2, h3");
                  const t = h ? (h.innerText ?? "").replace(/\s+/g, " ").trim() : "";
                  const m = t.match(SECTION);
                  if (m) section = m[0].toLowerCase();
                }
              }
              return `${section || "?"}: ${label || "no label"}`;
            });
          // What one marked question is built from: tags, roles and class
          // names only. The row that holds the message, then the rows after
          // it up to the next question.
          let shape = null;
          const first = Array.from(document.querySelectorAll('[role=alert], [class*="error" i], [class*="invalid" i], [id*="error" i]'))
            .find((e) => /^(this|the)\b[^.]{0,60}\b(required|invalid|not valid)\b/i.test((e.innerText ?? "").trim()));
          if (first) {
            const row = first.closest(".input-row") ?? first.parentElement;
            const scope = row?.parentElement ?? row;
            const sk = (c) =>
              `${c.tagName.toLowerCase()}${c.getAttribute("role") ? `[${c.getAttribute("role")}]` : ""}` +
              `${c.getAttribute("type") ? `:${c.getAttribute("type")}` : ""}` +
              `${typeof c.className === "string" && c.className ? `.${c.className.trim().split(/\s+/).slice(0, 2).join(".").slice(0, 40)}` : ""}` +
              `${c.getAttribute("aria-haspopup") ? "^" + c.getAttribute("aria-haspopup") : ""}` +
              `${c.id ? "#" + c.id.replace(/\d+/g, "N").slice(0, 24) : ""}`;
            shape = {
              message: sk(first),
              row: row ? sk(row) : null,
              inScope: Array.from(scope.querySelectorAll("*")).slice(0, 45).map(sk),
            };
          }
          return { ids: Array.from(new Set(ids)).slice(0, 14), says: Array.from(new Set(says)).slice(0, 14), shape };
        })
        .catch(() => null);
      console.log(`    oracle: the form marked ${JSON.stringify({ ids: marked?.ids, says: marked?.says })}`);
      // Oracle's own "Go to Next Issue" walks its list, and each stop is
      // something that can be put right: a question with neither pill
      // chosen (these are not in the page until the submit is refused), or
      // an entry imported from the resume that is missing its employer.
      // Put right what can be, then submit once more.
      const fixed = await oracleRepair(page, form, profile, job, false, lookupSaved);
      if (fixed > 0) {
        const again = await findSubmit(page, form);
        if (again) {
          await press(again);
          let then = "";
          await until(async () => {
            then = await bodyText();
            return landed(then) ? true : null;
          }, 25_000, 1000);
          if (landed(then)) {
            console.log(`    oracle: accepted after ${fixed} repair(s)`);
            return { status: "applied", filled: filled + fixed };
          }
          console.log(`    oracle: still refused after ${fixed} repair(s)`);
          await oracleRepair(page, form, profile, job, true, lookupSaved);
        }
      }
    }

    if (errors.length || invalid > invalidBefore) {
      return {
        status: "needs_help",
        help_reason: "error",
        note: (errors.length
          ? errors.join(" | ")
          : `${invalid - invalidBefore} field(s) rejected by the form`
        ).slice(0, 300),
      };
    }

    // No confirmation, and no error anyone can read. This used to return
    // "applied" with the doubt written into a note nobody reads — so four
    // submissions were counted as sent when sixty days of inbox later showed
    // not one receipt for any of them. An application is claimed only on
    // evidence; without it the honest answer is that nobody knows.
    if (await visibleCaptcha(page)) {
      return {
        status: "needs_help",
        help_reason: "captcha",
        filled,
        note: `Filled ${filled} fields and pressed submit; the portal answered with a captcha challenge.`,
      };
    }

    const stillOnForm = await form
      .$$("input, textarea, select")
      .then((els) => els.length >= 3)
      .catch(() => false);

    // Every ambiguous submit so far has been settled by reading what the page
    // said, and the note never carried it. Headings only: the body text of a
    // careers page is long, and this log is public.
    const said = await form
      .evaluate(() =>
        Array.from(document.querySelectorAll("h1, h2, h3, [role=alert], [role=status]"))
          .map((e) => (e.innerText ?? "").replace(/\s+/g, " ").trim())
          .filter((t) => t && t.length < 120)
          .slice(0, 6),
      )
      .catch(() => []);
    console.log(`    submitted but unconfirmed; page says: ${JSON.stringify(said)}`);

    // Ask the form why it did not go.
    //
    // A complete form, submit clicked, and then nothing at all: no
    // confirmation, no error, no navigation. That is what the BROWSER
    // refusing looks like. The completeness check here excuses a field when a
    // react-select value sits beside it, which is right for knowing whether a
    // person answered it — but checkValidity() does not accept that
    // reasoning, and a required control the browser still considers empty
    // blocks a native submit silently, showing only its own bubble.
    //
    // So let the form name its own invalid controls, and say what was
    // clicked, since "clicked submit" has never been checked against what the
    // element actually was. Three theories about this field cost three rounds;
    // asking cost one.
    // `form` is a FRAME, so evaluate() receives no element — the first version
    // of this took one as its argument and threw on every call, which is why
    // the verdict read null. Reach the form through the frame's document.
    const why = await form
      .evaluate(() => {
        const el = document.querySelector("form") ?? document.body;
        const bad = Array.from(el.querySelectorAll("input, select, textarea"))
          .filter((c) => typeof c.checkValidity === "function" && !c.checkValidity())
          .slice(0, 6)
          .map((c) => ({
            name: c.getAttribute("name") || c.id || c.tagName,
            type: c.getAttribute("type"),
            required: c.required === true || c.getAttribute("aria-required") === "true",
            empty: !String(c.value ?? "").trim(),
            says: String(c.validationMessage ?? "").slice(0, 60),
          }));
        return {
          formValid: typeof el.checkValidity === "function" ? el.checkValidity() : null,
          invalid: bad,
        };
      })
      .catch(() => null);
    console.log(`    the form's own verdict: ${JSON.stringify(why)}`);

    // What the form says now, as presence rather than text.
    //
    // This log is public and the page at this moment holds the name, email
    // and address that were just typed into it. So: does it contain each of
    // the phrases that would explain the outcome, and how much of the form is
    // still standing — never the words themselves.
    const shows = await form
      .evaluate(() => {
        const t = (document.body?.innerText ?? "").toLowerCase();
        const has = (re) => re.test(t);
        return {
          securityCode: has(/security code|verification code|enter the code/),
          resubmit: has(/resubmit/),
          thanks: has(/thank you|thanks for applying|application (received|submitted)/),
          errorWord: has(/\berror\b|went wrong|try again|could not|unable to/),
          requiredWord: has(/required|cannot be blank|please (complete|fill|select)/),
          inputsLeft: document.querySelectorAll("input, select, textarea").length,
          chars: t.length,
        };
      })
      .catch(() => null);
    console.log(`    what the form shows now: ${JSON.stringify(shows)}`);

    const clicked = await submit
      .evaluate((b) => ({
        tag: b.tagName,
        type: b.getAttribute("type"),
        text: (b.innerText ?? b.value ?? "").replace(/\s+/g, " ").trim().slice(0, 40),
        disabled: b.disabled === true || b.getAttribute("aria-disabled") === "true",
        inForm: !!b.closest("form"),
      }))
      .catch(() => null);
    console.log(`    what was clicked: ${JSON.stringify(clicked)}`);

    return {
      status: "needs_help",
      help_reason: "unconfirmed",
      filled,
      note:
        `Clicked submit after filling ${filled} fields, but nothing confirmed it. ` +
        `${stillOnForm ? "The form is still on screen" : "The form is gone"}; ` +
        `${page.url() === urlBefore ? "the page did not navigate" : "the page navigated"}. ` +
        `Open it and finish by hand if it did not go through.`,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Store an answer the model wrote, so the next form reuses it instead of
 * spending another call.
 *
 * Only ever called for answers `generateAnswer` marked cacheable, and written
 * with confirmed=false so it stays clearly machine-written: a human-confirmed
 * answer must always win over this.
 */
async function saveGeneratedAnswer(question, answer, fieldType) {
  const key = String(question).toLowerCase()
    .replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  if (key.length < 4) return;
  await db("answers", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([{
      q_key: key,
      question: String(question).slice(0, 300),
      answer,
      field_type: fieldType ?? "longtext",
      confirmed: false,
      reusable: true,
      generated: true,
    }]),
  }).catch(() => {});
}

async function recordUnknowns(unknowns) {
  // Say what is being handed to the panel.
  //
  // Every employer adds its own questions — "please select all the languages
  // you speak fluently" — and no profile field will ever cover them all. The
  // answers page is how that long tail closes: asked once, reused on every
  // application after. But a question that never reaches the table is a
  // question nobody can answer, and there has been no way to tell the two
  // apart from a run log.
  if (unknowns.length) {
    console.log(
      `    asking the panel about ${unknowns.length}: ` +
        JSON.stringify(unknowns.slice(0, 5).map((u) => String(u.question).slice(0, 44))),
    );
  }
  for (const u of unknowns.slice(0, 12)) {
    const key = String(u.question).toLowerCase()
      .replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
    if (key.length < 4) continue;

    const row = {
      q_key: key,
      question: String(u.question).slice(0, 300),
      answer: "",
      field_type: u.type ?? "text",
      confirmed: false,
    };

    // The choices the employer offered, so the panel can show them as
    // buttons instead of a text box. Typing an answer into a text box is
    // guessing at a spelling: this questionnaire offers "Bachelor's Degree"
    // with a curly apostrophe, and a typed straight one would miss in
    // silence, leaving someone sure they had answered it.
    const options = (u.options ?? []).filter(Boolean).slice(0, 40);

    const post = (body) =>
      db("answers", {
        method: "POST",
        headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
        body: JSON.stringify([body]),
      });

    if (options.length) {
      // Until the column exists the insert fails as a whole, which would
      // lose the question entirely — so fall back rather than drop it.
      const ok = await post({ ...row, options }).then(() => true).catch(() => false);
      if (ok) continue;
    }
    await post(row).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
const main = async () => {
  const [profileRow] = await db("profile?id=eq.1&select=*");
  // From here on nothing this run prints can carry the owner's name, email,
  // phone, street, or the employers and schools on their resume.
  try {
    guardLogs(profileRow, structureResume(profileRow?.resume_text, profileRow ?? {}));
  } catch {
    guardLogs(profileRow);
  }
  if (profileRow) console.log(`profile shape: ${JSON.stringify(profileShape(profileRow))}`);
  if (!profileRow?.email || !profileRow?.full_name) {
    console.error("Profile incomplete — set your name and email in the panel.");
    process.exit(1);
  }

  // --- is unattended applying switched on? ---------------------------------
  // A scheduled run sets RESPECT_AUTOPILOT and carries no dry_run of its own.
  // It submits only if the panel says so. Four real applications once went
  // out because a YAML default said false and nobody had been asked.
  if (process.env.RESPECT_AUTOPILOT === "true") {
    if (profileRow.autopilot !== true) {
      // The checkbox is on the DASHBOARD, under "autopilot", and reads
      // "apply automatically every 3 hours". This said Settings, which is
      // where it is not, and sent someone looking for it twice.
      console.log(
        "Autopilot is off — nothing will be applied to. The switch is on the " +
          "dashboard, under autopilot: \"apply automatically every 3 hours\".",
      );
      process.exit(0);
    }
    DRY_RUN = false;
    console.log("Autopilot is on.");
  }

  // --- how many may still go out today -------------------------------------
  // daily_cap existed and nothing read it. MAX_JOBS is per RUN, so eight
  // scheduled runs of 25 is 200 a day whatever the cap says — a cap nobody
  // enforces is worse than none, because it reads like a safety net.
  const [cfgRow] = (await db("search_config?id=eq.1&select=daily_cap,radius_miles")) ?? [];
  // The commuting radius, enforced here as well as in discovery.
  //
  // An application went to Carvana for "Operations Manager - Buffalo (2nd
  // shift)", about 350 miles from a search set to 25. Discovery measures
  // distance, but when a lookup has not finished it keeps the posting to be
  // measured on a later run — and nothing stopped it being scored, queued
  // and applied to in the meantime. This is the last place a job passes
  // before it becomes a real application, so the radius is checked here:
  // remote, or measured and inside it. A posting nobody has measured yet is
  // left alone until it has been.
  // The owner's rule, built in rather than configurable: only postings from
  // the last two weeks are applied to.
  const FRESH_DAYS = 14;
  const FRESH_SINCE = new Date(Date.now() - FRESH_DAYS * 86_400_000).toISOString().slice(0, 19) + "Z";

  // Applications already sent to each employer today.
  const PER_EMPLOYER_DAILY = Math.max(1, Number(process.env.PER_EMPLOYER_DAILY ?? 3));
  const SENT_TO = new Map();
  {
    // Whole seconds. Inside an or=(…) the fraction's full stop reads as the
    // separator between a column, an operator and a value, the request was
    // refused, and — the refusal being swallowed — every employer started
    // each run at zero: Live Nation was sent four in a day under a limit of
    // three.
    const since = new Date(Date.now() - 24 * 3600_000).toISOString().slice(0, 19) + "Z";
    // By when it was sent, whatever it is filed as now: an application later
    // re-filed as unconfirmed still reached that employer today.
    let sent = await db(
      `jobs?or=(applied_at.gte.%22${since}%22,and(help_reason.eq.unconfirmed,updated_at.gte.%22${since}%22))&select=company&limit=2000`,
    ).catch((e) => {
      console.log(`could not read what was sent in the last day: ${String(e?.message ?? e).slice(0, 120)}`);
      return null;
    });
    // The plain question, if the fuller one is refused: a limit that counts
    // too little is still a limit, and one that counts nothing is not.
    sent ??= await db(`jobs?applied_at=gte.${encodeURIComponent(since)}&select=company&limit=2000`).catch(() => null);
    sent ??= [];
    for (const r of sent) {
      const k = String(r.company ?? "").toLowerCase().trim();
      SENT_TO.set(k, (SENT_TO.get(k) ?? 0) + 1);
    }
  }
  // A run may be given its own radius for a test; otherwise the panel's.
  {
    const busy = [...SENT_TO.entries()].filter(([, n]) => n >= PER_EMPLOYER_DAILY).map(([k, n]) => `${k}:${n}`);
    // How many, never which: the log is read by people who are not the owner.
    console.log(`employers at the ${PER_EMPLOYER_DAILY}-a-day limit: ${busy.length}`);
  }
  const RADIUS = Number(process.env.RADIUS_MILES || 0) || Number(cfgRow?.radius_miles ?? 0);
  const withinReach = (j) =>
    !(RADIUS > 0) || j?.remote === true || (j?.distance_miles != null && Number(j.distance_miles) <= RADIUS);
  const dailyCap = Number(cfgRow?.daily_cap ?? 50);
  let sentToday = Number(await rpc("applications_today")) || 0;
  const remainingToday = Math.max(0, dailyCap - sentToday);

  if (!DRY_RUN && remainingToday === 0) {
    console.log(`Daily cap reached: ${sentToday} of ${dailyCap} already sent today.`);
    process.exit(0);
  }
  if (!DRY_RUN) {
    console.log(`${sentToday} of ${dailyCap} sent today; up to ${remainingToday} more.`);
  }

  const p = { ...profileRow };
  const names = (p.full_name || "").trim().split(/\s+/);
  p.first_name = names[0] || "";
  p.last_name = names.length > 1 ? names[names.length - 1] : "";

  const answers = await db("answers?confirmed=eq.true&select=q_key,answer") ?? [];

  // Adopt the row the panel opened when it dispatched this run.
  //
  // The panel inserts a "running" row the moment the button is pressed, and
  // this used to insert a SECOND one and close that instead — so every press
  // left a row reading "running" on the dashboard forever, next to a "done"
  // row it had not made. That is precisely what "I pressed apply and nothing
  // happened" looks like, while the run was in fact working.
  const open = (await db(
    "runs?kind=eq.apply&status=eq.running&order=started_at.desc&limit=1&select=id,started_at",
  ).catch(() => null)) ?? [];
  const waiting = open[0];
  const freshEnough =
    waiting && Date.now() - new Date(waiting.started_at ?? 0).getTime() < 20 * 60_000;

  const run = freshEnough
    ? waiting
    : (
        await db("runs", {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify([{ kind: "apply" }]),
        })
      )[0];
  if (freshEnough) console.log("picked up the run the panel started");

  // Say how far along it is, every job.
  //
  // Twenty-five jobs is forty minutes of work, and the dashboard showed one
  // unchanging line for all of it. A run that cannot say "4 of 25" is
  // indistinguishable from a run that has died.
  const progress = async (done, total, tally) =>
    await db(`runs?id=eq.${run.id}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        processed: tally.applied,
        message:
          `${done} of ${total} — applied ${tally.applied}, ` +
          `need you ${tally.needs_help ?? 0}, skipped ${tally.skipped ?? 0}`,
      }),
    }).catch(() => {});

  await heartbeat({ online: true, state: "applying" });

  const browser = await chromium.launch({
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
  });

  const tally = { applied: 0, needs_help: 0, skipped: 0, errors: 0 };
  // One line per job, printed together at the very end. Four workers
  // interleave several hundred lines, and reading how a run went meant
  // scrolling back through all of them for the four that matter.
  const recap = [];
  // Declared out here because the finally block reports it.
  let ranOut = false;

  try {
    await requeueStaleParked();

    // What is actually in the queue, by portal and by status.
    //
    // A Greenhouse-only run found none to claim after forty tries, although
    // discovery had just inserted 159 of them. Counting beats guessing at
    // where they went.
    const census = async (status) => {
      const rows =
        (await db(`jobs?status=eq.${status}&select=ats&limit=2000`).catch(() => null)) ?? [];
      const by = {};
      for (const r of rows) by[r.ats ?? "none"] = (by[r.ats ?? "none"] ?? 0) + 1;
      return { total: rows.length, by };
    };
    // How much of the queue is actually within reach.
    if (RADIUS > 0) {
      const rows =
        (await db("jobs?status=eq.queued&select=ats,remote,distance_miles,posted_at&limit=3000").catch(() => null)) ?? [];
      const reach = {};
      const age = { fresh: 0, older: 0, undated: 0 };
      for (const r of rows) {
        const near = r.remote === true || (r.distance_miles != null && r.distance_miles <= RADIUS);
        if (near) {
          if (!r.posted_at) age.undated++;
          else if (r.posted_at >= FRESH_SINCE) age.fresh++;
          else age.older++;
        }
        const a = (reach[r.ats ?? "none"] ??= { within: 0, unmeasured: 0, beyond: 0 });
        if (r.remote === true || (r.distance_miles != null && r.distance_miles <= RADIUS)) a.within++;
        else if (r.distance_miles == null) a.unmeasured++;
        else a.beyond++;
      }
      console.log(`queue within ${RADIUS} mi: ${JSON.stringify(reach)}`);
      console.log(`of those in reach, posted within ${FRESH_DAYS} days: ${JSON.stringify(age)}`);
    }
    for (const st of ["queued", "new", "review", "needs_help", "skipped"]) {
      const c = await census(st);
      if (c.total) console.log(`queue ${st}: ${c.total} ${JSON.stringify(c.by)}`);
    }

    // Why the skipped ones were skipped.
    //
    // 575 Greenhouse postings sit in "skipped" against 313 Workday in the
    // whole queue. If the reason is distance that is the filter working; if
    // it is anything else it is hundreds of applications being thrown away
    // every run, and the two need opposite responses.
    const skipped =
      (await db("jobs?status=eq.skipped&select=ats,skip_reason&limit=2000").catch(() => null)) ??
      [];
    const reasons = {};
    for (const r of skipped) {
      const why = String(r.skip_reason ?? "none").replace(/:.*$/, "").trim().slice(0, 40);
      const k = `${r.ats ?? "none"} / ${why}`;
      reasons[k] = (reasons[k] ?? 0) + 1;
    }
    const topSkips = Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (topSkips.length) console.log(`skipped because: ${JSON.stringify(Object.fromEntries(topSkips))}`);

    // Why discovery drops what it drops.
    //
    // 2687 of 3029 postings are filtered out every run and the reason for
    // each was recorded and then never shown anywhere — so whether the
    // radius is too tight, remote is excluded, or the titles are too narrow
    // has been unanswerable. It is in the last discover run's detail.
    const lastFind =
      (await db("runs?kind=eq.discover&order=started_at.desc&limit=1&select=detail").catch(
        () => null,
      )) ?? [];
    const why = lastFind[0]?.detail?.filtered_by;
    if (why) {
      const top = Object.entries(why)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8);
      console.log(`discovery filtered: ${JSON.stringify(Object.fromEntries(top))}`);
    }

    const limit = DRY_RUN ? MAX_JOBS : Math.min(MAX_JOBS, remainingToday);

    // Several at once.
    //
    // A measured run spent 125 seconds per job and did them strictly one
    // after another, which is the real ceiling on volume: the time goes on
    // page loads and portals thinking, not on anything this process is
    // doing, so most of it is spent waiting. claim_next_job already hands
    // each worker a different job — it locks the row and skips locked ones —
    // so there is nothing to coordinate.
    //
    // Each worker gets its own browser context: separate cookies, so two
    // workers signing in to the same portal do not fight over one session.
    let taken = 0;
    let done = 0;

    // Stop before the runner does.
    //
    // GitHub killed a 25-job run at its 50-minute cap with twelve done, and
    // a killed run runs no cleanup: the dashboard read "running" forever and
    // the jobs it had claimed stayed claimed. Leaving on our own terms means
    // the run closes, the tally is honest, and whatever was not reached goes
    // back to the queue rather than counting as an attempt.
    const budgetMs = Math.max(1, Number(process.env.RUN_BUDGET_MIN ?? 300)) * 60_000;
    const deadline = Date.now() + budgetMs;

    const BUSY_COMPANIES = new Set();
    const companyOf = (j) => String(j?.company ?? j?.id ?? "").toLowerCase().trim();

    async function worker(slot) {
      const ctx = await browser.newContext(CONTEXT_OPTIONS);
      try {
        while (true) {
          if (taken >= limit) break;
          // A job takes minutes; starting one with less than that left only
          // guarantees it is interrupted.
          if (Date.now() > deadline - 4 * 60_000) {
            if (!ranOut) {
              ranOut = true;
              console.log("time budget reached — finishing the jobs in flight and stopping.");
            }
            break;
          }
          // Ask the database how many have gone out, not this process.
          //
          // The count used to be read once at the start and added to locally,
          // which is right for one run and wrong for two: a Greenhouse lane
          // and a Workday lane side by side would each believe the whole
          // remainder was theirs and together send twice the cap. Read before
          // every claim, the worst overshoot is the handful of jobs already
          // in flight when the line is crossed.
          if (!DRY_RUN) {
            const fresh = Number(await rpc("applications_today").catch(() => null));
            if (Number.isFinite(fresh)) sentToday = Math.max(sentToday, fresh);
          }
          if (!DRY_RUN && sentToday >= dailyCap) {
            console.log(`Daily cap reached: ${sentToday} of ${dailyCap}.`);
            break;
          }
          const mine = ++taken;

          let job = null;
          // ATS_ONLY exists to put a run against one kind of portal.
          //
          // The queue holds hundreds of Greenhouse and Lever postings that no
          // run has ever reached, because Workday outnumbers them four to one
          // and every claim came back Workday. Testing the plain-HTML portals
          // needed a way to ask for them rather than waiting for chance.
          const want = String(process.env.ATS_ONLY ?? "").toLowerCase().trim();

          // With a portal asked for, claim that portal's job directly.
          //
          // claim_next_job hands out the highest-scoring queued job, and 430
          // Workday postings rank above the 204 Greenhouse ones — so sixty
          // claims never reached a single Greenhouse job and the run
          // reported there were none. Claiming by id, conditional on the row
          // still being queued, lets a run test one portal without waiting
          // for every job above it to be applied to first.
          if (want) {
            const rows =
              (await db(
                // "none": the jobs with no portal named — an employer's own
                // website — which the general form-filler takes.
                `jobs?status=eq.queued&${want === "none" ? "ats=is.null" : `ats=eq.${encodeURIComponent(want)}`}` +
                  (RADIUS > 0 ? `&and=(or(remote.is.true,distance_miles.lte.${RADIUS}))` : "") +
                  // Fresh postings only, and not a setting: posted inside the
                  // last fourteen days. A posting with no date cannot be shown
                  // to be fresh and is left out with the rest.
                  (want === "workday"
                    ? `&or=(posted_at.gte.${FRESH_SINCE},posted_at.is.null)`
                    : `&posted_at=gte.${encodeURIComponent(FRESH_SINCE)}`) +
                  `&attempts=lt.3&order=score.desc.nullslast&limit=30&select=*`,
              ).catch(() => null)) ?? [];
            for (const row of rows) {
              // One application per employer at a time.
              //
              // Two Block jobs ran side by side and each was emailed a code
              // under the identical subject, "Security code for your
              // application to Block". Nothing in either message says which
              // application it is for. Both went through, which was order of
              // arrival and not design. Taking a different employer's job
              // while one is in flight costs nothing and removes the question.
              if (BUSY_COMPANIES.has(companyOf(row))) continue;
              // And only so many to one employer in a day. Eight went to
              // Carvana this afternoon; a recruiter who sees one name on
              // eight requisitions reads it as noise, not interest.
              if ((SENT_TO.get(companyOf(row)) ?? 0) >= PER_EMPLOYER_DAILY) continue;
              // The status filter is the lock: whichever worker patches the
              // row first gets it, and the others see nothing come back.
              const won =
                (await db(`jobs?id=eq.${row.id}&status=eq.queued`, {
                  method: "PATCH",
                  headers: { Prefer: "return=representation" },
                  body: JSON.stringify({
                    status: "applying",
                    attempts: (row.attempts ?? 0) + 1,
                    updated_at: new Date().toISOString(),
                  }),
                }).catch(() => null)) ?? [];
              if (won.length) { job = { ...row, attempts: (row.attempts ?? 0) + 1 }; break; }
            }
            if (!job) console.log(`No queued ${want} jobs left.`);
          }

          // Hold the ones we pass over until a match is found, then give
          // them all back at once.
          //
          // Releasing each immediately put it straight back at the front of
          // the queue — it is still the highest-scoring job there — so the
          // next claim returned the same one again. A hundred and sixty
          // claims cycled over the same few Workday postings and reported
          // that no Greenhouse jobs existed, while 204 of them sat queued.
          const parked = [];
          for (let look = 0; !job && look < (want ? 0 : 1); look++) {
            const claimed = await rpc("claim_next_job");
            const got = Array.isArray(claimed) ? claimed[0] : claimed;
            if (!got) break;
            if (!want || String(got.ats ?? "").toLowerCase() === want) { job = got; break; }
            parked.push(got);
          }
          for (const p2 of parked) {
            // Unspent: a perfectly good posting, simply not the one this run
            // is testing.
            await patchJob(p2.id, {
              status: "queued",
              attempts: Math.max(0, (p2.attempts ?? 1) - 1),
            }).catch(() => {});
          }
          if (want && parked.length) {
            console.log(`    passed over ${parked.length} job(s) that were not ${want}`);
          }
          if (!job) { if (!want) console.log("Queue empty."); break; }

          // The other way in — the queue's own claim — does not carry the
          // distance, so look it up before going any further.
          if (RADIUS > 0 && job.distance_miles === undefined) {
            const [where] = (await db(`jobs?id=eq.${job.id}&select=remote,distance_miles`).catch(() => null)) ?? [];
            if (where) Object.assign(job, where);
          }
          if (!withinReach(job)) {
            const why =
              job.distance_miles == null
                ? "its distance from home has not been measured yet"
                : `it is ${job.distance_miles} miles away, outside the ${RADIUS}-mile radius`;
            hideJob(job);
            console.log(`    not applying to ${job.title} @ ${job.company ?? "?"}: ${why}`);
            await patchJob(job.id, {
              status: job.distance_miles == null ? "needs_help" : "skipped",
              help_reason: job.distance_miles == null ? "location" : null,
              skip_reason: job.distance_miles == null ? null : `over ${RADIUS} mi`,
              last_error: `Not applied: ${why}.`,
            }).catch(() => {});
            taken--;
            continue;
          }

          BUSY_COMPANIES.add(companyOf(job));
          try {
            await TAG.run(mine, async () => {
              // Known to the log's net before a word about it is printed.
              hideJob(job);
              console.log(`[${mine}] ${job.title} @ ${job.company ?? "?"}`);
              await heartbeat({ online: true, state: "applying", current_job: job.id });
              await runOne(ctx, job, mine);
            });
          } finally {
            BUSY_COMPANIES.delete(companyOf(job));
          }

          await new Promise((r) => setTimeout(r, 1200 + Math.random() * 1800));
        }
      } finally {
        await ctx.close().catch(() => {});
      }
    }

    // No single application may hold a worker forever.
    //
    // One Crown Holdings posting took 438 seconds while three others finished
    // in 114 — and a worker stuck on a form that will not complete is a
    // worker not applying to anything. Six minutes is roughly three times
    // the longest application that has ever actually succeeded.
    const JOB_BUDGET_MS = Math.max(60, Number(process.env.JOB_BUDGET_SEC ?? 420)) * 1000;

    async function runOne(ctx, job, mine) {
      let outcome;
      try {
        outcome = await Promise.race([
          applyToJob(ctx, job, p, answers),
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  status: "needs_help",
                  help_reason: "error",
                  note:
                    `Gave up after ${Math.round(JOB_BUDGET_MS / 1000)}s on this form. ` +
                    `It is still being filled when every other application has finished, ` +
                    `which usually means a widget that never settles.`,
                }),
              JOB_BUDGET_MS,
            ),
          ),
        ]);
      } catch (e) {
        outcome = { status: "needs_help", help_reason: "error",
                    note: String(e?.message ?? e).slice(0, 300) };
        tally.errors++;
      }

      // A dry run must leave the queue as it found it. It was parking every
      // job it looked at as needs_help/"dry_run" and spending one of its
      // three attempts, so rehearsing the applier quietly emptied the queue
      // into the backlog — the opposite of a rehearsal.
      const patch = DRY_RUN
        ? { status: "queued", attempts: 0, help_reason: null }
        : { status: outcome.status };
      if (outcome.status === "applied") {
        patch.applied_at = new Date().toISOString();
        patch.confirm_state = "pending";
      }
      if (!DRY_RUN && outcome.help_reason) patch.help_reason = outcome.help_reason;
      if (!DRY_RUN && outcome.skip_reason) patch.skip_reason = outcome.skip_reason;
      // The note is kept either way: on a dry run it is the only record of
      // what the applier saw on that form.
      if (outcome.note) patch.last_error = outcome.note;
      await patchJob(job.id, patch);

      // Pressed Submit and saw no confirmation: the employer may well have it.
      if (outcome.status !== "applied" && outcome.help_reason === "unconfirmed") {
        const k = String(job.company ?? job.id ?? "").toLowerCase().trim();
        SENT_TO.set(k, (SENT_TO.get(k) ?? 0) + 1);
      }
      if (outcome.status === "applied") {
        sentToday++;
        const k = String(job.company ?? job.id ?? "").toLowerCase().trim();
        SENT_TO.set(k, (SENT_TO.get(k) ?? 0) + 1);
      }
      tally[outcome.status] = (tally[outcome.status] ?? 0) + 1;
      console.log(`    -> ${outcome.status}${outcome.note ? ": " + outcome.note : ""}`);
      recap.push(
        `${outcome.status}${outcome.help_reason ? "/" + outcome.help_reason : ""} | ` +
          `${String(job.company ?? "?").slice(0, 22)} | ${String(outcome.note ?? "").split("\n")[0].slice(0, 170)}` +
          // For an application that went out, the one line that says what
          // it told the employer about where it came from; for one that did
          // not, everything kept.
          (EVIDENCE.get(TAG.getStore()) ?? [])
            .filter((e) => outcome.status !== "applied" || /source trace/.test(e))
            .map((e) => `\n      · ${e}`)
            .join(""),
      );
      EVIDENCE.delete(TAG.getStore());

      await progress(++done, limit, tally);
    }

    const workers = Math.max(1, Math.min(6, Number(process.env.WORKERS ?? 4)));
    console.log(`running ${workers} workers over up to ${limit} job(s)`);
    await Promise.all(Array.from({ length: workers }, (_, n) => worker(n)));
  } finally {
    await browser.close().catch(() => {});
    // The cloud agent runs in bursts rather than continuously, so it reports
    // offline on exit. The panel's "last run" line is the honest signal.
    await heartbeat({ online: false, state: "idle", current_job: null });
    // Read the mailbox now, while the acknowledgements are arriving.
    //
    // Syncing Gmail was something a person had to press, so the receipts for
    // an unattended run sat unread until someone happened to open the panel.
    // The applier is the one thing that knows a submission just went out,
    // and an employer's acknowledgement lands within minutes of it.
    if (tally.applied > 0) {
      const base = (process.env.APP_URL || "https://applynow.lol").replace(/\/+$/, "");
      const key = process.env.ENGINE_API_KEY;
      if (key) {
        await new Promise((r) => setTimeout(r, 20_000)); // let the receipts arrive
        const said = await fetch(`${base}/api/public/email/sync`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-engine-key": key },
          // Sixty messages over a day timed out at a full minute and read
          // nothing. What matters here arrived in the last hour or two.
          body: JSON.stringify({ query: "in:inbox newer_than:3h", max: 25 }),
          signal: AbortSignal.timeout(60_000),
        })
          .then((r) => r.json())
          .catch((e) => ({ error: String(e?.message ?? e).slice(0, 90) }));
        console.log(
          `inbox: ${said?.error ? `sync failed — ${said.error}` : `${said?.stored ?? 0} new message(s)`}`,
        );
      }
    }

    const message =
      `applied ${tally.applied}, need you ${tally.needs_help ?? 0}, skipped ${tally.skipped ?? 0}` +
      (ranOut ? " (stopped on time budget)" : "");
    await db(`runs?id=eq.${run.id}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        status: "done", processed: tally.applied, errors: tally.errors,
        detail: tally, message, ended_at: new Date().toISOString(),
      }),
    }).catch(() => {});
    if (recap.length) console.log("recap:\n" + recap.map((r) => "  " + r).join("\n"));

    // Where things stand, at the end where it is read: what is still waiting
    // within reach and fresh, by portal and by employer, and what has gone
    // out in the last day. Volume is decided by these numbers, and they were
    // only ever printed a thousand lines up.
    try {
      const waiting =
        (await db("jobs?status=eq.queued&select=ats,company,remote,distance_miles,posted_at,attempts&limit=4000").catch(() => null)) ?? [];
      const ready = {};
      const firms = {};
      let spent = 0;
      for (const r of waiting) {
        const near = RADIUS > 0 ? r.remote === true || (r.distance_miles != null && r.distance_miles <= RADIUS) : true;
        if (!near) continue;
        const ats = r.ats ?? "none";
        const fresh = r.posted_at ? r.posted_at >= FRESH_SINCE : ats === "workday";
        if (!fresh) continue;
        if ((r.attempts ?? 0) >= 3) { spent++; continue; }
        ready[ats] = (ready[ats] ?? 0) + 1;
        const k = `${ats}:${String(r.company ?? "?").slice(0, 18)}`;
        firms[k] = (firms[k] ?? 0) + 1;
      }
      const top = Object.entries(firms).sort((x, y) => y[1] - x[1]).slice(0, 24).map(([k, n]) => `${k} ${n}`);
      const since = new Date(Date.now() - 24 * 3600_000).toISOString();
      const sent = (await db(`jobs?applied_at=gte.${encodeURIComponent(since)}&select=ats&limit=2000`).catch(() => null)) ?? [];
      const sentBy = {};
      for (const r of sent) sentBy[r.ats ?? "none"] = (sentBy[r.ats ?? "none"] ?? 0) + 1;
      // What is held back, and by what: scored below the auto-apply line,
      // or not yet scored at all.
      const held =
        (await db("jobs?status=in.(review,new)&select=status,ats,remote,distance_miles,posted_at&limit=4000").catch(() => null)) ?? [];
      const waitingOn = {};
      for (const r of held) {
        const near = RADIUS > 0 ? r.remote === true || (r.distance_miles != null && r.distance_miles <= RADIUS) : true;
        const fresh = r.posted_at ? r.posted_at >= FRESH_SINCE : (r.ats ?? "") === "workday";
        const k = `${r.status}${near && fresh ? " in reach and fresh" : near ? " in reach, older" : " out of reach or unmeasured"}`;
        waitingOn[k] = (waitingOn[k] ?? 0) + 1;
      }
      console.log(`standing: ready to apply within ${RADIUS} mi and fresh ${JSON.stringify(ready)}; out of attempts ${spent}`);
      console.log(`standing: not queued ${JSON.stringify(waitingOn)}`);
      console.log(`standing: ${Object.keys(firms).length} employers waiting; the largest holds ${top.length ? Math.max(...Object.values(firms)) : 0} postings`);
      console.log(`standing: sent in the last 24h ${sent.length} ${JSON.stringify(sentBy)}; today's cap ${dailyCap}`);
      console.log(`standing: resumes this run — ${TAILORED.already} already written for their posting, ${TAILORED.written} written now, ${TAILORED.arranged} arranged for their posting without the model, ${TAILORED.general} sent the general resume`);
      console.log(
        `standing: per employer in the last 24h — ${SENT_TO.size} employers, counts ${JSON.stringify(
          [...SENT_TO.values()].sort((x, y) => y - x).slice(0, 14),
        )} (limit ${PER_EMPLOYER_DAILY})`,
      );
    } catch (e) {
      console.log(`standing: could not be read — ${String(e?.message ?? e).slice(0, 80)}`);
    }
    console.log(message);
  }

  // Leave deliberately.
  //
  // Every run sat for five to seven minutes after its last line before the
  // step ended — 17:47:52 to 17:53:18 on one, 17:38:44 to 17:45:41 on the
  // next. The work was done and written; node simply would not exit, because
  // a job abandoned by the JOB_BUDGET race keeps running. Promise.race does
  // not cancel the loser, so a timed-out job carries on through its own
  // retries and waits against a closed browser, holding the event loop with
  // nothing left to accomplish.
  //
  // Everything that matters is awaited above: the run row, the heartbeat, the
  // mailbox read. So the honest end of this script is here, and the varying
  // length of those tails is what says the cause is abandoned work rather
  // than a fixed timeout somewhere. Eight scheduled runs a day were each
  // paying six idle minutes for it.
  process.exit(0);
};

// The self-test imports this file to run applyToJob against fixture pages,
// and must not start a real run by doing so.
if (process.env.APPLY_SELFTEST !== "1") main();

export { applyToJob, resumeHtml, renderResumePdf, ensureTailored, readPosting };
