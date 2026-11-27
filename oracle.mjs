// Postings from employers whose careers portal is Oracle Recruiting.
//
// About thirty employers the resolver found run on it — JPMorgan Chase,
// Marriott, Macy's, and the hospital systems Atlantic Health, Northwell and
// Mount Sinai among them. The portal's own pages are drawn from a public
// feed, the one a visitor's browser asks for when it searches; this asks the
// same feed, for the owner's titles, and puts what is fresh and nearby in
// the same queue as every other source. Nothing is signed in to.
//
// Free: a public-repo runner and a public feed.

import { guardLogs, hideNames, shape } from "./quiet.mjs";
import { FRESH_MS } from "./fresh.mjs";
import { nearPattern } from "./near.mjs";
// Nothing this prints names an employer, a posting or a place: see quiet.mjs.
guardLogs();
const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
// Whose round this is, when the runner is doing somebody else's: see forusers.mjs.
const ACT_AS = process.env.AP_ACT_AS ? { "x-act-as": process.env.AP_ACT_AS } : {};
const AP_EMAIL = process.env.APPLYPILOT_EMAIL;
const AP_PASSWORD = process.env.APPLYPILOT_PASSWORD;
const APPLY = process.env.APPLY === "true"; // off: look and report, write nothing
const TITLES_PER_EMPLOYER = Number(process.env.TITLES_PER_EMPLOYER || 6);
const BUDGET_MS = Number(process.env.BUDGET_MINUTES || 30) * 60_000;
// Postings are kept only where the owner could work: these states, or remote.
// Distance from home is measured afterwards like everything else.
// Made from the owner's state once the profile is read.
let NEAR = nearPattern(process.env.HOME_STATE);

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
async function getJson(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(25_000),
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
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

const plain = (html) =>
  String(html ?? "")
    .replace(/<(br|\/p|\/li|\/div|\/h\d)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();

/** One search of one portal. */
async function search(host, site, keyword, near = null) {
  const finder =
    `findReqs;siteNumber=${site},facetsList=LOCATIONS%3BTITLES,limit=25,` +
    (keyword ? `keyword=%22${encodeURIComponent(keyword)}%22,` : "") +
    // Asked for around home when the portal will take it: a national list
    // of twenty-five holds one or two postings a person here could reach.
    (near ? `latitude=${near.lat},longitude=${near.lon},radius=${near.miles},radiusUnit=MI,` : "") +
    `sortBy=POSTING_DATES_DESC`;
  const j = await getJson(
    `https://${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList.secondaryLocations&finder=${finder}`,
  );
  return j?.items?.[0]?.requisitionList ?? [];
}

async function describe(host, site, id) {
  try {
    const j = await getJson(
      `https://${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;Id=%22${encodeURIComponent(id)}%22,siteNumber=${site}`,
    );
    const d = j?.items?.[0] ?? {};
    return plain(
      [d.ExternalDescriptionStr, d.ExternalResponsibilitiesStr, d.ExternalQualificationsStr, d.CorporateDescriptionStr]
        .filter(Boolean)
        .join("\n"),
    ).slice(0, 12000);
  } catch {
    return "";
  }
}

if (process.env.ORACLE_IMPORT_ONLY !== "1") {
  if (!SUPABASE_URL || !ANON_KEY || !AP_EMAIL || !AP_PASSWORD) {
    console.error("Missing SUPABASE_URL, SUPABASE_ANON_KEY, APPLYPILOT_EMAIL or APPLYPILOT_PASSWORD.");
    process.exit(1);
  }
  await auth({ email: AP_EMAIL, password: AP_PASSWORD }, "password");

  const [cfg] = (await db("search_config?id=eq.1&select=titles,exclude_titles")) ?? [{}];
  const titles = (cfg?.titles ?? []).filter(Boolean);
  const excludes = (cfg?.exclude_titles ?? []).filter(Boolean);

  const found = (await db("company_candidates?note=ilike.*runs%20on%20oracle%20at*&select=name,note&limit=500")) ?? [];
  const employers = found
    .map((r) => {
      const m = String(r.note).match(/oracle at ([a-z0-9.-]+\.oraclecloud\.com)\/sites\/([A-Za-z0-9_-]+)/i);
      return m ? { name: r.name, host: m[1], site: m[2] } : null;
    })
    .filter(Boolean);
  hideNames(employers.map((e) => e.name));
  console.log(`${employers.length} employer(s) on Oracle with a known site; ${titles.length} title(s); ${APPLY ? "saving postings" : "report only"}.`);

  const [prof] = (await db("profile?id=eq.1&select=home_lat,home_lon,state,home_state")) ?? [];
  NEAR = nearPattern(prof?.home_state || prof?.state || process.env.HOME_STATE);
  const home = prof?.home_lat != null && prof?.home_lon != null ? { lat: prof.home_lat, lon: prof.home_lon, miles: 50 } : null;
  let geoOk = null;

  const started = Date.now();
  const tally = { employers: 0, read: 0, wanted: 0, near: 0, fresh: 0, saved: 0, failed: 0 };
  let sampled = 0;
  // A different slice of the titles each run, so all of them are searched
  // over a day without asking every portal seventy-five questions at once.
  const turn = Math.floor(Date.now() / 3_600_000);

  for (const e of employers) {
    if (Date.now() - started > BUDGET_MS) break;
    tally.employers++;
    const seen = new Map();
    const terms = titles.length
      ? Array.from({ length: Math.min(TITLES_PER_EMPLOYER, titles.length) }, (_, i) => titles[(turn * TITLES_PER_EMPLOYER + i) % titles.length])
      : [""];
    let failed = null;
    for (const term of terms) {
      try {
        let got = null;
        if (home && geoOk !== false) {
          try {
            got = await search(e.host, e.site, term, home);
            if (geoOk === null) { geoOk = true; console.log("  searching around home works on this feed"); }
          } catch (err) {
            if (geoOk === null) { geoOk = false; console.log(`  searching around home was refused (${String(err?.message ?? err).slice(0, 40)}); reading the national list`); }
          }
        }
        got ??= await search(e.host, e.site, term);
        for (const r of got) if (r?.Id && !seen.has(r.Id)) seen.set(r.Id, r);
      } catch (err) {
        failed = String(err?.message ?? err).slice(0, 60);
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    const rows = [...seen.values()];
    tally.read += rows.length;
    if (!rows.length) {
      tally.failed++;
      console.log(`  ?  ${e.name} (${e.host}/${e.site}) — nothing read${failed ? ` (${failed})` : ""}`);
      continue;
    }
    if (sampled < 2) {
      sampled++;
      const r = rows[0];
      console.log(`  sample from ${e.name}: ${JSON.stringify({ ...shape({ Id: r.Id, Title: r.Title, PostedDate: r.PostedDate, PrimaryLocation: r.PrimaryLocation }), keys: Object.keys(r).slice(0, 14) }).slice(0, 500)}`);
    }

    const keep = [];
    for (const r of rows) {
      if (!wanted(r.Title, titles, excludes)) continue;
      tally.wanted++;
      const where = [r.PrimaryLocation, ...(r.secondaryLocations ?? []).map((x) => x?.Name)].filter(Boolean).join(" | ");
      if (!NEAR.test(where) && !/\bremote\b/i.test(String(r.Title))) continue;
      tally.near++;
      const posted = r.PostedDate ? new Date(r.PostedDate) : null;
      const posted_at = posted && Number.isFinite(posted.getTime()) ? posted.toISOString() : null;
      if (posted_at && posted.getTime() < Date.now() - FRESH_MS) continue;
      tally.fresh++;
      keep.push({ r, where, posted_at });
    }
    console.log(`  ok ${e.name} — ${rows.length} read, ${keep.length} wanted, nearby and fresh`);
    if (!APPLY || !keep.length) continue;

    const body = [];
    for (const k of keep.slice(0, 25)) {
      const url = `https://${e.host}/hcmUI/CandidateExperience/en/sites/${e.site}/job/${k.r.Id}`;
      body.push({
        url,
        apply_url: url,
        title: String(k.r.Title).slice(0, 200),
        company: e.name,
        // "Edison, NJ, United States" as "Edison, NJ".
        location: String(k.r.PrimaryLocation ?? "").replace(/,\s*United States.*$/i, "").slice(0, 120) || null,
        remote: /\bremote\b|\bvirtual\b/i.test(`${k.r.Title} ${k.where}`),
        description: await describe(e.host, e.site, k.r.Id),
        source: "oracle",
        ats: "oracle",
        posted_at: k.posted_at,
        status: "new",
      });
    }
    try {
      const saved = await db("jobs?on_conflict=user_id,url", {
        method: "POST",
        headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
        body: JSON.stringify(body),
      });
      tally.saved += saved?.length ?? 0;
    } catch (err) {
      console.log(`     could not save ${e.name}: ${String(err.message).slice(0, 140)}`);
    }
  }
  console.log(`result: ${JSON.stringify(tally)} in ${Math.round((Date.now() - started) / 60000)} min`);
  process.exit(0);
}
