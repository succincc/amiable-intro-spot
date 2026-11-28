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
import { allRows } from "./pages.mjs";
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
const count = (list, of) => { const o = {}; for (const x of list) { const k = of(x) ?? "none"; o[k] = (o[k] ?? 0) + 1; } return o; };

async function main() {
  await signIn();

  // Every one, a thousand at a time (pages.mjs): the record is not right if it stops at the first thousand.
  const sent = await allRows(db, "jobs?status=in.(applied,interview,offer,rejected)&select=id,status,ats,company,title,location,url,score,posted_at,applied_at,confirm_state,ats_match,tailored_resume,source");
  for (const j of sent) { j.has_tailored = Boolean(j.tailored_resume); delete j.tailored_resume; }
  const tried = await allRows(db, "jobs?status=in.(needs_help,failed)&select=ats,status,help_reason").catch(() => []);
  // The finer kind is a newer column; without it the subject stands in.
  let mail = await allRows(db, "emails?direction=eq.in&select=category,kind,subject,job_id,from_addr,received_at&order=received_at.desc", 20000).catch(() => null);
  if (!mail) mail = await allRows(db, "emails?direction=eq.in&select=category,subject,job_id,from_addr,received_at&order=received_at.desc", 20000);
  console.log(`letters from employers and boards read for this: ${mail.length}`);

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
  // What discovery brought in over the last seven days, by where it was
  // found: postings, employers, and what became of them.
  try {
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const found = [];
    for (let from = 0; from < 20000; from += 1000) {
      const rows = await db(`jobs?found_at=gte.${encodeURIComponent(since)}&select=source,company,status,skip_reason&order=id.asc&offset=${from}&limit=1000`);
      found.push(...rows);
      if (rows.length < 1000) break;
    }
    const by = {};
    for (const j of found) (by[String(j.source ?? "not recorded").toLowerCase().slice(0, 22)] ??= []).push(j);
    const eligible = (j) => ["queued", "applying", "applied", "interview", "offer", "rejected", "review", "needs_help"].includes(j.status);
    const same = (j) => /already applied|same role|duplicate/i.test(String(j.skip_reason ?? ""));
    console.log(`discovery, last 7 days: ${found.length} posting(s) from ${new Set(found.map((j) => String(j.company ?? "").toLowerCase())).size} employer(s); by status ${JSON.stringify(count(found, (j) => j.status))}`);
    console.log(`  by source (postings / employers / taken forward / set aside as the same job / set aside otherwise):`);
    for (const [k, list] of Object.entries(by).sort((a, b) => b[1].length - a[1].length).slice(0, 14)) {
      console.log(`    ${k}: ${list.length} / ${new Set(list.map((j) => String(j.company ?? "").toLowerCase())).size} / ${list.filter(eligible).length} / ${list.filter(same).length} / ${list.filter((j) => j.status === "skipped" && !same(j)).length}`);
    }
    // Why the ones set aside were set aside, in the engine's own reasons
    // with any number or name in them taken out.
    const reason = (j) => String(j.skip_reason ?? "no reason recorded").toLowerCase().replace(/\d+(\.\d+)?/g, "N").replace(/"[^"]*"/g, '"…"')
      // No place in what is printed: a reason that names the person's state, or a posting's town, says where they live.
      .replace(/^outside the us\b.*$/, "outside the United States").replace(/^outside [a-z ]{2,20}:.*$/, "outside the person's own state").replace(/^no state given.*$/, "no state given").replace(/^[a-z]{2} is far beyond/, "a state far beyond").slice(0, 60);
    const aside = found.filter((j) => j.status === "skipped");
    console.log(`discovery, set aside (${aside.length}): ${JSON.stringify(Object.fromEntries(Object.entries(count(aside, reason)).sort((a, b) => b[1] - a[1]).slice(0, 8)))}`);
    // The largest source on its own, and whether the same-state rule is still at work.
    const big = Object.entries(by).sort((a, b) => b[1].length - a[1].length)[0];
    if (big) console.log(`discovery, ${big[0]} alone, set aside (${big[1].filter((j) => j.status === "skipped").length} of ${big[1].length}): ${JSON.stringify(Object.fromEntries(Object.entries(count(big[1].filter((j) => j.status === "skipped"), reason)).sort((a, b) => b[1] - a[1]).slice(0, 5)))}`);
    try {
      const [sc] = (await db("search_config?select=same_state_only,include_unknown_location,radius_miles&limit=1")) ?? [];
      const day = new Date(Date.now() - 86_400_000).toISOString();
      // The state rule's own two reasons, and not "outside the US", which is a different rule.
      const stateRule = (j) => { const r = String(j.skip_reason ?? ""); return (/^outside [a-z ]{2,20}:/i.test(r) && !/^outside the us\b/i.test(r)) || /^no state given/i.test(r); };
      const recent = (await db(`jobs?status=eq.skipped&or=(skip_reason.like.outside*,skip_reason.like.no%20state%20given*)&updated_at=gte.${encodeURIComponent(day)}&select=skip_reason&limit=2000`).catch(() => [])).filter(stateRule);
      console.log(`discovery, the same-state rule: switched ${sc?.same_state_only === true ? "ON" : "off"}; postings it set aside in seven days ${found.filter(stateRule).length}, of those set aside in the last day ${recent.length}; postings with no placeable location are ${sc?.include_unknown_location === false ? "held back" : "let through"}`);
    } catch { /* said nothing rather than something wrong */ }
    console.log(`discovery, still waiting to be rated or held: ${found.filter((j) => j.status === "new").length} new, ${found.filter((j) => j.status === "review").length} held for a yes`);
    digest.discovered7d = found.length;
    digest.takenForward7d = found.filter(eligible).length;
  } catch (e) {
    console.log(`discovery could not be read: ${String(e?.message ?? e).slice(0, 80)}`);
  }

  // Which parts of the engine ran in ordinary rounds. Each lane of each
  // round writes down what it reached (apply.mjs); this adds seven days of
  // that up, and sets it against the things the upgrade work named. A part
  // with nothing against it exists in the code and did not run.
  try {
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const runs = await allRows(db, `runs?kind=eq.apply&started_at=gte.${encodeURIComponent(since)}&select=detail,started_at&order=started_at.desc`, 4000);
    const parts = {};
    let rounds = 0, lanes = 0, withLocal = 0, sent = 0, tried = 0;
    for (const r of runs) {
      const L = r.detail?.lanes;
      if (!L || typeof L !== "object") continue;
      rounds++;
      for (const [who, v] of Object.entries(L)) {
        if ((process.env.AP_ACT_AS ? "other" : "owner") !== who.split(":")[0]) continue;
        lanes++;
        if (v?.local_model) withLocal++;
        sent += Number(v?.sent) || 0;
        tried += Number(v?.tried) || 0;
        for (const [k, n] of Object.entries(v?.parts ?? {})) parts[k] = (parts[k] ?? 0) + (Number(n) || 0);
      }
    }
    if (!rounds) console.log("engine parts reached in ordinary rounds: no round has written its record yet (it is kept from 28 Nov on)");
    else {
      console.log(`engine parts reached in ordinary rounds, 7 days (${rounds} round(s), ${lanes} lane run(s), ${sent} sent of ${tried} tried): ${JSON.stringify(Object.fromEntries(Object.entries(parts).sort((a, b) => b[1] - a[1])))}`);
      const NAMED = {
        "workflow memory": ["answer kept from before, used again", "portal sign-in kept from before, used again", "written answer kept for next time", "list pick kept for next time"],
        "form handling": ["answer recognised under another spelling", "emailed code asked for", "emailed code read", "model asked to pick from a list"],
        "resume against the posting": ["requirements report kept", "resume put in the posting's own wording", "qualification the person confirmed beyond the resume"],
        "matching by meaning": ["answer recognised under another spelling", "same job under another address set aside"],
        "writing refinement": ["resume wording tidied", "resume writing and claims checked before sending"],
        "the queue kept between rounds": ["stops put back in the queue"],
      };
      const said = Object.entries(NAMED).map(([name, keys]) => `${name} ${keys.reduce((t, k) => t + (parts[k] ?? 0), 0)}`);
      console.log(`  by what the upgrade work named (times reached): ${said.join("; ")}; a model on the runner itself ${withLocal} of ${lanes} lane run(s)${withLocal ? "" : " (none is set up: that part has not run)"}; what came back from employers: counted by this audit, above`);
      digest.engineRounds7d = rounds;
    }
  } catch (e) {
    console.log(`engine parts could not be read: ${String(e?.message ?? e).slice(0, 80)}`);
  }

  // One line that says it all, for whoever reads only the end.
  console.log(`DIGEST ${process.env.AP_ACT_AS ? "another person" : "owner"}: ${JSON.stringify(digest)}`);
  if (failures.length) {
    for (const f of failures) console.log(`WRONG: ${f}`);
    process.exitCode = 1;
  } else console.log("nothing on record contradicts its evidence");
}

main().catch((e) => { console.error(`audit failed: ${String(e?.message ?? e).slice(0, 200)}`); process.exit(1); });
