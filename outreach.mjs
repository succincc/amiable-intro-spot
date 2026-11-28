// A short email to the employer after an application has gone in.
//
// For each recent application: find the contact address the employer
// publishes on its own website, write a note for that role from the resume
// that was sent, attach that resume, and hand it to the panel to send from
// the owner's Gmail.
//
// What it will not do:
//   - guess an address. Only one printed on the employer's own site is used,
//     and only at the employer's own domain.
//   - go looking for people. A named person is written to only when the
//     employer itself puts their address forward for hiring: in the posting
//     ("questions to …"), or on its own site beside the words recruiter,
//     talent acquisition, hiring or human resources. Then the note goes to
//     them, with the careers address copied if there is one. Otherwise it
//     goes to a role address (careers@, hr@, info@, help@) and greets nobody
//     by name. No address is built from a name, none is taken from LinkedIn
//     or a contact database, and it is never more than two recipients.
//   - say anything the resume does not. The note is checked after it is
//     written and replaced with a plain one if it fails the check.
//   - send without the switch. The panel refuses unless follow-up emails are
//     turned on in settings, the employer has not been written to in thirty
//     days, and today's count is under its limit. This file asks; the panel
//     decides.
//
// MODE:
//   report  — look and say what would happen. Nothing is written or sent.
//   preview — send each note to the owner's OWN mailbox, exactly as the
//             employer would receive it. Nothing reaches an employer.
//   send    — ask the panel to send to the employer.
//
// Free: a public-repo runner, public pages, the free Gemini tier.

import { allRows } from "./pages.mjs";
import { useOwnKey } from "./ownkey.mjs";
import { geminiForTitles } from "./answers.mjs";
import { alignToPosting } from "./ats.mjs";
import { tailorResume, rolesText, standardResume, arrangedResume, structureResume } from "./tailor.mjs";
import { guardLogs, hideJob } from "./quiet.mjs";
import { isBlocked } from "./blocked.mjs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
// Whose round this is, when the runner is doing somebody else's: see forusers.mjs.
const ACT_AS = process.env.AP_ACT_AS ? { "x-act-as": process.env.AP_ACT_AS } : {};
const AP_EMAIL = process.env.APPLYPILOT_EMAIL;
const AP_PASSWORD = process.env.APPLYPILOT_PASSWORD;
const APP_URL = (process.env.APP_URL || "https://applynow.lol").replace(/\/+$/, "");
const ENGINE_KEY = process.env.ENGINE_API_KEY;
const MODE = ["report", "preview", "send"].includes(process.env.MODE) ? process.env.MODE : "report";
const MAX = Number(process.env.MAX || 12);
const DAYS = Number(process.env.DAYS || 4);

let ACCESS = "";
let REFRESH = "";
let EXPIRES = 0;
async function auth(body, grant) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=${grant}`, {
    method: "POST",
    headers: { apikey: ANON_KEY, ...ACT_AS, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Sign-in failed ${res.status}`);
  const j = await res.json();
  ACCESS = j.access_token;
  REFRESH = j.refresh_token;
  EXPIRES = Date.now() + (j.expires_in - 120) * 1000;
}
async function db(path, init = {}) {
  if (Date.now() > EXPIRES) await auth({ refresh_token: REFRESH }, "refresh_token");
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: ANON_KEY, ...ACT_AS,
      Authorization: `Bearer ${ACCESS}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`DB ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
async function getPage(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    redirect: "follow",
    headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (!/html|text/i.test(res.headers.get("content-type") ?? "")) throw new Error("not a page");
  return { text: (await res.text()).slice(0, 1_500_000), final: res.url };
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

export const flat = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/\b(inc|llc|ltd|corp|corporation|co|company|group|holdings|plc|lp|the)\b\.?/g, " ")
    .replace(/[^a-z0-9]+/g, "");

// Careers portals are not the employer's website: nothing published there is
// the employer's contact address.
const PORTAL_HOST =
  /greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|myworkdaysite\.com|workday\.com|oraclecloud\.com|icims\.com|smartrecruiters\.com|workable\.com|successfactors|taleo\.net|jobvite\.com|eightfold\.ai|phenom|avature\.net|bamboohr\.com|paylocity\.com|adp\.com|ultipro\.com|breezy\.hr|recruitee\.com|teamtailor\.com|dayforcehcm\.com|linkedin\.com|indeed\.com/i;

/** "careers.acme.com" and "www.acme.co.uk" both belong to acme. */
export function site(host) {
  const parts = String(host ?? "").toLowerCase().replace(/^www\./, "").split(".");
  if (parts.length <= 2) return parts.join(".");
  const two = parts.slice(-2).join(".");
  return /^(co|com|org|net|ac|gov)\.[a-z]{2}$/.test(two) ? parts.slice(-3).join(".") : two;
}

// Never, whoever publishes them.
const NEVER =
  /^(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|abuse|security|privacy|legal|dmca|compliance|ethics|press|media|pr|investors?|ir|billing|invoices?|accounts?(payable|receivable)?|sales|orders?|webmaster|unsubscribe|accessibility|accommodations?)$/;
const TIERS = [
  // The people who read applications.
  /^(careers?|recruit(ing|ment|ers?)?|talent(acquisition|team)?|jobs?|hiring|hr|humanresources|people(ops|team)?|staffing|employment|joinus|workwithus|apply|resumes?|cv)$/,
  // The front door.
  /^(info|hello|hi|contact(us)?|inquir(y|ies)|enquir(y|ies)|general|office|team|admin|mail|connect|ask)$/,
  // The owner asked for these to count too; they come last.
  /^(help|support|customer(service|care|support)|care|service)$/,
];

/**
 * The role addresses on a page that belong to this employer's own domain,
 * best first. A named person's address is not returned.
 */
export function contactsIn(html, domain) {
  const text = String(html ?? "")
    .replace(/&#64;|&#x40;|%40/gi, "@")
    .replace(/&#46;|&#x2e;/gi, ".");
  const found = new Map();
  for (const m of text.matchAll(/[a-z0-9][a-z0-9._%+-]{0,40}@[a-z0-9][a-z0-9.-]{1,60}\.[a-z]{2,10}/gi)) {
    const addr = m[0].toLowerCase().replace(/\.+$/, "");
    const [local, host] = addr.split("@");
    if (site(host) !== domain) continue;
    if (/\.(png|jpe?g|gif|svg|webp|css|js)$/.test(host)) continue;
    const key = local.replace(/[._-]/g, "");
    if (NEVER.test(key)) continue;
    const tier = TIERS.findIndex((re) => re.test(key));
    if (tier < 0) continue; // a person, or something unrecognised
    if (!found.has(addr) || found.get(addr) > tier) found.set(addr, tier);
  }
  return [...found.entries()].sort((a, b) => a[1] - b[1]).map(([addr, tier]) => ({ addr, tier }));
}

const HIRING_WORDS = /recruit|talent acquisition|talent partner|hiring (manager|team|contact)|human resources|\bhr\b|people (team|operations|partner)|staffing|questions? (about|regarding) (this|the) (role|position|job|opening)|to apply|send (your )?(resume|cv)/i;

/**
 * A named person the employer puts forward for hiring: an address at the
 * employer's own domain that is not a role address, printed within a couple
 * of lines of words about recruiting. Returns the first such, or null.
 */
export function hiringPersonIn(html, domain) {
  const text = String(html ?? "")
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/&#64;|&#x40;|%40/gi, "@")
    .replace(/&#46;|&#x2e;/gi, ".")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
  for (const m of text.matchAll(/[a-z0-9][a-z0-9._%+-]{0,40}@[a-z0-9][a-z0-9.-]{1,60}\.[a-z]{2,10}/gi)) {
    const addr = m[0].toLowerCase().replace(/\.+$/, "");
    const [local, host] = addr.split("@");
    if (site(host) !== domain) continue;
    const key = local.replace(/[._-]/g, "");
    if (NEVER.test(key) || TIERS.some((re) => re.test(key))) continue;
    const around = text.slice(Math.max(0, m.index - 260), m.index + addr.length + 160);
    if (!HIRING_WORDS.test(around)) continue;
    // "jane.doe@" gives a first name to greet; anything else greets nobody.
    const first = /^[a-z]{2,15}[._][a-z'-]{2,25}$/.test(local) ? local.split(/[._]/)[0] : "";
    return { addr, first: first ? first[0].toUpperCase() + first.slice(1) : "" };
  }
  return null;
}

/** The employer's own website, from what the panel already knows of it. */
async function employerSite(company, hints) {
  const candidates = [];
  for (const h of hints) {
    try {
      const u = new URL(h);
      if (!PORTAL_HOST.test(u.hostname)) candidates.push(`https://${u.hostname}`);
    } catch {
      /* not an address */
    }
  }
  // Its name as a .com, kept only if the page that answers names the company.
  const slug = flat(company);
  if (slug.length >= 3 && slug.length <= 30) candidates.push(`https://www.${slug}.com`);

  for (const origin of [...new Set(candidates)]) {
    try {
      const home = await getPage(origin);
      const said = flat(home.text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").slice(0, 60_000));
      const title = flat((home.text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").slice(0, 200));
      if (!title.includes(slug) && !said.includes(slug)) continue;
      return { origin: new URL(home.final).origin, home: home.text };
    } catch {
      /* try the next */
    }
  }
  return null;
}

/** Look on the pages an employer puts its contact address on. */
async function findContact(company, hints, posting = "") {
  const where = await employerSite(company, hints);
  if (!where) return { contact: null, why: "its own website could not be found" };
  const domain = site(new URL(where.origin).hostname);
  let best = null;
  let person = null;
  const consider = (html, url) => {
    for (const c of contactsIn(html, domain)) {
      if (!best || c.tier < best.tier) best = { ...c, found_on: url };
    }
    if (!person) {
      const p = hiringPersonIn(html, domain);
      if (p) person = { ...p, found_on: url };
    }
  };
  // The posting itself first: a contact named there is named for this job.
  if (posting) consider(posting, where.origin + "/#posting");
  consider(where.home, where.origin);
  for (const path of ["/careers", "/contact", "/contact-us", "/about", "/about-us", "/company/contact", "/jobs"]) {
    if (best?.tier === 0 && person) break;
    try {
      const p = await getPage(where.origin + path);
      consider(p.text, p.final);
    } catch {
      /* that page is not there */
    }
    await pause(300);
  }
  if (person) {
    // The person, with the careers or front-door address copied. A help
    // desk is not copied on a note to a recruiter.
    return {
      contact: { addr: person.addr, tier: -1, found_on: person.found_on, first: person.first, cc: best && best.tier <= 1 ? best.addr : null },
      why: null,
    };
  }
  return best ? { contact: best, why: null } : { contact: null, why: `no contact address is published on ${domain}` };
}

const words = (s) => String(s ?? "").trim().split(/\s+/).filter(Boolean).length;

/** The first lines of the resume's summary, for the note written without the model. */
function summaryOf(resume) {
  const lines = String(resume ?? "").split(/\r?\n/).map((l) => l.trim());
  const at = lines.findIndex((l) => /^(summary|profile|professional summary|about)\b/i.test(l));
  const body = (at >= 0 ? lines.slice(at + 1) : lines.slice(3))
    .filter((l) => l && !/^[A-Z][A-Z &]{2,}$/.test(l) && !/^-\s/.test(l) && l.length > 40);
  const first = (body[0] ?? "").split(/(?<=[.!?])\s+/).slice(0, 2).join(" ");
  return first.length > 40 && first.length < 420 ? first : "";
}

export function plainNote({ title, company, name, phone, email, resume }) {
  // The summary is written about the applicant ("Hands-on retail leader
  // with…", "serves as…"). In a note it has to be said by them: the opening
  // phrase becomes "I am a …", and a sentence that speaks of them in the
  // third person is left out rather than sent as it stands.
  const first = summaryOf(resume).split(/(?<=[.!?])\s+/)[0] ?? "";
  const mine =
    first && !/^(i|my)\b/i.test(first) && !/\b(serves|leads|manages|oversees|works|is|has|brings)\b/i.test(first.split(/\s+/).slice(0, 4).join(" "))
      ? `I am ${/^[aeiou]/i.test(first) ? "an" : "a"} ${first[0].toLowerCase()}${first.slice(1)}`
      : /^(i|my)\b/i.test(first) ? first : "";
  return [
    "Hello,",
    `I recently applied for the ${title} position at ${company} and wanted to introduce myself directly.`,
    mine,
    "The resume I submitted with my application is attached. I would welcome the chance to talk about the role and how I could contribute, and I am glad to work around your schedule.",
    "Thank you for your time and consideration.",
    [name, [phone, email].filter(Boolean).join(" | ")].filter(Boolean).join("\n"),
  ].filter(Boolean).join("\n\n");
}

const PROMPT = `Write a short email from a job applicant to an employer's general contact address, sent right after they applied.

ROLE: {TITLE}
EMPLOYER: {COMPANY}

THE POSTING:
{POSTING}

THE APPLICANT'S RESUME (the only source of facts about them):
{RESUME}

Rules:
- Start with exactly "Hello," on its own line. Address nobody by name or title.
- First sentence: they just applied for the {TITLE} role at {COMPANY}.
- Then why this role interests them, tied to something specific in the posting.
- Then why they fit: two or three concrete things from the resume that match what the posting asks for. Use only facts stated in the resume. No invented numbers, employers, degrees, tools or years.
- Then that the resume they applied with is attached, and that they would welcome a conversation.
- 110 to 160 words in the body. Plain sentences. Warm and direct, not gushing. No bullet points, no subject line, no placeholders in brackets, no sign-off or name at the end (it is added afterwards).
Return only the body of the email.`;

/** The note, written for this role; the plain one when the model's fails a check. */
async function writeNote(job, profile, resume) {
  const base = { title: job.title, company: job.company, name: profile.full_name, phone: profile.phone, email: profile.email, resume };
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { body: plainNote(base), by: "template" };
  let text = "";
  let failed = "";
  try {
    text = String(
      (await geminiForTitles(
        PROMPT.replaceAll("{TITLE}", job.title)
          .replaceAll("{COMPANY}", job.company)
          .replace("{POSTING}", String(job.description ?? "No posting text available.").slice(0, 3500))
          .replace("{RESUME}", resume.slice(0, 4500)),
        key,
        // Room to think and still finish: 700 came back as twenty words.
        2500,
      )) ?? "",
    ).trim();
  } catch (e) {
    text = "";
    failed = String(e?.message ?? e).slice(0, 40);
  }
  text = text.replace(/^```[a-z]*\n?|\n?```$/g, "").replace(/^subject:.*\n+/i, "").trim();
  const ok =
    /^hello,/i.test(text) &&
    words(text) >= 80 &&
    words(text) <= 210 &&
    !/[\[\]{}]|\byour name\b|\bcompany name\b|dear\s/i.test(text) &&
    text.toLowerCase().includes(String(job.company).toLowerCase().split(/[ ,]/)[0]) &&
    // A number in the note has to be a number in the resume.
    (text.match(/\b\d[\d,.]*\+?%?/g) ?? []).every((n) => resume.includes(n.replace(/[+%]$/, "")));
  if (!ok) {
    // Why, by shape only: the note itself is not printed.
    const why = failed
      ? `the model failed: ${failed}`
      : !text ? "the model returned nothing"
      : !/^hello,/i.test(text) ? "it did not open as asked"
      : words(text) < 80 || words(text) > 210 ? `it ran to ${words(text)} words`
      : /[\[\]{}]|\byour name\b|\bcompany name\b|dear\s/i.test(text) ? "it held a placeholder or a salutation"
      : "it held a number the resume does not, or did not name the employer";
    console.log(`     the written note was set aside (${why}); the plain one is used`);
    return { body: plainNote(base), by: "template" };
  }
  const sign = `\n\nThank you for your time and consideration.\n\n${profile.full_name}\n${[profile.phone, profile.email].filter(Boolean).join(" | ")}`;
  return { body: text.replace(/\n(best|regards|sincerely|thank you)[\s\S]*$/i, "").trim() + sign, by: "model" };
}

if (process.env.OUTREACH_IMPORT_ONLY !== "1") {
  if (!SUPABASE_URL || !ANON_KEY || !AP_EMAIL || !AP_PASSWORD) {
    console.error("Missing SUPABASE_URL, SUPABASE_ANON_KEY, APPLYPILOT_EMAIL or APPLYPILOT_PASSWORD.");
    process.exit(1);
  }
  await auth({ email: AP_EMAIL, password: AP_PASSWORD }, "password");
  await useOwnKey(db);

  const [profile] = (await db("profile?id=eq.1&select=*")) ?? [];
  // Nothing printed from here can carry the owner's own details.
  try {
    guardLogs(profile, structureResume(profile?.resume_text, profile ?? {}));
  } catch {
    guardLogs(profile);
  }
  if (!profile?.full_name) {
    console.log("the profile has no name on it; nothing to sign a note with.");
    process.exit(0);
  }
  const on = profile.follow_up === true;
  console.log(`mode: ${MODE}; follow-up emails are ${profile.follow_up === undefined ? "not set up in the panel yet" : on ? "on" : "off"}.`);
  if (MODE === "send" && !on) {
    console.log("nothing to do: sending is switched off in settings.");
    process.exit(0);
  }

  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 19) + "Z";
  const jobs =
    ((await db(
      `jobs?status=eq.applied&applied_at=gte.${encodeURIComponent(since)}` +
        `&select=id,title,company,url,apply_url,description,tailored_resume,applied_at&order=applied_at.desc&limit=200`,
    )) ?? []).filter((j) => !isBlocked(j)); // an employer the owner has blocked is never written to (blocked.mjs)

  // Who has been written to, or looked at, already.
  let earlier = [];
  try {
    const from = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 19) + "Z";
    earlier = (await db(`outreach?created_at=gte.${encodeURIComponent(from)}&select=job_id,company,state&limit=2000`)) ?? [];
  } catch {
    console.log("the panel has no record of earlier notes yet (the update has not been published); treating every employer as new.");
  }
  const doneJobs = new Set(earlier.filter((e) => e.state !== "dry").map((e) => e.job_id));
  const doneFirms = new Set(earlier.filter((e) => e.state === "sent").map((e) => flat(e.company)));

  const firms = await allRows(db, "companies?select=name,careers_url").catch(() => []);
  const cands = await allRows(db, "company_candidates?select=name,careers_url,resolved_url").catch(() => []);
  const hintsFor = (company) => {
    const k = flat(company);
    return [...firms, ...cands]
      .filter((r) => flat(r.name) === k)
      .flatMap((r) => [r.careers_url, r.resolved_url])
      .filter(Boolean);
  };

  // One per employer: the most recent application to each.
  const picked = [];
  const seen = new Set();
  for (const j of jobs) {
    const k = flat(j.company);
    if (!k || seen.has(k) || doneFirms.has(k) || doneJobs.has(j.id)) continue;
    seen.add(k);
    picked.push(j);
    if (picked.length >= MAX) break;
  }
  for (const j of jobs) hideJob(j);
  console.log(`${jobs.length} application(s) in the last ${DAYS} day(s); ${picked.length} employer(s) not yet written to.`);

  let bank = "";
  let bankRows = [];
  try {
    bankRows = (await db("experience?select=company,title,location,start_date,end_date,details&order=created_at.desc&limit=40")) ?? [];
    bank = rolesText(bankRows);
  } catch {
    bank = "";
  }
  let browser = null;
  let renderResumePdf = null;
  let readPosting = null;
  const ready = async () => {
    if (browser) return;
    // The applier's own renderer and reader, so the attachment is the same
    // kind of document that goes in with an application.
    process.env.APPLY_SELFTEST = "1";
    ({ renderResumePdf, readPosting } = await import("./apply.mjs"));
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  };
  /** The posting's text, read from its own page, for a job stored without it. */
  const postingFor = async (job) => {
    if (String(job.description ?? "").trim().length >= 200) return;
    await ready();
    const page = await browser.newPage();
    try {
      await page.goto(job.url || job.apply_url, { waitUntil: "domcontentloaded", timeout: 40_000 });
      await readPosting(page, job);
      if (String(job.description ?? "").trim().length >= 200 && MODE !== "report") {
        await db(`jobs?id=eq.${job.id}`, {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ description: job.description }),
        }).catch(() => {});
      }
    } catch {
      /* the posting may have been taken down since */
    } finally {
      await page.close().catch(() => {});
    }
  };
  const pdfFor = async (text, name) => {
    await ready();
    const page = await browser.newPage();
    try {
      // One page, in the same design the application itself carried.
      return (await renderResumePdf(page, text, name)).toString("base64");
    } finally {
      await page.close().catch(() => {});
    }
  };

  const tally = { looked: 0, address: 0, people: 0, tiers: [0, 0, 0], model: 0, template: 0, sent: 0, preview: 0, refused: 0, failed: 0 };
  for (const job of picked) {
    tally.looked++;
    const { contact, why } = await findContact(job.company, [...hintsFor(job.company), job.url, job.apply_url].filter(Boolean), String(job.description ?? ""));
    if (!contact) {
      console.log(`  -- ${String(job.company).slice(0, 30)}: ${why}`);
      continue;
    }
    tally.address++;
    if (contact.tier < 0) tally.people++;
    else tally.tiers[contact.tier]++;
    // The page written for this posting. An application that went in before
    // each job had its own is given one now, so what is attached is for this
    // role and not the general resume.
    let tailored = Boolean(job.tailored_resume);
    if (!tailored) await postingFor(job);
    if (!tailored) {
      const made = await tailorResume({ job, profile, roles: bank, apiKey: process.env.GEMINI_API_KEY }).catch(() => ({ text: null, why: "failed" }));
      if (made.text) {
        job.tailored_resume = made.text;
        tailored = true;
        if (MODE !== "report") {
          await db(`jobs?id=eq.${job.id}`, {
            method: "PATCH",
            headers: { Prefer: "return=minimal" },
            body: JSON.stringify({ tailored_resume: made.text, tailored_at: new Date().toISOString() }),
          }).catch(() => {});
        }
      } else {
        console.log(`     resume not written for this posting (${made.why})`);
      }
    }
    // Not written by the model: still arranged for this posting, from what
    // is already on the resume.
    const arranged = tailored ? null : arrangedResume(profile, job, bankRows);
    if (arranged) console.log(`     resume: arranged for this posting without the model — ${arranged.moved} bullet(s) reordered${arranged.dropped ? `, ${arranged.dropped} left off` : ""}`);
    const basis = String(job.tailored_resume || arranged?.text || standardResume(profile.resume_text, profile) || "");
    const aligned = alignToPosting(basis, job.description ?? "", job.company ?? "");
    const resume = String(aligned.text || basis);
    console.log(`     resume: ${tailored ? "written for this posting" : arranged ? "arranged for this posting" : "the general one"}; match to the posting's terms ${aligned.before ?? "?"}% -> ${aligned.after ?? "?"}%`);
    const note = await writeNote(job, profile, resume);
    tally[note.by]++;
    // Greeted by first name only when the employer named the person.
    if (contact.first) note.body = note.body.replace(/^hello,/i, `Hello ${contact.first},`);
    // A person's address is not printed: this log is public.
    const who = contact.tier < 0
      ? `a named hiring contact${contact.cc ? `, copying ${contact.cc.split("@")[0]}@` : ""}`
      : `${contact.addr.split("@")[0]}@`;
    console.log(
      `  ok ${String(job.company).slice(0, 30)}: ${who}, published on ${new URL(contact.found_on).pathname || "/"}${new URL(contact.found_on).hash === "#posting" ? " (the posting)" : ""}; ` +
        `note of ${words(note.body)} words (${note.by})`,
    );
    if (MODE === "report") continue;

    if (!ENGINE_KEY) {
      console.log("     no ENGINE_API_KEY here; cannot ask the panel to send.");
      break;
    }
    const safe = String(profile.full_name).replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "Resume";
    let base64 = null;
    try {
      base64 = await pdfFor(resume, String(profile.full_name).trim());
    } catch (e) {
      console.log(`     could not make the resume file: ${String(e?.message ?? e).slice(0, 60)}`);
      continue;
    }
    let out = null;
    try {
      const res = await fetch(`${APP_URL}/api/public/email/outreach`, {
        method: "POST",
        signal: AbortSignal.timeout(40_000),
        headers: { "Content-Type": "application/json", "x-engine-key": ENGINE_KEY, ...ACT_AS },
        body: JSON.stringify({
          job_id: job.id,
          company: job.company,
          to: contact.addr,
          cc: contact.cc ?? null,
          found_on: contact.found_on,
          subject: `Application for ${job.title} - ${profile.full_name}`,
          body: note.body,
          attachment: { filename: `${safe}_Resume.pdf`, base64 },
          preview: MODE === "preview",
        }),
      });
      out = res.ok ? await res.json() : { ok: false, error: `the panel answered ${res.status}` };
    } catch (e) {
      out = { ok: false, error: String(e?.message ?? e).slice(0, 80) };
    }
    if (out?.state === "sent") tally.sent++;
    else if (out?.state === "preview") tally.preview++;
    else if (out?.state === "off" || out?.state === "skipped" || out?.state === "limit") tally.refused++;
    else tally.failed++;
    console.log(`     -> ${out?.state ?? "failed"}${out?.error ? ` (${String(out.error).slice(0, 90)})` : ""}`);
    if (out?.state === "off" || out?.state === "limit" || /answered 404/.test(String(out?.error))) break;
    await pause(1500);
  }
  if (browser) await browser.close().catch(() => {});
  console.log(`result: ${JSON.stringify(tally)}`);
  process.exit(0);
}
