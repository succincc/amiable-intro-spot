/* eslint-disable @typescript-eslint/no-explicit-any */
// Untyped Supabase client, as in discover.server.ts — geo_cache arrives with
// this feature's migration, ahead of the generated types.
// ============================================================================
// geo.server.ts — turning a job's location string into a distance in miles.
//
// Server-only: it calls an external geocoder and writes the cache table.
// ============================================================================

export type Point = { lat: number; lon: number };

/**
 * Read the cache only, without ever going to the network.
 *
 * Returns the point on a hit, `null` for a place already known not to
 * resolve, and `undefined` when the place has never been looked up. That
 * three-way answer is what lets a caller spend its one-per-second network
 * budget on genuinely new places while still resolving the thousands of
 * postings that repeat a town already seen.
 */
export async function cachedGeocode(
  supabase: any,
  place: string,
): Promise<Point | null | undefined> {
  const key = place.trim().toLowerCase().replace(/\s+/g, " ");
  if (!key) return null;
  const { data: hit } = await supabase
    .from("geo_cache")
    .select("lat,lon,found")
    .eq("place", key)
    .maybeSingle();
  if (!hit) return undefined;
  return hit.found ? { lat: hit.lat, lon: hit.lon } : null;
}

/**
 * Geocode a place name, caching every result forever.
 *
 * Uses OpenStreetMap's Nominatim, which is free but asks for at most one
 * request per second and a real contact header. Job locations repeat heavily
 * — thousands of postings resolve to a few hundred towns — so the cache turns
 * this from a bottleneck into a handful of lookups per run.
 */
export async function geocode(
  supabase: any,
  place: string,
): Promise<{ lat: number; lon: number } | null> {
  const key = place.trim().toLowerCase().replace(/\s+/g, " ");
  if (!key) return null;

  const { data: hit } = await supabase
    .from("geo_cache")
    .select("lat,lon,found")
    .eq("place", key)
    .maybeSingle();
  if (hit) return hit.found ? { lat: hit.lat, lon: hit.lon } : null;

  let result: { lat: number; lon: number } | null = null;
  try {
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("q", place);
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", "1");

    // Nominatim throttles automated clients, and a throttled request can sit
    // open rather than refusing. With no timeout that stalls the whole
    // discovery run — one unanswered lookup and the panel reads "running"
    // until someone gives up on it.
    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(8000),
      headers: {
        "User-Agent": "ApplyPilot/1.0 (personal job search tool)",
        Accept: "application/json",
      },
    });
    if (res.ok) {
      const arr = await res.json();
      if (Array.isArray(arr) && arr[0]?.lat && arr[0]?.lon) {
        result = { lat: parseFloat(arr[0].lat), lon: parseFloat(arr[0].lon) };
      }
    }
  } catch {
    /* cache the miss below so we do not retry it every run */
  }

  // Cache misses too — an unparseable location string stays unparseable, and
  // re-querying it every run would waste the rate limit on nothing.
  await supabase.from("geo_cache").upsert(
    {
      place: key,
      lat: result?.lat ?? null,
      lon: result?.lon ?? null,
      found: !!result,
    },
    { onConflict: "place" },
  );

  await new Promise((r) => setTimeout(r, 1100)); // Nominatim: 1 req/sec
  return result;
}
