// One runner, each person's round in turn.
//
//   node forusers.mjs apply.mjs
//
// Every job here was written for one person: it signs in, reads "the"
// profile, and works. It still is. This runs it once for the owner and then
// once for each person the owner has approved, telling the database each
// time whose round it is (AP_ACT_AS). The database then shows that run that
// person's rows and nobody else's, so the job itself needs to know nothing
// about there being more than one person.
//
// The runner signs in as the owner, as it always has. Only the owner's
// login may name another person, and only an approved one has a workspace.
// Until the database has taken the workspace step, this runs the job once,
// for the owner, exactly as before.
//
// People are counted, never named: this log is public.

import { spawnSync } from "node:child_process";
// What this prints, and what every job it starts prints, goes through the
// nets in quiet.mjs. The job is started with them already in place, so a
// script that forgot to ask for them has them all the same.
import "./quiet.mjs";
const QUIET = new URL("./quiet.mjs", import.meta.url).href;

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const [script, ...args] = process.argv.slice(2);

/** Jobs that build the shared list of employers: run for the owner only. */
export const ONE_LIST = new Set(["resolve.mjs", "indexes.mjs", "crawl.mjs", "nearby.mjs", "feeds.mjs"]);

/** The line, turned so that it starts one place further on each hour. */
export function turnOrder(line, now) {
  if (line.length < 2) return [...line];
  const k = Math.floor(now / 3_600_000) % line.length;
  return [...line.slice(k), ...line.slice(0, k)];
}

/** Minutes each person gets of a job's time: an even part, and never under eight. */
export function shareOfTime(people, whole) {
  if (people <= 1) return whole;
  return Math.max(8, Math.min(whole, Math.floor((whole * 0.9) / people)));
}

/** Who to run for, after the owner: approved people whose workspace exists. */
export async function others(fetchImpl = fetch) {
  if (!SUPABASE_URL || !ANON_KEY || !process.env.APPLYPILOT_EMAIL || !process.env.APPLYPILOT_PASSWORD) return [];
  try {
    const sign = await fetchImpl(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email: process.env.APPLYPILOT_EMAIL, password: process.env.APPLYPILOT_PASSWORD }),
    });
    if (!sign.ok) return [];
    const headers = { apikey: ANON_KEY, Authorization: `Bearer ${(await sign.json()).access_token}`, "Content-Type": "application/json" };
    const ready = await fetchImpl(`${SUPABASE_URL}/rest/v1/rpc/workspaces_ready`, { method: "POST", headers, body: "{}" });
    if (!ready.ok || (await ready.json()) !== true) return [];
    const list = await fetchImpl(`${SUPABASE_URL}/rest/v1/members?status=eq.approved&select=user_id&order=created_at.asc&limit=100`, { headers });
    if (!list.ok) return [];
    const out = [];
    for (const m of await list.json()) {
      const id = String(m?.user_id ?? "");
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) continue;
      // Only someone who has come in at least once has a workspace to work in.
      const has = await fetchImpl(`${SUPABASE_URL}/rest/v1/profile?select=id&limit=1`, { headers: { ...headers, "x-act-as": id } });
      if (has.ok && (await has.json()).length) out.push(id);
    }
    return out;
  } catch {
    return [];
  }
}

if (process.env.FORUSERS_IMPORT_ONLY !== "1") {
  if (!script || !/^[a-z-]+\.mjs$/.test(script)) {
    console.error("usage: node forusers.mjs <script.mjs>");
    process.exit(2);
  }
  // Finding employers and working out which hiring system each is on fills
  // one list that everybody reads. It is done once, not once per person.
  const line = ONE_LIST.has(script) ? [] : await others();
  // Whoever was last in the line an hour ago is first after the owner now.
  // In a fixed order the same people would always be reached last, and on a
  // day with full queues not reached at all.
  const rest = turnOrder(line, Date.now());
  // The time one job has, shared out. Applying is the one script that can
  // fill hours; with a line of people each gets an even part of the job's
  // time, the owner included, so that nobody's full queue is the reason
  // somebody else's is not touched.
  const share = shareOfTime(rest.length + 1, Number(process.env.RUN_BUDGET_MIN || 300));
  const run = (actAs) => {
    const env = { ...process.env };
    if (actAs) env.AP_ACT_AS = actAs;
    else delete env.AP_ACT_AS;
    if (script === "apply.mjs" && rest.length) env.RUN_BUDGET_MIN = String(share);
    return spawnSync(process.execPath, ["--import", QUIET, script, ...args], { stdio: "inherit", env }).status ?? 1;
  };

  // The owner's round first, as it has always run.
  const first = run(null);
  let failed = 0;
  for (let i = 0; i < rest.length; i++) {
    console.log(`\n==== person ${i + 2} of ${rest.length + 1} ====`);
    if (run(rest[i]) !== 0) failed++;
  }
  if (rest.length) console.log(`\n${rest.length + 1} people's rounds done; ${failed + (first !== 0 ? 1 : 0)} ended in an error.`);
  process.exit(first !== 0 ? first : failed ? 1 : 0);
}
