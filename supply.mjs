/**
 * Where the jobs worth applying to come from, as counts.
 *
 * Postings collected is the wrong thing to count: most of what is collected
 * is three states away or for a trade the person does not practise. This
 * counts what survived — in reach or remote and open to them, for one of
 * their titles, fresh, over their bar — and says which source and which kind
 * of employer it came from, how old it was when it was found, and where the
 * employers nearby stand: on file, placed on a hiring system, being read.
 *
 * Report only. Nothing is written, and nothing is printed but counts and the
 * names of this system's own sources and rules.
 */
import { guardLogs } from "./quiet.mjs";
import { employerKey } from "./samejob.mjs";
import { isBlocked } from "./blocked.mjs";
guardLogs();

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const ACT_AS = process.env.AP_ACT_AS ? { "x-act-as": process.env.AP_ACT_AS } : {};

const count = (list, of) => { const o = {}; for (const x of list) { const k = of(x) ?? "none"; o[k] = (o[k] ?? 0) + 1; } return o; };
const top = (o, n = 10) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n));
const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : "-");
const median = (xs) => { const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const hours = (a, b) => (a && b ? (new Date(b).getTime() - new Date(a).getTime()) / 3_600_000 : NaN);

// A posting that was taken forward: rated over the bar and put in front of
// the applier or the person. What became of it afterwards is another matter.
export const TAKEN = new Set(["queued", "applying", "applied", "interview", "offer", "rejected", "review", "needs_help", "dry_run"]);
export const SENT = new Set(["applied", "interview", "offer", "rejected"]);

/**
 * Why a posting was set aside, as one of this system's own rules. The reason
 * on record may carry a number, a state or a town; the family carries none.
 */
export function family(reason) {
  const r = String(reason ?? "").toLowerCase();
  if (!r) return "no reason recorded";
  if (/blocked by the owner/.test(r)) return "employer blocked";
  if (/already applied|same role|duplicate|same job/.test(r)) return "the same job as one on record";
  if (/mi away|beyond the \d+ mi|far beyond/.test(r)) return "too far";
  if (/^outside the (us|united states)/.test(r)) return "outside the country";
  if (/only for residents/.test(r)) return "remote, residents of other states only";
  if (/^outside |^no state given/.test(r)) return "the same-state rule";
  if (/not placed yet|could not be placed/.test(r)) return "location not placed";
  if (/title not relevant|title excluded|excluded title|exclude/.test(r)) return "title";
  if (/older than|days ago|no posting date|stale/.test(r)) return "too old";
  if (/no longer|closed|taken down|talent community/.test(r)) return "posting gone";
  if (/salary|pay\b/.test(r)) return "pay";
  if (/score|rated|fit|bar\b|qualif|experience|seniority|level/.test(r)) return "rated under the bar";
  if (/part[- ]time|contract|intern|employment type|schedule/.test(r)) return "kind of employment";
  return "another rule";
}

/**
 * The funnel for a set of postings.
 * @param jobs   { source, company, status, skip_reason, distance_miles, remote, posted_at, found_at, applied_at }
 * @param radius miles
 */
export function funnel(jobs, radius) {
  const inReach = (j) => (j.remote === true && family(j.skip_reason) !== "remote, residents of other states only") || (Number.isFinite(Number(j.distance_miles)) && j.distance_miles != null && Number(j.distance_miles) <= radius);
  const taken = jobs.filter((j) => TAKEN.has(j.status));
  const sent = jobs.filter((j) => SENT.has(j.status));
  const waiting = jobs.filter((j) => j.status === "new");
  return {
    found: jobs.length,
    in_reach: jobs.filter(inReach).length,
    qualified: taken.length,
    sent: sent.length,
    not_rated_yet: waiting.length,
    age_when_found_h: median(taken.map((j) => hours(j.posted_at, j.found_at))),
  };
}

async function main() {
  const sign = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON_KEY, ...ACT_AS, "Content-Type": "application/json" },
    body: JSON.stringify({ email: process.env.APPLYPILOT_EMAIL, password: process.env.APPLYPILOT_PASSWORD }),
  });
  if (!sign.ok) throw new Error(`Sign-in failed ${sign.status}`);
  const ACCESS = (await sign.json()).access_token;
  const db = async (path) => {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: { apikey: ANON_KEY, ...ACT_AS, Authorization: `Bearer ${ACCESS}` } });
    if (!res.ok) throw new Error(`DB ${res.status}`);
    const text = await res.text();
    return text ? JSON.parse(text) : [];
  };
  const all = async (path, max = 40000) => {
    const out = [];
    for (let from = 0; from < max; from += 1000) {
      const rows = await db(`${path}&order=id.asc&offset=${from}&limit=1000`);
      out.push(...rows);
      if (rows.length < 1000) break;
    }
    return out;
  };

  const [cfg] = (await db("search_config?select=radius_miles&limit=1").catch(() => [])) ?? [];
  const radius = Number(cfg?.radius_miles) || 25;
  const who = process.env.AP_ACT_AS ? "another person" : "owner";
  const digest = {};

  // 1. The employers on file.
  try {
    const cands = await all("company_candidates?select=id,name,status,ats,note,checked_at,created_at");
    const origin = (c) => { const n = String(c.note ?? ""); return /^map:/.test(n) ? "the map" : /^crawl:/.test(n) ? "the web archive" : c.status === "pending" && !n ? "a list or a feed" : null; };
    const pending = cands.filter((c) => c.status === "pending");
    const week = Date.now() - 7 * 86_400_000;
    console.log(`employers on file to be placed on a hiring system: ${cands.length}; by standing ${JSON.stringify(count(cands, (c) => c.status))}; added in 7 days ${cands.filter((c) => new Date(c.created_at ?? 0).getTime() > week).length}; looked at in 7 days ${cands.filter((c) => new Date(c.checked_at ?? 0).getTime() > week).length}`);
    console.log(`  still waiting to be looked at: ${pending.length}; of those, by where they came from ${JSON.stringify(count(pending, (c) => origin(c) ?? "other"))}; never looked at ${pending.filter((c) => !c.checked_at).length}`);
    console.log(`  placed on a system: ${JSON.stringify(top(count(cands.filter((c) => c.status === "ok"), (c) => c.ats ?? (String(c.note ?? "").match(/runs on ([a-z0-9]+)/i) ?? [])[1]?.toLowerCase() ?? "its own site"), 16))}`);
    const failed = cands.filter((c) => c.status === "failed");
    const whyNot = (c) => { const n = String(c.note ?? ""); return /refused the visit/i.test(n) ? "site refused the visit" : /no application system recognised/i.test(n) ? "site read, no system recognised" : /did not finish loading/i.test(n) ? "site too slow" : /returned nothing/i.test(n) ? "board seen, list empty" : /does not look like/i.test(n) ? "board seen, not this employer's" : /runs on/i.test(n) ? "on a system with no reader" : n ? "another note" : "no note"; };
    console.log(`  not placed (${failed.length}): ${JSON.stringify(top(count(failed, whyNot)))}`);
    // How the visit was refused, and which systems nothing here reads: the
    // two lists a next piece of work would be chosen from.
    const refusal = (c) => { const n = String(c.note ?? ""); return (n.match(/HTTP (\d{3})/) ?? [])[1] ? `HTTP ${(n.match(/HTTP (\d{3})/) ?? [])[1]}` : (n.match(/ERR_[A-Z0-9_]+/) ?? [])[0] ?? (/timeout/i.test(n) ? "timeout" : "another way"); };
    console.log(`    refused, by how: ${JSON.stringify(top(count(failed.filter((c) => whyNot(c) === "site refused the visit"), refusal), 8))}`);
    const system = (c) => String((String(c.note ?? "").match(/runs on ([a-z0-9]+)/i) ?? [])[1] ?? "unnamed").toLowerCase().slice(0, 18);
    console.log(`    on a system with no reader, by system: ${JSON.stringify(top(count(failed.filter((c) => whyNot(c) === "on a system with no reader"), system), 14))}`);
    // The map's employers still carrying the map's note: how many places each has in reach.
    const mapped = cands.filter((c) => /^map:/.test(String(c.note ?? "")));
    console.log(`  from the map and not yet looked at: ${mapped.length}; with three or more places in reach ${mapped.filter((c) => Number((String(c.note).match(/(\d+) place/) ?? [])[1]) >= 3).length}`);
    Object.assign(digest, { employers_on_file: cands.length, waiting: pending.length, placed: cands.filter((c) => c.status === "ok").length, not_placed: failed.length });
  } catch (e) {
    console.log(`the employers on file could not be read: ${String(e?.message ?? e).slice(0, 60)}`);
  }

  // 2. The employers whose lists are read.
  let firms = [];
  try {
    firms = await all("companies?select=id,name,ats,enabled,job_count,last_pulled,last_error");
    const day = Date.now() - 86_400_000;
    const on = firms.filter((f) => f.enabled !== false);
    console.log(`employers whose own list is read: ${firms.length}, switched on ${on.length}; by system ${JSON.stringify(top(count(on, (f) => f.ats), 14))}`);
    console.log(`  read in the last day ${on.filter((f) => new Date(f.last_pulled ?? 0).getTime() > day).length}; never read ${on.filter((f) => !f.last_pulled).length}; last reading ended in an error ${on.filter((f) => f.last_error).length}; list empty at last reading ${on.filter((f) => f.last_pulled && !f.last_error && !Number(f.job_count)).length}`);
    Object.assign(digest, { employers_read: on.length });
  } catch (e) {
    console.log(`the employers being read could not be read: ${String(e?.message ?? e).slice(0, 60)}`);
  }

  // 3. Postings, thirty days of them, and the seven most recent apart.
  const since30 = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const jobs = (await all(`jobs?found_at=gte.${encodeURIComponent(since30)}&select=id,source,ats,company,url,status,skip_reason,help_reason,attempts,distance_miles,remote,posted_at,found_at,applied_at`)).filter((j) => !isBlocked(j));
  const week = Date.now() - 7 * 86_400_000;
  const recent = jobs.filter((j) => new Date(j.found_at ?? 0).getTime() > week);
  const src = (j) => String(j.source ?? j.ats ?? "not recorded").toLowerCase().replace(/[^a-z0-9_ -]/g, "").slice(0, 20) || "not recorded";

  // An employer is regional by evidence: it has posted at least one job
  // measured inside the radius. Nothing is assumed from its name or address.
  const near = new Set();
  const seen = new Set();
  for (const j of jobs) {
    const k = employerKey(j.company);
    if (!k) continue;
    seen.add(k);
    if (j.distance_miles != null && Number(j.distance_miles) <= radius) near.add(k);
  }
  console.log(`employers with a posting found in 30 days: ${seen.size}; with at least one measured inside ${radius} mi: ${near.size} (${pct(near.size, seen.size)})`);
  // Of the employers being read, how many have ever shown a job in reach.
  if (firms.length) {
    const on = firms.filter((f) => f.enabled !== false);
    const local = on.filter((f) => near.has(employerKey(f.name)));
    console.log(`  of the ${on.length} whose lists are read, ${local.length} showed a job in reach in 30 days; by system ${JSON.stringify(top(count(local, (f) => f.ats), 12))}`);
    digest.employers_read_with_jobs_in_reach = local.length;
  }

  for (const [label, set] of [["7 days", recent], ["30 days", jobs]]) {
    const f = funnel(set, radius);
    console.log(`postings, ${label}: found ${f.found}; in reach or remote ${f.in_reach}; qualified (taken forward) ${f.qualified} = ${pct(f.qualified, f.found)} of found; sent ${f.sent}; not rated yet ${f.not_rated_yet}; a qualified posting was ${f.age_when_found_h == null ? "of unknown age" : `${Math.round(f.age_when_found_h)}h old (median)`} when found`);
    if (label === "7 days") Object.assign(digest, { found_7d: f.found, in_reach_7d: f.in_reach, qualified_7d: f.qualified, sent_7d: f.sent });
    else Object.assign(digest, { qualified_30d: f.qualified });
  }
  console.log(`  by source, 7 days (found / in reach or remote / qualified / sent / employers with a qualified posting):`);
  const by = {};
  for (const j of recent) (by[src(j)] ??= []).push(j);
  for (const [k, list] of Object.entries(by).sort((a, b) => funnel(b[1], radius).qualified - funnel(a[1], radius).qualified || b[1].length - a[1].length).slice(0, 24)) {
    const f = funnel(list, radius);
    console.log(`    ${k}: ${f.found} / ${f.in_reach} / ${f.qualified} / ${f.sent} / ${new Set(list.filter((j) => TAKEN.has(j.status)).map((j) => employerKey(j.company))).size}`);
  }
  const aside = recent.filter((j) => j.status === "skipped");
  console.log(`  set aside in 7 days (${aside.length}), by rule: ${JSON.stringify(top(count(aside, (j) => family(j.skip_reason)), 14))}`);
  // What would have qualified but for place: the size of the prize in
  // finding more employers nearby instead of more postings anywhere.
  const far = aside.filter((j) => ["too far", "outside the country", "the same-state rule"].includes(family(j.skip_reason)));
  console.log(`  set aside for where it is: ${far.length} = ${pct(far.length, recent.length)} of everything found; qualified came from ${new Set(recent.filter((j) => TAKEN.has(j.status)).map((j) => employerKey(j.company))).size} employer(s)`);

  // Qualified and not sent: what found a job worth applying to and then
  // did not apply. Each stop is this system's own code for it.
  const stuck = recent.filter((j) => TAKEN.has(j.status) && !SENT.has(j.status));
  const stop = (j) => (j.status === "needs_help" ? String(j.help_reason ?? "no reason").replace(/[^a-z_]/gi, "").slice(0, 24) || "no reason" : j.status === "review" ? "held for a yes" : j.status === "queued" ? "waiting its turn" : j.status);
  console.log(`qualified and not sent, 7 days: ${stuck.length} of ${recent.filter((j) => TAKEN.has(j.status)).length}; by what stopped them ${JSON.stringify(top(count(stuck, stop), 14))}`);
  console.log(`  by source (not sent: stops, most frequent first):`);
  const stuckBy = {};
  for (const j of stuck) (stuckBy[src(j)] ??= []).push(j);
  for (const [k, list] of Object.entries(stuckBy).sort((a, b) => b[1].length - a[1].length).slice(0, 16)) {
    console.log(`    ${k}: ${list.length}: ${JSON.stringify(top(count(list, stop), 5))}`);
  }
  digest.qualified_not_sent_7d = stuck.length;

  // 4. Remote.
  const remote = recent.filter((j) => j.remote === true);
  console.log(`remote postings, 7 days: found ${remote.length}; qualified ${remote.filter((j) => TAKEN.has(j.status)).length}; sent ${remote.filter((j) => SENT.has(j.status)).length}; set aside ${JSON.stringify(top(count(remote.filter((j) => j.status === "skipped"), (j) => family(j.skip_reason)), 6))}`);
  digest.remote_qualified_7d = remote.filter((j) => TAKEN.has(j.status)).length;

  // 5. How new. A posting answered in its first days is read by someone.
  const q = recent.filter((j) => TAKEN.has(j.status));
  const ageBand = (j) => { const h = hours(j.posted_at, j.found_at); return !Number.isFinite(h) ? "no posting date" : h < 24 ? "under a day" : h < 72 ? "one to three days" : h < 168 ? "three to seven days" : "over a week"; };
  console.log(`qualified postings by age when found, 7 days: ${JSON.stringify(count(q, ageBand))}`);
  // The first reading of a new employer brings a month of postings at
  // once, which says nothing about how quickly a new one is noticed. So:
  // only employers already known more than a week before.
  const first = new Map();
  for (const j of jobs) { const k = employerKey(j.company); const t = new Date(j.found_at ?? 0).getTime(); if (k && (!first.has(k) || t < first.get(k))) first.set(k, t); }
  const steady = recent.filter((j) => (first.get(employerKey(j.company)) ?? Infinity) < week && Number.isFinite(hours(j.posted_at, j.found_at)));
  const lag = median(steady.map((j) => hours(j.posted_at, j.found_at)));
  console.log(`  from employers already being read a week before (${steady.length} posting(s)): ${lag == null ? "-" : `${Math.round(lag)}h`} old when found (median); found within a day of posting ${pct(steady.filter((j) => hours(j.posted_at, j.found_at) < 24).length, steady.length)}`);
  const sentNow = q.filter((j) => SENT.has(j.status) && j.applied_at);
  const wait = median(sentNow.map((j) => hours(j.found_at, j.applied_at)));
  const whole = median(sentNow.map((j) => hours(j.posted_at, j.applied_at)));
  console.log(`  sent ${sentNow.length} of them: ${wait == null ? "-" : `${Math.round(wait)}h`} from found to sent, ${whole == null ? "-" : `${Math.round(whole)}h`} from posted to sent (medians)`);
  Object.assign(digest, { found_to_sent_h: wait == null ? null : Math.round(wait) });

  console.log(`SUPPLY ${who}: ${JSON.stringify(digest)}`);
}

if (process.env.SUPPLY_IMPORT_ONLY !== "1") main().catch((e) => { console.error(`supply report failed: ${String(e?.message ?? e).slice(0, 120)}`); process.exit(1); });
