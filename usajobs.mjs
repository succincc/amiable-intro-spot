// Federal postings, from USAJOBS's own search service.
//
// Discovery and applying are two things. The search service is public,
// documented and free with a key the owner asks for; what it returns is a
// posting like any other — a title, a place, a closing date, an address.
// Applying is a later step that goes through the applicant's own government
// sign-in, and the applier files such a posting as the owner's to open when
// it meets that sign-in. A step that needs the owner at the end is no reason
// not to find the job at the start.
//
//   GET https://data.usajobs.gov/api/search
//   headers: Host: data.usajobs.gov, User-Agent: <the email the key was
//            issued to>, Authorization-Key: <the key>
//
// Runs only when both are set as repository secrets (USAJOBS_KEY,
// USAJOBS_EMAIL). Free: a public-repo runner and a public service.

import { guardLogs, hideNames, shape } from "./quiet.mjs";
import { FRESH_DAYS } from "./fresh.mjs";
import { stateName } from "./near.mjs";
// Nothing this prints names an employer, a posting or a place: see quiet.mjs.
guardLogs();

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const AP_EMAIL = process.env.APPLYPILOT_EMAIL;
const AP_PASSWORD = process.env.APPLYPILOT_PASSWORD;
const KEY = String(process.env.USAJOBS_KEY || "").trim();
const KEY_EMAIL = String(process.env.USAJOBS_EMAIL || "").trim();
const APPLY = process.env.APPLY === "true"; // off: look and report, write nothing
const TITLES_PER_RUN = Number(process.env.TITLES_PER_RUN || 12);

/** Does this title look like one the owner searches for? */
export function wanted(title, titles, excludes) {
  const t = String(title ?? "").toLowerCase();
  if (!t) return false;
  if (excludes.some((x) => x && t.includes(String(x).toLowerCase()))) return false;
  if (!titles.length) return true;
  return titles.some((want) => {
    const words = String(want).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
    return words.length > 0 && words.filter((w) => t.includes(w)).length / words.length >= 0.5;
  });
}

const plain = (html) =>
  String(html ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

/** One search answer as postings of the shape every other reader saves. */
export function readSearch(json) {
  const out = [];
  for (const item of json?.SearchResult?.SearchResultItems ?? []) {
    const d = item?.MatchedObjectDescriptor ?? {};
    const title = String(d.PositionTitle ?? "").trim();
    const url = String(d.PositionURI ?? "").trim();
    if (!title || !/^https?:\/\//.test(url)) continue;
    const at = (d.PositionLocation ?? [])[0] ?? {};
    const where = [at.CityName, at.CountrySubDivisionCode].map((x) => String(x ?? "").trim()).filter(Boolean);
    // "Trenton, New Jersey" comes with the state said twice over.
    const location = where.length === 2 && where[0].toLowerCase().includes(where[1].toLowerCase()) ? where[0] : where.join(", ");
    const pay = (d.PositionRemuneration ?? [])[0] ?? {};
    const details = d.UserArea?.Details ?? {};
    const lat = Number(at.Latitude);
    const lon = Number(at.Longitude);
    const opened = d.PublicationStartDate ? new Date(d.PublicationStartDate) : null;
    out.push({
      url,
      apply_url: String((d.ApplyURI ?? [])[0] ?? url),
      title: title.slice(0, 200),
      company: String(d.OrganizationName ?? d.DepartmentName ?? "U.S. Government").slice(0, 120),
      location: location || String(d.PositionLocationDisplay ?? "").slice(0, 120) || null,
      lat: Number.isFinite(lat) && lat !== 0 ? lat : null,
      lon: Number.isFinite(lon) && lon !== 0 ? lon : null,
      remote: /remote|telework eligible: yes|location negotiable/i.test(`${d.PositionLocationDisplay ?? ""} ${details.TeleworkEligible ?? ""} ${details.RemoteIndicator === true ? "remote" : ""}`),
      description: plain([details.JobSummary, details.MajorDuties, d.QualificationSummary].flat().filter(Boolean).join("\n")).slice(0, 12000),
      salary_text: pay.MinimumRange ? `$${pay.MinimumRange} - $${pay.MaximumRange} ${String(pay.Description ?? pay.RateIntervalCode ?? "").toLowerCase()}`.trim() : null,
      posted_at: opened && Number.isFinite(opened.getTime()) ? opened.toISOString() : null,
      closes: d.ApplicationCloseDate ?? null,
    });
  }
  return out;
}

if (process.env.USAJOBS_IMPORT_ONLY !== "1") {
  if (!KEY || !KEY_EMAIL) {
    console.log("No USAJOBS key is set (USAJOBS_KEY and USAJOBS_EMAIL); nothing read. The key is free: developer.usajobs.gov, 'request an API key'.");
    process.exit(0);
  }
  if (!SUPABASE_URL || !ANON_KEY || !AP_EMAIL || !AP_PASSWORD) {
    console.error("Missing SUPABASE_URL, SUPABASE_ANON_KEY, APPLYPILOT_EMAIL or APPLYPILOT_PASSWORD.");
    process.exit(1);
  }
  let ACCESS = "";
  const sign = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: AP_EMAIL, password: AP_PASSWORD }),
  });
  if (!sign.ok) throw new Error(`Sign-in failed ${sign.status}`);
  ACCESS = (await sign.json()).access_token;
  const db = async (path, init = {}) => {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      ...init,
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${ACCESS}`, "Content-Type": "application/json", ...(init.headers || {}) },
    });
    if (!res.ok) throw new Error(`DB ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  };

  const [cfg] = (await db("search_config?id=eq.1&select=titles,exclude_titles,radius_miles")) ?? [{}];
  const titles = (cfg?.titles ?? []).filter(Boolean);
  const excludes = (cfg?.exclude_titles ?? []).filter(Boolean);
  // The owner's town, for asking the service what is near it. Used in the
  // request and never printed.
  const [prof] = (await db("profile?id=eq.1&select=city,state,home_state")) ?? [];
  const st = prof?.home_state || prof?.state || "";
  const place = prof?.city && stateName(st) ? `${prof.city}, ${stateName(st)}` : stateName(st) ?? "";
  const radius = Math.max(10, Number(cfg?.radius_miles ?? 25) + 3);

  // A different dozen of the owner's titles each run, so that all of them
  // are asked for over a few runs without asking for all of them every time.
  const turn = Math.floor(Date.now() / (12 * 3_600_000));
  const startAt = titles.length ? (turn * TITLES_PER_RUN) % titles.length : 0;
  const asked = [...titles.slice(startAt), ...titles.slice(0, startAt)].slice(0, TITLES_PER_RUN);

  const tally = { asked: 0, answered: 0, read: 0, wanted: 0, saved: 0, errors: {} };
  const found = new Map();
  let sampled = false;
  for (const title of asked) {
    tally.asked++;
    const q = new URLSearchParams({ Keyword: title, DatePosted: String(Math.min(60, FRESH_DAYS)), ResultsPerPage: "100" });
    if (place) {
      q.set("LocationName", place);
      q.set("Radius", String(radius));
    }
    try {
      const res = await fetch(`https://data.usajobs.gov/api/search?${q}`, {
        headers: { Host: "data.usajobs.gov", "User-Agent": KEY_EMAIL, "Authorization-Key": KEY, Accept: "application/json" },
        signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) {
        tally.errors[`HTTP ${res.status}`] = (tally.errors[`HTTP ${res.status}`] ?? 0) + 1;
        // A key that is refused is refused for every title.
        if (res.status === 401 || res.status === 403) break;
        continue;
      }
      const rows = readSearch(await res.json());
      tally.answered++;
      tally.read += rows.length;
      if (rows.length && !sampled) {
        sampled = true;
        console.log(`  sample row: ${JSON.stringify(shape(rows[0])).slice(0, 420)}`);
      }
      for (const r of rows) {
        if (!wanted(r.title, titles, excludes)) continue;
        if (!found.has(r.url)) found.set(r.url, r);
      }
    } catch (e) {
      const k = String(e?.message ?? e).slice(0, 40);
      tally.errors[k] = (tally.errors[k] ?? 0) + 1;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  tally.wanted = found.size;
  hideNames([...found.values()].map((r) => r.company));

  if (APPLY && found.size) {
    const body = [...found.values()].slice(0, 200).map(({ closes, ...r }) => ({
      ...r,
      description: closes ? `${r.description}\n\nApplications close ${String(closes).slice(0, 10)}.` : r.description,
      source: "usajobs",
      ats: "usajobs",
      status: "new",
    }));
    try {
      const saved = await db("jobs?on_conflict=url", {
        method: "POST",
        headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
        body: JSON.stringify(body),
      });
      tally.saved = saved?.length ?? 0;
    } catch (e) {
      console.log(`  could not save: ${String(e.message).slice(0, 140)}`);
    }
  }
  console.log(`result: ${JSON.stringify(tally)}; ${APPLY ? "saved" : "report only"}`);
  process.exit(0);
}
