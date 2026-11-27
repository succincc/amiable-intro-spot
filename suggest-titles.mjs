/**
 * Widen the target-title list from the resume.
 *
 * Run it and it reads the profile's resume, works out every title that
 * resume supports, and merges them into search_config.titles. Titles
 * already there are kept; nothing is ever removed.
 *
 * Why this exists: 923 of 3029 discovered postings were rejected as "title
 * not relevant to targets" — more than distance, salary and the exclude
 * list put together. A person writes the four or five titles they can
 * picture, and the search then cannot see anything else they are qualified
 * for. Scoring is what decides which jobs are worth applying to, and it can
 * only judge what the search was allowed to find.
 *
 * DRY_RUN=1 prints what would be added and writes nothing.
 */
import { guardLogs, hideNames } from "./quiet.mjs";
// Nothing this prints names an employer, a posting or a place: see quiet.mjs.
guardLogs();
import { suggestTitles, suggestTitlesWithModel } from "./titles.mjs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
// Whose round this is, when the runner is doing somebody else's: see forusers.mjs.
const ACT_AS = process.env.AP_ACT_AS ? { "x-act-as": process.env.AP_ACT_AS } : {};
const AP_EMAIL = process.env.APPLYPILOT_EMAIL;
const AP_PASSWORD = process.env.APPLYPILOT_PASSWORD;
const DRY = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";

if (!SUPABASE_URL || !ANON_KEY || !AP_EMAIL || !AP_PASSWORD) {
  console.error("Missing SUPABASE_URL, SUPABASE_ANON_KEY, APPLYPILOT_EMAIL or APPLYPILOT_PASSWORD.");
  process.exit(1);
}

let ACCESS = null;
async function token() {
  if (ACCESS) return ACCESS;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON_KEY, ...ACT_AS, "Content-Type": "application/json" },
    body: JSON.stringify({ email: AP_EMAIL, password: AP_PASSWORD }),
  });
  if (!res.ok) throw new Error(`sign-in failed: ${res.status}`);
  ACCESS = (await res.json()).access_token;
  return ACCESS;
}

async function db(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: ANON_KEY, ...ACT_AS,
      Authorization: `Bearer ${await token()}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`DB ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

(async () => {
  const [profile] = (await db("profile?id=eq.1&select=*")) ?? [];
  const [cfg] = (await db("search_config?id=eq.1&select=*")) ?? [];
  if (!profile) {
    console.error("No profile to read.");
    process.exit(1);
  }

  const resume = profile.resume_text ?? "";
  if (!resume.trim()) {
    console.error("The profile has no resume text, so there is nothing to read titles from.");
    process.exit(1);
  }

  const existing = (cfg?.titles ?? []).map((t) => String(t).trim()).filter(Boolean);
  // Asked to help only where a search has next to nothing to look for: a
  // new person with one title, not somebody whose list is already theirs.
  const onlyUnder = Number(process.env.ONLY_UNDER || 0);
  if (onlyUnder > 0 && existing.length >= onlyUnder) {
    console.log(`this search already has ${existing.length} title(s); left as it is`);
    process.exit(0);
  }
  const exclude = [...(cfg?.exclude_titles ?? []), ...(cfg?.no_go_patterns ?? [])];

  // Base roles only. The seniority variants match nothing the base role
  // does not — the filter keeps a posting when half the words of a target
  // title appear in it, so "Data Analyst" already catches Senior Data
  // Analyst and Data Analyst II.
  const fromRules = suggestTitles({ resume, profile, exclude });
  console.log(`from the resume: ${fromRules.length} titles`);

  // Which of the stored titles are the person's own.
  //
  // A previous run wrote the generated list into the config, so "what was
  // there before" is no longer simply what is there. The generator is
  // deterministic, so subtracting everything it produces leaves exactly the
  // titles a human put in — and those are kept whatever the cap.
  const generatedEver = new Set(
    [
      ...suggestTitles({ resume, profile, exclude, ladder: true, limit: 1000 }),
      ...fromRules,
    ].map((t) => t.toLowerCase()),
  );
  const theirs = existing.filter((t) => !generatedEver.has(t.toLowerCase()));
  if (theirs.length !== existing.length) {
    console.log(`${theirs.length} of the ${existing.length} stored titles were written by hand`);
  }

  // The model only ever widens the list, and whatever it returns passes the
  // same filters, so a bad day for it costs breadth and never correctness.
  let fromModel = [];
  if (process.env.GEMINI_API_KEY) {
    try {
      const { geminiForTitles } = await import("./answers.mjs");
      fromModel = await suggestTitlesWithModel({
        resume,
        exclude,
        apiKey: process.env.GEMINI_API_KEY,
        gemini: geminiForTitles,
      });
      console.log(`from the model: ${fromModel.length} more`);
    } catch (e) {
      console.log(`the model added nothing: ${String(e?.message ?? e).slice(0, 90)}`);
    }
  }

  // Case-insensitive merge, keeping whatever spelling was there first, and
  // the person's own titles ahead of anything generated so a cap never
  // drops one of theirs.
  const seen = new Map();
  for (const t of [...theirs, ...fromRules, ...fromModel]) {
    const key = String(t).toLowerCase().replace(/\s+/g, " ").trim();
    if (key && !seen.has(key)) seen.set(key, String(t).replace(/\s+/g, " ").trim());
  }
  // A cap, because discovery runs on a host with a request time limit and
  // 178 titles took it past one: every extra title means more postings kept,
  // and every posting kept with an unresolved location costs a geocoder call.
  const cap = Math.max(10, Number(process.env.TITLE_LIMIT ?? 120));
  const ordered = [...seen.values()];
  const merged = ordered.slice(0, cap).sort((a, b) => a.localeCompare(b));
  if (ordered.length > cap) {
    console.log(`capped at ${cap} of ${ordered.length}; raise TITLE_LIMIT to go wider`);
  }
  const added = merged.filter((t) => !existing.some((e) => e.toLowerCase() === t.toLowerCase()));

  console.log(`had ${existing.length}, adding ${added.length}, ${merged.length} in total`);
  // Which titles is the owner's business and is in the panel; here, how many.

  if (DRY) {
    console.log("DRY_RUN — nothing was written.");
    return;
  }
  if (!added.length && merged.length === existing.length) {
    console.log("Nothing to change.");
    return;
  }

  await db("search_config?id=eq.1", {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ titles: merged, updated_at: new Date().toISOString() }),
  });
  console.log(`Saved ${merged.length} target titles. Run discovery to use them.`);
})().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
