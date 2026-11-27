// The companies of the S&P MidCap 400 and SmallCap 600, added to the
// employers the resolver looks at.
//
// The lists are Wikipedia's, read through its own interface for programs;
// each company's web address is Wikidata's "official website". The careers
// address saved is that site's /careers, which the resolver treats as a
// starting point: it follows it to whatever is really there, tries the usual
// other places when it is dead, and asks the hiring systems by name.
//
// Free: two public reference sites and a GitHub runner. Nothing is printed
// but counts.

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
// Whose round this is, when the runner is doing somebody else's: see forusers.mjs.
const ACT_AS = process.env.AP_ACT_AS ? { "x-act-as": process.env.AP_ACT_AS } : {};
const AP_EMAIL = process.env.APPLYPILOT_EMAIL;
const AP_PASSWORD = process.env.APPLYPILOT_PASSWORD;
const APPLY = process.env.APPLY === "true";
const UA = "ApplyPilot/1.0 (job search tool; reads index constituent lists monthly)";

export const LISTS = ["List of S&P 400 companies", "List of S&P 600 companies"];

const flat = (v) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const plain = (html) => String(html ?? "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;|&#160;/g, " ").replace(/\s+/g, " ").trim();

/**
 * The companies in a list page: each row's link to the company's own
 * article. The ticker links out to an exchange and is passed over; the
 * company is the first link in the row that stays on Wikipedia.
 */
export function companiesIn(html) {
  const out = [];
  const seen = new Set();
  const table = String(html ?? "").match(/<table[^>]*id="constituents"[\s\S]*?<\/table>/i)?.[0] ?? String(html ?? "").match(/<table[^>]*class="[^"]*wikitable[^"]*"[\s\S]*?<\/table>/i)?.[0] ?? "";
  for (const row of table.split(/<tr[\s>]/i).slice(1)) {
    if (!/<td/i.test(row)) continue;
    const m = row.match(/<a href="\/wiki\/([^"#?]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!m) continue;
    const title = decodeURIComponent(m[1]).replace(/_/g, " ");
    if (/^(File|Category|Help|Special|Wikipedia|Template):/i.test(title)) continue;
    const name = plain(m[2]);
    if (!name || seen.has(title)) continue;
    seen.add(title);
    out.push({ title, name });
  }
  return out;
}

/** A company's name as an employer would be known: no share class, no "Inc." */
export function employerName(name) {
  let n = String(name ?? "").replace(/\s*\((class [a-z]|[a-z]+ shares?|the)\)\s*/gi, " ").replace(/\s+/g, " ").trim();
  // The legal form only; "Group" and "Holdings" are part of what people call it.
  for (let i = 0; i < 2; i++) n = n.replace(/[,\s]+(inc|incorporated|corp|corporation|co|company|ltd|plc|llc|lp|n\.?v|s\.?a)\.?$/i, "").trim();
  return n;
}

/** Where the resolver should start for a company whose own site is this. */
export function careersFrom(website) {
  try {
    const u = new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`);
    if (!/\./.test(u.hostname)) return null;
    return `https://${u.hostname.toLowerCase()}/careers`;
  } catch {
    return null;
  }
}

/**
 * Asked politely: a reference site that says "too many, wait" is waited
 * for, as long as it says, and asked again.
 */
async function getJson(url) {
  let last = "";
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    if (res.ok) return res.json();
    last = `HTTP ${res.status}`;
    if (res.status !== 429 && res.status < 500) break;
    const asked = Number(res.headers.get("retry-after"));
    await new Promise((r) => setTimeout(r, Math.min(90_000, (Number.isFinite(asked) && asked > 0 ? asked : 5 * 2 ** attempt) * 1000)));
  }
  throw new Error(last);
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.env.INDEXES_IMPORT_ONLY !== "1") {
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

  // 1. The lists.
  const companies = [];
  for (const page of LISTS) {
    try {
      const j = await getJson(`https://en.wikipedia.org/w/api.php?action=parse&format=json&prop=text&redirects=1&page=${encodeURIComponent(page)}`);
      const found = companiesIn(j?.parse?.text?.["*"]);
      console.log(`${page}: ${found.length} companies listed`);
      companies.push(...found);
    } catch (e) {
      console.log(`${page}: could not be read (${String(e?.message ?? e).slice(0, 60)})`);
    }
    await pause(1000);
  }

  // 2. Each company's entry in Wikidata, fifty at a time.
  const item = new Map();
  const errors = [];
  for (let i = 0; i < companies.length; i += 50) {
    const batch = companies.slice(i, i + 50);
    try {
      const j = await getJson(`https://en.wikipedia.org/w/api.php?action=query&format=json&prop=pageprops&ppprop=wikibase_item&redirects=1&titles=${encodeURIComponent(batch.map((c) => c.title).join("|"))}`);
      const back = new Map();
      for (const r of [...(j?.query?.normalized ?? []), ...(j?.query?.redirects ?? [])]) back.set(r.to, back.get(r.from) ?? r.from);
      for (const p of Object.values(j?.query?.pages ?? {})) {
        const q = p?.pageprops?.wikibase_item;
        if (!q) continue;
        item.set(p.title, q);
        // Under the name it was asked for, too.
        let from = back.get(p.title);
        for (let hop = 0; from && hop < 3; hop++) {
          item.set(from, q);
          from = back.get(from);
        }
      }
    } catch (e) {
      errors.push(`entry lookup: ${String(e?.message ?? e).slice(0, 60)}`);
    }
    await pause(2500);
  }

  // 3. Each entry's official website.
  const site = new Map();
  const ids = [...new Set(item.values())];
  for (let i = 0; i < ids.length; i += 50) {
    try {
      const j = await getJson(`https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=claims&ids=${ids.slice(i, i + 50).join("|")}`);
      for (const [q, e] of Object.entries(j?.entities ?? {})) {
        const claims = e?.claims?.P856 ?? [];
        const best = claims.find((c) => c.rank === "preferred") ?? claims.find((c) => c.rank !== "deprecated");
        const url = best?.mainsnak?.datavalue?.value;
        if (typeof url === "string") site.set(q, url);
      }
    } catch (e) {
      errors.push(`web address lookup: ${String(e?.message ?? e).slice(0, 60)}`);
    }
    await pause(2500);
  }
  console.log(`entries found for ${item.size} name(s), ${ids.length} distinct; web addresses for ${site.size}${errors.length ? `; errors ${JSON.stringify([...new Set(errors)].slice(0, 4))}` : ""}`);

  // 4. The ones not already held.
  const known = (await db("company_candidates?select=name,careers_url&limit=10000")) ?? [];
  const firms = (await db("companies?select=name&limit=10000")) ?? [];
  const names = new Set([...known, ...firms].map((r) => flat(employerName(r.name))));
  const urls = new Set(known.map((r) => String(r.careers_url ?? "").replace(/\/+$/, "").toLowerCase()));
  const fresh = [];
  let noSite = 0;
  let held = 0;
  for (const c of companies) {
    const name = employerName(c.name);
    // The company's own address where one is on file; otherwise the guess
    // from its name, which the resolver follows or drops.
    let url = careersFrom(site.get(item.get(c.title)) ?? "");
    if (!url) {
      noSite++;
      const slug = flat(name);
      if (slug.length < 4 || slug.length > 30) continue;
      url = `https://www.${slug}.com/careers`;
    }
    if (names.has(flat(name)) || urls.has(url)) { held++; continue; }
    names.add(flat(name));
    urls.add(url);
    fresh.push({ name, careers_url: url, status: "pending" });
  }
  console.log(`${companies.length} companies on the two lists; ${site.size} with a web address on file; ${held} already held; ${noSite} with no address on file (started from a guess at it); ${fresh.length} new`);

  if (APPLY && fresh.length) {
    let added = 0;
    for (let i = 0; i < fresh.length; i += 50) {
      try {
        await db("company_candidates?on_conflict=user_id,careers_url", { method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=minimal" }, body: JSON.stringify(fresh.slice(i, i + 50)) });
        added += Math.min(50, fresh.length - i);
      } catch (e) {
        console.log(`a batch could not be saved: ${String(e?.message ?? e).slice(0, 100)}`);
      }
    }
    console.log(`added ${added} employer(s) for the resolver to look at.`);
  } else if (fresh.length) {
    console.log(`report only: would add ${fresh.length} employer(s)`);
  }
}
