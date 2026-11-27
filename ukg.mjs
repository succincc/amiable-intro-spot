// Postings from employers whose careers portal is UKG Pro Recruiting.
//
// The resolver names these and until now nothing read them. A UKG job board
// is a page that asks its own public address for the list of openings and
// draws it; this asks the same address the page does. Nothing is signed in
// to, and a board that refuses is left alone and counted.
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


/** Which board an address is: its host, its tenant and the board's own id. */
export function boardOf(...texts) {
  const all = texts.filter(Boolean).join(" ");
  const m = all.match(/(?:https?:\/\/)?(recruiting\d*\.ultipro\.com)\/([A-Za-z0-9]+)\/JobBoard\/([0-9a-f-]{36})/i);
  return m ? { host: m[1].toLowerCase(), tenant: m[2], id: m[3].toLowerCase() } : null;
}

/** One opening as the board lists it, as a row for the queue. */
export function rowOf(r, b) {
  const id = r?.Id;
  const title = String(r?.Title ?? "").trim();
  if (!id || !title) return null;
  const at = (r.Locations ?? [])[0] ?? {};
  const city = at.Address?.City ?? null;
  const st = at.Address?.State?.Code ?? null;
  const location = city && st ? `${city}, ${st}` : (at.LocalizedName ?? at.LocalizedDescription ?? city ?? st ?? null);
  const posted = r.PostedDate ? new Date(r.PostedDate) : null;
  return {
    id, title, location,
    posted_at: posted && !isNaN(posted) ? posted.toISOString() : null,
    href: `https://${b.host}/${b.tenant}/JobBoard/${b.id}/OpportunityDetail?opportunityId=${encodeURIComponent(id)}`,
    remote: /\bremote\b/i.test(`${title} ${location ?? ""}`) || r.JobLocationType === 3,
    brief: String(r.BriefDescription ?? ""),
  };
}

const strip = (html) => String(html ?? "").replace(/<(br|\/p|\/li|\/div|\/h\d)[^>]*>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();

async function page(b, skip) {
  const res = await fetch(`https://${b.host}/${b.tenant}/JobBoard/${b.id}/JobBoardView/LoadSearchResults`, {
    method: "POST",
    headers: { "User-Agent": UA, Accept: "application/json", "Content-Type": "application/json; charset=utf-8", "X-Requested-With": "XMLHttpRequest" },
    body: JSON.stringify({ opportunitySearch: { Top: 50, Skip: skip, QueryString: "", OrderBy: [{ Value: "postedDateDesc", PropertyName: "PostedDate", Ascending: false }], Filters: [] }, matchCriteria: { PreferredJobs: [], Educations: [], LicenseAndCertifications: [], Skills: [], hasNoLicenses: false, SkippedSkills: [] } }),
    redirect: "follow",
    signal: AbortSignal.timeout(25_000),
  });
  const text = await res.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* not data */ }
  return { status: res.status, j, bytes: text.length };
}

if (process.env.UKG_IMPORT_ONLY !== "1") {
  if (!SUPABASE_URL || !ANON_KEY || !AP_EMAIL || !AP_PASSWORD) { console.error("Missing sign-in settings."); process.exit(1); }
  await signIn();
  const [cfg] = (await db("search_config?id=eq.1&select=titles,exclude_titles")) ?? [{}];
  const titles = (cfg?.titles ?? []).filter(Boolean);
  const excludes = (cfg?.exclude_titles ?? []).filter(Boolean);
  const [prof] = (await db("profile?id=eq.1&select=state,home_state").catch(() => [])) ?? [];
  const NEAR = nearPattern(prof?.home_state || prof?.state || process.env.HOME_STATE);

  // Applications that stopped before any form was reached are put back: the
  // applier is still being taught this portal.
  if (APPLY) {
    await db("jobs?ats=eq.ukg&status=eq.needs_help&help_reason=in.(error,no_form,login)", {
      method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "queued", help_reason: null, attempts: 0 }),
    }).catch(() => {});
  }
  const found = (await db("company_candidates?note=ilike.*runs%20on%20ukg*&select=id,name,note,careers_url,resolved_url&limit=500")) ?? [];
  hideNames(found.map((r) => r.name));
  const tally = { employers: found.length, noBoard: 0, refused: 0, empty: 0, read: 0, rows: 0, wanted: 0, fresh: 0, near: 0, saved: 0 };
  const statuses = {};
  let sampled = 0;
  let shown = 0;
  for (const e of found) {
    const b = boardOf(e.note, e.resolved_url, e.careers_url);
    if (!b) {
      tally.noBoard++;
      // What is on file instead, by its shape, the first few times: the
      // next thing anyone needs to know to read these.
      if (shown++ < 4) console.log(`  -  ${e.name} — no board address on file: ${JSON.stringify({ note: /JobBoard\//i.test(e.note ?? ""), resolved: /ultipro|ukg/i.test(e.resolved_url ?? ""), careers: /ultipro|ukg/i.test(e.careers_url ?? "") })}`);
      continue;
    }
    const rows = [];
    let said = "";
    try {
      for (let skip = 0, total = Infinity; skip < 600 && skip < total; ) {
        const r = await page(b, skip);
        statuses[r.status] = (statuses[r.status] ?? 0) + 1;
        const list = r.j?.opportunities;
        if (!Array.isArray(list)) { said = `HTTP ${r.status}, ${r.bytes} bytes${r.j ? `, holds ${Object.keys(r.j).slice(0, 5).join(", ")}` : ", not data"}`; break; }
        rows.push(...list);
        total = Number(r.j?.totalCount ?? Infinity);
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
      const r = rowOf(raw, b);
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
      let description = strip(r.brief);
      try {
        const res = await fetch(r.href, { headers: { "User-Agent": UA, Accept: "text/html" }, redirect: "follow", signal: AbortSignal.timeout(25_000) });
        const html = await res.text();
        const m = html.match(/"Description"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        if (m) description = strip(JSON.parse(`"${m[1]}"`)).slice(0, 12000) || description;
      } catch { /* the brief still stands */ }
      body.push({ url: r.href, apply_url: r.href, title: r.title, company: e.name, location: r.location, remote: r.remote, description, source: "ukg", ats: "ukg", posted_at: r.posted_at, status: "new" });
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
