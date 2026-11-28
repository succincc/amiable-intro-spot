// Resumes written ahead of time, a few at a time, all day.
//
// A resume written for its posting needs the model, and the model is free
// only up to an allowance: so many requests a minute, so many a day. The
// applier asked for all of its resumes at the moment it needed them, in a
// burst, at the same time as it was asking the model to answer questions —
// and on a busy day the allowance was gone before most applications had
// been written for.
//
// This spreads the same work out. Every hour it takes the best jobs still
// waiting without a resume of their own, reads the posting where the queue
// has none, and writes them one at a time with a pause between, stopping the
// moment the model says it has had enough. By the time the applier reaches a
// job, its resume is usually already there. The allowance is the same; it is
// simply all used, and used on this first.
//
// Workday's listings carry no description, so its postings are read from the
// same public feed the careers page itself reads — no browser, nothing
// signed in to.
//
// Free: a public-repo runner, public feeds, the free Gemini tier.

import { isBlocked } from "./blocked.mjs";
import { useOwnKey } from "./ownkey.mjs";
import { tailorResume, rolesText, structureResume } from "./tailor.mjs";
import { guardLogs, hideJob } from "./quiet.mjs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
// Whose round this is, when the runner is doing somebody else's: see forusers.mjs.
const ACT_AS = process.env.AP_ACT_AS ? { "x-act-as": process.env.AP_ACT_AS } : {};
const AP_EMAIL = process.env.APPLYPILOT_EMAIL;
const AP_PASSWORD = process.env.APPLYPILOT_PASSWORD;
const MAX = Number(process.env.MAX || 30);
const GAP_MS = Number(process.env.GAP_SECONDS || 8) * 1000;
const WRITE = process.env.WRITE !== "false"; // false: look and report only
const READ_MAX = Number(process.env.READ_MAX || 120);

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
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const plain = (html) =>
  String(html ?? "")
    .replace(/<(br|\/p|\/li|\/div|\/h\d)\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&rsquo;|&apos;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();

/**
 * Where Workday's own page gets a posting from:
 *   https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Edison-NJ/Title_R123
 *   -> https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/Careers/job/Edison-NJ/Title_R123
 */
export function workdayFeedUrl(jobUrl) {
  let u;
  try {
    u = new URL(jobUrl);
  } catch {
    return null;
  }
  if (!/\.myworkdayjobs\.com$/i.test(u.hostname)) return null;
  const tenant = u.hostname.split(".")[0];
  const parts = u.pathname.split("/").filter(Boolean);
  // An optional language ("en-US"), then the site, then "job", then the rest.
  if (/^[a-z]{2}(-[A-Za-z]{2})?$/.test(parts[0] ?? "")) parts.shift();
  const at = parts.indexOf("job");
  if (at !== 1) return null;
  return `${u.origin}/wday/cxs/${tenant}/${parts[0]}/${parts.slice(1).join("/")}`;
}

async function workdayPosting(jobUrl) {
  const feed = workdayFeedUrl(jobUrl);
  if (!feed) return "";
  try {
    const res = await fetch(feed, {
      signal: AbortSignal.timeout(20_000),
      headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" },
    });
    if (!res.ok) return "";
    const j = await res.json();
    return plain(j?.jobPostingInfo?.jobDescription ?? "").slice(0, 12_000);
  } catch {
    return "";
  }
}

if (process.env.PRETAILOR_IMPORT_ONLY !== "1") {
  if (!SUPABASE_URL || !ANON_KEY || !AP_EMAIL || !AP_PASSWORD) {
    console.error("Missing SUPABASE_URL, SUPABASE_ANON_KEY, APPLYPILOT_EMAIL or APPLYPILOT_PASSWORD.");
    process.exit(1);
  }
  await auth({ email: AP_EMAIL, password: AP_PASSWORD }, "password");
  // The person's own key where they have saved one; the shared one otherwise.
  const own = await useOwnKey(db);
  if (!process.env.GEMINI_API_KEY) {
    console.log("no model key on this run; nothing can be written.");
    process.exit(0);
  }
  if (own) console.log("writing on this person's own key.");

  const [profile] = (await db("profile?id=eq.1&select=*")) ?? [];
  if (profile?.tailor_resumes === false) {
    console.log("this person sends their own resume as it is; nothing is written.");
    process.exit(0);
  }
  // Nothing printed from here can carry the owner's own details.
  try {
    guardLogs(profile, structureResume(profile?.resume_text, profile ?? {}));
  } catch {
    guardLogs(profile);
  }
  if (!String(profile?.resume_text ?? "").trim()) {
    console.log("no resume on file; nothing to write from.");
    process.exit(0);
  }
  // An empty Experience page is filled from the resume, once. Somebody who
  // has uploaded a resume has already written down where they worked; asking
  // them to type it again is a step that gets skipped, and everything that
  // reads this page — the written resumes, a portal's work history — then
  // has nothing to read. Only what the resume says goes in, and the owner
  // can change or remove any of it in settings afterwards.
  try {
    const have = (await db("experience?select=id&limit=1")) ?? [];
    if (!have.length) {
      const parsed = (structureResume(profile.resume_text, profile ?? {})?.experience ?? []).filter((e) => e?.company && e?.title).slice(0, 12);
      const rows = parsed.map((e) => {
        const [from, to] = String(e.dates ?? "").split(/\s+(?:-|–|—|to|through)\s+|(?<=\d)\s*[–—-]\s*(?=[A-Za-z0-9])/);
        const end = String(to ?? "").trim();
        return {
          company: String(e.company).slice(0, 120),
          title: String(e.title).slice(0, 120),
          location: String(e.location ?? "").trim() || null,
          start_date: String(from ?? "").trim() || null,
          end_date: !end || /present|current|now/i.test(end) ? null : end,
          details: (e.bullets ?? []).join("\n").slice(0, 4000) || null,
        };
      });
      if (!rows.length) {
        console.log("experience: the page is empty and no roles could be read from the resume.");
      } else if (!WRITE) {
        console.log(`experience: the page is empty; ${rows.length} role(s) from the resume would be entered (report only).`);
      } else {
        // Oldest first, one at a time, so that the newest is the newest row.
        let put = 0;
        for (const row of [...rows].reverse()) {
          await db("experience", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(row) });
          put++;
          await new Promise((r) => setTimeout(r, 1100));
        }
        console.log(`experience: the page was empty; ${put} role(s) entered from the resume.`);
      }
    }
  } catch (e) {
    console.log(`experience: could not be filled from the resume — ${String(e?.message ?? e).slice(0, 100)}`);
  }
  let roles = "";
  try {
    roles = rolesText((await db("experience?select=company,title,location,start_date,end_date,details&order=created_at.desc&limit=40")) ?? []);
  } catch {
    roles = "";
  }
  // What the person has confirmed about themselves beyond the resume
  // (candidate.mjs): theirs, in their words, and so the writer's to use.
  try {
    const { confirmedQualifications, qualificationLines } = await import("./candidate.mjs");
    const said = confirmedQualifications((await db("answers?confirmed=eq.true&question=ilike.About%20you:*&select=q_key,answer,confirmed&limit=200")) ?? []);
    if (said.length) {
      roles = [roles, `ALSO CONFIRMED BY THE CANDIDATE, IN THEIR OWN WORDS\n${qualificationLines(said)}`].filter(Boolean).join("\n\n");
      console.log(`the writer also has ${said.length} qualification(s) the person confirmed beyond the resume`);
    }
  } catch { /* the page of answers could not be read: the resume stands alone */ }

  // Where postings are being set aside over a location that could not be
  // read. These are employers' own place names, not anything of the owner's,
  // and seeing them is how the reading gets better: "2 Locations" and
  // "USA - NJ - Princeton" are both jobs a person could tell were nearby.
  if (!WRITE) try {
    const lost =
      (await db(
        `jobs?status=eq.skipped&or=(skip_reason.like.location%20could%20not%20be%20placed*,skip_reason.like.no%20state%20given*,skip_reason.eq.no%20usable%20location)` +
          `&select=location,ats&order=found_at.desc&limit=600`,
      )) ?? [];
    const counts = new Map();
    for (const r of lost) {
      const k = `${r.ats ?? "none"}: ${String(r.location ?? "(empty)").slice(0, 60)}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 45).map(([k, n]) => `${k} ×${n}`);
    console.log(`set aside over an unreadable location: ${lost.length}; ${counts.size} distinct, the commonest on ${JSON.stringify(top.slice(0, 12).map((t) => Number(t.split("×").pop())))} job(s)`);
  } catch (e) {
    console.log(`could not list the unreadable locations: ${String(e?.message ?? e).slice(0, 80)}`);
  }

  // Postings the scorer never saw.
  //
  // Workday's listing gives a title and a place and no description, so every
  // Workday job was being scored on its title alone — by the model and by
  // the free scorer alike — and a good many sat in review on the strength of
  // two or three words. The posting itself is one public request away. Read
  // here, before scoring where the job is new; and where a job was already
  // put in review without it, sent back to be scored once more with the
  // posting in hand. Once only: a job that has its description is never
  // picked up by this again.
  try {
    const blind =
      (await db(
        // Stored as an empty string by the panel, as nothing at all elsewhere.
        `jobs?ats=eq.workday&status=in.(new,review)&or=(description.is.null,description.eq.)&select=id,url,apply_url,status&order=found_at.desc&limit=${READ_MAX}`,
      )) ?? [];
    let read = 0;
    let again = 0;
    for (const j of blind) {
      const text = await workdayPosting(j.url || j.apply_url);
      await pause(350);
      if (text.length < 200) continue;
      read++;
      if (!WRITE) continue;
      const patch = { description: text };
      if (j.status === "review") {
        patch.score = null;
        patch.status = "new";
        again++;
      }
      await db(`jobs?id=eq.${j.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(patch) }).catch(() => {});
    }
    console.log(`Workday jobs the scorer had only a title for: ${blind.length}; postings read: ${read}${WRITE ? `; sent back to be scored with the posting in hand: ${again}` : " (report only)"}`);
  } catch (e) {
    console.log(`could not read the unseen postings: ${String(e?.message ?? e).slice(0, 80)}`);
  }

  // The jobs the applier will reach first: queued, best score first.
  const jobs =
    ((await db(
      `jobs?status=eq.queued&tailored_resume=is.null&select=id,title,company,url,apply_url,description,ats,score&order=score.desc.nullslast&limit=${MAX * 3}`,
    )) ?? []).filter((j) => !isBlocked(j)); // nothing is written for an employer the owner has blocked
  for (const j of jobs) hideJob(j);
  console.log(`${jobs.length} queued job(s) without a resume of their own; writing up to ${MAX}, ${GAP_MS / 1000}s apart${roles ? "; the list of roles in settings is in use" : ""}.`);

  const tally = { tried: 0, written: 0, postingsRead: 0, noPosting: 0, refused: 0, failed: 0 };
  let refusedInARow = 0;
  for (const job of jobs) {
    if (tally.tried >= MAX) break;

    if (String(job.description ?? "").trim().length < 200) {
      const text = job.ats === "workday" ? await workdayPosting(job.url || job.apply_url) : "";
      if (text.length < 200) {
        // The applier reads it from the page when it gets there.
        tally.noPosting++;
        continue;
      }
      job.description = text;
      tally.postingsRead++;
      if (WRITE) {
        await db(`jobs?id=eq.${job.id}`, {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ description: text }),
        }).catch(() => {});
      }
    }

    tally.tried++;
    const made = await tailorResume({ job, profile, roles, apiKey: process.env.GEMINI_API_KEY }).catch((e) => ({ text: null, why: String(e?.message ?? e).slice(0, 40) }));
    if (made.text) {
      refusedInARow = 0;
      tally.written++;
      const cut = made.removed.roles + made.removed.bullets + made.removed.schools;
      console.log(`  ok ${String(job.company ?? "").slice(0, 26)} — ${made.roles} role(s), ${made.bullets} bullet(s)${cut ? `, ${cut} unsupported line(s) taken out` : ""}`);
      if (WRITE) {
        await db(`jobs?id=eq.${job.id}`, {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ tailored_resume: made.text, tailored_at: new Date().toISOString() }),
        }).catch(() => {});
      }
    } else if (/RATE_LIMIT|free limit|429/i.test(String(made.why))) {
      tally.refused++;
      refusedInARow++;
      console.log(`  -- ${String(job.company ?? "").slice(0, 26)} — the model is at its allowance`);
      // Twice running means the allowance is spent, not that a minute is
      // full. Stop and leave what is left of it for the applier's questions;
      // the next hour's run carries on from here.
      if (refusedInARow >= 2) {
        console.log("  stopping: the free allowance is used up for now.");
        break;
      }
      await pause(45_000);
      continue;
    } else {
      refusedInARow = 0;
      tally.failed++;
      console.log(`  -- ${String(job.company ?? "").slice(0, 26)} — not written (${made.why})`);
    }
    await pause(GAP_MS);
  }
  console.log(`result: ${JSON.stringify(tally)}`);
  process.exit(0);
}
