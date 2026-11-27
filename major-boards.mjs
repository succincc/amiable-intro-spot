#!/usr/bin/env node
// major-boards.mjs — Job discovery for LinkedIn, Indeed, and ZipRecruiter.
//
// Runs inside GitHub Actions (free public-repo runner + cached Playwright) via
// `node forusers.mjs major-boards.mjs`. Reads each user's `search_config` and
// saved `site_accounts` sessions, discovers fresh matching postings, filters
// by titles/exclusions/remote/location, deduplicates against `jobs`, and stores
// them with `ats` = linkedin|indeed|ziprecruiter and `apply_mode` = easy_apply|external.
//
// Portions adapted from billmal071/job-agent (Copyright (c) 2025 Malachy Williams, MIT License).

import { guardLogs } from "./quiet.mjs";
import {
  BOARD_HOSTS,
  BOARD_PLATFORMS,
  BOARD_SELECTORS,
  CircuitBreakerRateLimiter,
  applyStealth,
  extractBoardJobId,
  humanDelay,
  humanScroll,
  normalizeBoardUrl,
} from "./major-boards-selectors.mjs";
import {
  captureBoardSession,
  checkVerificationWall,
  restoreBoardSession,
} from "./major-boards-engine.mjs";

guardLogs();

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const ACT_AS = process.env.AP_ACT_AS ? { "x-act-as": process.env.AP_ACT_AS } : {};
const AP_EMAIL = process.env.APPLYPILOT_EMAIL;
const AP_PASSWORD = process.env.APPLYPILOT_PASSWORD;
const APPLY = process.env.APPLY === "true";
const MAX_PER_QUERY = Math.max(5, Math.min(50, Number(process.env.MAX_PER_QUERY || 25)));
const MAX_TITLES = Math.max(1, Math.min(10, Number(process.env.MAX_TITLES || 5)));
const PLATFORMS_FILTER = (process.env.PLATFORMS || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter((s) => BOARD_PLATFORMS.includes(s));

/** Pure filter helper for board postings (exported for unit tests). */
export function filterBoardPostings(postings, cfg = {}) {
  const titles = (cfg.titles || []).map((t) => String(t).trim().toLowerCase()).filter(Boolean);
  const excludeTitles = (cfg.exclude_titles || []).map((t) => String(t).trim().toLowerCase()).filter(Boolean);
  const excludeCompanies = (cfg.exclude_companies || []).map((c) => String(c).trim().toLowerCase()).filter(Boolean);
  const includeRemote = cfg.include_remote !== false;
  const seen = new Set();
  const kept = [];

  for (const p of postings) {
    const title = String(p?.title ?? "").trim();
    const company = String(p?.company ?? "").trim();
    const url = String(p?.url ?? "").trim();
    if (!title || !url) continue;

    const tl = title.toLowerCase();
    const cl = company.toLowerCase();
    if (excludeTitles.some((ex) => tl.includes(ex))) continue;
    if (excludeCompanies.some((ex) => cl && cl.includes(ex))) continue;
    if (!includeRemote && p.remote) continue;

    if (titles.length) {
      const matched = titles.some((want) => {
        const words = want.split(/[^a-z0-9]+/).filter((w) => w.length > 2);
        return words.length > 0 && words.filter((w) => tl.includes(w)).length / words.length >= 0.5;
      });
      if (!matched) continue;
    }

    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(p);
  }
  return kept;
}

/** Build search URL for LinkedIn, Indeed, or ZipRecruiter. */
export function buildBoardSearchUrl(platform, { query, location = "", remote = false }) {
  const sel = BOARD_SELECTORS[platform];
  const params = new URLSearchParams();
  if (platform === "linkedin") {
    params.set("keywords", query);
    if (location) params.set("location", location);
    if (remote) params.set("f_WT", "2");
    params.set("f_TPR", "r604800"); // past 7 days
  } else if (platform === "indeed") {
    params.set("q", query);
    if (location) params.set("l", location);
    params.set("fromage", "7");
  } else if (platform === "ziprecruiter") {
    params.set("search", query);
    if (location) params.set("location", location);
    if (remote) params.set("remote", "1");
    params.set("days", "7");
  }
  return `${sel.searchUrl}?${params.toString()}`;
}

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
    headers: {
      apikey: ANON_KEY,
      ...ACT_AS,
      Authorization: `Bearer ${ACCESS}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`DB ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function scrapePlatform(context, platform, queries, location, remote) {
  const sel = BOARD_SELECTORS[platform];
  const limiter = new CircuitBreakerRateLimiter({ minDelayMs: 1800, maxDelayMs: 4200, maxFailures: 3 });
  const page = await context.newPage();
  const found = [];
  let blocked = null;

  try {
    for (const query of queries) {
      if (!(await limiter.wait())) {
        console.log(`${platform}: circuit breaker open, pausing remaining queries`);
        break;
      }
      const url = buildBoardSearchUrl(platform, { query, location, remote });
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
      await humanDelay(2000, 3800);

      const wall = await checkVerificationWall(page, platform);
      if (wall.blocked) {
        blocked = wall;
        limiter.failure();
        console.log(`${platform}: human verification wall detected during discovery`);
        break;
      }

      await page.waitForSelector(sel.jobCard, { timeout: 10_000 }).catch(async () => {
        await humanScroll(page, 400);
        await humanDelay(1000, 1800);
      });

      const cards = await page.locator(sel.jobCard).all().catch(() => []);
      if (!cards.length) {
        limiter.failure();
        continue;
      }
      limiter.success();

      for (const card of cards.slice(0, MAX_PER_QUERY)) {
        try {
          const title = ((await card.locator(sel.jobTitle).first().innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
          const company = ((await card.locator(sel.jobCompany).first().innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
          const loc = ((await card.locator(sel.jobLocation).first().innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
          const href = (await card.locator(sel.jobUrl).first().getAttribute("href").catch(() => "")) || "";
          const rawUrl = href.startsWith("/") ? `https://www.${BOARD_HOSTS[platform]}${href}` : href;
          let externalId = extractBoardJobId(platform, rawUrl);
          if (!externalId && platform === "linkedin") {
            const urn = (await card.getAttribute("data-entity-urn").catch(() => "")) || "";
            const m = urn.match(/jobPosting:(\d{7,})/);
            if (m) externalId = m[1];
          }
          if (!title || (!externalId && !rawUrl)) continue;

          const canonicalUrl = normalizeBoardUrl(platform, rawUrl, externalId);
          const salaryText = ((await card.locator(sel.jobSalary).first().innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim() || null;
          const cardText = ((await card.innerText().catch(() => "")) || "").toLowerCase();
          const easyApply =
            (await card.locator(sel.easyApplyBadge).count().catch(() => 0)) > 0 ||
            /easy apply|easily apply|1-click apply|quick apply/.test(cardText);
          const isRemote = /remote/i.test(loc) || /remote/i.test(title);

          found.push({
            title,
            company: company || "Unknown",
            location: loc || (isRemote ? "Remote" : location || null),
            url: canonicalUrl,
            apply_url: canonicalUrl,
            source: platform,
            ats: platform,
            apply_mode: easyApply ? "easy_apply" : "external",
            remote: isRemote,
            salary_text: salaryText,
            posted_at: new Date().toISOString(),
          });
        } catch {
          /* skip malformed card */
        }
      }
    }
  } finally {
    await page.close().catch(() => {});
  }
  return { found, blocked };
}

async function main() {
  await signIn();
  const [cfg] = (await db("search_config?id=eq.1&select=*")) ?? [];
  const [profile] = (await db("profile?id=eq.1&select=home_city,home_state,city,state")) ?? [];
  const enabledSources = Array.isArray(cfg?.sources) ? cfg.sources.map((s) => String(s).toLowerCase()) : [];
  const platforms = (PLATFORMS_FILTER.length ? PLATFORMS_FILTER : BOARD_PLATFORMS).filter((p) => enabledSources.includes(p));

  if (!platforms.length) {
    console.log("major-boards: none of linkedin/indeed/ziprecruiter enabled in search_config.sources");
    return;
  }

  const titles = (Array.isArray(cfg?.titles) ? cfg.titles : []).map((t) => String(t).trim()).filter(Boolean).slice(0, MAX_TITLES);
  if (!titles.length) {
    console.log("major-boards: no search titles configured");
    return;
  }

  const location =
    (Array.isArray(cfg?.locations) && cfg.locations[0]) ||
    [profile?.home_city || profile?.city, profile?.home_state || profile?.state].filter(Boolean).join(", ") ||
    "United States";
  const includeRemote = cfg?.include_remote !== false;

  const accounts = (await db("site_accounts?select=host,email,password,session_state,status")) ?? [];
  const existing = (await db("jobs?select=url&limit=8000")) ?? [];
  const existingUrls = new Set(existing.map((r) => String(r.url ?? "").toLowerCase()));

  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
  });

  let totalFound = 0;
  let totalKept = 0;
  let totalInserted = 0;

  try {
    for (const platform of platforms) {
      const host = BOARD_HOSTS[platform];
      const acct = accounts.find((a) => String(a.host || "").toLowerCase().includes(host));
      const ctx = await browser.newContext({
        viewport: { width: 1366, height: 900 },
        locale: "en-US",
        userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      });
      await applyStealth(ctx);
      const loaded = await restoreBoardSession(ctx, acct?.session_state, platform);
      console.log(`${platform}: searching ${titles.length} title(s), session cookies=${loaded}`);

      try {
        const { found, blocked } = await scrapePlatform(ctx, platform, titles, location, includeRemote);
        totalFound += found.length;
        const filtered = filterBoardPostings(found, cfg).filter((p) => !existingUrls.has(p.url.toLowerCase()));
        totalKept += filtered.length;

        if (APPLY && filtered.length) {
          for (const row of filtered) {
            existingUrls.add(row.url.toLowerCase());
          }
          await db("jobs?on_conflict=user_id,url", {
            method: "POST",
            headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
            body: JSON.stringify(filtered.map((r) => ({ ...r, status: "new" }))),
          }).catch((e) => console.log(`${platform}: insert warning — ${String(e.message).slice(0, 120)}`));
          totalInserted += filtered.length;
        }

        // Refresh captured cookies if we already had an account row
        if (APPLY && acct) {
          const fresh = await captureBoardSession(ctx, platform);
          if (fresh) {
            await db(`site_accounts?host=eq.${encodeURIComponent(acct.host)}`, {
              method: "PATCH",
              headers: { Prefer: "return=minimal" },
              body: JSON.stringify({ session_state: fresh, session_updated_at: new Date().toISOString() }),
            }).catch(() => {});
          }
        }
        console.log(`${platform}: found ${found.length}, new matching ${filtered.length}${blocked ? ` (paused: ${blocked.help_reason})` : ""}`);
      } finally {
        await ctx.close().catch(() => {});
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  console.log(`major-boards done: found ${totalFound}, kept ${totalKept}, inserted ${totalInserted} (apply=${APPLY})`);
}

if (process.env.MAJOR_BOARDS_IMPORT_ONLY !== "1") {
  main().catch((e) => {
    console.error(`major-boards failed: ${String(e?.message ?? e).slice(0, 200)}`);
    process.exit(1);
  });
}