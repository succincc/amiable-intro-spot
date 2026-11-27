// Postings from employers whose careers portal is ADP Workforce Now.
//
// The resolver names these and until now nothing read them. A Workforce Now
// career centre is a page that asks ADP's own public address for the list of
// openings and draws it; this asks the same address the page does. Nothing is
// signed in to, and a portal that refuses is left alone and counted.
//
// What it finds goes in the same queue as every other posting — held to the
// titles, the freshness rule and the places in reach, like the rest.
//
// Free: a public-repo runner and public pages.

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
const BASE = "https://workforcenow.adp.com/mascsr/default";

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

/** The two numbers that say which career centre an address is, or null. */
export function centreOf(...texts) {
  const all = texts.filter(Boolean).join(" ");
  const cid = (all.match(/[?&]cid=([0-9a-f]{8}-[0-9a-f-]{20,})/i) ?? [])[1];
  if (!cid) return null;
  const ccId = (all.match(/[?&]ccId=([0-9_]+)/i) ?? [])[1] ?? null;
  return { cid, ccId };
}

/** One opening as ADP lists it, as a row for the queue. */
export function rowOf(r, centre) {
  const id = r?.itemID;
  const title = String(r?.requisitionTitle ?? "").trim();
  if (!id || !title) return null;
  const at = (r.requisitionLocations ?? [])[0] ?? {};
  const city = at.address?.cityName ?? null;
  const st = at.address?.countrySubdivisionLevel1?.codeValue ?? null;
  const location = city && st ? `${city}, ${st}` : (at.nameCode?.shortName ?? city ?? st ?? null);
  const q = `cid=${centre.cid}${centre.ccId ? `&ccId=${centre.ccId}` : ""}&jobId=${encodeURIComponent(id)}&lang=en_US`;
  const posted = r.postDate ? new Date(r.postDate) : null;
  return {
    id, title, location,
    posted_at: posted && !isNaN(posted) ? posted.toISOString() : null,
    href: `${BASE}/mdf/recruitment/recruitment.html?${q}`,
    remote: /\bremote\b/i.test(`${title} ${location ?? ""}`),
  };
}

const strip = (html) => String(html ?? "").replace(/<(br|\/p|\/li|\/div|\/h\d)[^>]*>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();

async function ask(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json", "Accept-Language": "en-US" }, redirect: "follow", signal: AbortSignal.timeout(25_000) });
  const text = await res.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* not data */ }
  return { status: res.status, j, bytes: text.length };
}

if (process.env.ADP_IMPORT_ONLY !== "1") {
  if (!SUPABASE_URL || !ANON_KEY || !AP_EMAIL || !AP_PASSWORD) { console.error("Missing sign-in settings."); process.exit(1); }
  await signIn();
  const [cfg] = (await db("search_config?id=eq.1&select=titles,exclude_titles")) ?? [{}];
  const titles = (cfg?.titles ?? []).filter(Boolean);
  const excludes = (cfg?.exclude_titles ?? []).filter(Boolean);
  const [prof] = (await db("profile?id=eq.1&select=state,home_state").catch(() => [])) ?? [];
  const NEAR = nearPattern(prof?.home_state || prof?.state || process.env.HOME_STATE);

  const found = (await db("company_candidates?note=ilike.*runs%20on%20adp*&select=id,name,note,careers_url,resolved_url&limit=500")) ?? [];
  hideNames(found.map((r) => r.name));
  const tally = { employers: found.length, noCentre: 0, otherProduct: 0, refused: 0, empty: 0, read: 0, rows: 0, wanted: 0, fresh: 0, near: 0, saved: 0 };
  const statuses = {};
  let sampled = 0;
  for (const e of found) {
    const centre = centreOf(e.note, e.resolved_url, e.careers_url);
    if (!centre) {
      if (/myjobs\.adp\.com|recruiting\.adp\.com/i.test(`${e.note} ${e.resolved_url}`)) tally.otherProduct++; else tally.noCentre++;
      continue;
    }
    const q = `cid=${centre.cid}${centre.ccId ? `&ccId=${centre.ccId}` : ""}&lang=en_US&locale=en_US&timeStamp=${Date.now()}`;
    const rows = [];
    let said = "";
    try {
      // The address gives twenty at a time whatever is asked for, so it is
      // asked until it has no more to give.
      for (let skip = 0, total = Infinity; skip < 600 && skip < total; ) {
        const r = await ask(`${BASE}/careercenter/public/events/staffing/v1/job-requisitions?${q}&$top=20${skip ? `&$skip=${skip}` : ""}`);
        statuses[r.status] = (statuses[r.status] ?? 0) + 1;
        const list = r.j?.jobRequisitions;
        if (!Array.isArray(list)) { said = `HTTP ${r.status}, ${r.bytes} bytes${r.j ? `, holds ${Object.keys(r.j).slice(0, 5).join(", ")}` : ", not data"}`; break; }
        rows.push(...list);
        total = Number(r.j?.meta?.totalNumber ?? Infinity);
        skip += list.length;
        if (!list.length) break;
      }
    } catch (err) { said = String(err?.message ?? err).slice(0, 40); }
    if (!rows.length) {
      if (said) { tally.refused++; console.log(`  ?  ${e.name} — list not read: ${said}`); } else tally.empty++;
      continue;
    }
    tally.read++;
    tally.rows += rows.length;
    if (sampled < 2) { sampled++; console.log(`  sample from ${e.name}: ${JSON.stringify(shape(rows[0])).slice(0, 600)}`); }
    const keep = [];
    for (const raw of rows) {
      const r = rowOf(raw, centre);
      if (!r || !wanted(r.title, titles, excludes)) continue;
      tally.wanted++;
      if (r.posted_at && new Date(r.posted_at).getTime() < Date.now() - FRESH_MS) continue;
      tally.fresh++;
      if (r.location && !NEAR.test(r.location) && !r.remote) continue;
      tally.near++;
      keep.push(r);
    }
    console.log(`  ok ${e.name} — ${rows.length} read, ${keep.length} wanted, fresh and in reach`);
    if (!APPLY || !keep.length) continue;
    const body = [];
    for (const r of keep.slice(0, 25)) {
      let description = "";
      try {
        const d = await ask(`${BASE}/careercenter/public/events/staffing/v1/job-requisitions/${encodeURIComponent(r.id)}?${q}`);
        description = strip(d.j?.requisitionDescription ?? d.j?.jobRequisition?.requisitionDescription ?? "").slice(0, 12000);
      } catch { /* the title and place still stand */ }
      body.push({ url: r.href, apply_url: r.href, title: r.title, company: e.name, location: r.location, remote: r.remote, description, source: "adp", ats: "adp", posted_at: r.posted_at, status: "new" });
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
