// ============================================================================
// careers.ts — turn any employer careers URL into something we can pull from.
//
// Pure functions only. The paste box in Settings imports parseCareersUrl and
// explainUnrecognized directly, so nothing here may touch the network or the
// database — geocoding lives in geo.server.ts for that reason.
//
// The point of this file: you should be able to find a company you want to
// work for, copy the URL of its careers page, paste it in, and have the
// system start pulling its openings. No registry to maintain, no site ids to
// look up, no guessing.
//
// Large employers almost never build their own application system. They rent
// one and brand it. So "Target's careers portal" is a Workday tenant,
// "Stripe's" is a Greenhouse board, and so on. Detecting which one a URL
// belongs to is the whole job.
// ============================================================================

export type AtsTarget = {
  ats: "workday" | "greenhouse" | "lever" | "ashby" | "workable" | "smartrecruiters";
  token: string; // board token, or workday tenant
  site?: string | undefined; // workday site id
  pod?: string | undefined; // workday pod, e.g. "wd5"
  name?: string | undefined;
};

/**
 * Detect the ATS behind a careers URL and extract what the API needs.
 * Returns null when the URL is not a recognized ATS — a company homepage,
 * a LinkedIn listing, or anything else we cannot pull from.
 */
export function parseCareersUrl(input: string, name?: string): AtsTarget | null {
  if (!input) return null;
  let raw = input.trim();
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;

  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }

  const host = u.hostname.toLowerCase();
  const seg = u.pathname.split("/").filter(Boolean);
  const notLocale = (s: string) => !/^[a-z]{2}-[A-Z]{2}$/i.test(s);

  // --- Workday: {tenant}.wd{N}.myworkdayjobs.com/{locale}/{site} ---
  const wd = host.match(/^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/);
  const tenant = wd?.[1];
  const pod = wd?.[2];
  if (tenant && pod) {
    const site = seg.find(notLocale);
    if (!site) return null;
    return { ats: "workday", token: tenant, pod, site, name };
  }

  // --- Greenhouse: boards.greenhouse.io/{token} or job-boards.greenhouse.io/{token} ---
  if (host.endsWith("greenhouse.io")) {
    const token = seg.find(notLocale);
    if (!token || token === "embed") return null;
    return { ats: "greenhouse", token, name };
  }

  // --- Lever: jobs.lever.co/{token} ---
  if (host.endsWith("lever.co")) {
    const token = seg[0];
    if (!token) return null;
    return { ats: "lever", token, name };
  }

  // --- Ashby: jobs.ashbyhq.com/{token} ---
  if (host.endsWith("ashbyhq.com")) {
    const token = seg[0];
    if (!token) return null;
    return { ats: "ashby", token, name };
  }

  // --- Workable: apply.workable.com/{token} or {token}.workable.com ---
  if (host.endsWith("workable.com")) {
    const sub = host.replace(".workable.com", "");
    if (sub && sub !== "apply" && sub !== "www") {
      return { ats: "workable", token: sub, name };
    }
    const token = seg.find((s) => notLocale(s) && s !== "j");
    if (!token) return null;
    return { ats: "workable", token, name };
  }

  // --- SmartRecruiters: careers.smartrecruiters.com/{token} ---
  if (host.endsWith("smartrecruiters.com")) {
    const token = seg[0];
    if (!token) return null;
    return { ats: "smartrecruiters", token, name };
  }

  return null;
}

/**
 * What to tell someone whose URL we could not use.
 *
 * A company homepage is the common case, and "invalid URL" is useless advice
 * there — the fix is to click through to the actual job listings page, which
 * is where the ATS hostname appears.
 */
export function explainUnrecognized(input: string): string {
  const lower = (input || "").toLowerCase();
  if (lower.includes("linkedin.com")) {
    return (
      "That is a LinkedIn listing. Open the company's own careers page " +
      "instead — the apply button on LinkedIn usually leads there."
    );
  }
  if (lower.includes("indeed.com") || lower.includes("ziprecruiter")) {
    return (
      "That is a job board listing, not the employer's own portal. " +
      "Follow it through to the company's careers site and use that URL."
    );
  }
  // Platforms we can recognise but cannot pull from yet. Saying which one it
  // is matters: told only "not recognised", someone re-copies the same URL
  // several times assuming they got it wrong. It is the platform, not them —
  // and these are common exactly where it hurts, since mid-sized regional
  // employers use them far more than they use Greenhouse or Lever.
  const UNSUPPORTED: Array<[RegExp, string]> = [
    [/icims\.com/, "iCIMS"],
    [/taleo\.net|taleo\.com/, "Taleo"],
    [/successfactors\.(com|eu)|sapsf\.(com|eu)/, "SAP SuccessFactors"],
    [/myworkdaysite\.com/, "Workday (internal site)"],
    [/paylocity\.com/, "Paylocity"],
    [/bamboohr\.com/, "BambooHR"],
    [/jobvite\.com/, "Jobvite"],
    [/workforcenow\.adp\.com|adp\.com/, "ADP"],
    [/ultipro\.com|ukg\.(com|net)/, "UKG/UltiPro"],
    [/recruiting\.paycom\.com|paycom\.com/, "Paycom"],
    [/brassring\.com|kenexa\.com/, "BrassRing"],
    [/oraclecloud\.com\/hcmUI|fa\.oraclecloud\.com/, "Oracle Recruiting"],
  ];
  for (const [pattern, name] of UNSUPPORTED) {
    if (pattern.test(lower)) {
      return (
        `That is ${name}, which this can recognise but cannot pull jobs from ` +
        `yet. Nothing is wrong with the URL. Check whether the employer also ` +
        `posts to Greenhouse, Lever or Workday, or add them to a saved search ` +
        `on a job board instead.`
      );
    }
  }

  if (/^https?:\/\/(www\.)?[a-z0-9-]+\.(com|org|net)\/?$/i.test(input.trim())) {
    return (
      "That is the company homepage. Click through to its jobs or " +
      "careers page, then copy the URL once you can see job listings."
    );
  }
  return (
    "Not a recognized careers portal. Supported: Workday, Greenhouse, " +
    "Lever, Ashby, Workable and SmartRecruiters — which covers most " +
    "large employers. Open the company's job listings page and copy " +
    "that URL; the portal name appears in the address."
  );
}

// ---------------------------------------------------------------------------
// Distance
// ---------------------------------------------------------------------------

/** Great-circle distance in miles. */
export function milesBetween(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3958.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Pull a geocodable place out of a messy job location string.
 *
 * ATS location fields look like "Princeton, NJ, United States",
 * "US-NJ-Princeton", "Multiple Locations", "Remote - US". Feeding the raw
 * string to a geocoder mostly fails; this keeps the part that resolves.
 *
 * Returning null means "no location to measure", not "reject this job" — the
 * include_unknown_location setting decides what happens to those, and it
 * keeps them by default.
 */

/**
 * Is this string not a place at all?
 *
 * A geocoder will answer almost anything. Given "In-Office" it returned a
 * point 8,570 miles away; "N/A" became 3,695 miles, "AMER" 3,859, "LOCATION"
 * 294. Those are not distant jobs, they are nonsense with a number attached —
 * and a number is worse than a blank, because it looks measured.
 *
 * Checked both before and after the cleaning below, since "United States -
 * Remote" only reveals itself as a bare country once "Remote" is stripped.
 */
function isNonPlace(raw: string): boolean {
  const s = raw.trim().replace(/[.,;]+$/, "");
  if (!s) return true;

  // A posting listing several places has no single location. Measuring to
  // whichever one happens to parse gave "San Francisco; New York City" a
  // distance of 39 miles, as though it were within commuting range.
  if (s.includes(";")) return true;

  // Internal site shorthand listing several offices:
  // "US-SF-HQ, US-NYC, US-CHI, US-SEA", "SEA, NYC". A geocoder will pick one
  // of them, or something unrelated, and the resulting number means nothing.
  if ((s.match(/\bUS-\w+/gi) ?? []).length > 1) return true;
  if (/^[A-Z]{2,4}(\s*,\s*[A-Z]{2,4})+$/.test(s)) return true;

  // "Seattle or San Francisco", "New York / London", "Austin & Denver".
  // A choice of cities is not a location. Measuring to whichever one a
  // geocoder picks produces a confident number for a job that might be
  // anywhere, and that is exactly what kept a Stripe role listed as
  // "Seattle or San Francisco" inside a 25-mile search.
  if (/\s+(or|and)\s+/i.test(s) || /\s[/&]\s/.test(s)) return true;

  if (
    /^(n\/?a|none|null|tbd|tba|unknown|various|other|location|locations|office|offices|in[-\s]?office|on[-\s]?site|onsite|hybrid|flexible|field|field[-\s]based|corporate|corporate\s+hq|hq|headquarters|home|anywhere|global|worldwide|international|nationwide|multiple|all\s+locations)$/i.test(
      s,
    )
  ) {
    return true;
  }

  // Region codes and bare countries: AMER, EMEA, APAC, LATAM, USCA, "US",
  // "West Coast". None names a point you can measure a commute to.
  if (
    /^(amer|namer|emea|apac|apj|latam|usca|anz|dach|benelux|us|usa|u\.s\.a?\.?|united\s+states(\s+of\s+america)?|canada|europe|asia|americas|(north|south|east|west|mid)[-\s]?(west|east|coast|america)?|midwest|east\s+coast|west\s+coast|northeast|southeast|northwest|southwest)$/i.test(
      s,
    )
  ) {
    return true;
  }

  return false;
}

/**
 * Where a Greenhouse posting is, when the board has put something else in the
 * place for it.
 *
 * Some boards use the location line for the working arrangement — "Hybrid",
 * "In-Office", "Hybrid; In-Office", "N/A" — and keep the town on the office
 * the posting is attached to. Read plainly, a hundred such postings had no
 * place at all and were set aside, though each named its office one field
 * over. A real place on the location line is always kept as it is; so is
 * "Remote", which is an answer in itself.
 */
export function greenhousePlace(job: {
  location?: { name?: string | null } | null;
  offices?: Array<{ name?: string | null; location?: string | null }> | null;
}): string | undefined {
  const named = String(job?.location?.name ?? "").trim();
  const MODE = /^(hybrid|in[- ]?office|in[- ]?person|on[- ]?site|office|n\/?a|tbd|none|flexible)$/i;
  const onlyMode =
    !named ||
    MODE.test(named) ||
    named
      .split(/[;,|]+|\s\/\s/)
      .map((p) => p.trim())
      .filter(Boolean)
      .every((p) => MODE.test(p));
  if (!onlyMode) return named;
  for (const office of job?.offices ?? []) {
    // The office's address line is the fuller of the two; its name is often
    // just the town, and sometimes "HQ".
    const place = String(office?.location ?? "").trim() || String(office?.name ?? "").trim();
    if (place && !MODE.test(place) && !/^(hq|headquarters|corporate|main office|no office)$/i.test(place)) return place;
  }
  return named || undefined;
}

export function cleanLocation(raw?: string | null): string | null {
  if (!raw) return null;
  let s = raw.trim();
  if (!s || /^(remote|anywhere|various)/i.test(s)) return null;

  // Workday reports a posting open in several places as a bare count — "2
  // Locations", "15 Locations" — with no city anywhere in the string. A live
  // check against Target and BlackRock found roughly a third of postings look
  // like this. There is no place to geocode here, and the only way to get the
  // real cities is a per-posting detail request, which at thousands of
  // postings would cost thousands of requests and blow the run's time budget.
  // So these count as unknown rather than being sent to the geocoder, where
  // they would burn the rate limit and cache a meaningless miss.
  if (/^(multiple\s+locations|\d+\s+locations?)\b/i.test(s)) return null;

  if (isNonPlace(s)) return null;

  s = s
    .replace(/\s*\(.*?\)\s*/g, " ") // drop parentheticals
    .replace(/\b(remote|hybrid|on-?site|flexible)\b/gi, " ")
    // A ZIP, with or without the +4. Workday sends full postal addresses —
    // "1000 Nicollet Mall, Minneapolis,MN 55403-2542" — and a geocoder does
    // far better with the town than with the mailroom.
    .replace(/\b\d{5}(-\d{4})?\b/g, " ")
    // Normalise "Minneapolis,MN" so the state is a separate part below.
    .replace(/,(?=\S)/g, ", ")
    .replace(/\s*[-–—]\s*/g, ", ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .replace(/^,|,$/g, "")
    .trim();

  // Drop a leading street address. "1000 Nicollet Mall, Minneapolis, MN"
  // becomes "Minneapolis, MN": the street number makes a geocoder hunt for an
  // exact building and miss, where the town always resolves.
  {
    const bits = s
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    if (bits.length > 2 && /^\d+\s+\S/.test(bits[0] ?? "")) bits.shift();
    s = bits.join(", ");
  }

  // "US, NJ, Princeton" -> "Princeton, NJ" reads better to a geocoder
  const parts = s
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length >= 2 && /^(us|usa|united states)$/i.test(parts[0] ?? "")) {
    parts.shift();
    if (parts.length >= 2) return `${parts[parts.length - 1]}, ${parts[0]}`;
  }
  // "West Coast - United States" cleans to two parts, neither of which names
  // a point: a region and a country. Whole-string matching misses that, so
  // the parts are judged individually too.
  if (parts.length > 0 && parts.every((part) => isNonPlace(part))) return null;

  const out = parts.join(", ");
  if (!out || isNonPlace(out)) return null;
  return out;
}

// ---------------------------------------------------------------------------
// Deciding what is obviously too far, without asking anyone
// ---------------------------------------------------------------------------
//
// Geocoding is rate limited to about one request a second, so a run can only
// resolve a handful of new towns. On the first live run that meant most
// postings were never measured at all — and because unresolved locations are
// kept, a 25-mile search returned jobs in Minneapolis and Bangalore.
//
// Almost none of those needed a lookup to reject. "Bangalore,India" is not
// within 25 miles of New Jersey, and neither is anything in Minnesota. A
// state is enough to settle it, and a state can be read straight off the
// string. So the geocoder is now reserved for places that could plausibly be
// close, which is a few dozen towns rather than thousands of postings.

/** Approximate geographic centre of each US state. */
const STATE_CENTROIDS: Record<string, [number, number]> = {
  AL: [32.8, -86.8],
  AK: [64.0, -152.0],
  AZ: [34.3, -111.7],
  AR: [34.9, -92.4],
  CA: [37.2, -119.5],
  CO: [39.0, -105.5],
  CT: [41.6, -72.7],
  DE: [39.0, -75.5],
  DC: [38.9, -77.0],
  FL: [28.6, -82.4],
  GA: [32.6, -83.4],
  HI: [20.3, -156.4],
  ID: [44.4, -114.6],
  IL: [40.0, -89.2],
  IN: [39.9, -86.3],
  IA: [42.1, -93.5],
  KS: [38.5, -98.4],
  KY: [37.5, -85.3],
  LA: [31.0, -92.0],
  ME: [45.4, -69.2],
  MD: [39.0, -76.8],
  MA: [42.3, -71.8],
  MI: [44.3, -85.4],
  MN: [46.3, -94.3],
  MS: [32.7, -89.7],
  MO: [38.4, -92.5],
  MT: [47.0, -109.6],
  NE: [41.5, -99.8],
  NV: [39.3, -116.6],
  NH: [43.7, -71.6],
  NJ: [40.2, -74.7],
  NM: [34.4, -106.1],
  NY: [42.9, -75.5],
  NC: [35.5, -79.4],
  ND: [47.4, -100.5],
  OH: [40.3, -82.8],
  OK: [35.6, -97.5],
  OR: [43.9, -120.6],
  PA: [40.9, -77.8],
  RI: [41.7, -71.6],
  SC: [33.9, -80.9],
  SD: [44.4, -100.2],
  TN: [35.8, -86.4],
  TX: [31.5, -99.3],
  UT: [39.3, -111.7],
  VT: [44.1, -72.7],
  VA: [37.5, -78.9],
  WA: [47.4, -120.5],
  WV: [38.6, -80.6],
  WI: [44.6, -89.7],
  WY: [43.0, -107.6],
  PR: [18.2, -66.4],
};

const STATE_NAMES: Record<string, string> = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
  "district of columbia": "DC",
  "puerto rico": "PR",
};

/** A location outside the United States is never within commuting distance. */
const NON_US =
  /\b(india|china|japan|singapore|philippines|vietnam|indonesia|malaysia|thailand|korea|taiwan|hong kong|pakistan|bangladesh|israel|turkey|uae|dubai|qatar|saudi|egypt|nigeria|kenya|south africa|morocco|australia|new zealand|united kingdom|u\.?k\.?|england|scotland|wales|ireland|france|germany|spain|portugal|italy|netherlands|belgium|luxembourg|switzerland|austria|poland|czech|slovakia|hungary|romania|bulgaria|greece|sweden|norway|denmark|finland|iceland|estonia|latvia|lithuania|ukraine|russia|serbia|croatia|slovenia|canada|mexico|brazil|argentina|chile|colombia|peru|uruguay|costa rica|panama|guatemala)\b/i;

/** Cities common in job feeds whose names do not carry their country. */
const NON_US_CITIES =
  /\b(london|berlin|munich|hamburg|paris|madrid|barcelona|lisbon|dublin|amsterdam|rotterdam|brussels|zurich|geneva|vienna|prague|warsaw|budapest|bucharest|sofia|athens|stockholm|oslo|copenhagen|helsinki|tallinn|riga|vilnius|kyiv|kiev|moscow|istanbul|tel aviv|bangalore|bengaluru|hyderabad|chennai|mumbai|pune|delhi|gurgaon|gurugram|noida|kolkata|ahmedabad|beijing|shanghai|shenzhen|guangzhou|tokyo|osaka|seoul|taipei|manila|cebu|jakarta|bangkok|kuala lumpur|ho chi minh|hanoi|sydney|melbourne|brisbane|perth|auckland|wellington|toronto|vancouver|montreal|ottawa|calgary|waterloo|mexico city|guadalajara|monterrey|bogota|bogot[aá]|lima|santiago|buenos aires|s[aã]o paulo|sao paulo|rio de janeiro)\b/i;

export type CoarsePlace = {
  /** Approximate miles from home, or Infinity when definitely not nearby. */
  miles: number;
  /** How the estimate was reached, for the skip reason. */
  basis: "non-us" | "state" | "unknown";
  state?: string | undefined;
};

/**
 * Estimate how far a location is from home WITHOUT any network call.
 *
 * Deliberately coarse. It exists to answer one question cheaply — "could this
 * possibly be close?" — so a precise lookup is only spent on places where the
 * answer is yes. A state centroid can be several hundred miles from a city in
 * the same state, so the caller must allow generous slack before rejecting on
 * this alone.
 *
 * Returns basis "unknown" when the string carries neither a country nor a
 * state, and the caller must then decide without help.
 */
export function coarsePlace(
  raw: string | null | undefined,
  homeLat: number,
  homeLon: number,
): CoarsePlace {
  const str = (raw ?? "").trim();
  if (!str) return { miles: NaN, basis: "unknown" };

  // A US state settles it, and it has to be looked for FIRST. Plenty of
  // American towns are named after foreign cities — Dublin OH, Paris TX,
  // Berlin NH, Athens GA, Moscow ID — and checking city names first rejects
  // every one of them as foreign.
  const abbrev = str.match(/[,\s]([A-Z]{2})\b(?!\s*[A-Za-z])/);
  let code = abbrev?.[1];
  if (!code || !STATE_CENTROIDS[code]) {
    code = undefined;
    const lower = str.toLowerCase();
    for (const [name, abbr] of Object.entries(STATE_NAMES)) {
      if (new RegExp(`\\b${name}\\b`).test(lower)) {
        code = abbr;
        break;
      }
    }
  }

  const centre = code ? STATE_CENTROIDS[code] : undefined;
  if (centre) {
    return {
      miles: milesBetween(homeLat, homeLon, centre[0], centre[1]),
      basis: "state",
      state: code,
    };
  }

  // No US state anywhere in the string. Now a country or a well-known
  // foreign city is good enough to rule it out.
  if (NON_US.test(str) || NON_US_CITIES.test(str)) {
    return { miles: Infinity, basis: "non-us" };
  }

  return { miles: NaN, basis: "unknown" };
}
