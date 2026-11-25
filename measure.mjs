// Measure how far every waiting job is from home.
//
// The applier now refuses any job that is not remote or measured inside the
// commuting radius — and the first run under that rule found 685 of 699
// queued jobs had never been measured at all. Discovery measures as it goes,
// but inside a request that has to finish in seconds: about twenty new places
// a run, twice a day, against a backlog of several hundred. An application
// went to Buffalo, 350 miles away, in the gap.
//
// This does the same measuring where there is no clock on it. Places repeat
// heavily, so each distinct one is looked up once — the shared cache first,
// then OpenStreetMap's free geocoder at its one request a second — and every
// job in that place gets its distance. Jobs beyond the radius are skipped
// with the reason; jobs within it become applicable; jobs whose posting names
// no place stay unmeasured and are counted, not guessed.
//
// Nothing here costs anything, and nothing leaves but place names.

import { guardLogs, hideNames } from "./quiet.mjs";
// Nothing this prints names an employer, a posting or a place: see quiet.mjs.
guardLogs();
const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const AP_EMAIL = process.env.APPLYPILOT_EMAIL;
const AP_PASSWORD = process.env.APPLYPILOT_PASSWORD;
const APPLY = process.env.APPLY === "true"; // off: measure and report, write nothing
const MAX_LOOKUPS = Number(process.env.MAX_LOOKUPS ?? 600);

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

// ---------------------------------------------------------------------------
// Reading a place out of a location string
// ---------------------------------------------------------------------------
// The whole string, not its first word: Workday writes "US - NJ -
// Lawrenceville", and a rule that stopped at a leading "US" threw the town
// away with the country.
const NON_PLACE = /^(remote.*|anywhere|various|multiple\s+locations|\d+\s+locations?|united states( of america)?|usa?|north america|worldwide|global|virtual|field|nationwide)$/i;

/** One posting's location string, as the distinct places it names. */
export function placesIn(raw) {
  if (!raw) return [];
  const out = [];
  // "New York, NY; Boston, MA" and "New York, NY | Remote" name several.
  for (let s of String(raw).split(/\s*(?:;|\||\bor\b|\/(?=\s))\s*/i)) {
    s = s.trim();
    if (!s || NON_PLACE.test(s)) continue;
    s = s
      .replace(/\s*\(.*?\)\s*/g, " ")
      .replace(/\b(remote|hybrid|on-?site|flexible|office|headquarters|hq)\b/gi, " ")
      .replace(/\b\d{5}(-\d{4})?\b/g, " ")
      .replace(/,(?=\S)/g, ", ")
      .replace(/\s*[-–—]\s*/g, ", ")
      .replace(/\s{2,}/g, " ")
      .trim()
      .replace(/^,|,$/g, "")
      .trim();
    let bits = s.split(",").map((p) => p.trim()).filter(Boolean);
    if (bits.length > 2 && /^\d+\s+\S/.test(bits[0])) bits.shift();
    // "US, NJ, Lawrenceville" is a town with its country and state in front.
    while (bits.length > 1 && /^(us|usa|united states)$/i.test(bits[0])) bits.shift();
    if (bits.length === 2 && /^[A-Z]{2}$/.test(bits[0]) && !/^[A-Z]{2}$/.test(bits[1])) bits = [bits[1], bits[0]];
    s = bits.join(", ");
    if (s.length < 3 || NON_PLACE.test(s)) continue;
    out.push(s);
  }
  return [...new Set(out)];
}

export function milesBetween(aLat, aLon, bLat, bLon) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(bLat - aLat);
  const dLon = rad(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(h));
}

// ---------------------------------------------------------------------------
// Looking a place up: the shared cache, then the geocoder, one a second
// ---------------------------------------------------------------------------
const seen = new Map();
let lookups = 0;
const keyOf = (place) => place.trim().toLowerCase().replace(/\s+/g, " ");

async function locate(place) {
  const key = keyOf(place);
  if (seen.has(key)) return seen.get(key);

  const cached = await db(`geo_cache?place=eq.${encodeURIComponent(key)}&select=lat,lon,found&limit=1`).catch(() => null);
  if (cached?.[0]) {
    const point = cached[0].found ? { lat: cached[0].lat, lon: cached[0].lon } : null;
    seen.set(key, point);
    return point;
  }
  if (lookups >= MAX_LOOKUPS) return undefined; // not looked up; say so rather than call it a miss

  lookups++;
  let point = null;
  try {
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("q", place);
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", "1");
    url.searchParams.set("countrycodes", "us");
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      headers: { "User-Agent": "ApplyPilot/1.0 (personal job search tool)", Accept: "application/json" },
    });
    if (res.ok) {
      const arr = await res.json();
      if (Array.isArray(arr) && arr[0]?.lat && arr[0]?.lon) {
        point = { lat: parseFloat(arr[0].lat), lon: parseFloat(arr[0].lon) };
      }
    }
  } catch {
    // a failed request is not a place that does not exist; do not cache it
    await new Promise((r) => setTimeout(r, 1100));
    return undefined;
  }
  seen.set(key, point);
  // Where a town is does not depend on whether this run writes job results,
  // so the cache is filled either way and a report-only run is not wasted.
  {
    await db("geo_cache?on_conflict=place", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify([{ place: key, lat: point?.lat ?? null, lon: point?.lon ?? null, found: !!point }]),
    }).catch(() => {});
  }
  await new Promise((r) => setTimeout(r, 1100)); // the geocoder asks for one a second
  return point;
}

// ---------------------------------------------------------------------------
if (process.env.MEASURE_IMPORT_ONLY !== "1") {
  if (!SUPABASE_URL || !ANON_KEY || !AP_EMAIL || !AP_PASSWORD) {
    console.error("Missing SUPABASE_URL, SUPABASE_ANON_KEY, APPLYPILOT_EMAIL or APPLYPILOT_PASSWORD.");
    process.exit(1);
  }
  await auth({ email: AP_EMAIL, password: AP_PASSWORD }, "password");

  const [profile] = (await db("profile?id=eq.1&select=home_lat,home_lon,city,state")) ?? [];
  const [cfg] = (await db("search_config?id=eq.1&select=radius_miles")) ?? [];
  const radius = Number(cfg?.radius_miles ?? 0);

  let home = profile?.home_lat != null && profile?.home_lon != null ? { lat: profile.home_lat, lon: profile.home_lon } : null;
  if (!home && profile?.city) home = await locate(`${profile.city}, ${profile.state ?? ""}`);
  if (!home || !(radius > 0)) {
    console.log(`Nothing to measure against: home ${home ? "known" : "unknown"}, radius ${radius}.`);
    process.exit(0);
  }

  const jobs =
    (await db(
      "jobs?status=in.(queued,review,new)&distance_miles=is.null&select=id,status,ats,location,remote,title&limit=5000",
    )) ?? [];
  console.log(`${jobs.length} waiting job(s) have no measured distance; radius is ${radius} mi; ${APPLY ? "writing results" : "report only"}.`);

  const tally = { within: 0, beyond: 0, remote: 0, noPlace: 0, notFound: 0, deferred: 0 };
  const byAts = {};
  const unreadable = new Map();
  const unfound = new Map();
  // How the queue would look at other radii, so the radius can be chosen
  // knowing what it costs.
  const BANDS = [15, 25, 30, 40, 50, 75];
  const bands = Object.fromEntries(BANDS.map((b) => [b, 0]));
  let written = 0;

  for (const job of jobs) {
    const bucket = (byAts[job.ats ?? "none"] ??= { within: 0, beyond: 0, unknown: 0 });
    if (job.remote === true) { tally.remote++; bucket.within++; continue; }

    const places = placesIn(job.location);
    if (!places.length) {
      tally.noPlace++; bucket.unknown++;
      const shape = String(job.location ?? "(empty)").replace(/\d+/g, "N").slice(0, 40);
      unreadable.set(shape, (unreadable.get(shape) ?? 0) + 1);
      continue;
    }

    // A posting open in several places is as close as its nearest one.
    let best = null;
    let deferred = false;
    for (const place of places.slice(0, 6)) {
      const point = await locate(place);
      if (point === undefined) { deferred = true; continue; }
      if (!point) continue;
      const miles = Math.round(milesBetween(home.lat, home.lon, point.lat, point.lon));
      if (!best || miles < best.miles) best = { miles, ...point };
    }
    if (!best) {
      if (deferred) tally.deferred++; else tally.notFound++;
      bucket.unknown++;
      const shape = String(job.location ?? "").replace(/\d+/g, "N").slice(0, 44);
      unfound.set(shape, (unfound.get(shape) ?? 0) + 1);
      continue;
    }

    for (const edge of BANDS) if (best.miles <= edge) bands[edge]++;
    const inside = best.miles <= radius;
    if (inside) { tally.within++; bucket.within++; } else { tally.beyond++; bucket.beyond++; }

    if (APPLY) {
      // The distance only. Whether a job is applied to is decided by the
      // applier against the radius of the day, so changing the radius later
      // brings jobs back without anything having to be un-skipped.
      const patch = { lat: best.lat, lon: best.lon, distance_miles: best.miles };
      await db(`jobs?id=eq.${job.id}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify(patch),
      })
        .then(() => written++)
        .catch((e) => console.log(`  could not write job: ${String(e.message).slice(0, 80)}`));
    }
  }

  console.log(`looked up ${lookups} new place(s); ${seen.size} distinct place(s) in all.`);
  console.log(`result: ${JSON.stringify(tally)}`);
  console.log(`by portal: ${JSON.stringify(byAts)}`);
  console.log(`on-site jobs within N miles: ${JSON.stringify(bands)} (plus ${tally.remote} remote at any radius)`);
  const lost = [...unfound.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
  if (lost.length) console.log(`locations the geocoder could not find: ${unfound.size} distinct, the commonest on ${JSON.stringify(lost.map(([, n]) => n))} job(s)`);
  const top = [...unreadable.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  if (top.length) console.log(`locations that name no place: ${unreadable.size} distinct, the commonest on ${JSON.stringify(top.map(([, n]) => n))} job(s)`);
  if (APPLY) console.log(`wrote ${written} job(s).`);
}
