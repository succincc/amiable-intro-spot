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
import { readLocation, nearest, placesKnown, residency } from "./geo.mjs";
// Nothing this prints names an employer, a posting or a place: see quiet.mjs.
guardLogs();
const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
// Whose round this is, when the runner is doing somebody else's: see forusers.mjs.
const ACT_AS = process.env.AP_ACT_AS ? { "x-act-as": process.env.AP_ACT_AS } : {};
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

const STATE_NAME_TO_CODE = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT",
  delaware: "DE", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI",
  minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH",
  "new jersey": "NJ", "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH",
  oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD",
  tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV",
  wisconsin: "WI", wyoming: "WY", "district of columbia": "DC",
};
const STATE_CODES = new Set(Object.values(STATE_NAME_TO_CODE));

/**
 * Plainer ways of saying the same place, for when the geocoder cannot find
 * it as an employer wrote it. Workday writes "NJ - Florham Park - 100 Park
 * Ave" and "Edison NJ Distribution Center": the town and the state are in
 * there, with a street or a building's name around them.
 *
 * Only ever a town WITH its state. A town's name alone is a dozen towns, and
 * the wrong one within the radius is an application sent a state away.
 */
export function simplerPlaces(place) {
  const FACILITY =
    /\s*\b(?:(?:distribution|fulfil+ment|service|support|call|contact|data|tech(?:nology)?|corporate|regional|sales|customer|operations|innovation|research|medical|health)\s+)*(?:center|centre|offices?|campus|plant|store|warehouse|facility|site|building|bldg|hub|depot|terminal|branch|hq|headquarters|hospital|clinic|lab(?:orator(?:y|ies))?)\b.*$/i;
  let state = null;
  const towns = [];
  for (let b of String(place).split(",").map((x) => x.trim()).filter(Boolean)) {
    const whole = b.length === 2 && STATE_CODES.has(b.toUpperCase()) ? b.toUpperCase() : STATE_NAME_TO_CODE[b.toLowerCase()];
    if (whole) { state ??= whole; continue; }
    if (/^(us|usa|united states( of america)?)$/i.test(b)) continue;
    if (/^\d/.test(b)) continue; // a street address, a store number
    // "Edison NJ Distribution Center": the state inside the same piece.
    const inside = b.match(/^(.*?\S)\s+([A-Z]{2})\b(.*)$/);
    if (inside && STATE_CODES.has(inside[2])) { state ??= inside[2]; b = inside[1]; }
    b = b.replace(FACILITY, "").replace(/\s*#?\d+\s*$/, "").trim();
    if (b.length >= 3 && !/^\d/.test(b)) towns.push(b);
  }
  if (!state) return [];
  const same = (p) => p.trim().toLowerCase().replace(/\s+/g, " ");
  return [...new Set(towns.map((t) => `${t}, ${state}`))].filter((p) => same(p) !== same(place)).slice(0, 3);
}

/** A location by its shape only: letters, digits and where a state code sits. */
const shapeOfPlace = (s) =>
  String(s ?? "")
    .replace(/\b[A-Z]{2}\b/g, (m) => (STATE_CODES.has(m) ? "§" : m))
    .replace(/[A-Za-z]+/g, "a")
    .replace(/\d+/g, "9")
    .replace(/§/g, "ST")
    .slice(0, 44);

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
  const [cfg] = (await db("search_config?id=eq.1&select=radius_miles,include_unknown_location,same_state_only")) ?? [];
  const radius = Number(cfg?.radius_miles ?? 0);

  let home = profile?.home_lat != null && profile?.home_lon != null ? { lat: profile.home_lat, lon: profile.home_lon } : null;
  if (!home && profile?.city) home = await locate(`${profile.city}, ${profile.state ?? ""}`);
  if (!home || !(radius > 0)) {
    console.log(`Nothing to measure against: home ${home ? "known" : "unknown"}, radius ${radius}.`);
    process.exit(0);
  }

  // Whether this search keeps only what it can place.
  const STRICT = cfg?.include_unknown_location === false;
  // Postings the panel set aside as unplaceable after one plain look are
  // given the fuller try: put back as new, to be scored and measured again.
  // Once — the panel no longer sets these aside, so there are no more.
  if (APPLY) {
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const back = await db(`jobs?status=eq.skipped&skip_reason=like.location%20could%20not%20be%20placed:*&found_at=gte.${encodeURIComponent(since)}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ status: "new", score: null, score_reason: null, skip_reason: null, distance_miles: null }),
    }).catch(() => null);
    if (back?.length) console.log(`${back.length} posting(s) set aside as unplaceable after one plain look are put back for a fuller try.`);
  }

  const jobs =
    (await db(
      "jobs?status=in.(queued,review,new)&distance_miles=is.null&select=id,status,ats,location,remote,title&limit=5000",
    )) ?? [];
  console.log(`${jobs.length} waiting job(s) have no measured distance; radius is ${radius} mi; ${APPLY ? "writing results" : "report only"}.`);

  const UNPLACED = "location not placed yet: kept, and tried again each time";
  console.log(`towns this machine can place without asking anyone: ${placesKnown()}`);
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

    // On this machine first (geo.mjs): a town and its state are looked up
    // in a list, with no request made and nothing waited for.
    {
      const read = readLocation(job.location, { title: job.title });
      const here = nearest(read, home);
      // Taken as the answer when every place the posting names was placed,
      // or when one of them is already within reach. A posting with a place
      // still unread might be nearer than it looks: that goes the long way.
      if (here && (here.miles <= radius || (!read.unread.length && !read.states.length))) {
        tally.placedHere = (tally.placedHere ?? 0) + 1;
        for (const edge of BANDS) if (here.miles <= edge) bands[edge]++;
        if (here.miles <= radius) { tally.within++; bucket.within++; } else { tally.beyond++; bucket.beyond++; }
        if (APPLY) {
          await db(`jobs?id=eq.${job.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ lat: here.lat, lon: here.lon, distance_miles: here.miles }) })
            .then(() => written++).catch(() => {});
        }
        continue;
      }
    }

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
      let point = await locate(place);
      if (point === undefined) { deferred = true; continue; }
      if (!point) {
        // Not found as written: the town and its state, without the street
        // or the building around them.
        for (const plainer of simplerPlaces(place)) {
          const again = await locate(plainer);
          if (again === undefined) { deferred = true; break; }
          if (again) { point = again; tally.foundPlainer = (tally.foundPlainer ?? 0) + 1; break; }
        }
      }
      if (!point) continue;
      const miles = Math.round(milesBetween(home.lat, home.lon, point.lat, point.lon));
      if (!best || miles < best.miles) best = { miles, ...point };
    }
    if (!best) {
      if (deferred) tally.deferred++; else tally.notFound++;
      bucket.unknown++;
      const shape = shapeOfPlace(job.location);
      unfound.set(shape, (unfound.get(shape) ?? 0) + 1);
      // Tried every way this knows and not found, on a search that keeps
      // only what it can place: set aside here, where the trying was done.
      // (The panel used to do this after one plain look, before any of it.)
      if (!deferred && APPLY && STRICT) {
        // Held, not thrown away: the reason says it is unplaced, which is a
        // different thing from far, and every later run tries it again
        // (below) with whatever this has learned since.
        await db(`jobs?id=eq.${job.id}&status=in.(new,queued,review)`, {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ status: "skipped", skip_reason: UNPLACED }),
        }).catch(() => {});
        tally.setAside = (tally.setAside ?? 0) + 1;
      }
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

  // -------------------------------------------------------------------------
  // The postings set aside as unplaceable, tried again.
  //
  // In one week 513 postings on one account were set aside because the
  // geocoder could not find where they were. Unplaced is not far. Each is
  // read again here — its location, then its own text — and what can now
  // be placed is measured: inside the radius it goes back to be rated;
  // outside it, it is set aside for the distance, which is the true reason.
  // What still cannot be placed stays held, and is tried again next time.
  // -------------------------------------------------------------------------
  {
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const held = [];
    for (let from = 0; from < 10000; from += 500) {
      const rows = (await db(`jobs?status=eq.skipped&or=(skip_reason.like.location%20could%20not%20be%20placed*,skip_reason.like.location%20not%20placed%20yet*)&found_at=gte.${encodeURIComponent(since)}&select=id,location,title,description,remote&order=id.asc&offset=${from}&limit=500`).catch(() => null)) ?? [];
      held.push(...rows);
      if (rows.length < 500) break;
    }
    const again = { held: held.length, placedByField: 0, placedByText: 0, within: 0, beyond: 0, stateOnly: 0, noLocation: 0, unread: 0 };
    const shapes = new Map();
    const lastWords = new Map();
    for (const job of held) {
      const read = readLocation(job.location, { title: job.title, description: job.description, remote: job.remote });
      const here = nearest(read, home);
      if (!here && read.onlyAbroad && job.remote !== true) {
        // Every place it names is in another country: not unplaceable, and
        // not a matter of miles. Said as what it is.
        again.abroad = (again.abroad ?? 0) + 1;
        if (APPLY) await db(`jobs?id=eq.${job.id}&status=eq.skipped`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ skip_reason: "outside the United States" }) }).catch(() => {});
        continue;
      }
      if (!here) {
        if (!String(job.location ?? "").trim()) again.noLocation++;
        else if (read.states.length) again.stateOnly++;
        else again.unread++;
        const shape = shapeOfPlace(job.location);
        shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
        // The last word of a location this could not place, where many
        // postings end the same way: a country or a region not yet known
        // here. A posting's place, far from anyone's home by definition.
        const last = String(job.location ?? "").replace(/\(.*?\)/g, " ").split(/[,\-–—:|/]/).map((x) => x.trim()).filter(Boolean).pop();
        if (last && /^[A-Za-z .']{3,24}$/.test(last)) lastWords.set(last.toLowerCase(), (lastWords.get(last.toLowerCase()) ?? 0) + 1);
        continue;
      }
      if (read.fromDescription) again.placedByText++; else again.placedByField++;
      const inside = here.miles <= radius;
      if (inside) again.within++; else again.beyond++;
      if (APPLY) {
        const patch = inside
          // Back to be rated, as a posting newly found would be.
          ? { status: "new", score: null, score_reason: null, skip_reason: null, lat: here.lat, lon: here.lon, distance_miles: here.miles }
          : { skip_reason: `${here.miles} mi away (limit ${radius})`, lat: here.lat, lon: here.lon, distance_miles: here.miles };
        await db(`jobs?id=eq.${job.id}&status=eq.skipped`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(patch) }).catch(() => {});
      }
    }
    console.log(`set aside as unplaceable, tried again: ${JSON.stringify(again)}`);
    console.log(`  of ${again.held}: ${again.within} are within reach and go back to be rated; ${again.beyond} are placed and too far (now said so); ${again.abroad ?? 0} are in another country (now said so); ${again.held - again.within - again.beyond - (again.abroad ?? 0)} still cannot be placed and stay held`);
    const top = [...shapes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
    const ends = [...lastWords.entries()].filter(([, n]) => n >= 4).sort((a, b) => b[1] - a[1]).slice(0, 16);
    if (ends.length) console.log(`  still unplaced, how the commonest end: ${JSON.stringify(ends.map(([w, n]) => `${w} x${n}`))}`);
    if (top.length) console.log(`  still unplaced, by shape (a = a word, 9 = a number, ST = a state): ${JSON.stringify(top.map(([sh, n]) => `${sh} x${n}`))}`);
  }

  // Postings set aside by the same-state rule, read again while that rule
  // is switched off. The rule set them aside without measuring anything; with
  // it off, the radius is the only question, and it has not been asked of
  // them. Within reach they go back to be rated; beyond it they are set
  // aside for the distance. Should the rule be switched on again, the
  // panel's own check sets aside whatever it covers, as before.
  if (cfg?.same_state_only !== true) {
    // Counted on every run; written only when asked for by name. The rule
    // was switched off for a time, and whether what it set aside comes back
    // is the owner's to say, not this program's.
    const APPLY = process.env.APPLY === "true" && process.env.REVISIT_STATE_RULE === "1";
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const rows = [];
    for (let from = 0; from < 10000; from += 500) {
      const page = (await db(`jobs?status=eq.skipped&or=(skip_reason.like.outside*,skip_reason.like.no%20state%20given*)&found_at=gte.${encodeURIComponent(since)}&select=id,location,title,description,remote,skip_reason&order=id.asc&offset=${from}&limit=500`).catch(() => null)) ?? [];
      rows.push(...page);
      if (page.length < 500) break;
    }
    const mine = rows.filter((j) => !/^outside the us\b/i.test(String(j.skip_reason ?? "")));
    const st = { held: mine.length, within: 0, beyond: 0, abroad: 0, unplaced: 0 };
    for (const job of mine) {
      const read = readLocation(job.location, { title: job.title, description: job.description, remote: job.remote });
      const here = nearest(read, home);
      if (!here) {
        if (read.onlyAbroad) { st.abroad++; if (APPLY) await db(`jobs?id=eq.${job.id}&status=eq.skipped`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ skip_reason: "outside the United States" }) }).catch(() => {}); }
        else { st.unplaced++; if (APPLY) await db(`jobs?id=eq.${job.id}&status=eq.skipped`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ skip_reason: UNPLACED }) }).catch(() => {}); }
        continue;
      }
      const inside = here.miles <= radius;
      if (inside) st.within++; else st.beyond++;
      if (APPLY) {
        const patch = inside
          ? { status: "new", score: null, score_reason: null, skip_reason: null, lat: here.lat, lon: here.lon, distance_miles: here.miles }
          : { skip_reason: `${here.miles} mi away (limit ${radius})`, lat: here.lat, lon: here.lon, distance_miles: here.miles };
        await db(`jobs?id=eq.${job.id}&status=eq.skipped`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(patch) }).catch(() => {});
      }
    }
    console.log(`set aside by the same-state rule, which is switched off, read again${APPLY ? "" : " (counted only; nothing written)"}: ${JSON.stringify(st)}`);
    console.log(`  of ${st.held}: ${st.within} are within the radius${APPLY ? " and go back to be rated" : ""}; ${st.beyond} are too far (now said so); ${st.abroad} are in another country; ${st.unplaced} cannot be placed yet and stay held`);
  } else {
    console.log("the same-state rule is switched on: what it set aside stays set aside");
  }

  // A remote posting that keeps itself to residents of named states, none
  // of them the person's: remote, and still not open to them.
  if (profile?.state) {
    const mine = String(profile.state).trim().toUpperCase();
    const rows = (await db("jobs?status=in.(queued,review,new)&remote=is.true&select=id,location,description&limit=2000").catch(() => null)) ?? [];
    let shut = 0, open = 0, silent = 0;
    for (const job of rows) {
      const only = residency(job.location, String(job.description ?? "").replace(/<[^>]+>/g, " ").slice(0, 8000));
      if (!only.length) { silent++; continue; }
      const home2 = readLocation(mine).states[0] ?? mine;
      if (only.includes(home2)) { open++; continue; }
      shut++;
      if (APPLY) await db(`jobs?id=eq.${job.id}&status=in.(new,queued,review)`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "skipped", skip_reason: "remote, but only for residents of other states" }) }).catch(() => {});
    }
    console.log(`remote postings waiting: ${rows.length}; ${silent} say nothing about where one must live, ${open} name states that include the person's, ${shut} name only other states${APPLY ? " and are set aside for that" : ""}`);
  }

  console.log(`looked up ${lookups} new place(s); ${seen.size} distinct place(s) in all.`);
  console.log(`result: ${JSON.stringify(tally)}`);
  console.log(`by portal: ${JSON.stringify(byAts)}`);
  console.log(`on-site jobs within N miles: ${JSON.stringify(bands)} (plus ${tally.remote} remote at any radius)`);
  const lost = [...unfound.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
  // By shape — "a a, ST, a 9 a" — never by name.
  if (lost.length) console.log(`locations the geocoder could not find: ${unfound.size} distinct shape(s); the commonest ${JSON.stringify(lost.map(([s, n]) => `${s} x${n}`))}`);
  const top = [...unreadable.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  if (top.length) console.log(`locations that name no place: ${unreadable.size} distinct, the commonest on ${JSON.stringify(top.map(([, n]) => n))} job(s)`);
  if (APPLY) console.log(`wrote ${written} job(s).`);
}
