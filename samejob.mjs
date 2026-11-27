// Whether two postings are the same job: the same role, at the same employer,
// in the same place.
//
// A posting has one address, and an address is what the queue tells postings
// apart by. But one job is often posted at several — the employer's own board
// and a feed that copies it, or the same opening re-listed under a new
// number — and an application to each is the same person applying twice.
//
// The owner's rule, in their examples: Manager at Staples in Hazlet NJ is not
// applied to twice. Manager at Staples in Freehold NJ is another job, and so
// is Cashier at Staples in Hazlet, Manager at ShopRite in Hazlet, and Manager
// at Staples in Hazlet NY. Several jobs at one employer is encouraged; the
// same one twice is not.

const STATE_CODES = {
  alabama: "al", alaska: "ak", arizona: "az", arkansas: "ar", california: "ca", colorado: "co", connecticut: "ct", delaware: "de",
  "district of columbia": "dc", florida: "fl", georgia: "ga", hawaii: "hi", idaho: "id", illinois: "il", indiana: "in", iowa: "ia",
  kansas: "ks", kentucky: "ky", louisiana: "la", maine: "me", maryland: "md", massachusetts: "ma", michigan: "mi", minnesota: "mn",
  mississippi: "ms", missouri: "mo", montana: "mt", nebraska: "ne", nevada: "nv", "new hampshire": "nh", "new jersey": "nj",
  "new mexico": "nm", "new york": "ny", "north carolina": "nc", "north dakota": "nd", ohio: "oh", oklahoma: "ok", oregon: "or",
  pennsylvania: "pa", "rhode island": "ri", "south carolina": "sc", "south dakota": "sd", tennessee: "tn", texas: "tx", utah: "ut",
  vermont: "vt", virginia: "va", washington: "wa", "west virginia": "wv", wisconsin: "wi", wyoming: "wy",
};
const CODES = new Set(Object.values(STATE_CODES));

const flat = (t) => String(t ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();

/** An employer's name without the words that come and go between listings. */
export function employerKey(name) {
  return flat(name).replace(/\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|company|plc|lp|llp|holdings|group|the)\b/g, " ").replace(/\s+/g, " ").trim();
}

/** A role's name without a requisition number or the place tacked on the end. */
export function roleKey(title) {
  return flat(String(title ?? "").replace(/\s*[-–—|(#]\s*(req|r|job|id|jr)?[-\s#]*\d{3,}\)?\s*$/i, "")).replace(/\s+/g, " ").trim();
}

/**
 * A place as town and state: "Hazlet, NJ", "Hazlet, New Jersey, United
 * States" and "US-NJ-Hazlet" are one place; "Hazlet, NY" is another. A place
 * that names no town is kept as it reads, and no place at all is its own
 * place — two postings that both say nothing are taken to be the same.
 */
export function placeKey(location) {
  const raw = String(location ?? "").trim();
  if (!raw) return "";
  const coded = raw.match(/^([A-Z]{2})-([A-Z]{2})-(.+)$/);
  const parts = (coded ? [coded[3], coded[2]] : raw.split(/[,;|/]| - /)).map((p) => flat(p)).filter(Boolean);
  let state = "";
  let town = "";
  for (const p of parts) {
    if (/^(us|usa|united states|united states of america)$/.test(p)) continue;
    const code = STATE_CODES[p] ?? (CODES.has(p) ? p : null);
    if (code && !state) { state = code; continue; }
    // "hazlet nj" in one piece.
    const tail = p.match(/^(.+)\s([a-z]{2})$/);
    if (!town && tail && CODES.has(tail[2])) { town = tail[1]; if (!state) state = tail[2]; continue; }
    if (!town) town = p.replace(/\b\d{5}\b/g, "").trim();
  }
  return `${town}|${state}`;
}

/** The three together: what makes a posting the job it is. */
export function jobKey(job) {
  const role = roleKey(job?.title);
  const employer = employerKey(job?.company);
  if (!role || !employer) return null;
  return `${employer}::${role}::${placeKey(job?.location)}`;
}
