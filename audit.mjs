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
import { jobKey } from "./samejob.mjs";
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
const count = (list, of) => { const o = {}; for (const x of list) { const k = of(x) ?? "none"; o[k] = (o[k] ?? 0) + 1; } return o; };
const shape = (t) => String(t ?? "").toLowerCase().replace(/\d+/g, "N").replace(/[^a-z n]+/g, " ").split(/\s+/).filter(Boolean).slice(0, 6).join(" ");

async function main() {
  await signIn();

  const sent = await db("jobs?status=in.(applied,interview,offer,rejected)&select=id,status,ats,company,title,location,url,score,posted_at,applied_at,confirm_state,ats_match,tailored_resume&limit=3000");
  for (const j of sent) { j.has_tailored = Boolean(j.tailored_resume); delete j.tailored_resume; }
  console.log(`on record as sent: ${sent.length}; by status ${JSON.stringify(count(sent, (j) => j.status))}`);
  console.log(`  receipt in the mailbox: ${JSON.stringify(count(sent, (j) => j.confirm_state ?? "none on record"))}`);
  console.log(`  receipt, by system: ${JSON.stringify(Object.fromEntries(Object.entries(count(sent, (j) => j.ats ?? "own site")).map(([k, n]) => [k, `${sent.filter((j) => (j.ats ?? "own site") === k && j.confirm_state === "confirmed").length} of ${n}`])))}`);

  // The same job sent twice: same role, employer and place.
  const groups = {};
  for (const j of sent) { const k = jobKey(j); if (k) (groups[k] ??= []).push(j); }
  const twice = Object.values(groups).filter((g) => g.length > 1);
  console.log(`  sent more than once to the same role, employer and place: ${twice.length} group(s), ${twice.reduce((n, g) => n + g.length - 1, 0)} extra application(s)`);

  const mail = await db("emails?direction=eq.in&select=category,subject,job_id,from_addr&order=received_at.desc&limit=2000");
  console.log(`employer mail read: ${mail.length}; called ${JSON.stringify(count(mail, (m) => m.category))}`);
  for (const cat of ["interview", "offer", "action_needed"]) {
    const of = mail.filter((m) => m.category === cat);
    const top = Object.entries(count(of, (m) => shape(m.subject))).sort((a, b) => b[1] - a[1]).slice(0, 12);
    console.log(`  called ${cat} (${of.length}), by how the subject begins: ${JSON.stringify(top)}`);
  }
  const byJob = (cat) => new Set(mail.filter((m) => m.category === cat && m.job_id).map((m) => m.job_id));
  const said = byJob("interview");
  const marked = sent.filter((j) => j.status === "interview");
  console.log(`  jobs marked interview: ${marked.length}; of those with mail called an interview attached: ${marked.filter((j) => said.has(j.id)).length}`);
  for (const line of outcomeLines(outcomes(sent))) console.log(line);
}

main().catch((e) => { console.error(`audit failed: ${String(e?.message ?? e).slice(0, 200)}`); process.exit(1); });
