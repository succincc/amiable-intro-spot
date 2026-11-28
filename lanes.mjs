/**
 * Which lanes of a round have anything to do.
 *
 * A round starts fourteen lanes. Measured over two live rounds, seven of
 * them found nothing queued and ended in five seconds, each after half a
 * minute of setting a machine up. This reads, for each person, which kinds
 * of portal have work waiting, and adds them to a file; the workflow then
 * starts only those lanes.
 *
 * It errs towards starting a lane. "Work waiting" is anything queued, in
 * hand, held for review (the leading lane may send that band), or stopped
 * for a reason the round itself puts back in the queue. The leading lane
 * always runs: it does what is done once a round. And if this cannot read
 * the record for any reason, every lane runs, as before.
 *
 * Run for each person by forusers.mjs. Prints counts only.
 */
// Everything printed here goes through the nets in quiet.mjs: this log is public.
import "./quiet.mjs";
import fs from "node:fs";

export const ALL = ["workday@0of3", "workday@1of3", "workday@2of3", "greenhouse@0of2", "greenhouse@1of2", "oracle", "successfactors", "ashby", "lever", "linkedin", "indeed", "ziprecruiter", "other", "none"];
const NAMED = ["workday", "greenhouse", "oracle", "successfactors", "ashby", "lever", "linkedin", "indeed", "ziprecruiter"];
export const LEADER = "workday@0of3";

/** The lane a portal's jobs fall to, as apply.mjs reads them. */
export const laneOf = (ats) => (ats == null || ats === "" ? "none" : NAMED.includes(String(ats)) ? String(ats) : "other");

/** The lanes to start, given the kinds of lane with work. Anything unsure starts everything. */
export function lanesFor(kinds, sure = true) {
  if (!sure) return ALL;
  const has = new Set(kinds);
  return ALL.filter((l) => l === LEADER || has.has(l.split("@")[0]));
}

async function main() {
  const out = process.env.LANES_FILE;
  const SUPABASE_URL = process.env.SUPABASE_URL, ANON_KEY = process.env.SUPABASE_ANON_KEY;
  const ACT_AS = process.env.AP_ACT_AS ? { "x-act-as": process.env.AP_ACT_AS } : {};
  try {
    const sign = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST", headers: { apikey: ANON_KEY, ...ACT_AS, "Content-Type": "application/json" },
      body: JSON.stringify({ email: process.env.APPLYPILOT_EMAIL, password: process.env.APPLYPILOT_PASSWORD }),
    });
    if (!sign.ok) throw new Error(`sign-in ${sign.status}`);
    const headers = { apikey: ANON_KEY, ...ACT_AS, Authorization: `Bearer ${(await sign.json()).access_token}` };
    const kinds = new Set();
    let seen = 0;
    for (const filter of ["status=in.(queued,applying,review)", "status=eq.needs_help&help_reason=in.(dry_run,incomplete,email_verification,registered)"]) {
      for (let from = 0; from < 20000; from += 1000) {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/jobs?${filter}&select=ats&order=id.asc&offset=${from}&limit=1000`, { headers });
        if (!res.ok) throw new Error(`jobs ${res.status}`);
        const rows = await res.json();
        for (const r of rows) kinds.add(laneOf(r.ats));
        seen += rows.length;
        if (rows.length < 1000) break;
      }
    }
    console.log(`lanes with work for this person: ${[...kinds].sort().join(", ") || "none"} (${seen} posting(s) waiting)`);
    if (out) fs.appendFileSync(out, [...kinds].map((k) => `${k}\n`).join("") + "ok\n");
  } catch (e) {
    console.log(`lanes could not be read (${String(e?.message ?? e).slice(0, 60)}): every lane will start`);
    if (out) fs.appendFileSync(out, "unsure\n");
    process.exitCode = 0;
  }
}

if (process.argv[1]?.endsWith("lanes.mjs")) {
  if (process.argv[2] === "matrix") {
    // The file the rounds above wrote, turned into the list of lanes to start.
    let lines = [];
    try { lines = fs.readFileSync(process.env.LANES_FILE, "utf8").split("\n").map((l) => l.trim()).filter(Boolean); } catch { /* no file: unsure */ }
    const sure = lines.includes("ok") && !lines.includes("unsure");
    const lanes = lanesFor(lines.filter((l) => l !== "ok" && l !== "unsure"), sure);
    console.log(JSON.stringify(lanes));
  } else {
    main();
  }
}
