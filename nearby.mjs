// The employers around the owner, from the open map.
//
// No stock index holds the shops, restaurants, offices and clinics within a
// drive of home, and those are most of the jobs that are. OpenStreetMap
// lists them, many with their own web address. Each one's site is handed to
// the resolver as a place to start, the same as any company from a list;
// a chain with twenty branches in reach is looked at first.
//
// One question to the map every three days. The owner's position is rounded
// before it is sent, and nothing is printed but counts. Free, no key.

// Everything printed here goes through the nets in quiet.mjs: this log is public.
import { allRows } from "./pages.mjs";
import "./quiet.mjs";
const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
// Whose round this is, when the runner is doing somebody else's: see forusers.mjs.
const ACT_AS = process.env.AP_ACT_AS ? { "x-act-as": process.env.AP_ACT_AS } : {};
const AP_EMAIL = process.env.APPLYPILOT_EMAIL;
const AP_PASSWORD = process.env.APPLYPILOT_PASSWORD;
const APPLY = process.env.APPLY === "true";
// How many new employers one run hands to the resolver. It was 400 a week
// against 2,283 the map knows within reach: a month to hear of them all,
// while the resolver was looking at 2,000 a day and running out of new ones.
const MAX_NEW = Number(process.env.MAX_NEW || 1000);

// Addresses that are a page on somebody else's site, not the business's own.
const NOT_ITS_OWN =
  /(^|\.)(facebook|instagram|twitter|x|linkedin|yelp|google|goo|tripadvisor|foursquare|linktr|wixsite|wix|squarespace|weebly|godaddysites|business\.site|sites\.google|youtube|tiktok|doordash|grubhub|ubereats|toasttab|opentable|square\.site|shopify|myshopify|blogspot|wordpress|bit|tinyurl|wikipedia|openstreetmap)\.[a-z.]+$|^(bit\.ly|goo\.gl|t\.co|fb\.me)$/i;

const flat = (v) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** A business's web address as the site it belongs to, or null for one that is not its own. */
export function siteOf(raw) {
  const t = String(raw ?? "").trim().split(/[;\s]/)[0];
  if (!t) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(t) ? t : `https://${t}`);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) || NOT_ITS_OWN.test(host)) return null;
    // "locations.acme.com" and "stores.acme.com" are acme.com.
    return host.replace(/^(locations?|stores?|local|shop|order|restaurants?|branches?|find|maps?|m)\./, "");
  } catch {
    return null;
  }
}

/**
 * The map's places as employers: one per web site, under the name most of
 * its places go by, with how many places it has in reach. Most places first.
 */
export function employersFrom(elements) {
  const by = new Map();
  for (const e of elements ?? []) {
    const tags = e?.tags ?? {};
    const site = siteOf(tags.website ?? tags["contact:website"] ?? tags["brand:website"]);
    const name = String(tags.brand ?? tags.operator ?? tags.name ?? "").trim();
    if (!site || name.length < 2 || name.length > 80) continue;
    const row = by.get(site) ?? { site, names: new Map(), places: 0 };
    row.places++;
    row.names.set(name, (row.names.get(name) ?? 0) + 1);
    by.set(site, row);
  }
  return [...by.values()]
    .map((r) => ({ site: r.site, places: r.places, name: [...r.names.entries()].sort((a, b) => b[1] - a[1])[0][0] }))
    .sort((a, b) => b.places - a.places);
}

if (process.env.NEARBY_IMPORT_ONLY !== "1") {
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

  const [prof] = (await db("profile?id=eq.1&select=home_lat,home_lon").catch(() => [])) ?? [];
  const [cfg] = (await db("search_config?id=eq.1&select=radius_miles").catch(() => [])) ?? [];
  const lat = Number(prof?.home_lat);
  const lon = Number(prof?.home_lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || (!lat && !lon)) {
    console.log("home is not placed on the map yet (set the home town in Settings); nothing asked.");
    process.exit(0);
  }
  // To about a mile, which is all the question needs.
  const at = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const miles = Math.min(30, Math.max(5, Number(cfg?.radius_miles ?? 0) || 25));
  const around = `around:${Math.round(miles * 1609)},${at}`;
  const site = `[~"^(website|contact:website|brand:website)$"~"."]`;
  const q =
    `[out:json][timeout:170][maxsize:268435456];(` +
    `nwr(${around})["name"]["shop"]${site};` +
    `nwr(${around})["name"]["office"]${site};` +
    `nwr(${around})["name"]["craft"]${site};` +
    `nwr(${around})["name"]["healthcare"]${site};` +
    `nwr(${around})["name"]["amenity"~"^(restaurant|fast_food|cafe|bank|pharmacy|clinic|hospital|dentist|doctors|veterinary|car_rental|car_wash|fuel|cinema|college|university|childcare|kindergarten|gym|social_facility|school|library|townhall|community_centre|nursing_home|theatre|arts_centre|animal_boarding|courthouse|pub|bar|ice_cream)$"]${site};` +
    `nwr(${around})["name"]["tourism"~"^(hotel|motel|attraction|museum|theme_park)$"]${site};` +
    `nwr(${around})["name"]["leisure"~"^(fitness_centre|sports_centre|golf_course)$"]${site};` +
    // Where most of the jobs that are not in a shop are, and where an
    // employer is least likely to pay a job board: plants, warehouses,
    // depots, business parks.
    `nwr(${around})["name"]["industrial"]${site};` +
    `nwr(${around})["name"]["man_made"="works"]${site};` +
    `nwr(${around})["name"]["building"~"^(industrial|warehouse|commercial|office|retail)$"]${site};` +
    `nwr(${around})["name"]["landuse"~"^(industrial|commercial|retail)$"]${site};` +
    `);out tags 12000;`;
  let elements = null;
  for (const host of ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]) {
    try {
      const res = await fetch(host, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "ApplyPilot (job search assistant)" },
        body: `data=${encodeURIComponent(q)}`,
        signal: AbortSignal.timeout(200_000),
      });
      if (!res.ok) {
        console.log(`the map answered ${res.status}`);
        continue;
      }
      elements = (await res.json())?.elements ?? [];
      break;
    } catch (e) {
      console.log(`the map could not be asked (${String(e?.message ?? e).slice(0, 40)})`);
    }
  }
  if (!elements) {
    console.log("no answer from the map this time; tried again next week.");
    process.exit(0);
  }
  const employers = employersFrom(elements);

  // All of them, a thousand at a time: see pages.mjs.
  const known = await allRows(db, "company_candidates?select=name,careers_url,resolved_url");
  const firms = await allRows(db, "companies?select=name,careers_url");
  const names = new Set([...known, ...firms].map((r) => flat(r.name)));
  const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase().replace(/^(www|careers?|jobs?)\./, ""); } catch { return ""; } };
  const hosts = new Set([...known, ...firms].flatMap((r) => [hostOf(r.careers_url), hostOf(r.resolved_url)]).filter(Boolean));
  const fresh = [];
  let held = 0;
  for (const e of employers) {
    if (names.has(flat(e.name)) || hosts.has(e.site)) { held++; continue; }
    names.add(flat(e.name));
    hosts.add(e.site);
    fresh.push({ name: e.name, careers_url: `https://www.${e.site}/careers`, status: "pending", note: `map: ${e.places} place(s) in reach` });
    if (fresh.length >= MAX_NEW) break;
  }
  const chains = employers.filter((e) => e.places >= 3).length;
  console.log(`${elements.length} place(s) with a web address within ${miles} mi; ${employers.length} employer(s), ${chains} with three or more places; ${held} already held; ${fresh.length} new this time (most places first)`);

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
