// Postings from employers whose careers portal is iCIMS.
//
// The resolver found about thirty employers on iCIMS, among them the hospital
// systems nearest Princeton. The panel's discovery does not know iCIMS, and
// teaching it would need a change to the panel; this reads the portals from
// a runner instead and puts what it finds in the same queue, as postings like
// any other — scored, measured for distance and held to the fourteen-day rule
// by the machinery that already exists.
//
// An iCIMS portal is a search page per employer: careers-NAME.icims.com/jobs/
// search. It is read with a browser because the listing is drawn inside an
// iframe by script. Each of the owner's job titles is searched; nothing is
// signed in to.
//
// Free: a public-repo runner and public pages.

import { guardLogs, hideNames, shape } from "./quiet.mjs";
// Nothing this prints names an employer, a posting or a place: see quiet.mjs.
guardLogs();
import { chromium } from "playwright";

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const AP_EMAIL = process.env.APPLYPILOT_EMAIL;
const AP_PASSWORD = process.env.APPLYPILOT_PASSWORD;
const APPLY = process.env.APPLY === "true"; // off: look and report, write nothing
const MAX_EMPLOYERS = Number(process.env.MAX_EMPLOYERS || 60);
const TITLES_PER_EMPLOYER = Number(process.env.TITLES_PER_EMPLOYER || 5);
const BUDGET_MS = Number(process.env.BUDGET_MINUTES || 40) * 60_000;
const ONLY = String(process.env.ONLY_HOST || "").trim();

let ACCESS = "";
let REFRESH = "";
let EXPIRES = 0;
async function auth(body, grant) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=${grant}`, {
    method: "POST",
    headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
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
      apikey: ANON_KEY,
      Authorization: `Bearer ${ACCESS}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`DB ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/** "US-NJ-Princeton" and its relatives, as "Princeton, NJ". */
export function placeOf(raw) {
  const t = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  const first = t.split(/\s*\|\s*|\s*;\s*/)[0];
  const m = first.match(/^([A-Z]{2})-([A-Z]{2})-(.+)$/);
  if (m) return `${m[3].trim()}, ${m[2]}`;
  const m2 = first.match(/^([A-Z]{2})-([A-Z]{2})$/);
  if (m2) return m2[2];
  return first.slice(0, 80);
}

/** When a listing row says it was posted, as a date, or null. */
export function postedOf(text, now = Date.now()) {
  const t = String(text ?? "").toLowerCase();
  let m = t.match(/(\d+)\s+(hour|day|week|month)s?\s+ago/);
  if (m) {
    const n = Number(m[1]);
    const ms = { hour: 3600e3, day: 86400e3, week: 7 * 86400e3, month: 30 * 86400e3 }[m[2]];
    return new Date(now - n * ms).toISOString();
  }
  if (/\b(today|just posted)\b/.test(t)) return new Date(now).toISOString();
  if (/\byesterday\b/.test(t)) return new Date(now - 86400e3).toISOString();
  m = t.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (m) {
    const d = new Date(Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2])));
    if (Number.isFinite(d.getTime())) return d.toISOString();
  }
  return null;
}

/** Does this title look like one the owner searches for? */
export function wanted(title, titles, excludes) {
  const t = String(title ?? "").toLowerCase();
  if (!t) return false;
  if (excludes.some((x) => x && t.includes(String(x).toLowerCase()))) return false;
  if (!titles.length) return true;
  return titles.some((want) => {
    const words = String(want).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
    return words.length > 0 && words.every((w) => t.includes(w));
  });
}

/** The listing rows on whatever frame holds them. */
async function rowsOn(page) {
  const out = [];
  for (const frame of page.frames()) {
    const got = await frame
      .evaluate(() => {
        const rows = [];
        const seen = new Set();
        for (const a of document.querySelectorAll('a[href*="/jobs/"]')) {
          const href = a.href || "";
          const m = href.match(/\/jobs\/(\d+)\/[^/?#]*\/job/);
          if (!m || seen.has(m[1])) continue;
          seen.add(m[1]);
          // The card: climb to the block that holds this posting and no other.
          let card = a;
          for (let d = 0; d < 6 && card.parentElement; d++) {
            const up = card.parentElement;
            if (up.querySelectorAll('a[href*="/jobs/"][href*="/job"]').length > 2) break;
            card = up;
          }
          const text = (card.innerText || "").replace(/[ \t]+/g, " ").trim();
          const title =
            (a.querySelector("h2, h3, h4")?.innerText || a.getAttribute("title") || a.innerText || "")
              .replace(/\s+/g, " ")
              .replace(/^title\s*/i, "")
              .trim();
          rows.push({ id: m[1], href: href.split("?")[0], title: title.slice(0, 160), text: text.slice(0, 600) });
        }
        return rows;
      })
      .catch(() => []);
    out.push(...got);
  }
  return out;
}

/** The posting's own words, for the scorer. */
async function describe(context, url) {
  const page = await context.newPage();
  try {
    await page.goto(`${url}?in_iframe=1`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(1500);
    let best = "";
    for (const frame of page.frames()) {
      const t = await frame
        .evaluate(() => {
          const el = document.querySelector(".iCIMS_JobContent, .iCIMS_InfoMsg_Job, [class*=JobContent], main, #main") ?? document.body;
          return (el?.innerText || "").replace(/\s+\n/g, "\n").trim();
        })
        .catch(() => "");
      if (t.length > best.length) best = t;
    }
    return best.slice(0, 12000);
  } catch {
    return "";
  } finally {
    await page.close().catch(() => {});
  }
}

if (process.env.ICIMS_IMPORT_ONLY !== "1") {
  if (!SUPABASE_URL || !ANON_KEY || !AP_EMAIL || !AP_PASSWORD) {
    console.error("Missing SUPABASE_URL, SUPABASE_ANON_KEY, APPLYPILOT_EMAIL or APPLYPILOT_PASSWORD.");
    process.exit(1);
  }
  await auth({ email: AP_EMAIL, password: AP_PASSWORD }, "password");

  const [cfg] = (await db("search_config?id=eq.1&select=titles,exclude_titles")) ?? [{}];
  const titles = (cfg?.titles ?? []).filter(Boolean);
  const excludes = (cfg?.exclude_titles ?? []).filter(Boolean);

  // Employers the resolver found on iCIMS, with the host it saw.
  const found =
    (await db("company_candidates?note=ilike.*runs%20on%20icims%20at*&select=name,note&limit=500")) ?? [];
  let employers = found
    .map((r) => ({ name: r.name, host: (String(r.note).match(/icims at ([a-z0-9.-]+\.icims\.com)/i) ?? [])[1] }))
    .filter((e) => e.host && !/^(www|api|cdn\d*|assets?|static|login|cookie[a-z-]*)\./.test(e.host))
    // The staff-only twin of a portal sits beside the public one.
    .map((e) => ({ ...e, host: e.host.replace(/^(internalcareers|internal|employee)-/, "careers-") }));
  if (ONLY) employers = employers.filter((e) => e.host === ONLY);
  employers = employers.slice(0, MAX_EMPLOYERS);
  hideNames(employers.map((e) => e.name));
  console.log(`${employers.length} employer(s) on iCIMS; ${titles.length} title(s) to search; ${APPLY ? "saving postings" : "report only"}.`);

  const browser = await chromium.launch({ args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"] });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    locale: "en-US",
  });
  await context
    .route("**/*", (r) => (["image", "media", "font"].includes(r.request().resourceType()) ? r.abort() : r.continue()))
    .catch(() => {});

  const started = Date.now();
  const tally = { employers: 0, rows: 0, wanted: 0, fresh: 0, saved: 0, empty: 0 };
  let sampled = 0;
  let looked = 0;

  for (const e of employers) {
    if (Date.now() - started > BUDGET_MS) break;
    tally.employers++;
    const page = await context.newPage();
    const seen = new Map();
    // Every title is its own search; with none configured, the first page of
    // everything.
    // The unfiltered first page as well: it is what proves the portal reads.
    const terms = ["", ...titles.slice(0, TITLES_PER_EMPLOYER)];
    for (const term of terms) {
      const url =
        `https://${e.host}/jobs/search?ss=1&in_iframe=1` +
        (term ? `&searchKeyword=${encodeURIComponent(term)}` : "");
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.waitForTimeout(2500);
        for (const r of await rowsOn(page)) if (!seen.has(r.id)) seen.set(r.id, r);
        // What the portal actually served, for the first few that read as
        // empty: an empty list, a different link shape and a refusal all
        // look the same from the count alone.
        if (!term && !seen.size && looked < 4) {
          looked++;
          const what = [];
          for (const frame of page.frames()) {
            what.push(
              await frame
                .evaluate(() => ({
                  url: location.href.slice(0, 110),
                  title: document.title.slice(0, 60),
                  links: document.querySelectorAll("a[href]").length,
                  jobLinks: Array.from(document.querySelectorAll('a[href*="job"]')).slice(0, 4).map((a) => a.href.slice(0, 110)),
                  says: (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 160),
                }))
                .catch(() => null),
            );
          }
          console.log(`  looked at ${e.host}: ${JSON.stringify(what.filter(Boolean).map((w) => ({ links: w.links, jobLinks: w.jobLinks?.length ?? 0, words: String(w.says ?? "").length }))).slice(0, 600)}`);
        }
      } catch {
        /* one search failing is not the employer failing */
      }
    }
    await page.close().catch(() => {});

    const rows = [...seen.values()];
    tally.rows += rows.length;
    if (!rows.length) {
      tally.empty++;
      console.log(`  ?  ${e.name} (${e.host}) — no postings read`);
      continue;
    }
    // What a row looks like, a few times, so the parsing can be checked
    // against the real thing rather than against a guess.
    if (sampled < 3) {
      sampled++;
      console.log(`  sample row from ${e.name}: ${JSON.stringify(shape(rows[0])).slice(0, 500)}`);
    }

    const keep = [];
    for (const r of rows) {
      if (!wanted(r.title, titles, excludes)) continue;
      tally.wanted++;
      const posted_at = postedOf(r.text);
      // Fresh postings only, as everywhere else. One that shows no date is
      // kept undated and left for the applier to judge.
      if (posted_at && new Date(posted_at).getTime() < Date.now() - 14 * 86_400_000) continue;
      tally.fresh++;
      const loc = (r.text.match(/\b([A-Z]{2}-[A-Z]{2}(?:-[A-Za-z .'-]+)?)\b/) ?? [])[1] ?? null;
      keep.push({ ...r, posted_at, location: placeOf(loc) });
    }
    console.log(`  ok ${e.name} — ${rows.length} read, ${keep.length} wanted and fresh`);
    if (!APPLY || !keep.length) continue;

    const body = [];
    for (const r of keep.slice(0, 25)) {
      body.push({
        url: r.href,
        apply_url: r.href,
        title: r.title,
        company: e.name,
        location: r.location,
        remote: /\bremote\b/i.test(`${r.title} ${r.text}`),
        description: await describe(context, r.href),
        source: "icims",
        ats: "icims",
        posted_at: r.posted_at,
        status: "new",
      });
    }
    try {
      const saved = await db("jobs?on_conflict=url", {
        method: "POST",
        headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
        body: JSON.stringify(body),
      });
      tally.saved += saved?.length ?? 0;
    } catch (err) {
      console.log(`     could not save ${e.name}: ${String(err.message).slice(0, 120)}`);
    }
  }

  await browser.close().catch(() => {});
  console.log(`result: ${JSON.stringify(tally)} in ${Math.round((Date.now() - started) / 60000)} min`);
  process.exit(0);
}
