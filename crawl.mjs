// Employers found by the hiring system they are on.
//
// Everything else here starts from a company's name and looks for where it
// hires. This starts from the other end: Common Crawl, a free public archive
// of the web, knows every address it has seen on Workday, Greenhouse, Lever
// and Ashby — the systems the applier already sends through. Each such
// address is an employer's public job board.
//
// Most are nowhere near the owner or hire for nothing they do. So a board is
// kept only when its own public list, asked once, shows an opening for one
// of the owner's titles in reach of them. The rest are remembered as looked
// at, and not asked again.
//
// A few pages of the archive's index a day, a different few each day; one
// request at a time, as the archive asks. Nothing is printed but counts.

// Everything printed here goes through the nets in quiet.mjs: this log is public.
import "./quiet.mjs";
process.env.FEEDS_IMPORT_ONLY = "1";
const { wanted } = await import("./feeds.mjs");
const { nearPattern, stateName } = await import("./near.mjs");

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
// Whose round this is, when the runner is doing somebody else's: see forusers.mjs.
const ACT_AS = process.env.AP_ACT_AS ? { "x-act-as": process.env.AP_ACT_AS } : {};
const AP_EMAIL = process.env.APPLYPILOT_EMAIL;
const AP_PASSWORD = process.env.APPLYPILOT_PASSWORD;
const APPLY = process.env.APPLY === "true";
const MAX_CHECK = Number(process.env.MAX_CHECK || 300);
const UA = "ApplyPilot/1.0 (job search tool; a few index pages a day)";

/** What the archive is asked for, and how many of its pages a run reads. */
export const SYSTEMS = [
  { ats: "workday", query: "url=myworkdayjobs.com&matchType=domain", pages: 6 },
  { ats: "greenhouse", query: "url=boards.greenhouse.io%2F*", pages: 3 },
  { ats: "greenhouse", query: "url=job-boards.greenhouse.io%2F*", pages: 2 },
  { ats: "lever", query: "url=jobs.lever.co%2F*", pages: 3 },
  { ats: "ashby", query: "url=jobs.ashbyhq.com%2F*", pages: 2 },
];

const LOCALE = /^[a-z]{2}(-[a-z]{2,4})?$/i;

/** An address on one of the four systems, as the board it belongs to. Null for anything else. */
export function boardFrom(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split("/").filter(Boolean);
  const ok = (t) => /^[A-Za-z0-9_.-]{2,60}$/.test(t ?? "");
  const wd = host.match(/^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/);
  if (wd) {
    const rest = LOCALE.test(parts[0] ?? "") ? parts.slice(1) : parts;
    const site = rest[0];
    if (!ok(site) || /^(wday|login|job|jobs|details|search)$/i.test(site)) return null;
    return { ats: "workday", token: wd[1], pod: wd[2], site, url: `https://${host}/${site}` };
  }
  const first = parts[0];
  if (!ok(first) || /^(embed|api|v1|static|assets|favicon\.ico|robots\.txt|sitemap\.xml)$/i.test(first)) return null;
  if (host === "boards.greenhouse.io" || host === "job-boards.greenhouse.io") return { ats: "greenhouse", token: first.toLowerCase(), url: `https://boards.greenhouse.io/${first.toLowerCase()}` };
  if (host === "jobs.lever.co") return { ats: "lever", token: first, url: `https://jobs.lever.co/${first}` };
  if (host === "jobs.ashbyhq.com") return { ats: "ashby", token: decodeURIComponent(first), url: `https://jobs.ashbyhq.com/${first}` };
  return null;
}

/** A board's postings as title and place, whatever system gave them. */
export function postingsOf(ats, j) {
  if (ats === "workday") return (j?.jobPostings ?? []).map((p) => ({ title: p?.title, where: p?.locationsText }));
  if (ats === "greenhouse") return (j?.jobs ?? []).map((p) => ({ title: p?.title, where: p?.location?.name }));
  if (ats === "lever") return (Array.isArray(j) ? j : []).map((p) => ({ title: p?.text, where: [p?.categories?.location, p?.workplaceType].filter(Boolean).join(", ") }));
  if (ats === "ashby") return (j?.jobs ?? []).map((p) => ({ title: p?.title, where: [p?.location, p?.isRemote ? "Remote" : ""].filter(Boolean).join(", ") }));
  return [];
}

/**
 * How many of a board's postings are for the owner: one of their titles, in
 * a place that is in reach. A Workday list was already asked for the state
 * by name, so "3 Locations" there counts as in reach.
 */
export function forOwner(ats, rows, titles, excludes, near) {
  return rows.filter((r) => {
    if (!r.title || !wanted(r.title, titles, excludes)) return false;
    const where = String(r.where ?? "");
    return near.test(where) || (ats === "workday" && /^\d+ locations?$/i.test(where.trim()));
  }).length;
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function ask(url, init = {}, tries = 4) {
  let last = "";
  for (let attempt = 0; attempt < tries; attempt++) {
    let res;
    try {
      res = await fetch(url, { ...init, headers: { "User-Agent": UA, ...(init.headers || {}) }, signal: AbortSignal.timeout(60_000) });
    } catch (e) {
      last = String(e?.message ?? e).slice(0, 40);
      await pause(5000 * (attempt + 1));
      continue;
    }
    if (res.ok) return res;
    last = `HTTP ${res.status}`;
    if (res.status !== 429 && res.status < 500) break;
    const asked = Number(res.headers.get("retry-after"));
    await pause(Math.min(90_000, (Number.isFinite(asked) && asked > 0 ? asked : 8 * 2 ** attempt) * 1000));
  }
  throw new Error(last);
}

async function listOf(b, home) {
  if (b.ats === "workday") {
    const res = await ask(`https://${b.token}.${b.pod}.myworkdayjobs.com/wday/cxs/${b.token}/${b.site}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ appliedFacets: {}, limit: 20, offset: 0, searchText: home ?? "" }),
    }, 1);
    return res.json();
  }
  const url =
    b.ats === "greenhouse" ? `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(b.token)}/jobs`
    : b.ats === "lever" ? `https://api.lever.co/v0/postings/${encodeURIComponent(b.token)}?mode=json&limit=200`
    : `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(b.token)}`;
  return (await ask(url, { headers: { Accept: "application/json" } }, 1)).json();
}

if (process.env.CRAWL_IMPORT_ONLY !== "1") {
  if (!SUPABASE_URL || !ANON_KEY || !AP_EMAIL || !AP_PASSWORD) {
    console.error("Missing SUPABASE_URL, SUPABASE_ANON_KEY, APPLYPILOT_EMAIL or APPLYPILOT_PASSWORD.");
    process.exit(1);
  }
  const sign = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON_KEY, ...ACT_AS, "Content-Type": "application/json" },
    body: JSON.stringify({ email: AP_EMAIL, password: AP_PASSWORD }),
  });
  if (!sign.ok) throw new Error(`Sign-in failed ${sign.status}`);
  const ACCESS = (await sign.json()).access_token;
  const db = async (path, init = {}) => {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      ...init,
      headers: { apikey: ANON_KEY, ...ACT_AS, Authorization: `Bearer ${ACCESS}`, "Content-Type": "application/json", ...(init.headers || {}) },
    });
    if (!res.ok) throw new Error(`DB ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  };

  const [cfg] = (await db("search_config?id=eq.1&select=titles,exclude_titles")) ?? [{}];
  const titles = (cfg?.titles ?? []).filter(Boolean);
  const excludes = (cfg?.exclude_titles ?? []).filter(Boolean);
  const [prof] = (await db("profile?id=eq.1&select=state,home_state").catch(() => [])) ?? [];
  const HOME = prof?.home_state || prof?.state || "";
  const near = nearPattern(HOME);
  if (!titles.length) {
    console.log("no titles to look for yet; nothing read.");
    process.exit(0);
  }

  // 1. The newest index the archive has.
  let api = null;
  try {
    const info = await (await ask("https://index.commoncrawl.org/collinfo.json")).json();
    api = info?.[0]?.["cdx-api"] ?? null;
  } catch (e) {
    console.log(`the archive's list of indexes could not be read (${String(e?.message ?? e).slice(0, 40)}); nothing done.`);
    process.exit(0);
  }
  if (!api) {
    console.log("the archive named no index; nothing done.");
    process.exit(0);
  }

  // 2. A few pages of it for each system, a different few each day.
  const day = Math.floor(Date.now() / 86_400_000);
  const boards = new Map();
  const read = {};
  const errors = [];
  for (const s of SYSTEMS) {
    let pages = 0;
    try {
      const n = await (await ask(`${api}?${s.query}&output=json&showNumPages=true`)).json();
      pages = Number(n?.pages ?? 0);
    } catch (e) {
      errors.push(`${s.ats} page count: ${String(e?.message ?? e).slice(0, 30)}`);
      continue;
    }
    await pause(2000);
    let lines = 0;
    for (let i = 0; i < Math.min(s.pages, pages); i++) {
      const page = (day * s.pages + i) % pages;
      try {
        const text = await (await ask(`${api}?${s.query}&output=json&fl=url&page=${page}`)).text();
        for (const line of text.split("\n")) {
          if (!line) continue;
          lines++;
          let url = null;
          try { url = JSON.parse(line).url; } catch { continue; }
          const b = boardFrom(url);
          if (b && !boards.has(b.url.toLowerCase())) boards.set(b.url.toLowerCase(), b);
        }
      } catch (e) {
        errors.push(`${s.ats} page ${i + 1}: ${String(e?.message ?? e).slice(0, 30)}`);
      }
      await pause(3000);
    }
    read[`${s.ats} (${pages} pages in all)`] = lines;
  }
  console.log(`archive addresses read: ${JSON.stringify(read)}; distinct boards among them: ${boards.size}`);

  // 3. The ones not looked at before.
  const known = (await db("company_candidates?select=careers_url&limit=50000")) ?? [];
  const firms = (await db("companies?select=ats,token,site&limit=20000")) ?? [];
  const seenUrl = new Set(known.map((r) => String(r.careers_url ?? "").replace(/\/+$/, "").toLowerCase()));
  const seenBoard = new Set(firms.map((r) => `${r.ats}|${String(r.token ?? "").toLowerCase()}|${String(r.site ?? "").toLowerCase()}`));
  const fresh = [...boards.values()].filter((b) => !seenUrl.has(b.url.toLowerCase()) && !seenBoard.has(`${b.ats}|${b.token.toLowerCase()}|${String(b.site ?? "").toLowerCase()}`));
  // Spread over the systems, so one large page of one does not use the run.
  const bySystem = {};
  for (const b of fresh) (bySystem[b.ats] ??= []).push(b);
  const turn = [];
  for (let i = 0; turn.length < MAX_CHECK && Object.values(bySystem).some((l) => l[i]); i++) for (const l of Object.values(bySystem)) if (l[i] && turn.length < MAX_CHECK) turn.push(l[i]);
  console.log(`not looked at before: ${fresh.length}; looking at ${turn.length} now`);

  // 4. Each board's own list, asked once.
  const tally = { kept: 0, nothingForOwner: 0, empty: 0, didNotAnswer: 0 };
  const keptBy = {};
  const home = stateName(HOME);
  for (const b of turn) {
    let rows = null;
    try {
      rows = postingsOf(b.ats, await listOf(b, home));
    } catch {
      rows = null;
    }
    const mine = rows ? forOwner(b.ats, rows, titles, excludes, near) : 0;
    const status = mine > 0 ? "ok" : "skipped";
    const note = rows === null ? "crawl: its list did not answer" : !rows.length ? "crawl: no openings listed" : mine > 0 ? `crawl: ${mine} opening(s) for the owner's titles in reach` : `crawl: ${rows.length} listed, none for the owner's titles in reach`;
    if (rows === null) tally.didNotAnswer++;
    else if (!rows.length) tally.empty++;
    else if (mine > 0) { tally.kept++; keptBy[b.ats] = (keptBy[b.ats] ?? 0) + 1; }
    else tally.nothingForOwner++;
    if (APPLY) {
      let name = b.token;
      if (mine > 0 && b.ats === "greenhouse") {
        name = await ask(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(b.token)}`, {}, 1).then((r) => r.json()).then((j) => String(j?.name ?? "").trim() || b.token).catch(() => b.token);
      }
      try {
        if (mine > 0) {
          await db("companies", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify([{ ats: b.ats, token: b.token, name, enabled: true, pod: b.pod ?? null, site: b.site ?? null, careers_url: b.url, last_error: null }]) });
        }
        await db("company_candidates?on_conflict=user_id,careers_url", {
          method: "POST",
          headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
          body: JSON.stringify([{ name, careers_url: b.url, status, ats: b.ats, token: b.token, pod: b.pod ?? null, site: b.site ?? null, note, checked_at: new Date().toISOString() }]),
        });
      } catch (e) {
        errors.push(`save: ${String(e?.message ?? e).slice(0, 60)}`);
      }
    }
    await pause(b.ats === "workday" ? 700 : 350);
  }
  console.log(`result: ${JSON.stringify(tally)}; kept by system ${JSON.stringify(keptBy)}${APPLY ? "" : " (report only; nothing saved)"}`);
  if (errors.length) console.log(`errors: ${JSON.stringify([...new Set(errors)].slice(0, 8))}`);
}
