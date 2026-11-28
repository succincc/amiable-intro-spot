// One switch of the owner's own search, set from a run started by hand.
//
// The panel is where settings are changed. This exists for the hours the
// owner has asked for a switch to be flipped while they are away from it:
// only the switches named here, only the owner's own search, and the value
// before and after is printed.

// Everything printed here goes through the nets in quiet.mjs: this log is public.
import "./quiet.mjs";
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


const ALLOWED = { same_state_only: ["true", "false"], include_unknown_location: ["true", "false"] };
const key = String(process.env.SETTING ?? "");
const value = String(process.env.VALUE ?? "");
if (!ALLOWED[key] || !ALLOWED[key].includes(value)) { console.error(`not a switch this sets: ${key}=${value}`); process.exit(2); }
if (process.env.AP_ACT_AS) { console.log("the owner's search only; nothing changed for anybody else"); process.exit(0); }
await signIn();
const [before] = (await db(`search_config?id=eq.1&select=${key},radius_miles`)) ?? [];
await db("search_config?id=eq.1", { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ [key]: value === "true" }) });
const [after] = (await db(`search_config?id=eq.1&select=${key}`)) ?? [];
console.log(`${key}: was ${JSON.stringify(before?.[key])}, now ${JSON.stringify(after?.[key])}; radius ${before?.radius_miles ?? "none"} mi`);
process.exit(0);
