// How the database is put together, and whether every row has an owner.
//
// Run after the first workspace step is applied. It asks the database for
// its own description — tables, the "only one" rules, who may read what,
// views and functions — and checks that nothing was left without a user_id.
// The second step is written against this, not against a guess.
//
// Structure only: no row of anybody's data is read or printed, and anything
// that looks like an address or an id is struck out before printing.

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
// Whose round this is, when the runner is doing somebody else's: see forusers.mjs.
const ACT_AS = process.env.AP_ACT_AS ? { "x-act-as": process.env.AP_ACT_AS } : {};
const AP_EMAIL = process.env.APPLYPILOT_EMAIL;
const AP_PASSWORD = process.env.APPLYPILOT_PASSWORD;

export const TENANT_TABLES = ["agent", "answers", "call_keys", "companies", "company_candidates", "email_sync", "emails", "experience", "google_tokens", "jobs", "outreach", "profile", "runs", "search_config", "site_accounts"];

/** Nothing that names a person or a login leaves in a printed definition. */
export function hush(text) {
  return String(text ?? "")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[an address]")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "[an id]");
}

if (process.env.TENANCY_IMPORT_ONLY !== "1") {
  const sign = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON_KEY, ...ACT_AS, "Content-Type": "application/json" },
    body: JSON.stringify({ email: AP_EMAIL, password: AP_PASSWORD }),
  });
  if (!sign.ok) throw new Error(`Sign-in failed ${sign.status}`);
  const ACCESS = (await sign.json()).access_token;
  const headers = { apikey: ANON_KEY, ...ACT_AS, Authorization: `Bearer ${ACCESS}`, "Content-Type": "application/json" };

  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/schema_report`, { method: "POST", headers, body: "{}" });
  if (!res.ok) {
    console.log(`the first workspace step is not applied yet (the database answered ${res.status}); nothing to report.`);
    process.exit(0);
  }
  const r = await res.json();
  const say = (title, lines) => {
    console.log(`\n== ${title} (${lines.length})`);
    for (const l of lines) console.log(hush(l));
  };
  say("tables", Object.entries(r.tables ?? {}).sort().map(([t, v]) => `${t} [rls ${v.rls ? "on" : "OFF"}; ~${v.rows ?? "?"} rows; ${v.no_user === 0 ? "has user_id" : "no user_id"}]: ${(v.columns ?? []).join(", ")}`));
  say("only-one rules and keys", (r.indexes ?? []).slice().sort());
  say("other rules", (r.constraints ?? []).slice().sort());
  say("who may read what", (r.policies ?? []).slice().sort());
  say("views", Object.entries(r.views ?? {}).map(([n, v]) => `${n} ${JSON.stringify(v.options ?? [])}: ${String(v.def).replace(/\s+/g, " ")}`));
  say("functions", Object.entries(r.functions ?? {}).map(([n, v]) => `${n} [${v.definer ? "DEFINER" : "invoker"}]: ${String(v.def).replace(/\s+/g, " ")}`));
  say("triggers", r.triggers ?? []);
  say("file stores", (r.buckets ?? []).map((b) => `${b.id} ${b.public ? "PUBLIC" : "private"}`));
  say("live-updating tables", r.realtime ?? []);

  // Every row has an owner.
  const left = {};
  for (const t of TENANT_TABLES) {
    const q = await fetch(`${SUPABASE_URL}/rest/v1/${t}?user_id=is.null&select=user_id&limit=1`, { headers });
    left[t] = q.ok ? ((await q.json()).length ? "ROWS WITHOUT AN OWNER" : "ok") : `not readable (${q.status})`;
  }
  console.log(`\n== every row has an owner: ${JSON.stringify(left)}`);

  // What somebody with no login at all can read. Only how many rows come
  // back is looked at; none of it is printed.
  const open = {};
  for (const t of ["v_inbox", "v_stats", "v_email_stats", "v_apply_queue", "v_candidate_stats", "jobs", "profile", "emails", "google_tokens", "site_accounts", "members", "user_keys"]) {
    const q = await fetch(`${SUPABASE_URL}/rest/v1/${t}?select=*&limit=3`, { headers: { apikey: ANON_KEY } });
    const rows = q.ok ? await q.json().catch(() => []) : null;
    // A counting view always answers with one row; it is open only if the count in it is not nothing.
    const counts = rows?.length === 1 && Object.values(rows[0]).every((v) => typeof v === "number" || v === null);
    open[t] = rows === null ? `closed (${q.status})` : !rows.length ? "closed (no rows)" : counts ? (Object.values(rows[0]).some((v) => Number(v) > 0) ? "OPEN: counts readable" : "closed (counts of nothing)") : "OPEN: ROWS READABLE WITHOUT A LOGIN";
  }
  console.log(`\n== readable with no login: ${JSON.stringify(open)}`);

  const ready = await fetch(`${SUPABASE_URL}/rest/v1/rpc/workspaces_ready`, { method: "POST", headers, body: "{}" });
  console.log(`\n== second workspace step applied: ${ready.ok ? "yes" : "not yet"}`);
}
