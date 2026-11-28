/**
 * The owner's block on an employer, carried out now, for one person.
 *
 * Everything not yet sent to a blocked employer is set aside at once —
 * whatever state it was waiting in — and what was already sent is counted,
 * because that cannot be recalled from here: an application an employer
 * has received is withdrawn on the employer's own portal, by the person.
 * Counts only; no name is printed. Run for each person by forusers.mjs.
 */
import { isBlocked, BLOCKED_REASON } from "./blocked.mjs";

const SUPABASE_URL = process.env.SUPABASE_URL, ANON_KEY = process.env.SUPABASE_ANON_KEY;
const ACT_AS = process.env.AP_ACT_AS ? { "x-act-as": process.env.AP_ACT_AS } : {};
const sign = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
  method: "POST", headers: { apikey: ANON_KEY, ...ACT_AS, "Content-Type": "application/json" },
  body: JSON.stringify({ email: process.env.APPLYPILOT_EMAIL, password: process.env.APPLYPILOT_PASSWORD }),
});
if (!sign.ok) { console.error(`sign-in failed ${sign.status}`); process.exit(1); }
const headers = { apikey: ANON_KEY, ...ACT_AS, Authorization: `Bearer ${(await sign.json()).access_token}`, "Content-Type": "application/json" };
const db = async (path, init = {}) => {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  if (!res.ok) throw new Error(`DB ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const t = await res.text();
  return t ? JSON.parse(t) : null;
};

const all = [];
for (let from = 0; from < 60000; from += 1000) {
  const rows = await db(`jobs?select=id,company,url,apply_url,status&order=id.asc&offset=${from}&limit=1000`);
  all.push(...rows);
  if (rows.length < 1000) break;
}
const theirs = all.filter(isBlocked);
const by = {};
for (const j of theirs) by[j.status] = (by[j.status] ?? 0) + 1;
const SENT = new Set(["applied", "interview", "offer", "rejected"]);
const pending = theirs.filter((j) => !SENT.has(j.status) && j.status !== "skipped");
let pulled = 0;
for (let i = 0; i < pending.length; i += 50) {
  const ids = pending.slice(i, i + 50).map((j) => j.id);
  const ok = await db(`jobs?id=in.(${ids.join(",")})`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "skipped", skip_reason: BLOCKED_REASON, help_reason: null, tailored_resume: null, updated_at: new Date().toISOString() }) }).then(() => true).catch(() => false);
  if (ok) pulled += ids.length;
}
// Resumes written for postings there that were set aside before: taken off those too.
const kept = theirs.filter((j) => j.status === "skipped");
for (let i = 0; i < kept.length; i += 50) {
  await db(`jobs?id=in.(${kept.slice(i, i + 50).map((j) => j.id).join(",")})`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ tailored_resume: null, skip_reason: BLOCKED_REASON }) }).catch(() => {});
}
const sent = theirs.filter((j) => SENT.has(j.status)).length;
let notes = 0;
try { notes = ((await db("outreach?state=eq.sent&select=job_id&limit=5000")) ?? []).filter((o) => theirs.some((j) => j.id === o.job_id)).length; } catch { /* no such table for this person */ }
console.log(`blocked employer: ${theirs.length} posting(s) on record ${JSON.stringify(by)}; ${pulled} not yet sent were set aside now, with any resume written for them removed; ${sent} had already been sent and cannot be recalled from here; follow-up emails already sent there: ${notes}`);
