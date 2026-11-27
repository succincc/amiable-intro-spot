// Postings from employers whose careers portal is SmartRecruiters.
//
// The resolver names these employers and the search lists the system among
// the ones it reads, and nothing read them: the panel's round had no reader
// for it, so twenty-three employers were asked for nothing, round after
// round, and not one posting of theirs was ever in the queue. This asks the
// public list SmartRecruiters publishes for each employer — the same one its
// own careers page draws from. Nothing is signed in to.
//
// What it finds goes in the same queue as every other posting — held to the
// titles, the freshness rule and the places in reach, like the rest.
//
// Free: a public-repo runner and a public list.

import { guardLogs, hideNames, shape } from "./quiet.mjs";
import { FRESH_MS } from "./fresh.mjs";
import { nearPattern } from "./near.mjs";
guardLogs();
process.env.ICIMS_IMPORT_ONLY = "1";
const { wanted } = await import("./icims.mjs");

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const ACT_AS = process.env.AP_ACT_AS ? { "x-act-as": process.env.AP_ACT_AS } : {};
const AP_EMAIL = process.env.APPLYPILOT_EMAIL;
const AP_PASSWORD = process.env.APPLYPILOT_PASSWORD;
const APPLY = process.env.APPLY === "true";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

let ACCESS = "";
async function signIn() {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON_KEY, ...ACT_AS, "Content-Type": "application/json" },
    body: JSON.stringify({ email: AP_EMAIL, password: AP_PASSWORD }),
  });
  if (!res.ok) throw new Error(`Sign-in failed ${res.status}`);
  ACCESS = (await res.json()).access_token;
}
async function db(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: ANON_KEY, ...ACT_AS, Authorization: `Bearer ${ACCESS}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`DB ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/** One opening as the list gives it, as a row for the queue. */
export function rowOf(r, token) {
  const id = r?.id;
  const title = String(r?.name ?? "").trim();
  if (!id || !title) return null;
  const at = r.location ?? {};
  const country = String(at.country ?? "").toLowerCase();
  const city = at.city ? String(at.city).trim() : "";
  const region = at.region ? String(at.region).trim() : "";
  const location = [city, region].filter(Boolean).join(", ") || (at.fullLocation ? String(at.fullLocation) : null);
  const posted = r.releasedDate ? new Date(r.releasedDate) : null;
  const firm = r.company?.identifier || token;
  return {
    id: String(id), title, location, country,
    posted_at: posted && !isNaN(posted) ? posted.toISOString() : null,
    href: `https://jobs.smartrecruiters.com/${encodeURIComponent(firm)}/${encodeURIComponent(id)}`,
    remote: at.remote === true || /\bremote\b/i.test(`${title} ${location ?? ""}`),
  };
}

const strip = (html) => String(html ?? "").replace(/<(br|\/p|\/li|\/div|\/h\d)[^>]*>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();

/** The whole text of one opening, from the sections its page is drawn from. */
export function textOf(detail) {
  const s = detail?.jobAd?.sections ?? {};
  return [s.jobDescription, s.qualifications, s.additionalInformation, s.companyDescription]
    .map((part) => strip(part?.text))
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 12000);
}

async function getJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, redirect: "follow", signal: AbortSignal.timeout(25_000) });
  const text = await res.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* not data */ }
  return { status: res.status, j, bytes: text.length };
}

if (process.env.SR_IMPORT_ONLY !== "1") {
  if (!SUPABASE_URL || !ANON_KEY || !AP_EMAIL || !AP_PASSWORD) { console.error("Missing sign-in settings."); process.exit(1); }
  await signIn();
  const [cfg] = (await db("search_config?id=eq.1&select=titles,exclude_titles")) ?? [{}];
  const titles = (cfg?.titles ?? []).filter(Boolean);
  const excludes = (cfg?.exclude_titles ?? []).filter(Boolean);
  const [prof] = (await db("profile?id=eq.1&select=state,home_state").catch(() => [])) ?? [];
  const NEAR = nearPattern(prof?.home_state || prof?.state || process.env.HOME_STATE);

  const found = (await db("companies?ats=eq.smartrecruiters&enabled=eq.true&select=name,token&limit=1000")) ?? [];
  hideNames(found.map((r) => r.name));
  const tally = { employers: found.length, refused: 0, empty: 0, read: 0, rows: 0, wanted: 0, us: 0, fresh: 0, near: 0, saved: 0 };
  const statuses = {};
  let sampled = 0;
  for (const e of found) {
    if (!e.token) { tally.empty++; continue; }
    const rows = [];
    let said = "";
    try {
      for (let offset = 0, total = Infinity; offset < 3000 && offset < total; ) {
        const r = await getJson(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(e.token)}/postings?limit=100&offset=${offset}`);
        statuses[r.status] = (statuses[r.status] ?? 0) + 1;
        const list = r.j?.content;
        if (!Array.isArray(list)) { said = `HTTP ${r.status}, ${r.bytes} bytes${r.j ? `, holds ${Object.keys(r.j).slice(0, 5).join(", ")}` : ", not data"}`; break; }
        rows.push(...list);
        total = Number(r.j?.totalFound ?? Infinity);
        offset += list.length;
        if (!list.length) break;
      }
    } catch (err) { said = String(err?.message ?? err).slice(0, 40); }
    if (!rows.length) {
      if (said) { tally.refused++; console.log(`  ?  ${e.name} — list not read: ${said}`); } else tally.empty++;
      continue;
    }
    tally.read++;
    tally.rows += rows.length;
    if (sampled < 1) { sampled++; console.log(`  sample from ${e.name}: ${JSON.stringify(shape(rows[0])).slice(0, 600)}`); }
    const keep = [];
    for (const raw of rows) {
      const r = rowOf(raw, e.token);
      if (!r || !wanted(r.title, titles, excludes)) continue;
      tally.wanted++;
      if (r.country && r.country !== "us") continue;
      tally.us++;
      if (r.posted_at && new Date(r.posted_at).getTime() < Date.now() - FRESH_MS) continue;
      tally.fresh++;
      if (r.location && !NEAR.test(r.location) && !r.remote) continue;
      tally.near++;
      keep.push(r);
    }
    console.log(`  ok ${e.name} — ${rows.length} read, ${keep.length} wanted, fresh and in reach`);
    if (!APPLY || !keep.length) continue;
    const body = [];
    for (const r of keep.slice(0, 40)) {
      let description = "";
      try {
        const d = await getJson(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(e.token)}/postings/${encodeURIComponent(r.id)}`);
        description = textOf(d.j);
      } catch { /* saved without; the applier opens the page itself */ }
      body.push({ url: r.href, apply_url: r.href, title: r.title, company: e.name, location: r.location, remote: r.remote, description, source: "smartrecruiters", ats: "smartrecruiters", posted_at: r.posted_at, status: "new" });
    }
    try {
      const saved = await db("jobs?on_conflict=user_id,url", { method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=representation" }, body: JSON.stringify(body) });
      tally.saved += saved?.length ?? 0;
    } catch (err) { console.log(`     could not save ${e.name}: ${String(err.message).slice(0, 120)}`); }
  }
  console.log(`answers by status: ${JSON.stringify(statuses)}`);
  console.log(`result: ${JSON.stringify(tally)}`);
  process.exit(0);
}
