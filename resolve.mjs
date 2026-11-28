// Find the application system behind an employer's careers page — with a
// real browser.
//
// The employer list holds each company's own careers address, and the panel
// resolves it by fetching that address and reading the markup. About a third
// resolve that way. The rest do not, and not because they run on anything
// exotic: a large employer's careers site draws itself with JavaScript, so
// the link to its Workday tenant or Greenhouse board is simply not in the
// HTML a plain fetch receives. It appears when the page runs, or one click
// further in — on the search page, or on the Apply button of a posting.
//
// So this does what a person would: open the page, look at where it reaches
// and what it links to, follow "search jobs", open a posting, look at where
// Apply goes. Whatever it finds is checked against that system's own public
// job feed before anything is saved, so a wrong guess cannot become a company
// row that quietly returns nothing.
//
// It also names the system when it is one the applier cannot use yet. A count
// of how many employers sit on each is the honest answer to "which portal is
// worth building next".
//
// Free: a GitHub runner, a browser, and public pages. Nothing is logged in to.

import { guardLogs, hideNames } from "./quiet.mjs";
// Nothing this prints names an employer, a posting or a place: see quiet.mjs.
guardLogs();
import { chromium } from "playwright";
import fs from "node:fs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
// Whose round this is, when the runner is doing somebody else's: see forusers.mjs.
const ACT_AS = process.env.AP_ACT_AS ? { "x-act-as": process.env.AP_ACT_AS } : {};
const AP_EMAIL = process.env.APPLYPILOT_EMAIL;
const AP_PASSWORD = process.env.APPLYPILOT_PASSWORD;
const APPLY = process.env.APPLY === "true"; // off: look and report, write nothing
const MAX = Number(process.env.MAX_CANDIDATES || 400);
const WORKERS = Math.max(1, Number(process.env.WORKERS || 4));
const BUDGET_MS = Number(process.env.BUDGET_MINUTES || 50) * 60_000;
const PER_SITE_MS = 80_000;
// For trying it against a handful of addresses without a database:
//   RESOLVE_URLS="Target|https://jobs.target.com/,Stripe|https://stripe.com/jobs"
const LOCAL = String(process.env.RESOLVE_URLS || "").trim();

// ---------------------------------------------------------------------------
// Database, the same way measure.mjs talks to it
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Reading an address: which system is this, and what does its feed need
// ---------------------------------------------------------------------------
const LOCALE = /^[a-z]{2}(-[a-z]{2,4})?$/i;

// Systems the applier cannot fill in yet. Recognised so they can be counted.
const OTHER = [
  [/(^|\.)icims\.com$/, "icims"],
  [/(^|\.)taleo\.net$/, "taleo"],
  [/(^|\.)oraclecloud\.com$/, "oracle"],
  [/(^|\.)(successfactors\.(com|eu)|sapsf\.(com|eu)|jobs2web\.com)$/, "successfactors"],
  [/(^|\.)eightfold\.ai$/, "eightfold"],
  [/(^|\.)brassring\.com$/, "brassring"],
  [/(^|\.)jobvite\.com$/, "jobvite"],
  [/(^|\.)(ultipro\.com|ukg\.com)$/, "ukg"],
  [/(^|\.)dayforcehcm\.com$/, "dayforce"],
  [/(^|\.)(workforcenow\.adp\.com|myjobs\.adp\.com|recruiting\.adp\.com)$/, "adp"],
  [/(^|\.)paylocity\.com$/, "paylocity"],
  [/(^|\.)avature\.net$/, "avature"],
  [/(^|\.)bamboohr\.com$/, "bamboohr"],
  [/(^|\.)teamtailor\.com$/, "teamtailor"],
  [/(^|\.)recruitee\.com$/, "recruitee"],
  [/(^|\.)pinpointhq\.com$/, "pinpoint"],
  [/(^|\.)tal\.net$/, "tal.net"],
  [/(^|\.)csod\.com$/, "cornerstone"],
  [/(^|\.)hirebridge\.com$/, "hirebridge"],
  [/(^|\.)applytojob\.com$/, "jazzhr"],
];

/** One address, as a feed we can pull, a system we can only name, or nothing. */
export function atsFrom(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase();
  const seg = u.pathname.split("/").filter(Boolean);

  // Workday: {tenant}.wd{N}.myworkdayjobs.com/{locale}/{site}/…
  let m = host.match(/^([a-z0-9_-]+)\.(wd\d+)\.myworkdayjobs\.com$/);
  if (m) {
    // Its own API: /wday/cxs/{tenant}/{site}/…
    if (seg[0] === "wday") {
      if (seg[1] === "cxs" && seg[3]) return { ats: "workday", token: m[1], pod: m[2], site: seg[3] };
      return null;
    }
    const site = seg.find((s) => !LOCALE.test(s));
    if (!site || /^(job|jobs|details|login|userHome|search)$/i.test(site)) return null;
    return { ats: "workday", token: m[1], pod: m[2], site };
  }
  // The same service on its other domain: wd5.myworkdaysite.com/recruiting/{tenant}/{site}
  m = host.match(/^(wd\d+)\.myworkdaysite\.com$/);
  if (m) {
    const i = seg.indexOf("recruiting");
    if (i >= 0 && seg[i + 1] && seg[i + 2]) return { ats: "workday", token: seg[i + 1].toLowerCase(), pod: m[1], site: seg[i + 2] };
    return null;
  }

  if (host.endsWith("greenhouse.io")) {
    const named = u.searchParams.get("for");
    if (named) return { ats: "greenhouse", token: named };
    if (host.startsWith("boards-api") || host.startsWith("api")) {
      const i = seg.indexOf("boards");
      return i >= 0 && seg[i + 1] ? { ats: "greenhouse", token: seg[i + 1] } : null;
    }
    if (/^(boards|job-boards)(\.eu)?\.greenhouse\.io$/.test(host)) {
      const token = seg.find((s) => !LOCALE.test(s));
      if (token && !/^(embed|v1|static|assets)$/i.test(token)) return { ats: "greenhouse", token };
    }
    return null;
  }

  if (host === "jobs.lever.co" || host === "jobs.eu.lever.co") {
    return seg[0] ? { ats: "lever", token: seg[0] } : null;
  }
  if (host === "api.lever.co") {
    const i = seg.indexOf("postings");
    return i >= 0 && seg[i + 1] ? { ats: "lever", token: seg[i + 1] } : null;
  }

  if (host === "jobs.ashbyhq.com") return seg[0] ? { ats: "ashby", token: decodeURIComponent(seg[0]) } : null;
  if (host === "api.ashbyhq.com") {
    const i = seg.indexOf("job-board");
    return i >= 0 && seg[i + 1] ? { ats: "ashby", token: decodeURIComponent(seg[i + 1]) } : null;
  }

  if (host === "careers.smartrecruiters.com" || host === "jobs.smartrecruiters.com") {
    return seg[0] && !/^(oneclick-ui|sr-jobs)$/i.test(seg[0]) ? { ats: "smartrecruiters", token: seg[0] } : null;
  }
  if (host === "api.smartrecruiters.com") {
    const i = seg.indexOf("companies");
    return i >= 0 && seg[i + 1] ? { ats: "smartrecruiters", token: seg[i + 1] } : null;
  }

  if (host === "apply.workable.com") {
    return seg[0] && !/^(api|j)$/i.test(seg[0]) ? { ats: "workable", token: seg[0] } : null;
  }

  for (const [re, name] of OTHER) {
    if (!re.test(host)) continue;
    // Oracle's portal is a site on a shared host; the site is half the address.
    const site = name === "oracle" ? (u.pathname.match(/\/sites\/([A-Za-z0-9_-]+)/) ?? [])[1] : null;
    return { other: name, host: site ? `${host}/sites/${site}` : host };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Checking a find against the system's own public feed
// ---------------------------------------------------------------------------
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function getJson(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(20_000),
    headers: { "User-Agent": UA, Accept: "application/json", ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

/** How many openings the feed reports, or null when it does not answer. */
export async function openings(t) {
  try {
    if (t.ats === "workday") {
      const j = await getJson(`https://${t.token}.${t.pod}.myworkdayjobs.com/wday/cxs/${t.token}/${t.site}/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appliedFacets: {}, limit: 1, offset: 0, searchText: "" }),
      });
      return typeof j?.total === "number" ? j.total : null;
    }
    if (t.ats === "greenhouse") {
      const j = await getJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(t.token)}/jobs`);
      return Array.isArray(j?.jobs) ? j.jobs.length : null;
    }
    if (t.ats === "lever") {
      const j = await getJson(`https://api.lever.co/v0/postings/${encodeURIComponent(t.token)}?mode=json&limit=50`);
      return Array.isArray(j) ? j.length : null;
    }
    if (t.ats === "ashby") {
      const j = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(t.token)}`);
      return Array.isArray(j?.jobs) ? j.jobs.length : null;
    }
    if (t.ats === "smartrecruiters") {
      const j = await getJson(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(t.token)}/postings?limit=1`);
      return typeof j?.totalFound === "number" ? j.totalFound : null;
    }
    if (t.ats === "workable") {
      const j = await getJson(`https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(t.token)}`);
      return Array.isArray(j?.jobs) ? j.jobs.length : null;
    }
  } catch {
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Looking at one employer's careers site
// ---------------------------------------------------------------------------

/** Every address the page knows about: links, frames, scripts, and its markup. */
async function addressesOn(page) {
  const out = new Set();
  for (const frame of page.frames()) {
    const found = await frame
      .evaluate(() => {
        const urls = [];
        for (const el of document.querySelectorAll("a[href], iframe[src], script[src], form[action], link[href]")) {
          const v = el.href || el.src || el.action;
          if (typeof v === "string" && v.startsWith("http")) urls.push(v);
        }
        // Addresses written into inline data rather than into an attribute.
        const html = document.documentElement.innerHTML.slice(0, 1_500_000);
        const re =
          /https?:\\?\/\\?\/[a-z0-9._-]*(?:myworkdayjobs\.com|myworkdaysite\.com|greenhouse\.io|lever\.co|ashbyhq\.com|smartrecruiters\.com|workable\.com|icims\.com|taleo\.net|oraclecloud\.com|successfactors\.com|eightfold\.ai|brassring\.com|jobvite\.com|ultipro\.com|dayforcehcm\.com|avature\.net)[^"'\s<>)]*/gi;
        for (const hit of html.match(re) ?? []) urls.push(hit.replace(/\\\//g, "/").replace(/&amp;/g, "&"));
        return urls.slice(0, 4000);
      })
      .catch(() => []);
    for (const f of found) out.add(f);
    out.add(frame.url());
  }
  return out;
}

/** Links worth following, best first: the way to the job search, then to a posting. */
async function waysIn(page) {
  return await page
    .evaluate(() => {
      const here = location.href.split("#")[0];
      const shown = (e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const SEARCH = [
        [/^(search|view|see|browse|explore|find)( all| our| open| current)?( jobs?| openings| positions| roles| opportunities| careers)/i, 9],
        [/job search|search jobs|all jobs|open (positions|roles|jobs)|current openings|job openings|view openings/i, 8],
        [/find (a|your)( next)? (job|role|career)|explore (jobs|roles|opportunities|careers)|see (jobs|roles|openings)/i, 7],
        [/^(apply|apply now|apply today|join us|join our team|work with us)$/i, 5],
        // What a small business calls the page: one word in a menu or a footer.
        [/^(careers?|jobs?|employment|employment opportunities|job opportunities|career opportunities|join the team|work (for|with) us|work here|we(’|')?re hiring|now hiring|hiring|open positions)$/i, 6],
        [/careers?|jobs/i, 2],
      ];
      const DETAIL = /\/(job|jobs|position|positions|opening|requisition|vacancy|details?)\/[^/?#]{3,}|[?&](jobid|job_id|reqid|gh_jid|id)=/i;
      const NO = /linkedin\.|facebook\.|twitter\.|x\.com|instagram\.|youtube\.|glassdoor\.|mailto:|tel:|\/login|sign-?in|privacy|cookie|terms|investor|press|news|blog|\.pdf($|\?)/i;
      const picks = new Map();
      for (const a of document.querySelectorAll("a[href]")) {
        const href = (a.href || "").split("#")[0];
        if (!href.startsWith("http") || href === here || NO.test(href)) continue;
        const text = (a.innerText || a.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
        let score = 0;
        for (const [re, w] of SEARCH) if (re.test(text)) { score = Math.max(score, w); }
        if (/\/(search|jobs|job-search|openings|positions|search-results|search-jobs)\b/i.test(href)) score += 2;
        if (DETAIL.test(href) && text.length >= 8 && text.length <= 140) score = Math.max(score, 6);
        if (/^apply/i.test(text)) score += 3;
        if (!score) continue;
        if (!shown(a)) score -= 1;
        if (score > (picks.get(href)?.score ?? 0)) picks.set(href, { href, score, text: text.slice(0, 50), detail: DETAIL.test(href) });
      }
      return [...picks.values()].sort((x, y) => y.score - x.score).slice(0, 8);
    })
    .catch(() => []);
}

/**
 * For a system with no reader yet, the address that says which of its
 * tenants this employer is: the next thing a reader for it needs, and not
 * something its bare host tells.
 */
const WAY_IN = {
  adp: /[?&]cid=[0-9a-f-]{8,}|myjobs\.adp\.com\/[^/?#]+/i,
  avature: /avature\.net\/[^/?#]+/i,
  taleo: /careersection\/[^/?#]+/i,
  brassring: /partnerid=\d+[^#]*siteid=\d+|siteid=\d+[^#]*partnerid=\d+/i,
  dayforce: /dayforcehcm\.com\/(?:[a-z]{2}-[A-Z]{2}\/[^/?#]+\/[^/?#]+|CandidatePortal\/[a-z]{2}-[A-Z]{2}\/[^/?#]+)/i,
  ukg: /(?:recruiting\d*\.ultipro\.com\/[A-Za-z0-9]+\/)?JobBoard\/[0-9a-f-]{36}/i,
  cornerstone: /careersite\/\d+/i,
  jobvite: /jobs\.jobvite\.com\/[^/?#]+/i,
};

/** What a set of addresses says: feeds we can pull, and systems we can only name. */
function readAddresses(urls) {
  const feeds = new Map();
  const others = new Map();
  const ways = new Map();
  // Where each such system lives for this employer: the next thing anyone
  // building for it needs. A careers host, not a tracking or asset one.
  const hosts = new Map();
  for (const url of urls) {
    const t = atsFrom(url);
    if (!t) continue;
    if (t.other) {
      others.set(t.other, (others.get(t.other) ?? 0) + 1);
      const prev = hosts.get(t.other);
      const careersy = (h) => /^careers?[-.]|jobs|recruit/.test(h);
      if (!prev || (careersy(t.host) && !careersy(prev)) || (t.host.includes("/sites/") && !prev.includes("/sites/"))) hosts.set(t.other, t.host);
      if (WAY_IN[t.other]?.test(url) && !ways.has(t.other)) ways.set(t.other, String(url).split("#")[0].slice(0, 200));
    } else feeds.set(`${t.ats}|${t.token}|${t.pod ?? ""}|${t.site ?? ""}`, t);
  }
  return { feeds: [...feeds.values()], others, hosts, ways };
}

/**
 * Other places an employer's careers pages usually are, given one address
 * for them that turned out to be dead: careers. and jobs. under its own
 * name, and /careers and /jobs on its main site.
 */
/** The employer's own name as its web address has it: "careers.acme.com" is "acme" at "acme.com". */
export function ownDomain(careersUrl) {
  try {
    const host = new URL(careersUrl).hostname.toLowerCase().replace(/^(www|careers?|jobs?|work|join|apply|hire|talent)\./, "");
    const labels = host.split(".");
    if (labels.length < 2) return null;
    const two = /^(co|com|org|net|ac)$/.test(labels.at(-2)) && labels.length >= 3;
    const base = labels.slice(two ? -3 : -2).join(".");
    return { base, label: base.split(".")[0] };
  } catch {
    return null;
  }
}

/**
 * The places to try after a refusal. A refusal is honoured where it was
 * given: nothing more is asked of the host that said no. Only the employer's
 * other public addresses are tried — a jobs site is often a different
 * server from the marketing site in front of it. For an address that was
 * simply dead, every usual place is tried.
 */
export function afterRefusal(careersUrl, blocked) {
  const all = otherAddresses(careersUrl);
  if (/HTTP 404|HTTP 410|NAME_NOT_RESOLVED|CERT_|SSL_/.test(String(blocked ?? ""))) return all;
  let refused = "";
  try {
    refused = new URL(careersUrl).hostname.toLowerCase();
  } catch {
    return [];
  }
  return all.filter((u) => new URL(u).hostname.toLowerCase() !== refused);
}

/**
 * Asking two hiring systems directly whether the employer is on them, by
 * the name in its own web address. Each is that system's public page for
 * that employer. An answer counts only when the page names the employer's
 * own domain, so that a namesake is not taken for it.
 */
async function askByName(careersUrl) {
  const own = ownDomain(careersUrl);
  if (!own || own.label.length < 3) return null;
  const text = async (url) => {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" }, signal: AbortSignal.timeout(15_000), redirect: "follow" });
      return res.ok ? { body: (await res.text()).slice(0, 600_000), final: res.url } : null;
    } catch {
      return null;
    }
  };
  const ef = await text(`https://${own.label}.eightfold.ai/careers`);
  if (ef && new RegExp(`["']domain["']\\s*:\\s*["']${own.base.replace(/\./g, "\\.")}["']`, "i").test(ef.body)) {
    return { system: "eightfold", host: `${own.label}.eightfold.ai` };
  }
  for (const host of [`careers-${own.label}.icims.com`, `${own.label}.icims.com`]) {
    const ic = await text(`https://${host}/jobs/search?ss=1`);
    if (ic && /icims/i.test(ic.body) && ic.body.toLowerCase().includes(own.base)) return { system: "icims", host: new URL(ic.final).hostname.toLowerCase() };
  }
  return null;
}

/**
 * The names an employer might go by on a hiring system: the one in its own
 * web address, and its name run together. Short ones are left out; three
 * letters are anybody's.
 */
export function namesFor(name, careersUrl) {
  const own = ownDomain(careersUrl);
  const run = String(name ?? "").toLowerCase().replace(/&/g, "and").replace(/\b(inc|llc|corp|corporation|company|co|group|holdings|plc|ltd)\b\.?/g, " ").replace(/[^a-z0-9]/g, "");
  const out = [];
  for (const n of [own?.label, run]) if (n && n.length >= 4 && !out.includes(n)) out.push(n);
  // The name and the address agreeing is what makes a bare name on a system
  // this employer's and not a namesake's.
  return { names: out.slice(0, 2), agree: Boolean(own?.label && run && (own.label === run || (own.label.length >= 5 && (run.includes(own.label) || own.label.includes(run))))) };
}

/**
 * Asking the systems the applier already works on whether the employer is
 * there, by name. Used when the employer's own careers site refused the
 * visit or showed nothing: the hiring system is a different server, and its
 * list is public. A refusal is still honoured where it was given; nothing
 * more is asked of the site that said no.
 *
 * Returned as feeds for bestFeed to count and to check against the
 * employer's name, as any feed found on a page is.
 */
async function askFeedsByName(name, careersUrl) {
  const { names, agree } = namesFor(name, careersUrl);
  const feeds = [];
  for (const n of names) {
    // Workday: a tenant's own address sends a visitor on to its careers
    // site, and that address says which site it is.
    for (const pod of ["wd1", "wd5", "wd3", "wd12", "wd2", "wd10"]) {
      try {
        const res = await fetch(`https://${n}.${pod}.myworkdayjobs.com/`, { headers: { "User-Agent": UA, Accept: "text/html" }, redirect: "follow", signal: AbortSignal.timeout(12_000) });
        const t = res.ok ? atsFrom(res.url) : null;
        if (t && t.ats === "workday" && t.site && agree) {
          feeds.push(t);
          break;
        }
      } catch {
        /* not on this pod */
      }
    }
    // Boards named in an address. Greenhouse says whose board it is, and
    // bestFeed holds it to that; the others are taken only where the
    // employer's name and web address agree on the word.
    feeds.push({ ats: "greenhouse", token: n });
    if (agree && n.length >= 5) {
      feeds.push({ ats: "lever", token: n }, { ats: "ashby", token: n });
    }
  }
  return feeds;
}

/** Why a board's list could not be confirmed: the answer its address gave. */
async function listAnswer(t) {
  const url =
    t.ats === "workday" ? `https://${t.token}.${t.pod}.myworkdayjobs.com/wday/cxs/${t.token}/${t.site}/jobs`
    : t.ats === "greenhouse" ? `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(t.token)}/jobs`
    : t.ats === "lever" ? `https://api.lever.co/v0/postings/${encodeURIComponent(t.token)}?mode=json&limit=1`
    : null;
  if (!url) return "not asked";
  try {
    const res = await fetch(url, {
      method: t.ats === "workday" ? "POST" : "GET",
      headers: { "User-Agent": UA, Accept: "application/json", ...(t.ats === "workday" ? { "Content-Type": "application/json" } : {}) },
      ...(t.ats === "workday" ? { body: JSON.stringify({ appliedFacets: {}, limit: 1, offset: 0, searchText: "" }) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return `HTTP ${res.status}`;
    const j = await res.json().catch(() => null);
    const n = t.ats === "workday" ? j?.total : Array.isArray(j?.jobs) ? j.jobs.length : Array.isArray(j) ? j.length : null;
    return `answered, ${n ?? "no count"} listed`;
  } catch (e) {
    return String(e?.message ?? e).slice(0, 40);
  }
}

/** Systems whose postings are read by a job of their own, from the resolver's note. */
export const READ_SYSTEMS = ["oracle", "successfactors", "icims", "bamboohr", "jazzhr", "recruitee", "pinpoint", "teamtailor", "eightfold"];

/**
 * Every employer on the list, counted by where it stands and why. Counts
 * only: which employers they are is not said.
 */
export function census(rows) {
  const out = { total: rows.length, found: {}, unreadable: {}, waiting: 0, not_found: {} };
  const add = (bag, k) => (bag[k] = (bag[k] ?? 0) + 1);
  for (const r of rows) {
    const note = String(r.note ?? "");
    const on = (note.match(/runs on ([a-z0-9]+)/i) ?? [])[1]?.toLowerCase();
    if (r.status === "ok" && /list not read/i.test(note)) add(out.unreadable, on ?? "other");
    else if (r.status === "ok") add(out.found, r.ats ?? on ?? "other");
    else if (r.status === "pending") out.waiting++;
    else if (on) add(out.not_found, `on ${on}, no reader`);
    else if (/refused the visit/i.test(note)) add(out.not_found, `refused (${(note.match(/HTTP (\d{3})/) ?? note.match(/(ERR_[A-Z0-9_]+)/) ?? note.match(/(timeout)/i) ?? [])[1] ?? "other"})`);
    else if (/no application system recognised/i.test(note)) add(out.not_found, "site read, no system recognised");
    else if (/did not finish loading/i.test(note)) add(out.not_found, "site too slow");
    else if (/returned nothing/i.test(note)) add(out.not_found, `board seen, its list empty${(note.match(/its list answered: (HTTP \d{3}|answered)/) ?? [])[1] ? ` (${(note.match(/its list answered: (HTTP \d{3}|answered)/) ?? [])[1]})` : ""}`);
    else if (/does not look like/i.test(note)) add(out.not_found, "board seen, not this employer's");
    else add(out.not_found, note ? "older note" : "no note");
  }
  return out;
}

/** Where an employer came from, as its record says: "map: 3 place(s) in reach", "feed: near home". */
export function originOf(note) {
  return (String(note ?? "").match(/(?:^|; )((?:map|feed|index|crawl|seed): [^;]{0,60})/) ?? [])[1]?.trim() ?? null;
}

export function otherAddresses(careersUrl) {
  let host = "";
  try {
    host = new URL(careersUrl).hostname.toLowerCase();
  } catch {
    return [];
  }
  const base = host.replace(/^(www|careers?|jobs?|work|join|apply|hire|talent)\./, "");
  if (!base.includes(".")) return [];
  const all = [
    `https://www.${base}/careers`,
    `https://careers.${base}/`,
    `https://jobs.${base}/`,
    `https://www.${base}/jobs`,
    `https://www.${base}/company/careers`,
    `https://www.${base}/about/careers`,
  ];
  const same = (u) => u.replace(/\/+$/, "").toLowerCase();
  return all.filter((u) => same(u) !== same(careersUrl));
}

async function look(browser, name, careersUrl) {
  const context = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1366, height: 900 },
    locale: "en-US",
  });
  // Pictures, fonts and video are most of a careers page's weight and none of
  // its information.
  await context
    .route("**/*", (route) =>
      ["image", "media", "font"].includes(route.request().resourceType()) ? route.abort() : route.continue(),
    )
    .catch(() => {});

  const reached = new Set();
  context.on("request", (req) => {
    const u = req.url();
    if (u.startsWith("http")) reached.add(u);
  });

  const visited = [];
  let blocked = null;
  const result = { feeds: [], others: new Map(), hosts: new Map(), ways: new Map(), pages: 0, final: careersUrl, blocked: null };

  const settle = async (page) => {
    await page.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(3500);
  };
  const read = async (page) => {
    const urls = new Set([...reached, ...(await addressesOn(page))]);
    for (const p of context.pages()) urls.add(p.url());
    const seen = readAddresses(urls);
    for (const f of seen.feeds) {
      if (!result.feeds.some((x) => x.ats === f.ats && x.token === f.token && (x.site ?? "") === (f.site ?? ""))) result.feeds.push(f);
    }
    for (const [k, n] of seen.others) result.others.set(k, Math.max(result.others.get(k) ?? 0, n));
    for (const [k, h] of seen.hosts) if (!result.hosts.has(k)) result.hosts.set(k, h);
    for (const [k, w] of seen.ways ?? []) if (!result.ways.has(k)) result.ways.set(k, w);
    return result.feeds.length > 0;
  };

  try {
    const page = await context.newPage();
    const open = async (url) => {
      blocked = null;
      const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 35_000 }).catch((e) => {
        blocked = String(e?.message ?? e).split("\n")[0].slice(0, 80);
        return null;
      });
      if (res && res.status() >= 400) blocked = `HTTP ${res.status()}`;
      return res;
    };
    let first = await open(careersUrl);
    // An address that no longer exists is usually a careers subdomain that
    // was retired: careers.tenethealth.com is gone, tenethealth.com is not,
    // and its front page links to wherever the jobs went.
    if (!first && /ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ERR_CERT|ERR_SSL/i.test(blocked ?? "")) {
      try {
        const host = new URL(careersUrl).hostname.split(".");
        const base = host.slice(-2).join(".");
        for (const alt of [`https://www.${base}/careers`, `https://www.${base}/`, `https://${base}/`]) {
          first = await open(alt);
          if (first && first.status() < 400) break;
        }
      } catch {
        /* keep the first failure */
      }
    }
    // A careers address that was only ever a guess — "www.<site>/careers"
    // for a business found on the map — answers "no such page" more often
    // than not: 248 employers were written off that way. The front page is
    // there, and links to wherever the jobs are.
    if (first && [404, 410].includes(first.status())) {
      try {
        const front = new URL("/", careersUrl).href;
        if (front.replace(/\/+$/, "") !== careersUrl.replace(/\/+$/, "")) {
          const alt = await open(front);
          if (alt && alt.status() < 400) first = alt;
          else blocked = `HTTP ${first.status()}`;
        }
      } catch {
        /* keep the first answer */
      }
    }
    await settle(page);
    visited.push(page.url());
    result.final = page.url();
    if (await read(page)) return result;

    // Two rounds in: the search page, then a posting and its Apply button.
    const queue = (await waysIn(page)).slice(0, 4);
    const tried = new Set([page.url().split("#")[0]]);
    for (let hop = 0; hop < 7 && queue.length; hop++) {
      const next = queue.shift();
      if (!next || tried.has(next.href)) continue;
      tried.add(next.href);
      await page.goto(next.href, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
      await settle(page);
      visited.push(page.url());
      if (await read(page)) return result;

      // An Apply control that is a button, not a link: press it and watch
      // where the browser goes.
      if (next.detail) {
        const apply = page
          .locator('a, button, [role=button]')
          .filter({ hasText: /^\s*apply( now| today| for this job)?\s*$/i })
          .first();
        if (await apply.isVisible().catch(() => false)) {
          await apply.click({ timeout: 4000 }).catch(() => {});
          await page.waitForTimeout(4500);
          if (await read(page)) return result;
        }
      }
      const more = await waysIn(page);
      // From a search page, the postings; from anywhere else, its best links.
      const details = more.filter((x) => x.detail).slice(0, 2);
      const rest = more.filter((x) => !x.detail).slice(0, 2);
      for (const x of [...details, ...rest]) if (!tried.has(x.href)) queue.unshift(x);
      if (queue.length > 8) queue.length = 8;
    }
    return result;
  } catch (e) {
    blocked = blocked ?? String(e?.message ?? e).split("\n")[0].slice(0, 80);
    return result;
  } finally {
    result.pages = visited.length;
    result.blocked = blocked;
    await context.close().catch(() => {});
  }
}

/**
 * Could this feed be this employer's?
 *
 * A Workday tenant belongs to one employer, so reaching one from a company's
 * own careers site is as good as being told. A Greenhouse or Lever board is
 * just a name in a URL, and careers sites link to other people's: the vendor
 * that built the site, a partner, a parent. Saving one of those would file a
 * stranger's openings under this employer's name, so a board has to look like
 * the company it is being attached to.
 */
export function plausible(name, t) {
  if (t.ats === "workday") return true;
  const n = flat(name);
  const k = flat(t.token);
  if (!n || k.length < 2) return false;
  if (n.includes(k) || k.includes(n)) return true;
  return String(name).toLowerCase().split(/[^a-z0-9]+/).some((w) => w.length >= 4 && k.includes(w));
}

const flat = (v) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Does the board say it belongs to this employer?
 *
 * A board token is a short word, and short words are shared: "gemini",
 * "cedar" and "carta" are each somebody's company. Greenhouse states the
 * company a board belongs to, so where an employer was named by its board
 * the two names have to agree. True when they do or when the board does not
 * say; false only on a stated name that is somebody else's.
 */
async function boardIsTheirs(name, t) {
  if (t.ats !== "greenhouse") return true;
  try {
    const j = await getJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(t.token)}`);
    const said = String(j?.name ?? "");
    if (!said) return true;
    const a = flat(name);
    const b = flat(said);
    if (a.includes(b) || b.includes(a)) return true;
    return String(name).toLowerCase().split(/[^a-z0-9]+/).some((w) => w.length >= 4 && b.includes(w));
  } catch {
    return true;
  }
}

/** Of several feeds found, the one the public should apply through. */
async function bestFeed(feeds, name) {
  let best = null;
  for (const f of feeds.filter((x) => plausible(name, x)).slice(0, 6)) {
    const n = await openings(f);
    if (n === null || n < 1) continue;
    if (!(await boardIsTheirs(name, f))) continue;
    // A tenant often has a campus or internal site beside the main one.
    const side = /intern|campus|student|alumni|internal|university|early/i.test(f.site ?? "");
    const rank = (side ? 0 : 1_000_000) + n;
    if (!best || rank > best.rank) best = { feed: f, count: n, rank };
  }
  return best;
}

// ---------------------------------------------------------------------------
if (process.env.RESOLVE_IMPORT_ONLY !== "1") {
  let list = [];
  if (LOCAL) {
    list = LOCAL.split(",").map((pair, i) => {
      const [name, url] = pair.split("|");
      return { id: `local-${i}`, name: name.trim(), careers_url: url.trim() };
    });
  } else {
    if (!SUPABASE_URL || !ANON_KEY || !AP_EMAIL || !AP_PASSWORD) {
      console.error("Missing SUPABASE_URL, SUPABASE_ANON_KEY, APPLYPILOT_EMAIL or APPLYPILOT_PASSWORD.");
      process.exit(1);
    }
    await auth({ email: AP_EMAIL, password: AP_PASSWORD }, "password");
    // There was a list of employers near the owner kept beside this file.
    // It is gone on purpose: this repository is public, and such a list says
    // where somebody lives. Its employers are in the database already, and
    // the employers near each person now come from the map (nearby.mjs).
    // An employer on a system that has a reader of its own is found, not
    // failed. Ones marked before that was the rule are put right here, in
    // one statement each, rather than waiting weeks to be looked at again.
    if (APPLY) {
      for (const sys of READ_SYSTEMS) {
        await db(`company_candidates?status=eq.failed&note=ilike.*runs%20on%20${sys}%20at*`, {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ status: "ok" }),
        }).catch(() => {});
      }
    }
    // Where every employer stands, by kind and count: what the panel's
    // "resolved" and "failed" are made of.
    try {
      const all = (await db("company_candidates?select=status,ats,note&limit=5000")) ?? [];
      console.log(`census: ${JSON.stringify(census(all))}`);
    } catch (e) {
      console.log(`census: could not be read (${String(e.message).slice(0, 60)})`);
    }
    // Longest-unchecked first, so successive runs work through the whole list.
    list =
      (await db(
        `company_candidates?status=in.(failed,pending)` +
          (process.env.ONLY_SYSTEM ? `&note=ilike.*runs%20on%20${encodeURIComponent(process.env.ONLY_SYSTEM)}*` : "") +
          `&select=id,name,careers_url,note&order=checked_at.asc.nullsfirst&limit=${MAX}`,
      )) ?? [];
  }
  hideNames(list.map((c) => c.name));
  console.log(`${list.length} employer(s) to look at; ${APPLY && !LOCAL ? "saving what is found" : "report only"}.`);

  const browser = await chromium.launch({ args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"] });
  const started = Date.now();
  const tally = { found: 0, other: 0, nothing: 0, blocked: 0, unverified: 0, skipped: 0 };
  const byAts = {};
  const byOther = {};
  const otherNames = {};
  const lines = [];
  let cursor = 0;

  const save = async (c, patch) => {
    if (!APPLY || LOCAL) return;
    // Where the employer came from stays on its record when what was found
    // is written over the rest: it is what the worth of each way of finding
    // employers is measured by afterwards.
    const from = originOf(c.note);
    if (from && patch.note && !patch.note.includes(from)) patch = { ...patch, note: `${String(patch.note).slice(0, 376 - from.length)}; ${from}` };
    await db(`company_candidates?id=eq.${c.id}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ ...patch, checked_at: new Date().toISOString() }),
    }).catch((e) => console.log(`  could not update ${c.name}: ${String(e.message).slice(0, 80)}`));
  };

  async function worker() {
    for (;;) {
      const c = list[cursor++];
      if (!c) return;
      if (Date.now() - started > BUDGET_MS) {
        tally.skipped++;
        continue;
      }
      let seen = null;
      // An address that is already a job board says what it is; there is
      // nothing to look for.
      const named = atsFrom(c.careers_url);
      if (named && !named.other) {
        seen = { feeds: [named], others: new Map(), hosts: new Map(), pages: 0, final: c.careers_url, blocked: null };
      }
      // The quick way first: the hiring systems the applier already works
      // on are asked for this employer by name. That is a handful of plain
      // requests against a browser visit of a minute or more, and for a
      // large employer it is usually enough. Only what it does not settle is
      // looked at with the browser.
      if (!seen) {
        const quick = await bestFeed(await askFeedsByName(c.name, c.careers_url).catch(() => []), c.name).catch(() => null);
        if (quick) {
          tally.quick = (tally.quick ?? 0) + 1;
          seen = { feeds: [quick.feed], others: new Map(), hosts: new Map(), pages: 0, final: c.careers_url, blocked: null };
        }
      }
      try {
        seen ??= await Promise.race([
          look(browser, c.name, c.careers_url),
          new Promise((r) => setTimeout(() => r(null), PER_SITE_MS)),
        ]);
      } catch {
        seen = null;
      }
      // A careers address that is dead — not found, or no such site — is a
      // wrong guess at the address, not an employer without jobs. The usual
      // places are tried before giving up: careers and jobs under the
      // employer's own name, and the pages of those names on its main site.
      if (seen && !seen.feeds.length && !seen.others.size && seen.blocked) {
        for (const other of afterRefusal(c.careers_url, seen.blocked)) {
          if (Date.now() - started > BUDGET_MS) break;
          let again = null;
          try {
            again = await Promise.race([
              look(browser, c.name, other),
              new Promise((r) => setTimeout(() => r(null), PER_SITE_MS)),
            ]);
          } catch {
            again = null;
          }
          if (again && (again.feeds.length || again.others.size)) {
            tally.elsewhere = (tally.elsewhere ?? 0) + 1;
            seen = again;
            c.careers_url = other;
            break;
          }
        }
      }
      if (!seen) {
        tally.nothing++;
        lines.push(`  ?  ${c.name} — took too long`);
        await save(c, { status: "failed", note: "browser: the careers site did not finish loading in time" });
        continue;
      }

      const best = seen.feeds.length ? await bestFeed(seen.feeds, c.name) : null;
      if (best) {
        const t = best.feed;
        tally.found++;
        byAts[t.ats] = (byAts[t.ats] ?? 0) + 1;
        lines.push(`  ok ${c.name} — ${t.ats} ${t.token}${t.site ? "/" + t.site : ""} (${best.count} openings, ${seen.pages} page(s))`);
        if (APPLY && !LOCAL) {
          try {
            const where =
              `ats=eq.${t.ats}&token=eq.${encodeURIComponent(t.token)}&` +
              (t.site ? `site=eq.${encodeURIComponent(t.site)}` : "site=is.null");
            const have = (await db(`companies?${where}&select=id&limit=1`)) ?? [];
            const row = {
              ats: t.ats, token: t.token, name: c.name, enabled: true,
              pod: t.pod ?? null, site: t.site ?? null, careers_url: c.careers_url, last_error: null,
            };
            // Already pulled under some name: leave that row as it is.
            if (!have.length) {
              await db("companies", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify([row]) });
            }
            await save(c, {
              status: "ok", ats: t.ats, token: t.token, pod: t.pod ?? null, site: t.site ?? null,
              resolved_url: seen.final, note: `found with a browser (${best.count} openings)`,
            });
          } catch (e) {
            lines.push(`     could not save ${c.name}: ${String(e.message).slice(0, 90)}`);
          }
        }
        continue;
      }

      if (seen.feeds.length) {
        // An address of the right shape that could not be confirmed: its feed
        // did not answer, or the board does not look like this employer's.
        tally.unverified++;
        const f = seen.feeds.find((x) => plausible(c.name, x)) ?? seen.feeds[0];
        const why = plausible(c.name, f) ? "its job feed returned nothing" : "the board does not look like this employer's";
        const said = await listAnswer(f).catch(() => "?");
        lines.push(`  ~  ${c.name} — ${f.ats} ${f.token}${f.site ? "/" + f.site : ""} seen, but ${why} [${f.ats}${f.pod ? " " + f.pod : ""}: ${said}; ${seen.feeds.length} address(es) seen]`);
        // Still worth knowing what else the site runs on.
        const also = seen.others.size ? ` Also reaches ${[...seen.others.keys()].slice(0, 3).join(", ")}.` : "";
        await save(c, {
          status: "failed", resolved_url: seen.final,
          note: `browser: saw ${f.ats} ${f.token}${f.site ? "/" + f.site : ""}, but ${why} (its list answered: ${said}).${also}`.slice(0, 380),
        });
        if (!seen.others.size) continue;
        const top = [...seen.others.entries()].sort((x, y) => y[1] - x[1])[0][0];
        byOther[top] = (byOther[top] ?? 0) + 1;
        (otherNames[top] ??= []).push(c.name);
        continue;
      }

      if (seen.others.size) {
        const top = [...seen.others.entries()].sort((a, b) => b[1] - a[1])[0][0];
        tally.other++;
        byOther[top] = (byOther[top] ?? 0) + 1;
        (otherNames[top] ??= []).push(c.name);
        const at = seen.hosts?.get(top) ?? "";
        lines.push(`  -  ${c.name} — runs on ${top}${at ? ` (${at})` : ""}`);
        // A system with a reader of its own is an employer found, not one
        // failed: its postings are pulled by that reader from this note.
        const READ = READ_SYSTEMS.includes(top);
        await save(c, {
          status: READ ? "ok" : "failed", resolved_url: seen.final,
          note: `browser: runs on ${top}${at ? ` at ${at}` : ""}${READ ? ", read by its own job" : ", which the applier does not handle yet"}${seen.ways?.get(top) ? `; way in ${seen.ways.get(top)}` : ""}`.slice(0, 380),
        });
        continue;
      }

      // The systems the applier already works on, asked by name.
      const asked = await bestFeed(await askFeedsByName(c.name, c.careers_url).catch(() => []), c.name).catch(() => null);
      if (asked) {
        const t = asked.feed;
        tally.found++;
        tally.byname = (tally.byname ?? 0) + 1;
        byAts[t.ats] = (byAts[t.ats] ?? 0) + 1;
        lines.push(`  ok ${c.name} — ${t.ats} ${t.token}${t.site ? "/" + t.site : ""}, found by asking it (${asked.count} openings)`);
        if (APPLY && !LOCAL) {
          try {
            const where = `ats=eq.${t.ats}&token=eq.${encodeURIComponent(t.token)}&` + (t.site ? `site=eq.${encodeURIComponent(t.site)}` : "site=is.null");
            const have = (await db(`companies?${where}&select=id&limit=1`)) ?? [];
            if (!have.length) {
              await db("companies", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify([{ ats: t.ats, token: t.token, name: c.name, enabled: true, pod: t.pod ?? null, site: t.site ?? null, careers_url: c.careers_url, last_error: null }]) });
            }
            await save(c, { status: "ok", ats: t.ats, token: t.token, pod: t.pod ?? null, site: t.site ?? null, resolved_url: seen.final, note: `asked ${t.ats} by name (${asked.count} openings)` });
          } catch (e) {
            lines.push(`     could not save ${c.name}: ${String(e.message).slice(0, 90)}`);
          }
        }
        continue;
      }

      // Then the two systems with readers of their own that can be asked by
      // the employer's name.
      const named2 = await askByName(c.careers_url).catch(() => null);
      if (named2) {
        tally.asked = (tally.asked ?? 0) + 1;
        byOther[named2.system] = (byOther[named2.system] ?? 0) + 1;
        lines.push(`  ok ${c.name} — on ${named2.system}, found by asking it`);
        await save(c, { status: "ok", resolved_url: seen.final, note: `asked: runs on ${named2.system} at ${named2.host}, read by its own job` });
        continue;
      }

      if (seen.blocked) tally.blocked++;
      else tally.nothing++;
      lines.push(`  ?  ${c.name} — ${seen.blocked ? `refused (${seen.blocked})` : `nothing recognised on ${seen.pages} page(s)`}`);
      await save(c, {
        status: "failed", resolved_url: seen.final,
        note: seen.blocked
          ? `browser: the careers site refused the visit (${seen.blocked})`
          : `browser: no application system recognised after ${seen.pages} page(s)`,
      });
    }
  }

  await Promise.all(Array.from({ length: WORKERS }, worker));
  await browser.close().catch(() => {});

  console.log(lines.join("\n"));
  console.log(`result: ${JSON.stringify(tally)} in ${Math.round((Date.now() - started) / 60000)} min`);
  console.log(`now pullable, by system: ${JSON.stringify(byAts)}`);
  console.log(`on systems the applier does not handle yet: ${JSON.stringify(byOther)}`);
  for (const [k, names] of Object.entries(otherNames)) console.log(`  ${k}: ${names.length} employer(s)`);
  process.exit(0);
}
