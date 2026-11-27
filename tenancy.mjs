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
    headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: AP_EMAIL, password: AP_PASSWORD }),
  });
  if (!sign.ok) throw new Error(`Sign-in failed ${sign.status}`);
  const ACCESS = (await sign.json()).access_token;
  const headers = { apikey: ANON_KEY, Authorization: `Bearer ${ACCESS}`, "Content-Type": "application/json" };

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
}
