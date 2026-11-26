#!/usr/bin/env node
// boards.mjs — postings from the smaller hiring systems.
//
// The resolver keeps finding employers on systems nothing read: BambooHR,
// JazzHR, Recruitee, Pinpoint, Teamtailor. Each of these publishes an
// employer's openings at a fixed, public address — the same list the
// employer's own careers page draws — and each ends in a plain application
// form: name, email, phone, resume, a handful of questions. The general
// form-filler already fills forms like that. So all that was missing was
// reading the lists.
//
// Nothing here signs in to anything or opens a browser. One request for an
// employer's list, one per wanted posting for its text, a pause between.
//
//   APPLY=true node boards.mjs
//
// Free: public addresses, and a runner in a public repository.

import { guardLogs, hideNames, shape, STATES } from "./quiet.mjs";
// Nothing this prints names an employer, a posting or a place: see quiet.mjs.
guardLogs();

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const AP_EMAIL = process.env.APPLYPILOT_EMAIL;
const AP_PASSWORD = process.env.APPLYPILOT_PASSWORD;
const APPLY = process.env.APPLY === "true"; // off: look and report, write nothing
const MAX_EMPLOYERS = Number(process.env.MAX_EMPLOYERS || 200);
const BUDGET_MS = Number(process.env.BUDGET_MINUTES || 25) * 60_000;

/** The systems read here, and the host each employer's board lives on. */
export const SYSTEMS = {
  bamboohr: /^([a-z0-9-]+)\.bamboohr\.com$/i,
  jazzhr: /^([a-z0-9-]+)\.applytojob\.com$/i,
  recruitee: /^([a-z0-9-]+)\.recruitee\.com$/i,
  pinpoint: /^([a-z0-9-]+)\.pinpointhq\.com$/i,
  teamtailor: /^([a-z0-9-]+)\.teamtailor\.com$/i,
  eightfold: /^([a-z0-9-]+)\.eightfold\.ai$/i,
};

/** A board's host, as the system it is and the employer's name on it; null for anything else. */
export function boardOf(host) {
  const h = String(host ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/[/?#].*$/, "");
  for (const [ats, re] of Object.entries(SYSTEMS)) {
    const m = h.match(re);
    if (m && !/^(www|app|api|careers?|jobs?|cdn|static|assets?|support|help|go|info|marketing)$/.test(m[1])) return { ats, sub: m[1], host: h };
  }
  return null;
}

const plain = (html) =>
  String(html ?? "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|li|h\d|tr|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&rsquo;|&apos;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*/g, "\n")
    .trim();

const place = (...parts) => parts.map((p) => String(p ?? "").trim()).filter(Boolean).join(", ") || null;
const isoOr = (v) => {
  const d = v ? new Date(v) : null;
  return d && Number.isFinite(d.getTime()) ? d.toISOString() : null;
};

/** Does this title look like one the owner searches for? */
export function wanted(title, titles, excludes) {
  const t = String(title ?? "").toLowerCase();
  if (!t) return false;
  if (excludes.some((x) => x && t.includes(String(x).toLowerCase()))) return false;
  if (!titles.length) return true;
  return titles.some((want) => {
    const words = String(want).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
    return words.length > 0 && words.filter((w) => t.includes(w)).length / words.length >= 0.5;
  });
}

// ---------------------------------------------------------------------------
// One reader per system. Each takes what its public address returned and
// gives back rows of one shape. Kept apart from the fetching so that each
// can be tested against a sample of the real thing.
// ---------------------------------------------------------------------------

/** BambooHR: /careers/list → { result: [{ id, jobOpeningName, location: { city, state }, isRemote }] } */
export function readBamboo(json, host) {
  return (json?.result ?? [])
    .filter((r) => r && r.id && r.jobOpeningName)
    .map((r) => ({
      id: String(r.id),
      url: `https://${host}/careers/${r.id}`,
      title: String(r.jobOpeningName).trim(),
      location: place(r.location?.city, r.location?.state) ?? place(r.atsLocation?.city, r.atsLocation?.state ?? r.atsLocation?.province),
      remote: r.isRemote === true || /remote/i.test(String(r.locationType ?? "")) || String(r.locationType) === "1",
      posted_at: isoOr(r.datePosted),
    }));
}

/** Recruitee: /api/offers/ → { offers: [{ title, careers_url, city, state_code, remote, published_at, description, requirements }] } */
export function readRecruitee(json) {
  return (json?.offers ?? [])
    .filter((r) => r && r.title && (r.careers_url || r.careers_apply_url))
    .filter((r) => !r.status || r.status === "published")
    .map((r) => ({
      id: String(r.id ?? r.slug ?? r.careers_url),
      url: String(r.careers_url || r.careers_apply_url),
      title: String(r.title).trim(),
      location: place(r.city, r.state_code || r.state_name) ?? (r.location ? String(r.location) : null),
      country: String(r.country_code ?? "").toUpperCase() || null,
      remote: r.remote === true,
      posted_at: isoOr(r.published_at ?? r.created_at),
      description: plain(`${r.description ?? ""}\n${r.requirements ?? ""}`).slice(0, 12000),
    }));
}

/** Pinpoint: /postings.json → { data: [{ id, title, url, location: { city, province }, workplace_type, description… }] } */
export function readPinpoint(json) {
  return (json?.data ?? [])
    .filter((r) => r && r.title && r.url)
    .map((r) => ({
      id: String(r.id ?? r.url),
      url: String(r.url),
      title: String(r.title).trim(),
      location: place(r.location?.city, r.location?.province) ?? (r.location?.name ? String(r.location.name) : null),
      remote: /remote/i.test(String(r.workplace_type ?? "")),
      posted_at: isoOr(r.published_at ?? r.created_at),
      description: plain(`${r.description ?? ""}\n${r.key_responsibilities ?? ""}\n${r.skills_knowledge_expertise ?? ""}`).slice(0, 12000),
    }));
}

/** JazzHR: the board is a page of links, /apply/{id}/{slug}, each in a row with its place. */
export function readJazz(html, host) {
  const out = [];
  const seen = new Set();
  const re = /<a[^>]+href="((?:https?:\/\/[^"]*)?\/apply\/([A-Za-z0-9]+)\/[^"#?]*)[^"]*"[^>]*>([\s\S]*?)<\/a>(?=([\s\S]{0,600}))/gi;
  for (const m of String(html ?? "").matchAll(re)) {
    const id = m[2];
    if (seen.has(id)) continue;
    const title = plain(m[3]);
    if (!title || title.length > 160 || /^(apply|view|details|learn more|read more)$/i.test(title)) continue;
    seen.add(id);
    // The place is the first short "Town, ST" in what follows the link.
    const after = plain(m[4].split(/<a\b/i)[0]);
    const where = (after.match(/([A-Z][A-Za-z .'-]{1,40},\s*[A-Z]{2})\b/) ?? [])[1] ?? null;
    out.push({
      id,
      url: m[1].startsWith("http") ? m[1] : `https://${host}${m[1]}`,
      title,
      location: where,
      remote: /\bremote\b/i.test(`${title} ${after}`),
      posted_at: null,
    });
  }
  return out;
}

const US_STATE_NAMES = new Set(Object.values(STATES).map((n) => n.toLowerCase()));

/**
 * Eightfold: /api/apply/v2/jobs?domain=… → { positions: [{ id, name, location,
 * locations, t_create, canonicalPositionUrl, work_location_option }], count }.
 * The place is written "Town, ST, US" or "Town, Country"; the country is
 * taken off the end so that only postings in this one are kept.
 */
export function readEightfold(json, host) {
  const out = [];
  for (const r of json?.positions ?? []) {
    const id = r?.id ?? r?.ats_job_id;
    const title = String(r?.name ?? r?.posting_name ?? "").trim();
    if (!id || !title) continue;
    const raw = String(r.location ?? (Array.isArray(r.locations) ? r.locations[0] : "") ?? "").trim();
    const parts = raw.split(",").map((x) => x.trim()).filter(Boolean);
    const last = parts.at(-1) ?? "";
    let country = null;
    if (/^(US|USA|United States( of America)?)$/i.test(last)) {
      country = "US";
      parts.pop();
    } else if (parts.length >= 2 && !/^[A-Z]{2}$/.test(last) && !US_STATE_NAMES.has(last.toLowerCase()) && !/remote|hybrid|multiple|virtual/i.test(last)) {
      country = last;
    }
    const made = Number(r.t_create ?? r.t_update ?? 0);
    out.push({
      id: String(id),
      url: typeof r.canonicalPositionUrl === "string" && r.canonicalPositionUrl.startsWith("http") ? r.canonicalPositionUrl : `https://${host}/careers/job/${id}`,
      title,
      location: parts.join(", ") || null,
      country,
      remote: /remote/i.test(`${r.work_location_option ?? ""} ${raw}`),
      description: r.job_description ? plain(r.job_description).slice(0, 12000) : "",
      posted_at: made > 0 ? new Date(made < 1e11 ? made * 1000 : made).toISOString() : null,
    });
  }
  return out;
}

/** The employer's own domain as an Eightfold careers page states it: the key its list is asked for by. */
export function eightfoldDomain(html) {
  const t = String(html ?? "");
  return (
    (t.match(/["']domain["']\s*:\s*["']([a-z0-9-]+(?:\.[a-z0-9-]+)+)["']/i) ?? [])[1] ??
    (t.match(/[?&]domain=([a-z0-9-]+(?:\.[a-z0-9-]+)+)/i) ?? [])[1] ??
    null
  );
}

/** Teamtailor: /jobs.rss → <item><title/><link/><pubDate/><description/> and its own location tags. */
export function readTeamtailor(xml) {
  const out = [];
  for (const m of String(xml ?? "").matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const item = m[1];
    const tag = (name) => {
      const t = item.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
      return t ? t[1].replace(/^<!\[CDATA\[|\]\]>$/g, "").trim() : "";
    };
    const title = plain(tag("title"));
    const url = plain(tag("link"));
    if (!title || !/^https?:\/\//.test(url)) continue;
    out.push({
      id: url,
      url,
      title,
      location: place(plain(tag("tt:city")) || plain(tag("city")), plain(tag("tt:state")) || plain(tag("region"))) ,
      country: plain(tag("tt:country") || tag("country")) || null,
      remote: /fully|remote/i.test(tag("remoteStatus") || tag("tt:remoteStatus")),
      posted_at: isoOr(tag("pubDate")),
      description: plain(tag("description")).slice(0, 12000),
    });
  }
  return out;
}

/** A posting's own words out of its page: the JobPosting data where there is any, else the page's main text. */
export function describeFrom(html) {
  for (const m of String(html ?? "").matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const j = JSON.parse(m[1]);
      for (const node of Array.isArray(j) ? j : [j, ...(Array.isArray(j?.["@graph"]) ? j["@graph"] : [])]) {
        if (node?.["@type"] === "JobPosting" && node.description) {
          // The place too, where the posting states it: a list that names no
          // town leaves a posting that cannot be measured.
          const at = [node.jobLocation].flat().filter(Boolean)[0]?.address ?? null;
          const where = at && typeof at === "object" ? [at.addressLocality, at.addressRegion].map((x) => String(x ?? "").trim()).filter(Boolean).join(", ") : "";
          return { description: plain(node.description).slice(0, 12000), posted_at: isoOr(node.datePosted), ...(where ? { location: where.slice(0, 80) } : {}) };
        }
      }
    } catch {
      /* not this block */
    }
  }
  const main = String(html ?? "").match(/<(main|article)[\s\S]*?<\/\1>/i)?.[0] ?? String(html ?? "").match(/<body[\s\S]*<\/body>/i)?.[0] ?? "";
  return { description: plain(main).slice(0, 12000), posted_at: null };
}

// ---------------------------------------------------------------------------
if (process.env.BOARDS_IMPORT_ONLY !== "1") {
  if (!SUPABASE_URL || !ANON_KEY || !AP_EMAIL || !AP_PASSWORD) {
    console.error("Missing SUPABASE_URL, SUPABASE_ANON_KEY, APPLYPILOT_EMAIL or APPLYPILOT_PASSWORD.");
    process.exit(1);
  }

  let ACCESS = "";
  let REFRESH = "";
  let EXPIRES = 0;
  const auth = async (body, grant) => {
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
  };
  const db = async (path, init = {}) => {
    if (Date.now() > EXPIRES) await auth({ refresh_token: REFRESH }, "refresh_token");
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      ...init,
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${ACCESS}`, "Content-Type": "application/json", ...(init.headers || {}) },
    });
    if (!res.ok) throw new Error(`DB ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  };
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  const get = async (url, accept) => {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: accept }, signal: AbortSignal.timeout(20_000), redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  };
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));

  await auth({ email: AP_EMAIL, password: AP_PASSWORD }, "password");
  const [cfg] = (await db("search_config?id=eq.1&select=titles,exclude_titles")) ?? [{}];
  const titles = (cfg?.titles ?? []).filter(Boolean);
  const excludes = (cfg?.exclude_titles ?? []).filter(Boolean);

  // Every employer the resolver has placed on one of these systems. Its note
  // carries the board's host.
  const names = Object.keys(SYSTEMS);
  const found =
    (await db(
      `company_candidates?or=(${names.map((n) => `note.ilike.*runs%20on%20${n}%20at*`).join(",")})&select=name,note,careers_url,resolved_url&limit=1000`,
    )) ?? [];
  const boards = new Map();
  for (const r of found) {
    const hosts = [
      (String(r.note).match(/ at ([a-z0-9.-]+\.[a-z]{2,})/i) ?? [])[1],
      (() => { try { return new URL(r.resolved_url).hostname; } catch { return null; } })(),
      (() => { try { return new URL(r.careers_url).hostname; } catch { return null; } })(),
    ];
    let placed = false;
    for (const h of hosts) {
      const b = boardOf(h);
      if (b) placed = true;
      if (b && !boards.has(b.host)) { boards.set(b.host, { ...b, name: r.name }); break; }
    }
    // Eightfold is often served from the employer's own careers address,
    // and answers there the same way.
    const own = (String(r.note).match(/runs on eightfold at ([a-z0-9.-]+\.[a-z]{2,})/i) ?? [])[1]?.toLowerCase();
    if (!placed && own && !boards.has(own)) boards.set(own, { ats: "eightfold", sub: own.split(".").slice(-2, -1)[0] ?? "", host: own, name: r.name });
  }
  const list = [...boards.values()].slice(0, MAX_EMPLOYERS);
  hideNames(list.map((e) => e.name));
  const by = {};
  for (const e of list) by[e.ats] = (by[e.ats] ?? 0) + 1;
  console.log(`${found.length} employer(s) placed on these systems; ${list.length} board(s) to read ${JSON.stringify(by)}; ${titles.length} title(s) wanted; ${APPLY ? "saving postings" : "report only"}.`);

  const started = Date.now();
  const tally = { boards: 0, unreadable: 0, read: 0, wanted: 0, fresh: 0, saved: 0 };
  const perSystem = {};
  const sampled = new Set();
  for (const e of list) {
    if (Date.now() - started > BUDGET_MS) break;
    tally.boards++;
    const sys = (perSystem[e.ats] ??= { boards: 0, read: 0, kept: 0, failed: 0 });
    sys.boards++;
    let rows = [];
    try {
      if (e.ats === "bamboohr") rows = readBamboo(await (await get(`https://${e.host}/careers/list`, "application/json")).json(), e.host);
      else if (e.ats === "recruitee") rows = readRecruitee(await (await get(`https://${e.host}/api/offers/`, "application/json")).json());
      else if (e.ats === "pinpoint") rows = readPinpoint(await (await get(`https://${e.host}/postings.json`, "application/json")).json());
      else if (e.ats === "jazzhr") rows = readJazz(await (await get(`https://${e.host}/apply`, "text/html")).text(), e.host);
      else if (e.ats === "teamtailor") rows = readTeamtailor(await (await get(`https://${e.host}/jobs.rss`, "application/rss+xml, text/xml")).text());
      else if (e.ats === "eightfold") {
        // Its list is asked for by the employer's own domain, which the
        // careers page states. Newest first, a few pages: fresh is all that
        // is wanted.
        const page = await (await get(`https://${e.host}/careers`, "text/html")).text();
        const domain = eightfoldDomain(page) ?? `${e.sub}.com`;
        e.domain = domain;
        let total = Infinity;
        for (let start = 0; start < Math.min(total, 300); ) {
          const j = await (await get(`https://${e.host}/api/apply/v2/jobs?domain=${encodeURIComponent(domain)}&start=${start}&num=50&sort_by=timestamp`, "application/json")).json();
          const got = readEightfold(j, e.host);
          if (start === 0 && !got.length) console.log(`     eightfold answered ${JSON.stringify(shape(j)).slice(0, 300)}; domain ${eightfoldDomain(page) ? "stated on the page" : "guessed"}`);
          if (!got.length) break;
          rows.push(...got);
          total = Number(j?.count ?? rows.length);
          start += (j?.positions ?? []).length;
          await pause(400);
        }
      }
    } catch (err) {
      tally.unreadable++;
      sys.failed++;
      console.log(`  ?  ${e.name} (${e.ats}) — list not read: ${String(err?.message ?? err).slice(0, 60)}`);
      await pause(600);
      continue;
    }
    tally.read += rows.length;
    sys.read += rows.length;
    if (rows.length && !sampled.has(e.ats)) {
      sampled.add(e.ats);
      console.log(`  sample ${e.ats} row: ${JSON.stringify(shape(rows[0])).slice(0, 400)}`);
    }

    const keep = [];
    for (const r of rows) {
      if (r.country && !/^(US|USA|UNITED STATES)$/i.test(r.country)) continue;
      if (!wanted(r.title, titles, excludes)) continue;
      tally.wanted++;
      if (r.posted_at && new Date(r.posted_at).getTime() < Date.now() - 14 * 86_400_000) continue;
      keep.push(r);
    }
    console.log(`  ok ${e.name} (${e.ats}) — ${rows.length} read, ${keep.length} wanted`);
    if (!keep.length) { await pause(500); continue; }

    const body = [];
    for (const r of keep.slice(0, 25)) {
      let description = r.description ?? "";
      let posted_at = r.posted_at ?? null;
      if (description.length < 200) {
        try {
          if (e.ats === "bamboohr") {
            const d = await (await get(`https://${e.host}/careers/${r.id}/detail`, "application/json")).json();
            const o = d?.result?.jobOpening ?? d?.result ?? {};
            description = plain(o.description ?? "").slice(0, 12000);
            posted_at ??= isoOr(o.datePosted);
          } else if (e.ats === "eightfold") {
            const d = await (await get(`https://${e.host}/api/apply/v2/jobs/${r.id}?domain=${encodeURIComponent(e.domain ?? "")}`, "application/json")).json();
            description = plain(d?.job_description ?? "").slice(0, 12000);
          } else {
            const got = describeFrom(await (await get(r.url, "text/html")).text());
            description = got.description;
            posted_at ??= got.posted_at;
            r.location ??= got.location ?? null;
          }
        } catch {
          /* a posting without its text is still a posting */
        }
        await pause(700);
      }
      // Fresh postings only, as everywhere else; one with no date is kept
      // undated and left for the applier to judge.
      if (posted_at && new Date(posted_at).getTime() < Date.now() - 14 * 86_400_000) continue;
      tally.fresh++;
      sys.kept++;
      body.push({
        url: r.url,
        apply_url: r.url,
        title: r.title,
        company: e.name,
        location: r.location,
        remote: r.remote === true,
        description,
        source: e.ats,
        ats: e.ats,
        posted_at,
        status: "new",
      });
    }
    if (APPLY && body.length) {
      try {
        const saved = await db("jobs?on_conflict=url", {
          method: "POST",
          headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
          body: JSON.stringify(body),
        });
        tally.saved += saved?.length ?? 0;
      } catch (err) {
        console.log(`     could not save ${e.name}: ${String(err.message).slice(0, 120)}`);
      }
    }
    await pause(800);
  }

  console.log(`by system: ${JSON.stringify(perSystem)}`);
  console.log(`result: ${JSON.stringify(tally)} in ${Math.round((Date.now() - started) / 60000)} min`);
  process.exit(0);
}
