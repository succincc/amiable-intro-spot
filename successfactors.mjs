// Postings from employers whose careers site runs on SAP SuccessFactors.
//
// Of the first 150 employers the resolver looked at in one sitting, 36 run on
// it — more than every other system without a lane of its own put together.
//
// A SuccessFactors careers site is the employer's own address ("jobs.…com")
// in front of a standard search page: /search/?q=…&locationsearch=…, rows of
// title, place and date. Newer ones draw the same list from a small public
// service the page itself calls. This asks whichever the site answers to, the
// way a visitor's browser does, for postings in the owner's state, and keeps
// what matches their titles and is fresh. Nothing is signed in to.
//
// With APPLY set the postings kept are saved for the applier, which has its
// own lane for this system; without it they are counted and reported only.
//
// Free: a public-repo runner and public pages.

import { guardLogs, hideNames, shape } from "./quiet.mjs";
import { nearPattern, stateName } from "./near.mjs";
// Nothing this prints names an employer, a posting or a place: see quiet.mjs.
guardLogs();
const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const AP_EMAIL = process.env.APPLYPILOT_EMAIL;
const AP_PASSWORD = process.env.APPLYPILOT_PASSWORD;
const APPLY = process.env.APPLY === "true"; // off: look and report, write nothing
const MAX = Number(process.env.MAX_EMPLOYERS || 40);
const BUDGET_MS = Number(process.env.BUDGET_MINUTES || 20) * 60_000;
// For trying it against a handful of addresses without the list:
//   SF_URLS="Example|https://jobs.example.com,Other|https://careers.other.example"
const LOCAL = String(process.env.SF_URLS || "").trim();
// The site's own place search is loose — asked for New Jersey, some return
// everything they have. Postings are kept only where the owner could work:
// these states, or remote. Distance from home is measured afterwards like
// everything else.
// The pattern is made from the owner's state once the profile is read.
let NEAR = nearPattern(process.env.HOME_STATE);

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
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function get(url, accept = "text/html,application/xhtml+xml") {
  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(25_000),
    headers: { "User-Agent": UA, Accept: accept, "Accept-Language": "en-US,en;q=0.9" },
  });
  return { status: res.status, url: res.url, text: res.ok ? await res.text() : "" };
}

const unescape = (s) =>
  String(s ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&rsquo;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ")
    .trim();

/** Does this title look like one the owner searches for? (As oracle.mjs.) */
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

/**
 * The rows of a classic SuccessFactors search page.
 *
 *   <tr class="data-row"> … <a class="jobTitle-link" href="/job/Town-Title-NJ-08854/123456700/">Title</a>
 *   … <span class="jobLocation">Piscataway, NJ, US, 08854</span>
 *   … <span class="jobDate">Nov 24, 2026</span>
 *
 * Every row carries its title twice, once for wide screens and once for
 * phones; a posting is counted once, by its address.
 */
export function rowsIn(html, origin) {
  const out = new Map();
  const text = String(html ?? "");
  // A table row on the older sites, a tile on the newer ones; either way the
  // element is marked, and a posting runs from one mark to the next.
  const rows = text.split(/<(?:tr|li|div)[^>]*class="[^"]*\b(?:data-row|job-tile)\b[^"]*"[^>]*>/i).slice(1);
  for (const row of rows) {
    const link = row.match(/<a[^>]*href=["']([^"']*\/job\/[^"']+)["'][^>]*class=["'][^"']*jobTitle-link[^"']*["'][^>]*>([\s\S]*?)<\/a>/i) ??
      row.match(/<a[^>]*class=["'][^"']*jobTitle-link[^"']*["'][^>]*href=["']([^"']*\/job\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    let url;
    try {
      // The address is written into the page as text, so an apostrophe in a
      // title arrives as "&apos;" and has to be read back before it is one.
      const href = link[1].replace(/&amp;/g, "&").replace(/&apos;|&#39;|&#x27;/gi, "'").replace(/&quot;/g, '"');
      url = new URL(href, origin).toString();
    } catch {
      continue;
    }
    if (out.has(url)) continue;
    const where =
      row.match(/<span[^>]*class="[^"]*\bjobLocation\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i) ??
      row.match(/<[a-z]+[^>]*id="[^"]*section-location-value"[^>]*>([\s\S]*?)<\/[a-z]+>/i);
    const when =
      row.match(/<span[^>]*class="[^"]*\bjobDate\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i) ??
      row.match(/<[a-z]+[^>]*id="[^"]*section-date-value"[^>]*>([\s\S]*?)<\/[a-z]+>/i);
    // "New York, NY, US, 10001 +80 more…" is the first of many places.
    const place = unescape(where?.[1]).replace(/\s*\+\s*\d+\s+more.*$/i, "").trim();
    const more = /\+\s*\d+\s+more/i.test(unescape(where?.[1]));
    out.set(url, { url, title: unescape(link[2]), location: place, posted: unescape(when?.[1]), ...(more ? { more: true } : {}) });
  }
  return [...out.values()];
}

/** "Piscataway, NJ, US, 08854" as "Piscataway, NJ". */
export function placeOf(location) {
  const parts = String(location ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  const kept = parts.filter((p) => !/^(us|usa|united states)$/i.test(p) && !/^\d{5}(-\d{4})?$/.test(p));
  return kept.slice(0, 2).join(", ");
}

/** A posting's date as the site prints it, or null where it prints none. */
export function postedAt(text) {
  const t = String(text ?? "").trim();
  if (!t) return null;
  const d = new Date(/\d{4}/.test(t) ? `${t} 12:00 UTC` : t);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/** What one employer's site answers to, and what it lists for a place. */
async function read(origin, place) {
  const seen = { how: null, rows: [], notes: [] };
  // The classic search page, newest first: page after page until one is
  // short, or everything on it is older than a posting is wanted for.
  for (const start of [0, 25, 50, 75, 100, 125]) {
    const url = `${origin}/search/?q=&locationsearch=${encodeURIComponent(place)}&sortColumn=referencedate&sortDirection=desc${start ? `&startrow=${start}` : ""}`;
    let page;
    try {
      page = await get(url);
    } catch (e) {
      seen.notes.push(`search: ${String(e?.message ?? e).slice(0, 40)}`);
      break;
    }
    if (page.status !== 200) {
      seen.notes.push(`search: HTTP ${page.status}`);
      break;
    }
    const rows = rowsIn(page.text, origin);
    if (start === 0) {
      // What kind of page came back, by its markers — how the next shape
      // gets learned when this one finds no rows.
      const marks = {
        rows: rows.length,
        dataRow: (page.text.match(/\bdata-row\b/g) ?? []).length,
        titleLink: (page.text.match(/jobTitle-link/g) ?? []).length,
        service: /services\/recruiting\/v1|\/api\/jobs|csb\/|careerSiteBuilder|xweb\/rmk/i.test(page.text),
        bytes: page.text.length,
        landed: new URL(page.url).pathname.slice(0, 40),
      };
      seen.notes.push(`search page ${JSON.stringify(marks)}`);
    }
    if (!rows.length) break;
    seen.how = "search page";
    seen.rows.push(...rows);
    if (rows.length < 20) break;
    const dates = rows.map((r) => postedAt(r.posted)).filter(Boolean).map((d) => new Date(d).getTime());
    if (dates.length && Math.max(...dates) < Date.now() - 14 * 86_400_000) break;
    await pause(500);
  }
  if (seen.rows.length) return seen;

  // The service a newer site's own page calls for its list.
  try {
    const res = await fetch(`${origin}/services/recruiting/v1/jobs`, {
      method: "POST",
      signal: AbortSignal.timeout(25_000),
      headers: { "User-Agent": UA, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ locale: "en_US", pageNumber: 0, sortBy: "date", keywords: "", location: place, facetFilters: {}, brand: "", skills: [], categoryId: 0, alertId: "", rcmCandidateId: "" }),
    });
    const body = res.ok ? await res.json().catch(() => null) : null;
    const list = body?.jobSearchResult ?? body?.jobs ?? [];
    seen.notes.push(`service: HTTP ${res.status}, ${Array.isArray(list) ? list.length : 0} posting(s)${body ? `, keys ${JSON.stringify(Object.keys(body).slice(0, 8))}` : ""}`);
    if (Array.isArray(list) && list.length) {
      seen.how = "service";
      const first = list[0]?.response ?? list[0];
      seen.notes.push(`service row keys ${JSON.stringify(Object.keys(first ?? {}).slice(0, 16))}`);
      for (const item of list) {
        const r = item?.response ?? item;
        const id = r?.id ?? r?.jobReqId;
        const title = r?.unifiedStandardTitle ?? r?.title ?? r?.jobTitle;
        if (!id || !title) continue;
        const slug = String(r?.urlTitle ?? r?.unifiedUrlTitle ?? title).replace(/[^A-Za-z0-9]+/g, "-");
        seen.rows.push({
          url: `${origin}/job/${slug}/${id}-en_US`,
          title: String(title),
          location: Array.isArray(r?.jobLocationShort) ? r.jobLocationShort.join(" | ") : String(r?.jobLocationShort ?? r?.location ?? ""),
          posted: String(r?.unifiedStandardStart ?? r?.postingStartDate ?? r?.startDate ?? ""),
        });
      }
    }
  } catch (e) {
    seen.notes.push(`service: ${String(e?.message ?? e).slice(0, 40)}`);
  }
  return seen;
}

if (process.env.SF_IMPORT_ONLY !== "1") {
  let employers = [];
  let titles = [];
  let excludes = [];
  let state = stateName(process.env.HOME_STATE) ?? "";
  if (LOCAL) {
    employers = LOCAL.split(",").map((pair) => {
      const [name, url] = pair.split("|");
      return { name: name.trim(), origin: new URL(url.trim()).origin };
    });
  } else {
    if (!SUPABASE_URL || !ANON_KEY || !AP_EMAIL || !AP_PASSWORD) {
      console.error("Missing SUPABASE_URL, SUPABASE_ANON_KEY, APPLYPILOT_EMAIL or APPLYPILOT_PASSWORD.");
      process.exit(1);
    }
    await auth({ email: AP_EMAIL, password: AP_PASSWORD }, "password");
    const [cfg] = (await db("search_config?id=eq.1&select=titles,exclude_titles")) ?? [{}];
    titles = (cfg?.titles ?? []).filter(Boolean);
    excludes = (cfg?.exclude_titles ?? []).filter(Boolean);
    // The owner's state: used to ask each site for postings there and to
    // keep the ones nearby. Never printed.
    const [prof] = (await db("profile?id=eq.1&select=state,home_state").catch(() => [])) ?? [];
    const home = prof?.home_state || prof?.state || process.env.HOME_STATE;
    NEAR = nearPattern(home);
    state = stateName(home) ?? "";
    const found =
      (await db(`company_candidates?note=ilike.*runs%20on%20successfactors*&select=id,name,note,careers_url,resolved_url&order=checked_at.desc.nullslast&limit=${MAX}`)) ?? [];
    for (const r of found) {
      // The page the resolver ended on is the employer's own careers site,
      // which is where the search page lives; SAP's own hosts are where the
      // application is, and have no list to read.
      for (const raw of [r.resolved_url, r.careers_url]) {
        try {
          const u = new URL(raw);
          if (/successfactors\.|sapsf\.|jobs2web\./i.test(u.hostname)) continue;
          employers.push({ name: r.name, origin: u.origin, id: r.id, note: String(r.note ?? "") });
          break;
        } catch {
          /* try the other */
        }
      }
    }
  }
  hideNames(employers.map((e) => e.name));
  console.log(`${employers.length} employer(s) on SuccessFactors with a site of their own; ${titles.length} title(s); ${APPLY ? "saving postings" : "report only"}.`);

  // An employer whose list this cannot read is said so on its record, so
  // that the reader of employers' own pages takes it up instead of nobody
  // doing so; and unsaid the day the list reads.
  const UNREAD = "; list not read";
  const mark = async (e, read) => {
    if (!APPLY || !e.id || read === !e.note.includes(UNREAD)) return;
    const note = read ? e.note.replace(UNREAD, "") : `${e.note}${UNREAD}`.slice(0, 380);
    await db(`company_candidates?id=eq.${e.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ note }) }).catch(() => {});
  };

  const started = Date.now();
  const tally = { employers: 0, answered: 0, bySearchPage: 0, byService: 0, read: 0, wanted: 0, near: 0, fresh: 0, saved: 0 };
  let sampled = 0;
  for (const e of employers) {
    if (Date.now() - started > BUDGET_MS) break;
    tally.employers++;
    const seen = await read(e.origin, state).catch((err) => ({ how: null, rows: [], notes: [String(err?.message ?? err).slice(0, 60)] }));
    if (!seen.rows.length) {
      console.log(`  ?  ${e.name} (${new URL(e.origin).hostname}) — nothing read; ${seen.notes.join("; ").slice(0, 300)}`);
      await mark(e, false);
      await pause(400);
      continue;
    }
    tally.answered++;
    await mark(e, true);
    if (seen.how === "service") tally.byService++;
    else tally.bySearchPage++;
    tally.read += seen.rows.length;
    if (sampled < 3) {
      sampled++;
      // An employer's own public posting; nothing of the owner's.
      console.log(`  sample from ${e.name} by ${seen.how}: ${JSON.stringify(shape(seen.rows[0])).slice(0, 320)}`);
      if (seen.how === "service") console.log(`     ${seen.notes.filter((n) => n.startsWith("service")).join("; ").slice(0, 400)}`);
    }
    const keep = [];
    for (const r of seen.rows) {
      if (!wanted(r.title, titles, excludes)) continue;
      tally.wanted++;
      if (!NEAR.test(r.location) && !/\bremote\b/i.test(r.title)) continue;
      tally.near++;
      const posted_at = postedAt(r.posted);
      if (posted_at && new Date(posted_at).getTime() < Date.now() - 14 * 86_400_000) continue;
      tally.fresh++;
      keep.push({ ...r, posted_at });
    }
    console.log(`  ok ${e.name} — ${seen.rows.length} read by ${seen.how}, ${keep.length} wanted, nearby and fresh`);

    if (APPLY && keep.length) {
      const body = keep.slice(0, 25).map((k) => ({
        url: k.url,
        apply_url: k.url,
        title: k.title.slice(0, 200),
        company: e.name,
        location: placeOf(k.location).slice(0, 120) || null,
        remote: /\bremote\b|\bvirtual\b/i.test(`${k.title} ${k.location}`),
        description: "",
        source: "successfactors",
        ats: "successfactors",
        posted_at: k.posted_at,
        status: "new",
      }));
      try {
        const saved = await db("jobs?on_conflict=url", {
          method: "POST",
          headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
          body: JSON.stringify(body),
        });
        tally.saved += saved?.length ?? 0;
      } catch (err) {
        console.log(`     could not save ${e.name}: ${String(err.message).slice(0, 140)}`);
      }
    }
    await pause(600);
  }
  console.log(`result: ${JSON.stringify(tally)} in ${Math.round((Date.now() - started) / 60000)} min`);
  process.exit(0);
}
