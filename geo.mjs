/**
 * Where a posting is, worked out on this machine.
 *
 * Places used to be found by asking a free geocoder on the internet, one a
 * second. In one week it could not place 513 postings on one account, and
 * each of those was set aside as though it were out of reach. Most of what
 * an employer writes is a town and a state with something around it, and a
 * town and a state can be looked up in a list.
 *
 * This reads a location as an employer writes it — "US-NJ-Florham Park-100
 * Park Ave", "Greater Boston Area", "St. Louis, Missouri", "Middlesex
 * County, NJ", "Remote (must reside in TX or FL)", three towns on one line —
 * and says what it can stand behind:
 *
 *   places   each with a position, and how exact it is (a town; or a
 *            county, which is the middle of its towns and no more than that)
 *   mode     remote, hybrid or on site, where the posting says
 *   reside   the states a remote posting restricts itself to, where it says
 *   state    a state named with no town (a fact, but not a position)
 *
 * It never guesses. A town's name without its state is taken only where
 * one state has a town of that name. What it cannot place it says it cannot
 * place, and the caller keeps the posting for another try rather than
 * treating it as far away.
 *
 * The list: data/us-cities.tsv, from kelvins/US-Cities-Database (MIT).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const STATE_CODE = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT",
  delaware: "DE", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI",
  minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH",
  "new jersey": "NJ", "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH",
  oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD",
  tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV",
  wisconsin: "WI", wyoming: "WY", "district of columbia": "DC", "puerto rico": "PR",
};
const CODES = new Set(Object.values(STATE_CODE));
const stateOf = (t) => {
  const s = String(t ?? "").trim();
  if (/^[A-Za-z]{2}$/.test(s) && CODES.has(s.toUpperCase())) return s.toUpperCase();
  return STATE_CODE[s.toLowerCase().replace(/\./g, "").replace(/\s+/g, " ")] ?? null;
};

/** A town's name as the list keys it: "St. Louis" and "Saint Louis" are one. */
const key = (t) =>
  String(t ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/\bst\.?\s/g, "saint ").replace(/\bste\.?\s/g, "sainte ").replace(/\bft\.?\s/g, "fort ").replace(/\bmt\.?\s/g, "mount ")
    .replace(/\b(city|township|twp|borough|boro|village|town) of\s+/g, "")
    .replace(/\s+(township|twp|borough|boro|village)$/g, "")
    .replace(/[^a-z0-9]+/g, " ").trim();

// Names an employer uses that the list does not: each is one town, written out.
const ALSO = {
  "nyc": ["New York", "NY"], "new york city": ["New York", "NY"], "manhattan": ["New York", "NY"], "midtown manhattan": ["New York", "NY"],
  "queens": ["Jamaica", "NY"], "sf": ["San Francisco", "CA"], "san fran": ["San Francisco", "CA"], "la": ["Los Angeles", "CA"],
  "dc": ["Washington", "DC"], "washington dc": ["Washington", "DC"], "washington d c": ["Washington", "DC"], "philly": ["Philadelphia", "PA"],
  "vegas": ["Las Vegas", "NV"], "nola": ["New Orleans", "LA"], "atl": ["Atlanta", "GA"], "chi": ["Chicago", "IL"], "sea": ["Seattle", "WA"],
  "bos": ["Boston", "MA"], "silicon valley": ["San Jose", "CA"], "bay area": ["San Francisco", "CA"], "san francisco bay area": ["San Francisco", "CA"],
  "twin cities": ["Minneapolis", "MN"], "research triangle": ["Durham", "NC"], "research triangle park": ["Durham", "NC"], "rtp": ["Durham", "NC"],
  "dfw": ["Dallas", "TX"], "dallas fort worth": ["Dallas", "TX"], "kc": ["Kansas City", "MO"], "slc": ["Salt Lake City", "UT"],
};

// Countries other than this one, and the provinces of the nearest: a posting
// that names one of these and no American town is abroad, which is a
// reason of its own — not "unplaceable", and not a distance.
const ABROAD = new RegExp(`\\b(${[
  "canada", "mexico", "united kingdom", "uk", "england", "scotland", "wales", "northern ireland", "ireland", "india", "germany", "france", "spain", "italy",
  "netherlands", "belgium", "switzerland", "austria", "sweden", "norway", "denmark", "finland", "poland", "portugal", "czech republic", "czechia", "romania",
  "hungary", "greece", "turkey", "israel", "united arab emirates", "uae", "saudi arabia", "qatar", "egypt", "south africa", "nigeria", "kenya",
  "china", "japan", "south korea", "korea", "taiwan", "hong kong", "singapore", "malaysia", "thailand", "vietnam", "philippines", "indonesia",
  "australia", "new zealand", "brazil", "argentina", "chile", "colombia", "peru", "costa rica", "pakistan", "bangladesh", "sri lanka", "ukraine",
  "bulgaria", "serbia", "croatia", "lithuania", "latvia", "estonia", "luxembourg", "slovakia", "slovenia", "morocco",
  "ontario", "quebec", "british columbia", "alberta", "manitoba", "saskatchewan", "nova scotia", "new brunswick",
  "emea", "apac", "latam", "europe", "asia", "venezuela", "ecuador", "uruguay", "panama", "guatemala", "dominican republic", "jamaica",
  // Countries by their three letters, as Workday writes them at the end of a location.
  "gbr", "ind", "cri", "mex", "deu", "fra", "irl", "phl", "aus", "bra", "chn", "jpn", "sgp", "esp", "ita", "nld", "pol", "isr", "che", "swe", "arg", "col",
].join("|")})\\b`, "i");
// Great cities abroad that employers write with no country after them.
const ABROAD_CITY = /\b(london|toronto|vancouver|montreal|mississauga|ottawa|calgary|phuket|dublin|bangalore|bengaluru|hyderabad|mumbai|pune|chennai|gurgaon|gurugram|noida|new delhi|delhi|paris|berlin|munich|amsterdam|madrid|barcelona|sydney|melbourne|tokyo|shanghai|beijing|shenzhen|manila|krakow|warsaw|prague|budapest|bucharest|tel aviv|dubai|sao paulo|são paulo|mexico city|guadalajara|bogota|bogotá|zurich|stockholm|copenhagen|lisbon|cork|edinburgh|manchester|kuala lumpur|bangkok|seoul|taipei|cairo|lagos|nairobi|johannesburg|cape town)\b/i;

const METRO = {
  "boston": "MA", "chicago": "IL", "seattle": "WA", "atlanta": "GA", "denver": "CO", "houston": "TX", "dallas": "TX", "austin": "TX",
  "miami": "FL", "phoenix": "AZ", "philadelphia": "PA", "los angeles": "CA", "san diego": "CA", "detroit": "MI", "minneapolis": "MN",
  "new york": "NY", "pittsburgh": "PA", "baltimore": "MD", "nashville": "TN", "charlotte": "NC", "tampa": "FL", "orlando": "FL",
  "portland": "OR", "sacramento": "CA", "san antonio": "TX", "cleveland": "OH", "cincinnati": "OH", "indianapolis": "IN", "milwaukee": "WI",
};

let INDEX = null;
function index() {
  if (INDEX) return INDEX;
  const town = new Map();   // "name|ST" -> {lat, lon}
  const byName = new Map(); // "name" -> Set(ST)
  const county = new Map(); // "name|ST" -> {sumLat, sumLon, n}
  let text = "";
  try { text = fs.readFileSync(path.join(HERE, "data", "us-cities.tsv"), "utf8"); } catch { /* no list: nothing is placed, and that is said */ }
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const [st, name, co, lat, lon] = line.split("\t");
    const k = key(name);
    if (!k || !st) continue;
    const p = { lat: Number(lat), lon: Number(lon) };
    if (!town.has(`${k}|${st}`)) town.set(`${k}|${st}`, p);
    if (!byName.has(k)) byName.set(k, new Set());
    byName.get(k).add(st);
    const ck = `${key(co)}|${st}`;
    const c = county.get(ck) ?? { sumLat: 0, sumLon: 0, n: 0 };
    c.sumLat += p.lat; c.sumLon += p.lon; c.n++;
    county.set(ck, c);
  }
  INDEX = { town, byName, county, size: town.size };
  return INDEX;
}

/** How many towns the list holds: 0 means it could not be read. */
export const placesKnown = () => index().size;

/** One town and its state, as a position. Null when the list has no such town in that state. */
export function townAt(name, state) {
  const st = stateOf(state);
  const k = key(name);
  if (!st || !k) return null;
  const p = index().town.get(`${k}|${st}`);
  return p ? { lat: p.lat, lon: p.lon, exact: "town", state: st } : null;
}

function countyAt(name, state) {
  const st = stateOf(state);
  const k = key(String(name).replace(/\s+(county|parish|co\.?)$/i, ""));
  const c = st && k ? index().county.get(`${k}|${st}`) : null;
  return c ? { lat: +(c.sumLat / c.n).toFixed(4), lon: +(c.sumLon / c.n).toFixed(4), exact: "county", state: st } : null;
}

const WORDS_AROUND =
  /\b(greater|metro(politan)?( area)?|area|region|downtown|uptown|midtown|north|south|east|west|central|northern|southern|eastern|western|hq|headquarters|office|campus|site|plant|store|branch|location|facility|center|centre|warehouse|distribution|fulfil+ment|corporate|regional|usa?|united states( of america)?|on-?site|onsite|hybrid|remote|in-?office|flexible)\b/gi;

/**
 * One piece of a location — what is left between the separators — as a
 * position, or as a state alone, or as nothing.
 */
function onePlace(piece) {
  let s = String(piece ?? "").replace(/\(.*?\)/g, " ").replace(/\b\d{5}(-\d{4})?\b/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return null;
  // Its parts, whichever way round: "Florham Park, NJ", "NJ - Florham Park - 100 Park Ave", "US-NJ-Princeton".
  // "US-NJ-Florham Park-100 Park Ave": hyphens with no room around them, in a string that opens with a country or a state.
  if (/^(?:usa?-)?[A-Z]{2}-\S/.test(s)) s = s.replace(/-/g, ", ");
  // "US:NJ:Parsippany:1 Sylvan Way:Corporate/HQ": the same, with colons.
  if ((s.match(/:/g) ?? []).length >= 2) s = s.replace(/:/g, ", ");
  const bits = s.split(/\s*(?:,|\s[-–—]\s)\s*/).map((b) => b.trim()).filter(Boolean)
    .filter((b) => !/^(us|usa|united states( of america)?)$/i.test(b));
  // The state is the last piece that is one. "New York, NY" and "Washington,
  // DC" are towns that share a state's name; "New York" alone is the state.
  let state = null;
  let stateAt = -1;
  for (let i = bits.length - 1; i >= 0; i--) { const st = stateOf(bits[i]); if (st) { state = st; stateAt = i; break; } }
  // A two-letter code anywhere outranks a name: "NJ - Florham Park".
  for (let i = 0; i < bits.length; i++) if (/^[A-Za-z]{2}$/.test(bits[i]) && stateOf(bits[i])) { state = stateOf(bits[i]); stateAt = i; break; }
  const names = [];
  for (let i = 0; i < bits.length; i++) {
    const b = bits[i];
    if (i === stateAt) continue;
    // "Edison NJ Distribution Center", "Princeton NJ"
    const inside = b.match(/^(.*?\S)\s+([A-Z]{2})\b(.*)$/);
    if (inside && CODES.has(inside[2]) && !state) { state = inside[2]; names.push(inside[1]); continue; }
    if (/^\d/.test(b)) continue; // a street address, a store number
    names.push(b);
  }
  const tries = [];
  for (const n of names) {
    tries.push(n);
    const bare = n.replace(WORDS_AROUND, " ").replace(/\s*#?\d+\s*$/, "").replace(/\s+/g, " ").trim();
    if (bare && bare !== n) tries.push(bare);
  }
  for (const n of tries) {
    const also = ALSO[key(n)];
    if (also && (!state || state === also[1])) { const p = townAt(also[0], also[1]); if (p) return { ...p, name: `${also[0]}, ${also[1]}` }; }
    // "Greater Boston Area", "Chicago Metro": a great city named as the middle of its region, which is one city whatever small towns share its name.
    const metro = /\b(greater|metro(politan)?|area|region)\b/i.test(String(piece)) ? METRO[key(n)] : null;
    if (metro && (!state || state === metro)) { const p = townAt(n, metro); if (p) return { ...p, name: `${n}, ${metro}`, exact: "town, the middle of the region named" }; }
    if (state) {
      if (/\b(county|parish)\b/i.test(n)) { const c = countyAt(n, state); if (c) return { ...c, name: `${n}, ${state}` }; }
      const p = townAt(n, state);
      if (p) return { ...p, name: `${n}, ${state}` };
    } else {
      // No state written: only where one state alone has a town of this name.
      const states = index().byName.get(key(n));
      if (states && states.size === 1) { const st = [...states][0]; const p = townAt(n, st); if (p) return { ...p, name: `${n}, ${st}`, exact: "town, its state not written" }; }
    }
  }
  if (state && names.length && /\b(county|parish)\b/i.test(names.join(" "))) { const c = countyAt(names[0], state); if (c) return { ...c, name: `${names[0]}, ${state}` }; }
  if (state) return { stateOnly: state };
  return null;
}

const REMOTE = /\b(remote|work from home|wfh|telecommut\w*|virtual|home[- ]based|distributed|anywhere)\b/i;
const HYBRID = /\bhybrid\b|\b\d\s*days?\s*(a|per)\s*week\s*(in|on-?site|at the office)|\bin[- ]office\s+\d\s*days/i;
const ONSITE = /\b(on-?site|onsite|in[- ]person|in[- ]office|office[- ]based|100% (in )?office)\b/i;

/** The states a remote posting keeps itself to, where it says: "Remote (CA, TX only)", "must reside in New Jersey or New York". */
export function residency(location, description = "") {
  const found = new Set();
  const spans = [];
  // In the posting's own words, only where it is said as a condition. That
  // an employer "is based in Austin" restricts nobody.
  const t = String(description ?? "");
  spans.push(
    ...t.matchAll(/\b(?:must|need to|needs to|required to|have to)\s+(?:currently\s+|physically\s+)?(?:reside|live|be (?:located|based|a resident|residing|living))\s+(?:in|within)\s+(?:one of\s+)?(?:the following\s+(?:states|locations)\s*:?\s*)?([^.;\n]{2,200})/gi),
    ...t.matchAll(/\b(?:only (?:open|available) to (?:candidates|applicants|residents) (?:in|of|from|located in|residing in)|open only to residents of|residents of the following states\s*:?|eligible states\s*:?|we (?:can|are able to) (?:only )?hire (?:only )?in(?: the following states)?\s*:?)\s+([^.;\n]{2,200})/gi),
  );
  // In the location field, which is about this posting and nothing else:
  // "Remote - CA only", "Remote (TX, FL)", "Remote, must reside in NJ".
  const loc = String(location ?? "");
  if (/\b(remote|work from home|virtual)\b/i.test(loc)) {
    spans.push(...loc.matchAll(/\b(?:remote|work from home|virtual)\b\s*[-–—:(,]\s*([^;|\n]{2,120})/gi));
    spans.push(...loc.matchAll(/\(([^)]{2,120})\)/g));
  }
  for (const m of spans) {
    const span = String(m[1]).replace(/\bthe following\s+(states|locations)\s*:?/gi, " ").replace(/\b(must|reside|live|located|based|in|within|residents? of|only|the state of|states? of|u\.?s\.?a?\.?|united states)\b/gi, " ");
    for (const w of span.split(/\s*(?:,|\/|\bor\b|\band\b|&|\|)\s*/)) {
      const st = stateOf(w.replace(/[()]/g, "").trim());
      if (st) found.add(st);
    }
  }
  return [...found];
}

/**
 * A posting's location, read.
 * @param location  the posting's own location field
 * @param more      { title, description, remote } — read only for what the field leaves out
 */
export function readLocation(location, more = {}) {
  const raw = String(location ?? "").trim();
  const around = `${raw} ${more.title ?? ""}`;
  const mode = HYBRID.test(around) ? "hybrid" : more.remote === true || REMOTE.test(around) ? "remote" : ONSITE.test(around) ? "onsite" : null;

  const places = [];
  const states = new Set();
  const unread = [];
  const abroad = [];
  const take = (text) => {
    // What is in brackets is about the place, not another place: "(must reside in TX or FL)".
    for (const piece of String(text).replace(/\([^)]*\)/g, " ").split(/\s*(?:;|\||\n|\/(?=\s)|\s\/\s|\bor\b|\s&\s|\band\b(?=\s+[A-Z])|•|·)\s*/i)) {
      const p = piece.trim();
      if (!p || /^(remote.*|anywhere|various|multiple( locations)?|\d+\s+locations?|united states( of america)?|usa?|north america|worldwide|global|virtual|field|nationwide|hybrid|on-?site)$/i.test(p)) continue;
      const got = onePlace(p);
      if (got?.lat != null) { if (!places.some((x) => x.name === got.name)) places.push(got); }
      else if (got?.stateOnly) states.add(got.stateOnly);
      else if (ABROAD.test(p) || ABROAD_CITY.test(p)) abroad.push(p);
      else unread.push(p);
    }
  };
  take(raw);

  // Where the field names no town, the posting's own words may: "Location:
  // Parsippany, NJ", "based in our Austin, TX office". Only a town with its
  // state, and only one the list holds.
  let fromDescription = false;
  if (!places.length && more.description) {
    const text = String(more.description).replace(/<[^>]+>/g, " ").replace(/&nbsp;|&amp;/g, " ").slice(0, 8000);
    const seen = new Set();
    for (const m of text.matchAll(/\b([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,3}),\s*([A-Z]{2})\b/g)) {
      const p = townAt(m[1], m[2]) ?? townAt(m[1].split(/\s+/).slice(-2).join(" "), m[2]) ?? townAt(m[1].split(/\s+/).slice(-1)[0], m[2]);
      if (!p) continue;
      const name = `${m[1]}, ${m[2]}`;
      if (seen.has(`${p.lat},${p.lon}`)) continue;
      seen.add(`${p.lat},${p.lon}`);
      places.push({ ...p, name, exact: "town, from the posting's own text" });
      if (places.length >= 5) break;
    }
    fromDescription = places.length > 0;
  }

  const reside = mode === "remote" || mode === "hybrid" || more.remote === true ? residency(raw, String(more.description ?? "").slice(0, 8000)) : [];
  return { places, states: [...states], mode, reside, unread, fromDescription, abroad: abroad.length, onlyAbroad: abroad.length > 0 && !places.length && !states.size && !unread.length };
}

export function milesBetween(aLat, aLon, bLat, bLon) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(bLat - aLat), dLon = rad(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(h));
}

/** The nearest of a posting's places to a point: { miles, lat, lon, exact } or null when it names none that can be placed. */
export function nearest(read, home) {
  let best = null;
  for (const p of read?.places ?? []) {
    const miles = Math.round(milesBetween(home.lat, home.lon, p.lat, p.lon));
    if (!best || miles < best.miles) best = { miles, lat: p.lat, lon: p.lon, exact: p.exact };
  }
  return best;
}
