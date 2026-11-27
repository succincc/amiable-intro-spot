// The phone number of the place itself, for postings applied to.
//
// After applying, a call to the location — "is the hiring manager in?" —
// puts a name to the application. This finds the number: the location's own
// published one, from the open map of the world (OpenStreetMap), looked up
// by the employer's name near where the posting is. Free, no key. Nothing is
// called from here; the number is saved beside the application and the
// owner makes the call.

import { guardLogs, hideNames } from "./quiet.mjs";
guardLogs();

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
// Whose round this is, when the runner is doing somebody else's: see forusers.mjs.
const ACT_AS = process.env.AP_ACT_AS ? { "x-act-as": process.env.AP_ACT_AS } : {};
const AP_EMAIL = process.env.APPLYPILOT_EMAIL;
const AP_PASSWORD = process.env.APPLYPILOT_PASSWORD;
const APPLY = process.env.APPLY === "true";
const MAX = Number(process.env.MAX_JOBS || 40);

/** The words of an employer's name a map would file it under. */
export function nameKey(company) {
  return String(company ?? "")
    .replace(/\b(inc|llc|ltd|corp|corporation|company|co|stores?|the|usa|us|group|holdings)\b\.?/gi, " ")
    .replace(/[^A-Za-z0-9 &'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 2)
    .join(" ");
}

/** The nearest place of that name with a phone, from what the map answered. */
export function phoneFrom(json, lat, lon) {
  let best = null;
  for (const e of json?.elements ?? []) {
    const phone = e?.tags?.phone ?? e?.tags?.["contact:phone"];
    if (!phone) continue;
    const at = e.center ?? e;
    const d = Math.hypot((Number(at.lat) - lat) * 69, (Number(at.lon) - lon) * 53);
    if (!best || d < best.d) best = { phone: String(phone).split(/[;,]/)[0].trim(), d };
  }
  return best && best.d <= 3 ? best.phone : null;
}

if (process.env.PHONES_IMPORT_ONLY !== "1") {
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

  // Applied to in the last ten days, at a place on the map, with no number yet.
  const since = new Date(Date.now() - 10 * 86_400_000).toISOString();
  const jobs =
    (await db(`jobs?status=eq.applied&applied_at=gte.${since}&phone=is.null&lat=not.is.null&remote=not.is.true&select=id,company,lat,lon&order=applied_at.desc&limit=${MAX}`).catch((e) => {
      console.log(`could not read the applications (is the calls migration applied?): ${String(e.message).slice(0, 100)}`);
      return [];
    })) ?? [];
  hideNames(jobs.map((j) => j.company));
  const tally = { looked: 0, found: 0, notOnMap: 0, failed: 0 };
  for (const j of jobs) {
    const key = nameKey(j.company);
    if (key.length < 3) continue;
    tally.looked++;
    const q = `[out:json][timeout:20];nwr(around:4500,${j.lat},${j.lon})["name"~"${key.replace(/["\\]/g, "")}",i];out tags center 12;`;
    try {
      const res = await fetch("https://overpass-api.de/api/interpreter", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "ApplyPilot (job search assistant)" },
        body: `data=${encodeURIComponent(q)}`,
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) { tally.failed++; await new Promise((r) => setTimeout(r, 4000)); continue; }
      const phone = phoneFrom(await res.json(), Number(j.lat), Number(j.lon));
      if (!phone) { tally.notOnMap++; }
      else {
        tally.found++;
        if (APPLY) await db(`jobs?id=eq.${j.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ phone }) }).catch(() => {});
      }
    } catch {
      tally.failed++;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.log(`result: ${JSON.stringify(tally)}; ${APPLY ? "saved" : "report only"}`);
  process.exit(0);
}
