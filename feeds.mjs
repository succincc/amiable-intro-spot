// Employers that are hiring near home right now, from public job feeds.
//
// Indeed, LinkedIn and ZipRecruiter mostly list jobs that live somewhere
// else: the posting says "apply on company site" and the link goes to the
// employer's own Workday, Greenhouse or Oracle portal — the same portals the
// applier already completes. What those sites add is knowing WHICH employers
// have an opening this week. The same knowledge is published, for free and
// without an account, by feeds that exist to be read by programs.
//
// This reads those feeds for the owner's titles around home and hands the
// employers it finds to the resolver, which opens each one's careers site,
// finds the application system behind it and checks that system's own feed
// before anything is saved. Nothing is applied to from here, nothing is
// signed in to, and no posting is taken from an aggregator: the job is always
// read from, and applied for on, the employer's own portal.
//
// Sources:
//   Remotive, Jobicy, Remote OK, Himalayas, We Work Remotely, Working Nomads
//            — public, no key. (The Muse's feed is not answering.)
//   Adzuna   — free key (ADZUNA_APP_ID / ADZUNA_APP_KEY); skipped without one.
//   Jooble   — free key (JOOBLE_KEY); skipped without one.
//
// Free: a public-repo runner and public feeds.

import { allRows } from "./pages.mjs";
import { guardLogs, hideNames, shape } from "./quiet.mjs";
import { FRESH_DAYS, FRESH_MS } from "./fresh.mjs";
// Nothing this prints names an employer, a posting or a place: see quiet.mjs.
guardLogs();
const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
// Whose round this is, when the runner is doing somebody else's: see forusers.mjs.
const ACT_AS = process.env.AP_ACT_AS ? { "x-act-as": process.env.AP_ACT_AS } : {};
const AP_EMAIL = process.env.APPLYPILOT_EMAIL;
const AP_PASSWORD = process.env.APPLYPILOT_PASSWORD;
const APPLY = process.env.APPLY === "true"; // off: look and report, write nothing
const MAX_NEW = Number(process.env.MAX_NEW || 150);

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

async function getJson(url, init = {}) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(25_000),
    ...init,
    headers: { "User-Agent": "applypilot-feeds/1.0", Accept: "application/json", ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

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

export const flat = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/\b(inc|llc|ltd|corp|corporation|co|company|group|holdings|plc|lp|the)\b\.?/g, " ")
    .replace(/[^a-z0-9]+/g, "");

/**
 * The employer's own careers address, guessed from its name. The resolver
 * treats it as a guess: it follows it to whatever is really there, and adds
 * nothing if it leads nowhere.
 */
export function guessCareersUrl(company) {
  const slug = flat(company);
  if (slug.length < 3 || slug.length > 30) return null;
  return `https://www.${slug}.com/careers`;
}

// Staffing firms and job boards post other employers' jobs under their own
// name; there is no portal of theirs to apply on.
const NOT_AN_EMPLOYER =
  /staffing|recruit|talent|search group|personnel|solutions inc|consulting group|jobot|cybercoders|robert half|adecco|randstad|kelly services|insight global|aerotek|teksystems|manpower|kforce|apex systems|beacon hill|actalent|motion recruitment|dice|lensa|talentify|jobs via|confidential|careerbuilder|ziprecruiter|indeed|linkedin|monster|glassdoor|upwork|appcast|joveo|vaco|collabera|mindlance|pyramid consulting|artech/i;

const fresh14 = (iso) => {
  const t = Date.parse(iso ?? "");
  return Number.isFinite(t) ? Date.now() - t <= FRESH_MS : true;
};

/**
 * The Muse: jobs by city, twenty to a page. The cities are the caller's to
 * give — the person's own town and the places they have listed — and none
 * is written here: this file is public, and a list of towns says where
 * somebody lives.
 */
async function fromMuse(titles, excludes, tally, places = []) {
  const out = [];
  for (const place of places) {
    for (let page = 1; page <= 12; page++) {
      let j;
      try {
        // Its pages have been numbered from 0 and from 1 at different times.
        j = await getJson(`https://www.themuse.com/api/public/jobs?location=${encodeURIComponent(place)}&page=${page}`).catch(
          () => getJson(`https://www.themuse.com/api/public/jobs?page=${page - 1}&location=${encodeURIComponent(place)}`),
        );
      } catch (e) {
        tally.errors.push(`muse ${place} p${page}: ${String(e?.message ?? e).slice(0, 30)}`);
        break;
      }
      const rows = j?.results ?? [];
      tally.read += rows.length;
      for (const r of rows) {
        if (!fresh14(r.publication_date)) continue;
        if (!wanted(r.name, titles, excludes)) continue;
        if (r?.company?.name) out.push({ name: r.company.name, source: "muse" });
      }
      if (page >= (j?.page_count ?? 1)) break;
      await pause(350);
    }
  }
  return out;
}

/** Remotive: remote jobs, searched by title. Public, no key. */
async function fromRemotive(titles, excludes, tally) {
  const out = [];
  for (const title of titles.slice(0, 25)) {
    let j;
    try {
      j = await getJson(`https://remotive.com/api/remote-jobs?search=${encodeURIComponent(title)}&limit=40`);
    } catch (e) {
      tally.errors.push(`remotive "${title.slice(0, 16)}": ${String(e?.message ?? e).slice(0, 30)}`);
      if (out.length === 0 && tally.errors.filter((x) => x.startsWith("remotive")).length >= 3) break;
      continue;
    }
    const rows = j?.jobs ?? [];
    tally.read += rows.length;
    for (const r of rows) {
      if (!fresh14(r.publication_date)) continue;
      if (!/usa|united states|north america|worldwide|anywhere|americas/i.test(String(r.candidate_required_location ?? ""))) continue;
      if (!wanted(r.title, titles, excludes)) continue;
      if (r?.company_name) out.push({ name: r.company_name, source: "remotive" });
    }
    await pause(1500);
  }
  return out;
}

/** Jobicy: remote jobs open to the United States. Public, no key. */
async function fromJobicy(titles, excludes, tally) {
  const out = [];
  let j;
  try {
    j = await getJson("https://jobicy.com/api/v2/remote-jobs?count=50&geo=usa");
  } catch (e) {
    tally.errors.push(`jobicy: ${String(e?.message ?? e).slice(0, 30)}`);
    return out;
  }
  const rows = j?.jobs ?? [];
  tally.read += rows.length;
  for (const r of rows) {
    if (!fresh14(r.pubDate)) continue;
    if (!wanted(r.jobTitle, titles, excludes)) continue;
    if (r?.companyName) out.push({ name: r.companyName, source: "jobicy" });
  }
  return out;
}

// A feed's first record, by field name and size only: enough to see from a
// run's log whether the feed still has the fields this reads.
const SHAPES_SHOWN = new Set();
function showShape(label, row) {
  if (!row || SHAPES_SHOWN.has(label)) return;
  SHAPES_SHOWN.add(label);
  console.log(`${label}: a record is made of ${JSON.stringify(shape(row)).slice(0, 500)}`);
}
/**
 * A posting's own "apply here" address, when it is on a job board this
 * system reads: the board is then known for certain, and nothing has to be
 * guessed from the employer's name. Returns the board's address, or null.
 */
const BOARD_LINK = [
  ["greenhouse", /^https?:\/\/(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/([a-z0-9_-]+)/i, (m) => `https://boards.greenhouse.io/${m[1]}`],
  ["lever", /^https?:\/\/jobs(?:\.eu)?\.lever\.co\/([a-z0-9_.-]+)/i, (m) => `https://jobs.lever.co/${m[1]}`],
  ["ashby", /^https?:\/\/jobs\.ashbyhq\.com\/([a-z0-9_.%-]+)/i, (m) => `https://jobs.ashbyhq.com/${m[1]}`],
  ["smartrecruiters", /^https?:\/\/(?:jobs|careers)\.smartrecruiters\.com\/([a-z0-9_-]+)/i, (m) => `https://jobs.smartrecruiters.com/${m[1]}`],
  ["workday", /^https?:\/\/([a-z0-9-]+\.wd\d+\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?[A-Za-z0-9_-]+)/i, (m) => `https://${m[1]}`],
];
const LINKS = {};
export function boardLink(url) {
  const u = String(url ?? "").trim();
  for (const [name, re, make] of BOARD_LINK) {
    const m = u.match(re);
    if (m && !/^(embed|search|jobs|careers)$/i.test(m[1])) {
      LINKS[name] = (LINKS[name] ?? 0) + 1;
      return make(m);
    }
  }
  if (u) LINKS.other = (LINKS.other ?? 0) + 1;
  return null;
}

const US_OR_ANYWHERE = /\b(usa?|u\.s\.a?\.?|united states|america|north america|americas|worldwide|anywhere|global|remote)\b/i;

/** Remote OK: every remote job it lists, in one request. Public, no key. */
async function fromRemoteOk(titles, excludes, tally) {
  const out = [];
  let j;
  try {
    j = await getJson("https://remoteok.com/api");
  } catch (e) {
    tally.errors.push(`remoteok: ${String(e?.message ?? e).slice(0, 30)}`);
    return out;
  }
  // The first item is the feed's own notice, not a job.
  const rows = (Array.isArray(j) ? j : []).filter((r) => r && (r.position || r.title));
  showShape("remoteok", rows[0]);
  tally.read += rows.length;
  for (const r of rows) {
    if (!fresh14(r.date)) continue;
    const where = String(r.location ?? "");
    if (where && !US_OR_ANYWHERE.test(where)) continue;
    if (!wanted(r.position ?? r.title, titles, excludes)) continue;
    if (r.company) out.push({ name: r.company, source: "remoteok", link: boardLink(r.apply_url) ?? boardLink(r.url) });
  }
  return out;
}

/** Himalayas: remote jobs, twenty to a page. Public, no key. */
async function fromHimalayas(titles, excludes, tally) {
  const out = [];
  for (let offset = 0; offset < 400; offset += 20) {
    let j;
    try {
      j = await getJson(`https://himalayas.app/jobs/api?limit=20&offset=${offset}`);
    } catch (e) {
      tally.errors.push(`himalayas @${offset}: ${String(e?.message ?? e).slice(0, 30)}`);
      break;
    }
    const rows = j?.jobs ?? [];
    if (!rows.length) break;
    showShape("himalayas", rows[0]);
    tally.read += rows.length;
    let old = 0;
    for (const r of rows) {
      const at = Number(r.pubDate) > 1e9 ? new Date(Number(r.pubDate) * (Number(r.pubDate) > 1e12 ? 1 : 1000)).toISOString() : r.pubDate;
      if (!fresh14(at)) { old++; continue; }
      const places = Array.isArray(r.locationRestrictions) ? r.locationRestrictions.join(" ") : String(r.locationRestrictions ?? "");
      if (places && !US_OR_ANYWHERE.test(places)) continue;
      if (!wanted(r.title, titles, excludes)) continue;
      if (r.companyName) out.push({ name: r.companyName, source: "himalayas", link: boardLink(r.applicationLink) });
    }
    // Newest first: a page that is all older than two weeks ends it.
    if (old === rows.length) break;
    await pause(1200);
  }
  return out;
}

/** We Work Remotely: its public feed, where a title reads "Company: Role". */
async function fromWeWorkRemotely(titles, excludes, tally) {
  const out = [];
  let xml;
  try {
    const res = await fetch("https://weworkremotely.com/remote-jobs.rss", {
      signal: AbortSignal.timeout(25_000),
      headers: { "User-Agent": "applypilot-feeds/1.0", Accept: "application/rss+xml, application/xml, text/xml" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    xml = await res.text();
  } catch (e) {
    tally.errors.push(`weworkremotely: ${String(e?.message ?? e).slice(0, 30)}`);
    return out;
  }
  const items = xml.split(/<item>/i).slice(1);
  tally.read += items.length;
  const tag = (item, name) => {
    const m = item.match(new RegExp(`<${name}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${name}>`, "i"));
    return m ? m[1].trim() : "";
  };
  for (const item of items) {
    if (!fresh14(tag(item, "pubDate"))) continue;
    const region = tag(item, "region");
    if (region && !US_OR_ANYWHERE.test(region)) continue;
    const full = tag(item, "title").replace(/&amp;/g, "&");
    const cut = full.indexOf(":");
    if (cut < 2) continue;
    const company = full.slice(0, cut).trim();
    const role = full.slice(cut + 1).trim();
    if (!wanted(role, titles, excludes)) continue;
    out.push({ name: company, source: "weworkremotely" });
  }
  return out;
}

/** Working Nomads: its public list of remote jobs. No key. */
async function fromWorkingNomads(titles, excludes, tally) {
  const out = [];
  let j;
  try {
    j = await getJson("https://www.workingnomads.com/api/exposed_jobs/");
  } catch (e) {
    tally.errors.push(`workingnomads: ${String(e?.message ?? e).slice(0, 30)}`);
    return out;
  }
  const rows = Array.isArray(j) ? j : [];
  showShape("workingnomads", rows[0]);
  tally.read += rows.length;
  for (const r of rows) {
    if (!fresh14(r.pub_date)) continue;
    const where = String(r.location ?? "");
    if (where && !US_OR_ANYWHERE.test(where)) continue;
    if (!wanted(r.title, titles, excludes)) continue;
    if (r.company_name) out.push({ name: r.company_name, source: "workingnomads" });
  }
  return out;
}

/** Adzuna: by title, within about forty miles of home, posted in two weeks. */
async function fromAdzuna(titles, excludes, where, tally) {
  const id = process.env.ADZUNA_APP_ID;
  const key = process.env.ADZUNA_APP_KEY;
  if (!id || !key) return null;
  const out = [];
  for (const title of titles.slice(0, 40)) {
    for (let page = 1; page <= 2; page++) {
      let j;
      try {
        j = await getJson(
          `https://api.adzuna.com/v1/api/jobs/us/search/${page}?app_id=${id}&app_key=${key}` +
            `&results_per_page=50&max_days_old=${FRESH_DAYS}&distance=65&where=${encodeURIComponent(where)}` +
            `&what=${encodeURIComponent(title)}&content-type=application/json`,
        );
      } catch (e) {
        tally.errors.push(`adzuna "${title.slice(0, 16)}": ${String(e?.message ?? e).slice(0, 30)}`);
        break;
      }
      const rows = j?.results ?? [];
      tally.read += rows.length;
      for (const r of rows) {
        if (!wanted(r.title, titles, excludes)) continue;
        if (r?.company?.display_name) out.push({ name: r.company.display_name, source: "adzuna" });
      }
      if (rows.length < 50) break;
      await pause(1200);
    }
  }
  return out;
}

/** Jooble: by title and place. */
async function fromJooble(titles, excludes, where, tally) {
  const key = process.env.JOOBLE_KEY;
  if (!key) return null;
  const out = [];
  // A few titles a run, a different few each time. What a free key allows
  // is not stated by the service and is reported as low; asked forty times
  // a run it would be spent in a week. Six a run, in turn, covers every
  // title every few days and lasts.
  const turn = Math.floor(Date.now() / (12 * 3_600_000));
  const startAt = titles.length ? (turn * 6) % titles.length : 0;
  for (const title of [...titles.slice(startAt), ...titles.slice(0, startAt)].slice(0, 6)) {
    let j;
    try {
      j = await getJson(`https://jooble.org/api/${key}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keywords: title, location: where, radius: "40", page: "1" }),
      });
    } catch (e) {
      tally.errors.push(`jooble "${title.slice(0, 16)}": ${String(e?.message ?? e).slice(0, 30)}`);
      continue;
    }
    const rows = j?.jobs ?? [];
    tally.read += rows.length;
    for (const r of rows) {
      if (!fresh14(r.updated)) continue;
      if (!wanted(r.title, titles, excludes)) continue;
      if (r?.company) out.push({ name: r.company, source: "jooble" });
    }
    await pause(900);
  }
  return out;
}

/**
 * ZipRecruiter, through the search it publishes for assistants: by title and
 * place, a few titles a run. Only the employers' names are kept.
 */
async function fromZipRecruiter(titles, excludes, where, tally) {
  // The endpoint refused this runner outright (403 at its front door) on
  // both tries. A refusal is not knocked on twice a day: this stays off
  // until ZipRecruiter grants access, and is switched on by a setting.
  if (process.env.ZIPRECRUITER !== "on") return null;
  const zip = await import("./zipmcp.mjs");
  let mcp;
  try {
    mcp = await zip.open();
  } catch (e) {
    tally.errors.push(`ziprecruiter: ${String(e?.message ?? e).slice(0, 220)}`);
    return [];
  }
  if (!mcp.tool) {
    tally.errors.push("ziprecruiter: no search tool offered");
    return [];
  }
  // What the tool takes, by name and kind; never what is put in it.
  const props = mcp.tool.inputSchema?.properties ?? {};
  console.log(`  ziprecruiter: tool "${mcp.tool.name}" takes ${JSON.stringify(Object.fromEntries(Object.entries(props).map(([k, v]) => [k, Array.isArray(v?.enum) ? v.enum : v?.type ?? "?"])))}`);
  const out = [];
  const turn = Math.floor(Date.now() / (12 * 3_600_000));
  const startAt = titles.length ? (turn * 6) % titles.length : 0;
  let shown = false;
  for (const title of [...titles.slice(startAt), ...titles.slice(0, startAt)].slice(0, 6)) {
    for (const offset of [0, 5]) {
      let result;
      try {
        result = await mcp.call(zip.argsFor(mcp.tool.inputSchema, { title, where, radius: 40, days: 30, offset }));
      } catch (e) {
        tally.errors.push(`ziprecruiter "${title.slice(0, 16)}": ${String(e?.message ?? e).slice(0, 40)}`);
        break;
      }
      const rows = zip.jobsIn(result);
      if (!shown) {
        shown = true;
        const kinds = (result?.content ?? []).map((c) => `${c?.type}${typeof c?.text === "string" ? ` of ${c.text.length}` : ""}`);
        console.log(`  ziprecruiter: an answer holds ${JSON.stringify(kinds)}${result?.structuredContent ? ` and a structure with ${JSON.stringify(Object.keys(result.structuredContent).slice(0, 8))}` : ""}; a posting has ${JSON.stringify(rows[0]?.keys?.slice(0, 16) ?? [])}`);
      }
      tally.read += rows.length;
      for (const r of rows) {
        if (r.posted && !fresh14(r.posted)) continue;
        if (!wanted(r.title, titles, excludes)) continue;
        out.push({ name: r.company, source: "ziprecruiter" });
      }
      if (rows.length < 5) break;
      await pause(1200);
    }
    await pause(900);
  }
  return out;
}

if (process.env.FEEDS_IMPORT_ONLY !== "1") {
  if (!SUPABASE_URL || !ANON_KEY || !AP_EMAIL || !AP_PASSWORD) {
    console.error("Missing SUPABASE_URL, SUPABASE_ANON_KEY, APPLYPILOT_EMAIL or APPLYPILOT_PASSWORD.");
    process.exit(1);
  }
  await auth({ email: AP_EMAIL, password: AP_PASSWORD }, "password");

  const [cfg] = (await db("search_config?id=eq.1&select=titles,exclude_titles")) ?? [{}];
  const titles = (cfg?.titles ?? []).filter(Boolean);
  const excludes = (cfg?.exclude_titles ?? []).filter(Boolean);
  // The town is the owner's; it is used in the request and not printed.
  const [prof] = (await db("profile?id=eq.1&select=city,state")) ?? [];
  const where = prof?.city && prof?.state ? `${prof.city}, ${prof.state}` : String(prof?.state ?? "");

  const tally = { read: 0, errors: [] };
  const hits = [];
  const bySource = {};
  for (const [label, run] of [
    // The Muse's public feed answered "not found" for every city on two
    // runs; it is kept in the file and left out of the round until it returns.
    ["remotive", () => fromRemotive(titles, excludes, tally)],
    ["jobicy", () => fromJobicy(titles, excludes, tally)],
    ["remoteok", () => fromRemoteOk(titles, excludes, tally)],
    ["himalayas", () => fromHimalayas(titles, excludes, tally)],
    ["weworkremotely", () => fromWeWorkRemotely(titles, excludes, tally)],
    ["workingnomads", () => fromWorkingNomads(titles, excludes, tally)],
    ["adzuna", () => fromAdzuna(titles, excludes, where, tally)],
    ["jooble", () => fromJooble(titles, excludes, where, tally)],
    ["ziprecruiter", () => fromZipRecruiter(titles, excludes, where, tally)],
  ]) {
    const got = await run().catch((e) => {
      tally.errors.push(`${label}: ${String(e?.message ?? e).slice(0, 40)}`);
      return [];
    });
    if (got === null) {
      console.log(`${label}: no key set, skipped`);
      continue;
    }
    bySource[label] = got.length;
    hits.push(...got);
  }

  // One row per employer, most openings first.
  const count = new Map();
  for (const h of hits) {
    const k = flat(h.name);
    if (!k || NOT_AN_EMPLOYER.test(h.name)) continue;
    const c = count.get(k) ?? { name: h.name.trim(), n: 0, link: null, near: false };
    c.n++;
    // A feed asked about the person's own town says the employer is hiring
    // there; a feed of remote jobs says nothing about where it is.
    if (["adzuna", "jooble", "ziprecruiter"].includes(h.source)) c.near = true;
    c.link ??= h.link ?? null;
    count.set(k, c);
  }
  const ranked = [...count.values()].sort((a, b) => b.n - a.n);

  const known = await allRows(db, "company_candidates?select=name,careers_url");
  const firms = await allRows(db, "companies?select=name");
  const names = new Set([...known, ...firms].map((r) => flat(r.name)));
  const urls = new Set(known.map((r) => String(r.careers_url ?? "").replace(/\/+$/, "").toLowerCase()));

  const fresh = [];
  for (const c of ranked) {
    if (names.has(flat(c.name))) continue;
    // The board the posting itself pointed at, where there was one; the
    // guess from the name otherwise.
    const url = c.link ?? guessCareersUrl(c.name);
    if (!url || urls.has(url.toLowerCase())) continue;
    urls.add(url);
    fresh.push({ name: c.name, careers_url: url, status: "pending", note: c.near ? "feed: near home" : "feed: remote" });
    if (fresh.length >= MAX_NEW) break;
  }

  console.log(
    `read ${tally.read} posting(s); matching the owner's titles and fresh: ${JSON.stringify(bySource)}; ` +
      `${ranked.length} employer(s), ${ranked.length - fresh.length} already known or unusable, ${fresh.length} new`,
  );
  console.log(`"apply here" addresses, by the system they are on: ${JSON.stringify(LINKS)}`);
  console.log(`most openings at one employer: ${JSON.stringify(ranked.slice(0, 25).map((c) => c.n))}`);
  if (tally.errors.length) console.log(`errors: ${JSON.stringify(tally.errors.slice(0, 8))}`);

  if (APPLY && fresh.length) {
    for (let i = 0; i < fresh.length; i += 50) {
      await db("company_candidates?on_conflict=user_id,careers_url", {
        method: "POST",
        headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
        body: JSON.stringify(fresh.slice(i, i + 50)),
      });
    }
    console.log(`added ${fresh.length} employer(s) for the resolver to look at.`);
  } else if (fresh.length) {
    console.log(`report only: would add ${fresh.length} employer(s)`);
  }
}
