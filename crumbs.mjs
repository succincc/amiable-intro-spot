// Where each person's last discovery rounds got to.
//
// A round the host ends leaves no error behind: the caller sees a bare 502
// and nothing says what the round was doing. Each round now writes down the
// step it is on before it takes it, and this reads those notes back — for a
// round that never finished, the employers it was reading when it stopped,
// by their system and the size of their last list. No names are printed.

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
  const step = /^(reading|judging|measuring)\b/.test(msg) ? msg.slice(0, 200) : `(${msg.length} letters of message)`;
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
process.exit(0);
