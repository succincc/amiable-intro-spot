/**
 * The applications on record, held against the evidence for each.
 *
 * "Sent" in this system means the applier saw the portal accept the form.
 * That is the applier's word. The evidence is elsewhere: a receipt in the
 * mailbox (confirm_state), a reply from the employer, and the absence of a
 * second application to the same job. This puts the two side by side, for
 * each person, and prints only counts and shapes.
 *
 * Run for each person by forusers.mjs, as crumbs.mjs is.
 */
import { guardLogs } from "./quiet.mjs";
import { evidence } from "./evidence.mjs";
import { outcomes, outcomeLines } from "./outcomes.mjs";
guardLogs();

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const ACT_AS = process.env.AP_ACT_AS ? { "x-act-as": process.env.AP_ACT_AS } : {};

let ACCESS = "";
async function signIn() {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON_KEY, ...ACT_AS, "Content-Type": "application/json" },
    body: JSON.stringify({ email: process.env.APPLYPILOT_EMAIL, password: process.env.APPLYPILOT_PASSWORD }),
  });
  if (!res.ok) throw new Error(`Sign-in failed ${res.status}`);
  ACCESS = (await res.json()).access_token;
}
async function db(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: ANON_KEY, ...ACT_AS, Authorization: `Bearer ${ACCESS}`, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`DB ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
async function main() {
  await signIn();

  const sent = await db("jobs?status=in.(applied,interview,offer,rejected)&select=id,status,ats,company,title,location,url,score,posted_at,applied_at,confirm_state,ats_match,tailored_resume,source&limit=3000");
  for (const j of sent) { j.has_tailored = Boolean(j.tailored_resume); delete j.tailored_resume; }
  const tried = (await db("jobs?status=in.(needs_help,failed)&select=ats,status,help_reason&limit=5000").catch(() => [])) ?? [];
  // The finer kind is a newer column; without it the subject stands in.
  let mail = await db("emails?direction=eq.in&select=category,kind,subject,job_id,from_addr,received_at&order=received_at.desc&limit=3000").catch(() => null);
  if (!mail) mail = await db("emails?direction=eq.in&select=category,subject,job_id,from_addr,received_at&order=received_at.desc&limit=3000");

  const { digest, lines, failures, corrected } = evidence(sent, mail, tried);
  // What came back first, the evidence last: the end of the log is what is read.
  if (sent.length >= 20) for (const line of outcomeLines(outcomes(corrected))) console.log(line);
  for (const l of lines) console.log(l);
  // Sent against the person's own bar for sending without being asked.
  const [cfg] = (await db("search_config?select=auto_apply_score,review_score&limit=1").catch(() => [])) ?? [];
  if (cfg?.auto_apply_score != null) {
    // Between the two bars is the band held for a yes. The owner's
    // standing order (26 Nov) sends that band unasked, so those are as
    // ordered. Under the lower bar nothing should ever go.
    const band = sent.filter((j) => j.score != null && j.score < cfg.auto_apply_score && j.score >= (cfg.review_score ?? 0));
    const below = sent.filter((j) => j.score != null && cfg.review_score != null && j.score < cfg.review_score);
    console.log(`the bar for sending unasked is ${cfg.auto_apply_score}, for holding to review ${cfg.review_score}; sent from the held band: ${band.length} of ${sent.length}${process.env.AP_ACT_AS ? "" : " (the owner's standing order sends it)"}; sent from under both: ${below.length}`);
    if (below.length) { console.log(`WRONG: ${below.length} job(s) sent that were rated under the bar for even a look`); process.exitCode = 1; }
    if (band.length && process.env.AP_ACT_AS) {
      const fresh = band.filter((j) => Date.now() - new Date(j.applied_at ?? 0).getTime() < 24 * 3_600_000).length;
      // Their own press of "queue" sends one too, so this is said, not failed.
      if (fresh) console.log(`  ${fresh} of those in the last day: by this person's own yes, or something to look into`);
    }
  }
  // One line that says it all, for whoever reads only the end.
  console.log(`DIGEST ${process.env.AP_ACT_AS ? "another person" : "owner"}: ${JSON.stringify(digest)}`);
  if (failures.length) {
    for (const f of failures) console.log(`WRONG: ${f}`);
    process.exitCode = 1;
  } else console.log("nothing on record contradicts its evidence");
}

main().catch((e) => { console.error(`audit failed: ${String(e?.message ?? e).slice(0, 200)}`); process.exit(1); });
