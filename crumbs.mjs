// Where each person's last discovery rounds got to.
//
// A round the host ends leaves no error behind: the caller sees a bare 502
// and nothing says what the round was doing. Each round now writes down the
// step it is on before it takes it, and this reads those notes back — for a
// round that never finished, the employers it was reading when it stopped,
// by their system and the size of their last list. No names are printed.

import { guardLogs, hideNames } from "./quiet.mjs";
guardLogs();

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const ACT_AS = process.env.AP_ACT_AS ? { "x-act-as": process.env.AP_ACT_AS } : {};
const AP_EMAIL = process.env.APPLYPILOT_EMAIL;
const AP_PASSWORD = process.env.APPLYPILOT_PASSWORD;

let ACCESS = "";
async function signIn() {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON_KEY, ...ACT_AS, "Content-Type": "application/json" },
    body: JSON.stringify({ email: AP_EMAIL, password: AP_PASSWORD }),
  });
  if (!res.ok) throw new Error(`Sign-in failed ${res.status}`);
  ACCESS = (await res.json()).access_token;
}
async function db(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: ANON_KEY, ...ACT_AS, Authorization: `Bearer ${ACCESS}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`DB ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}


await signIn();
const runs = (await db("runs?kind=eq.discover&order=id.desc&limit=6&select=*").catch((e) => { console.log(`could not read the rounds: ${String(e.message).slice(0, 120)}`); return []; })) ?? [];
console.log(`${runs.length} recent discovery round(s)`);
for (const r of runs) {
  const began = r.started_at ?? r.created_at ?? null;
  const took = began && r.ended_at ? `${Math.round((Date.parse(r.ended_at) - Date.parse(began)) / 1000)}s` : "never finished";
  const msg = String(r.message ?? "");
  const step = /^(reading|judging|measuring|saving)\b/.test(msg) ? msg.slice(0, 200) : `(${msg.length} letters of message)`;
  console.log(`  ${r.status ?? "?"} | ${took} | found ${r.found ?? "?"} | ${step}`);
  if (r.status !== "done" && /^reading /.test(msg)) {
    const ids = [...msg.matchAll(/#(\d+)/g)].map((m) => m[1]);
    if (ids.length) {
      const cos = (await db(`companies?id=in.(${ids.join(",")})&select=id,ats,job_count,last_error,last_pulled`).catch(() => [])) ?? [];
      for (const c of cos) console.log(`      was reading ${c.ats}#${c.id}: last list ${c.job_count ?? "never read"}${c.last_error ? `; last error of ${String(c.last_error).length} letters` : ""}`);
    }
  }
}
const [cfg] = (await db("search_config?id=eq.1&select=titles,exclude_titles,sources,radius_miles").catch(() => [])) ?? [];
console.log(`search: ${(cfg?.titles ?? []).length} title(s), ${(cfg?.exclude_titles ?? []).length} excluded, sources ${JSON.stringify(cfg?.sources ?? [])}, radius ${cfg?.radius_miles ?? "none"}`);
const cos = (await db("companies?select=ats&limit=2000").catch(() => [])) ?? [];
const by = {}; for (const c of cos) by[c.ats] = (by[c.ats] ?? 0) + 1;
console.log(`employers by system: ${JSON.stringify(by)}`);
// Every hiring system, by what has become of its postings: how many were
// ever sent, how many are waiting, how many stopped for a person, and how
// many were set aside. Which systems have been proven end to end, and which
// have only ever been read.
{
  const by = {};
  for (let from = 0; from < 40000; from += 1000) {
    const rows = (await db(`jobs?select=ats,status,help_reason&order=id.asc&offset=${from}&limit=1000`).catch(() => [])) ?? [];
    for (const r of rows) {
      const a = (by[r.ats ?? "none"] ??= { sent: 0, unconfirmed: 0, ready: 0, need_you: 0, set_aside: 0, other: 0 });
      if (r.status === "applied" || r.status === "interview" || r.status === "offer" || r.status === "rejected") a.sent++;
      else if (r.help_reason === "unconfirmed") a.unconfirmed++;
      else if (r.status === "queued" || r.status === "review" || r.status === "new") a.ready++;
      else if (r.status === "needs_help") a.need_you++;
      else if (r.status === "skipped") a.set_aside++;
      else a.other++;
    }
    if (rows.length < 1000) break;
  }
  console.log("by hiring system, all time:");
  for (const [k, v] of Object.entries(by).sort((x, y) => y[1].sent - x[1].sent)) console.log(`  ${k}: ${JSON.stringify(v)}`);
  const stuck = (await db("jobs?status=eq.needs_help&select=ats,help_reason&limit=3000").catch(() => [])) ?? [];
  const why = {};
  for (const r of stuck) { const k = `${r.ats ?? "none"} / ${r.help_reason ?? "?"}`; why[k] = (why[k] ?? 0) + 1; }
  console.log(`stopped for a person, by system and reason: ${JSON.stringify(Object.fromEntries(Object.entries(why).sort((x, y) => y[1] - x[1]).slice(0, 24)))}`);
}
// What the applier wrote down on the ones it could not finish, by system:
// the first words of each note, with numbers evened out, most common first.
// Employers' names are taken out before anything is printed.
{
  const rows = (await db("jobs?status=eq.needs_help&help_reason=in.(error,no_form,incomplete,login)&select=ats,company,last_error&order=updated_at.desc&limit=400&ats=neq.smartrecruiters").catch(() => [])) ?? [];
  hideNames(rows.map((r) => r.company).filter(Boolean));
  // And the person's own details, should a note have quoted a form back.
  const [whose] = (await db("profile?id=eq.1&select=*").catch(() => [])) ?? [];
  if (whose) guardLogs(whose);
  const said = {};
  for (const r of rows) {
    // The part that names what stopped it, where the note has one.
    const whole = String(r.last_error ?? "");
    const named = whole.split(/Stopped before clicking:|refused to move past this screen over:/)[1];
    const note = String(named ? `stopped on: ${named}` : whole).replace(/[\w.+-]+@[\w.-]+/g, "[address]").replace(/\d+/g, "N").replace(/\s+/g, " ").trim().slice(0, 170);
    const k = `${r.ats ?? "none"} | ${note}`;
    said[k] = (said[k] ?? 0) + 1;
  }
  console.log("what was written on the ones not finished:");
  for (const [k, n] of Object.entries(said).sort((x, y) => y[1] - x[1]).slice(0, 34)) console.log(`  ${n} x ${k}`);
}
// The mailbox: when it was last read and what the last reading said, with
// anything that looks like an address taken out.
const plain = (t) => String(t ?? "").replace(/[\w.+-]+@[\w.-]+/g, "[address]").replace(/\s+/g, " ").slice(0, 160);
const [mail] = (await db("email_sync?id=eq.1&select=*").catch(() => [])) ?? [];
if (mail) {
  const age = mail.last_run_at ? Math.round((Date.now() - Date.parse(mail.last_run_at)) / 60000) : null;
  console.log(`mailbox: last read ${age === null ? "never" : `${age} min ago`}; fields ${Object.keys(mail).filter((k) => k !== "user_id").join(",")}; last status: ${plain(mail.last_status ?? "none")}; last error: ${mail.last_error ? plain(mail.last_error) : "none"}`);
} else console.log("mailbox: no record of a reading");
const [tok] = (await db("google_tokens?id=eq.1&select=connected_at,updated_at").catch(() => [])) ?? [];
console.log(`gmail: ${tok ? `connected ${tok.connected_at ? Math.round((Date.now() - Date.parse(tok.connected_at)) / 3600000) + "h ago" : "at an unrecorded time"}` : "no connection on file"}`);
const beats = (await db("heartbeat?select=name,at").catch(() => [])) ?? [];
console.log(`turns last taken (min ago): ${JSON.stringify(Object.fromEntries(beats.map((b) => [b.name, Math.round((Date.now() - Date.parse(b.at)) / 60000)])))}`);
if (!process.env.AP_ACT_AS) {
  try {
    const res = await fetch("https://applynow.lol/api/public/cron/tick", { method: "POST", signal: AbortSignal.timeout(60_000) });
    console.log(`tick: HTTP ${res.status} ${plain(await res.text())}`);
  } catch (e) { console.log(`tick: ${plain(e?.message ?? e)}`); }
}
process.exit(0);
