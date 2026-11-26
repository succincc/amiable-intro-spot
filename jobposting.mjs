// Postings read from employers' own careers sites, by the tag they publish
// for search engines.
//
// Google's job search is not a list Google wrote. An employer marks each
// opening on its own site with a block of structured data called JobPosting —
// title, place, the date it was posted, the date it closes — and Google
// collects those. The blocks are public and meant to be read by programs, so
// this reads them where they are published: on the employer's site, which is
// also where the application is.
//
// It covers the employers the resolver could not place on a portal the
// applier has been taught — the ones with an application built into their
// own website, or on a system nothing here speaks yet. What it finds goes
// into the same queue as every other source, with no portal named, and the
// applier's general form-filler takes it from there.
//
// Nothing is signed in to and no search engine is asked anything.
//
// Free: a public-repo runner and public pages.

import { guardLogs, hideNames } from "./quiet.mjs";
import { FRESH_MS } from "./fresh.mjs";
import { nearPattern } from "./near.mjs";
// Nothing this prints names an employer, a posting or a place: see quiet.mjs.
guardLogs();
const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const AP_EMAIL = process.env.APPLYPILOT_EMAIL;
const AP_PASSWORD = process.env.APPLYPILOT_PASSWORD;
const APPLY = process.env.APPLY === "true"; // off: look and report, write nothing
const MAX_EMPLOYERS = Number(process.env.MAX_EMPLOYERS || 120);
const PAGES_PER_EMPLOYER = Number(process.env.PAGES_PER_EMPLOYER || 14);
const BUDGET_MS = Number(process.env.BUDGET_MINUTES || 25) * 60_000;
const ONLY = String(process.env.ONLY_URLS || "").trim(); // Name|https://…,Name|https://…

// Made from the owner's state once the profile is read.
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

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
async function getText(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(20_000),
    redirect: "follow",
    headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get("content-type") ?? "";
  if (!/html|xml|json|text/i.test(type)) throw new Error("not a page");
  return { text: (await res.text()).slice(0, 3_000_000), final: res.url };
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// Most large employers draw their careers site with JavaScript: the page a
// plain request gets back is an empty frame, and the postings and their
// structured data exist only once it has run. For those, a real browser
// opens the page the way a visitor's would. Used only when the plain request
// found nothing, and only for a limited number of sites a run.
const USE_BROWSER = process.env.USE_BROWSER !== "false";
const BROWSER_SITES = Number(process.env.BROWSER_SITES || 45);
let BROWSER = null;
let browserUsed = 0;
async function withBrowser(url) {
  if (!BROWSER) {
    const { chromium } = await import("playwright");
    BROWSER = await chromium.launch();
  }
  const ctx = await BROWSER.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25_000 });
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
    await page.waitForTimeout(1500);
    return { text: (await page.content()).slice(0, 3_000_000), final: page.url() };
  } finally {
    await ctx.close().catch(() => {});
  }
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

const flat = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/\b(inc|llc|ltd|corp|corporation|co|company|group|holdings|plc|lp|the)\b\.?/g, " ")
    .replace(/[^a-z0-9]+/g, "");

const plain = (html) =>
  String(html ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/<(br|\/p|\/li|\/div|\/h\d)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();

/**
 * Every JobPosting block in a page.
 *
 * The data sits in <script type="application/ld+json">, as one object, a
 * list, or an "@graph" of several things of which a posting is one.
 */
export function postingsIn(html) {
  const out = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let data;
    try {
      data = JSON.parse(m[1].trim().replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, ""));
    } catch {
      continue;
    }
    const walk = (node, depth = 0) => {
      if (!node || depth > 4) return;
      if (Array.isArray(node)) return node.forEach((n) => walk(n, depth + 1));
      if (typeof node !== "object") return;
      const type = [].concat(node["@type"] ?? []).map(String);
      if (type.includes("JobPosting")) out.push(node);
      if (node["@graph"]) walk(node["@graph"], depth + 1);
      if (type.includes("ItemList") && node.itemListElement) walk(node.itemListElement.map((x) => x?.item ?? x), depth + 1);
    };
    walk(data);
  }
  return out;
}

/** One posting, as the queue wants it; null when it cannot be used. */
export function shape(p, pageUrl, employer) {
  const title = String(p.title ?? p.name ?? "").replace(/\s+/g, " ").trim();
  if (!title) return null;
  const places = [].concat(p.jobLocation ?? []).map((l) => {
    const a = l?.address ?? l ?? {};
    if (typeof a === "string") return a;
    return [a.addressLocality, a.addressRegion].filter(Boolean).join(", ");
  }).filter(Boolean);
  const remote = /telecommute|remote/i.test(String(p.jobLocationType ?? "")) || /\bremote\b/i.test(title);
  const posted = Date.parse(p.datePosted ?? "");
  const closes = Date.parse(p.validThrough ?? "");
  const org = typeof p.hiringOrganization === "string" ? p.hiringOrganization : p.hiringOrganization?.name;
  let url = pageUrl;
  try {
    if (p.url) url = new URL(String(p.url), pageUrl).toString();
  } catch {
    /* keep the page's own address */
  }
  return {
    title: title.slice(0, 200),
    where: places.join(" | "),
    location: places[0]?.slice(0, 120) || null,
    remote,
    posted_at: Number.isFinite(posted) ? new Date(posted).toISOString() : null,
    closes_at: Number.isFinite(closes) ? new Date(closes).toISOString() : null,
    org: org ? String(org).slice(0, 120) : null,
    description: plain(p.description).slice(0, 12_000),
    url,
    company: employer,
  };
}

/** Posted within two weeks, or closing within one. Undated is not fresh. */
export function fresh(j, now = Date.now()) {
  if (j.closes_at && Date.parse(j.closes_at) < now) return false;
  if (j.posted_at && now - Date.parse(j.posted_at) <= FRESH_MS) return true;
  if (j.closes_at && Date.parse(j.closes_at) - now <= 7 * 86_400_000) return true;
  return false;
}

/** Links on a page that look like single job postings, best guesses first. */
export function jobLinks(html, base, titles, excludes) {
  const seen = new Map();
  const re = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    let url;
    try {
      url = new URL(m[1].replace(/&amp;/g, "&"), base);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(url.protocol)) continue;
    const text = plain(m[2]).slice(0, 140);
    let path = (url.pathname + url.search).toLowerCase();
    try {
      path = decodeURIComponent(path);
    } catch {
      /* an address with a stray % in it; read it as it is */
    }
    const looksLikeJob = /\/(jobs?|careers?|positions?|openings?|vacanc|requisitions?|opportunit|posting)/.test(path) || /job|req|position/.test(url.search.toLowerCase());
    if (!looksLikeJob) continue;
    // The link's own words, or the words in its address, name a wanted title.
    const slug = path.replace(/[^a-z0-9]+/g, " ");
    const score = wanted(text, titles, excludes) ? 2 : wanted(slug, titles, excludes) ? 1 : 0;
    if (!score) continue;
    const key = url.origin + url.pathname + url.search;
    if (!seen.has(key) || seen.get(key) < score) seen.set(key, score);
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([u]) => u);
}

/**
 * The link on a careers page that leads to the list itself: "search jobs",
 * "view all openings". A landing page is mostly pictures; the postings are
 * one press further in.
 */
export function listLink(html, base) {
  const re = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let best = null;
  let m;
  while ((m = re.exec(html))) {
    const text = plain(m[2]).slice(0, 80).toLowerCase();
    if (!/\b(search (all |our |open )?(jobs|careers|openings|positions|roles)|(view|see|browse|explore|find) (all |our |open |current )?(jobs|openings|positions|opportunities|roles|careers)|all (jobs|openings|positions)|open (positions|roles|jobs)|job (search|openings|opportunities|listings)|current (openings|opportunities|vacancies)|find (a|your) (job|role)|search and apply)\b/.test(text)) continue;
    let url;
    try {
      url = new URL(m[1].replace(/&amp;/g, "&"), base);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(url.protocol)) continue;
    // The shorter wording is the plainer link; a link out to a taught portal
    // is the resolver's to follow, not this reader's.
    if (/myworkdayjobs|greenhouse\.io|lever\.co|icims\.com|linkedin\.com|indeed\.com|glassdoor/i.test(url.hostname)) continue;
    if (!best || text.length < best.text.length) best = { url: url.href, text };
  }
  return best?.url ?? null;
}

/** Sitemaps a site names in its robots file. */
export function sitemapsIn(robots) {
  return [...String(robots ?? "").matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]).slice(0, 6);
}

/** Job addresses named in the site's own map, where it has one. */
async function fromSitemap(origin, titles, excludes) {
  const out = [];
  const queue = [`${origin}/sitemap.xml`];
  try {
    for (const u of sitemapsIn((await getText(`${origin}/robots.txt`)).text)) if (!queue.includes(u)) queue.push(u);
  } catch {
    /* no robots file is no news */
  }
  let fetched = 0;
  while (queue.length && fetched < 8) {
    const u = queue.shift();
    fetched++;
    let xml;
    try {
      xml = (await getText(u)).text;
    } catch {
      continue;
    }
    for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
      const loc = m[1].replace(/&amp;/g, "&");
      if (/sitemap[^/]*\.xml/i.test(loc)) {
        if (/job|career|position/i.test(loc)) queue.push(loc);
        continue;
      }
      let slug = loc.toLowerCase();
      try {
        slug = decodeURIComponent(slug);
      } catch {
        /* as above */
      }
      slug = slug.replace(/[^a-z0-9]+/g, " ");
      if (/\b(jobs?|careers?|positions?|openings?)\b/.test(slug) && wanted(slug, titles, excludes)) out.push(loc);
      if (out.length >= 40) return out;
    }
  }
  return out;
}

async function readEmployer(e, titles, excludes, tally) {
  const found = new Map();
  let pages = 0;
  const take = (html, url) => {
    for (const p of postingsIn(html)) {
      tally.postings++;
      const j = shape(p, url, e.name);
      if (j && !found.has(j.url + "|" + j.title)) found.set(j.url + "|" + j.title, j);
    }
  };

  let start = null;
  let why = "";
  try {
    start = await getText(e.url);
  } catch (err) {
    why = String(err?.message ?? err).slice(0, 30);
  }
  let links = [];
  if (start) {
    pages++;
    take(start.text, start.final);
    links = jobLinks(start.text, start.final, titles, excludes);
  }

  // Nothing readable in the plain page: refused, or an empty frame.
  let viaBrowser = false;
  if (USE_BROWSER && browserUsed < BROWSER_SITES && !found.size && !links.length && !/HTTP 404|HTTP 410/.test(why)) {
    try {
      browserUsed++;
      start = await withBrowser(e.url);
      viaBrowser = true;
      pages++;
      take(start.text, start.final);
      links = jobLinks(start.text, start.final, titles, excludes);
    } catch (err) {
      why = why || String(err?.message ?? err).slice(0, 30);
    }
  }
  if (!start) return { found: [], note: `could not open (${why})`, pages };

  // One press further in, where the page offers a way to the list itself.
  if (!found.size && !links.length) {
    const list = listLink(start.text, start.final);
    if (list && list !== start.final) {
      try {
        let page = await getText(list).catch(() => null);
        let got = page ? jobLinks(page.text, page.final, titles, excludes) : [];
        if (page) take(page.text, page.final);
        if (!got.length && !found.size && USE_BROWSER && browserUsed < BROWSER_SITES) {
          browserUsed++;
          page = await withBrowser(list).catch(() => page);
          if (page) {
            viaBrowser = true;
            take(page.text, page.final);
            got = jobLinks(page.text, page.final, titles, excludes);
          }
        }
        if (page) {
          pages++;
          tally.furtherIn = (tally.furtherIn ?? 0) + 1;
          links = got;
          start = page;
        }
      } catch {
        /* the landing page stands */
      }
    }
  }

  const origin = new URL(start.final).origin;
  if (links.length < PAGES_PER_EMPLOYER) {
    // The site's own map, and those of its jobs and careers addresses.
    const base = new URL(origin).hostname.replace(/^(www|careers?|jobs?)\./, "");
    const origins = [origin, ...[`https://careers.${base}`, `https://jobs.${base}`].filter((o) => o !== origin)];
    for (const o of origins) {
      const before = links.length;
      for (const u of await fromSitemap(o, titles, excludes)) if (!links.includes(u)) links.push(u);
      if (links.length > before) tally.fromMap = (tally.fromMap ?? 0) + 1;
      if (links.length >= PAGES_PER_EMPLOYER) break;
    }
  }
  for (const u of links.slice(0, (viaBrowser ? Math.min(8, PAGES_PER_EMPLOYER) : PAGES_PER_EMPLOYER) - 1)) {
    try {
      let page = null;
      if (!viaBrowser) page = await getText(u).catch(() => null);
      // A job page that only carries its data once it has run.
      if (viaBrowser || (page && !/application\/ld\+json/i.test(page.text) && USE_BROWSER && browserUsed <= BROWSER_SITES)) {
        page = await withBrowser(u).catch(() => page);
      }
      if (!page) continue;
      pages++;
      take(page.text, page.final);
    } catch {
      /* one page failing is not the employer failing */
    }
    await pause(400);
  }
  return { found: [...found.values()], note: `${links.length} likely job link(s)${viaBrowser ? ", read with a browser" : ""}`, pages };

}

if (process.env.JOBPOSTING_IMPORT_ONLY !== "1") {
  if (!SUPABASE_URL || !ANON_KEY || !AP_EMAIL || !AP_PASSWORD) {
    console.error("Missing SUPABASE_URL, SUPABASE_ANON_KEY, APPLYPILOT_EMAIL or APPLYPILOT_PASSWORD.");
    process.exit(1);
  }
  await auth({ email: AP_EMAIL, password: AP_PASSWORD }, "password");

  const [cfg] = (await db("search_config?id=eq.1&select=titles,exclude_titles")) ?? [{}];
  // The owner's state, for keeping what is nearby. Never printed.
  const [home] = (await db("profile?id=eq.1&select=state,home_state").catch(() => [])) ?? [];
  NEAR = nearPattern(home?.home_state || home?.state || process.env.HOME_STATE);
  const titles = (cfg?.titles ?? []).filter(Boolean);
  const excludes = (cfg?.exclude_titles ?? []).filter(Boolean);

  let employers;
  if (ONLY) {
    employers = ONLY.split(",").map((x) => {
      const [name, url] = x.split("|").map((y) => y.trim());
      return { name, url };
    }).filter((x) => x.name && /^https?:\/\//.test(x.url ?? ""));
  } else {
    // The ones no taught portal covers — and the ones whose portal has a
    // reader that could not read their list — longest-unread first.
    const rows =
      (await db(`company_candidates?or=(status.eq.failed,note.ilike.*list%20not%20read*)&select=name,careers_url,resolved_url,note&order=checked_at.asc.nullsfirst&limit=1000`)) ?? [];
    const turn = Math.floor(Date.now() / (6 * 3_600_000));
    const startAt = rows.length ? (turn * MAX_EMPLOYERS) % rows.length : 0;
    employers = [...rows.slice(startAt), ...rows.slice(0, startAt)]
      .slice(0, MAX_EMPLOYERS)
      .map((r) => ({ name: r.name, url: r.resolved_url || r.careers_url }))
      .filter((x) => /^https?:\/\//.test(String(x.url ?? "")));
  }
  hideNames(employers.map((e) => e.name));
  console.log(`${employers.length} employer site(s) to read; ${titles.length} title(s); ${APPLY ? "saving postings" : "report only"}.`);

  const started = Date.now();
  const tally = { employers: 0, withData: 0, postings: 0, wanted: 0, near: 0, fresh: 0, saved: 0 };
  for (const e of employers) {
    if (Date.now() - started > BUDGET_MS) break;
    tally.employers++;
    const got = await readEmployer(e, titles, excludes, tally).catch((err) => ({ found: [], note: String(err?.message ?? err).slice(0, 40), pages: 0 }));
    if (got.found.length) tally.withData++;

    const keep = [];
    for (const j of got.found) {
      // A page of someone else's jobs — a board, a parent company's feed.
      if (j.org && !(flat(j.org).includes(flat(e.name)) || flat(e.name).includes(flat(j.org)))) continue;
      if (!wanted(j.title, titles, excludes)) continue;
      tally.wanted++;
      if (!j.remote && !NEAR.test(j.where)) continue;
      tally.near++;
      if (!fresh(j)) continue;
      tally.fresh++;
      keep.push(j);
    }
    console.log(
      `  ${got.found.length ? "ok" : " ?"} ${e.name.slice(0, 34)} — ${got.pages} page(s), ${got.note}; ` +
        `${got.found.length} posting(s) marked up, ${keep.length} wanted, nearby and fresh`,
    );
    if (!APPLY || !keep.length) continue;

    try {
      const saved = await db("jobs?on_conflict=url", {
        method: "POST",
        headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
        body: JSON.stringify(
          keep.slice(0, 15).map((j) => ({
            url: j.url,
            apply_url: j.url,
            title: j.title,
            company: e.name,
            location: j.location,
            remote: j.remote,
            description: j.description,
            source: "jobposting",
            ats: null,
            posted_at: j.posted_at,
            status: "new",
          })),
        ),
      });
      tally.saved += saved?.length ?? 0;
    } catch (err) {
      console.log(`     could not save ${e.name.slice(0, 30)}: ${String(err.message).slice(0, 140)}`);
    }
    await pause(300);
  }
  console.log(`result: ${JSON.stringify(tally)}; ${browserUsed} site(s) needed a browser; ${Math.round((Date.now() - started) / 60000)} min`);
  if (BROWSER) await BROWSER.close().catch(() => {});
  process.exit(0);
}
