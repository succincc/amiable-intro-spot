// ============================================================================
// places.ts — a town typed, a town chosen.
//
// The profile's town, state and postal code are typed onto every application,
// so a slip in one of them is a slip on all of them. Typing a few letters of
// the town offers the towns it could be; choosing one fills in the town as
// forms write it, its state, and its postal code where the town has only one.
// A town with several is offered its own list rather than a guess.
//
// This is the part with no network in it: reading what the two public
// services answer. Pure, so each part has a test.
// ============================================================================

export const STATE_CODES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT", delaware: "DE",
  "district of columbia": "DC", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
  mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR",
  pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT",
  vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY", "puerto rico": "PR",
};

export type Town = { city: string; state: string; county: string | null; label: string };

/** "Hazlet, NJ" typed into the town box is the town "Hazlet"; the state is not part of its name. */
export function townOnly(typed: string): string {
  return String(typed ?? "").split(",")[0]!.replace(/\s+/g, " ").trim();
}

/** The towns in a place search's answer: United States only, one line per town and state. */
export function townsFrom(geojson: unknown, max = 7): Town[] {
  const features = (geojson as { features?: Array<{ properties?: Record<string, unknown> }> } | null)?.features ?? [];
  const out: Town[] = [];
  const seen = new Set<string>();
  for (const f of features) {
    const p = f?.properties ?? {};
    if (String(p["countrycode"] ?? "").toUpperCase() !== "US") continue;
    if (!/^(city|town|village|hamlet|borough|suburb|municipality|locality)$/.test(String(p["osm_value"] ?? p["type"] ?? ""))) continue;
    const city = String(p["name"] ?? "").trim();
    const state = STATE_CODES[String(p["state"] ?? "").trim().toLowerCase()];
    if (!city || !state) continue;
    const key = `${city.toLowerCase()}|${state}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const county = String(p["county"] ?? "").trim() || null;
    out.push({ city, state, county, label: `${city}, ${state}${county ? ` (${county})` : ""}` });
    if (out.length >= max) break;
  }
  return out;
}

/** A town's postal codes, as the postal lookup answers them: five digits each, in order, no repeats. */
export function zipsFrom(answer: unknown): string[] {
  const places = (answer as { places?: Array<Record<string, unknown>> } | null)?.places ?? [];
  const zips = places.map((p) => String(p["post code"] ?? "").trim()).filter((z) => /^\d{5}$/.test(z));
  return [...new Set(zips)].sort();
}
