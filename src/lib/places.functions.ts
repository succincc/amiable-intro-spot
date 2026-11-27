import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { STATE_CODES, townOnly, townsFrom, zipsFrom } from "@/lib/places";

const UA = "ApplyPilot (job search assistant)";

/**
 * The towns a few typed letters could be. Asked of Photon, the open map's
 * own search-as-you-type service; free, no key. Asked from the server so
 * that the letters a person types are not sent from their own browser.
 */
export const searchTowns = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { q: string }) => d)
  .handler(async ({ data }) => {
    const typed = String(data.q ?? "").slice(0, 80);
    const q = townOnly(typed);
    if (q.length < 3) return { towns: [] };
    // "Springfield, NJ" narrows to that state; the letters after the comma are not sent as part of the name.
    const after = (typed.split(",")[1] ?? "").trim().toLowerCase();
    const wantState = after.length === 2 ? after.toUpperCase() : STATE_CODES[after] ?? null;
    try {
      const url = new URL("https://photon.komoot.io/api/");
      url.searchParams.set("q", q);
      url.searchParams.set("limit", "20");
      url.searchParams.set("lang", "en");
      for (const kind of ["city", "town", "village", "hamlet", "borough"]) url.searchParams.append("osm_tag", `place:${kind}`);
      // Roughly the fifty states, to keep other countries' towns out of the first page.
      url.searchParams.set("bbox", "-179.9,17.5,-64.5,71.6");
      const res = await fetch(url.toString(), { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) return { towns: [] };
      const towns = townsFrom(await res.json(), 20);
      return { towns: (wantState ? towns.filter((t) => t.state === wantState) : towns).slice(0, 7) };
    } catch {
      return { towns: [] };
    }
  });

/** A chosen town's postal codes. Free, no key. */
export const zipsFor = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { city: string; state: string }) => d)
  .handler(async ({ data }) => {
    const city = String(data.city ?? "").trim().slice(0, 80);
    const state = String(data.state ?? "").trim().toLowerCase();
    if (!city || !/^[a-z]{2}$/.test(state)) return { zips: [] };
    try {
      const res = await fetch(`https://api.zippopotam.us/us/${state}/${encodeURIComponent(city.toLowerCase())}`, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) return { zips: [] };
      return { zips: zipsFrom(await res.json()).slice(0, 40) };
    } catch {
      return { zips: [] };
    }
  });
