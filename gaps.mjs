/**
 * What postings keep asking for that a person's material nowhere shows —
 * put to the person, never assumed.
 *
 * Reads the person's resume, their experience rows and what they have
 * already confirmed; reads the postings matched to them; and for each named
 * skill, tool or credential that several postings require and none of that
 * material shows, leaves one question on their Answers page. A Yes from
 * them (with a line saying where) becomes part of what tailoring may use.
 * A No is remembered and never asked again.
 *
 * Also says, in counts, how full the profile is. Run for each person by
 * forusers.mjs.
 */
import { guardLogs } from "./quiet.mjs";
import { requirementReport } from "./quality.mjs";
import { showsTerm } from "./ats.mjs";
import { askedQualifications, confirmedQualifications, qualificationLines, qualKey, qualQuestion } from "./candidate.mjs";
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
async function db(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { apikey: ANON_KEY, ...ACT_AS, Authorization: `Bearer ${ACCESS}`, "Content-Type": "application/json", ...(init.headers ?? {}) } });
  if (!res.ok) throw new Error(`DB ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// At most this many questions waiting at once: a page of forty is a page nobody answers.
const WAITING_AT_MOST = 8;
// Asked for by at least this many postings before it is worth a question.
const ASKED_BY_AT_LEAST = 3;

/** Named qualifications the postings require and the material does not show: term -> postings. */
export function gapsOf(material, postings) {
  const tally = new Map();
  let read = 0;
  for (const j of postings) {
    const d = String(j.description ?? "");
    if (d.length < 300) continue;
    const r = requirementReport(material, d, j.company ?? "");
    if (!r.named.total) continue;
    read++;
    for (const t of r.named.missing) if (!showsTerm(material, t)) tally.set(t, (tally.get(t) ?? 0) + 1);
  }
  return { read, gaps: [...tally.entries()].sort((a, b) => b[1] - a[1]) };
}

/** How full the profile is, in counts. */
export function profileAudit(profile, roles) {
  const fields = ["full_name", "email", "phone", "address", "city", "state", "postal_code", "linkedin_url", "website", "current_company", "target_role", "work_authorized", "needs_sponsorship", "salary_expectation"];
  const empty = fields.filter((f) => profile?.[f] == null || String(profile[f]).trim() === "");
  const resume = String(profile?.resume_text ?? "");
  const thin = (roles ?? []).filter((r) => String(r.details ?? "").trim().length < 120).length;
  return { resumeWords: resume.split(/\s+/).filter(Boolean).length, roles: (roles ?? []).length, rolesWithLittleSaid: thin, emptyFields: empty };
}

async function main() {
  await signIn();
  const [profile] = (await db("profile?select=*&limit=1")) ?? [];
  const roles = (await db("experience?select=company,title,location,start_date,end_date,details&limit=40").catch(() => [])) ?? [];
  const answers = (await db("answers?select=q_key,answer,confirmed&question=ilike.About%20you:*&limit=500").catch(() => [])) ?? [];
  const asked = askedQualifications(answers);
  const confirmed = confirmedQualifications(answers);

  const a = profileAudit(profile, roles);
  console.log(`the profile: a resume of ${a.resumeWords} word(s); ${a.roles} role(s) on the experience page, ${a.rolesWithLittleSaid} of them with under 120 characters said about them; fields left empty: ${a.emptyFields.length ? a.emptyFields.join(", ") : "none"}`);
  const state = [...asked.values()];
  console.log(`about the person, beyond the resume: ${confirmed.length} confirmed, ${state.filter((s) => s === "no").length} said no to, ${state.filter((s) => s === "waiting").length} waiting for an answer`);

  if (String(profile?.resume_text ?? "").length < 300) { console.log("no resume text to read gaps against"); return; }
  const material = [profile.resume_text, ...roles.map((r) => Object.values(r).join(" ")), qualificationLines(confirmed)].join("\n");
  const postings = (await db("jobs?status=in.(queued,review,applied,interview)&description=not.is.null&select=company,description&order=updated_at.desc&limit=300")) ?? [];
  const { read, gaps } = gapsOf(material, postings);
  console.log(`named qualifications required by ${read} posting(s) matched to this person and shown nowhere in their material: ${gaps.length ? gaps.slice(0, 20).map(([t, n]) => `${t} ${n}`).join(", ") : "none"}`);

  let waiting = state.filter((s) => s === "waiting").length;
  let put = 0;
  for (const [term, n] of gaps) {
    if (waiting >= WAITING_AT_MOST) break;
    if (n < ASKED_BY_AT_LEAST || asked.has(term.toLowerCase())) continue;
    const ok = await db("answers", {
      method: "POST",
      headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
      body: JSON.stringify([{ q_key: qualKey(term), question: qualQuestion(term, n), answer: "", field_type: "text", confirmed: false }]),
    }).then(() => true).catch(() => false);
    if (ok) { put++; waiting++; }
  }
  console.log(`questions put to the person this time: ${put}; waiting now: ${waiting} (never more than ${WAITING_AT_MOST} at once)`);
}

if (process.argv[1]?.endsWith("gaps.mjs")) main().catch((e) => { console.error(`gaps failed: ${String(e?.message ?? e).slice(0, 200)}`); process.exit(1); });
