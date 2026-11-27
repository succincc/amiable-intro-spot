/**
 * The person's own resume against the resume written for each posting, on
 * the same postings, measured the same way.
 *
 * For every job on record that has a resume written for it and a posting to
 * read: how much of what the posting requires each version names, whether
 * the written one says anything the person's own material does not, how the
 * two read, and how long they are. Counts only; no names, no text.
 *
 * These are this system's own readings of the posting. They are not an
 * employer's score and are not presented as one.
 *
 * Run for each person by forusers.mjs.
 */
import { guardLogs } from "./quiet.mjs";
import { requirementReport, unsupportedClaims, writingFindings, segmentPosting } from "./quality.mjs";
import { requirementTerms, NAMED_TERMS } from "./ats.mjs";
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
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: { apikey: ANON_KEY, ...ACT_AS, Authorization: `Bearer ${ACCESS}` } });
  if (!res.ok) throw new Error(`DB ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return res.json();
}

const mean = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

/** The comparison itself, on plain values, so it can be tested without a database. */
export function compare(own, material, rows) {
  const out = { read: 0, before: [], after: [], prefBefore: [], prefAfter: [], better: 0, same: 0, worse: 0, claims: 0, claimsJobs: 0, wBefore: 0, wAfter: [], length: [], noRequirements: 0 };
  out.wBefore = writingFindings(own).reduce((n, f) => n + f.count, 0);
  for (const j of rows) {
    const posting = String(j.description ?? "");
    const written = String(j.tailored_resume ?? "");
    if (posting.length < 300 || written.length < 300) continue;
    const a = requirementReport(own, posting, j.company ?? "");
    const b = requirementReport(written, posting, j.company ?? "");
    if (!a.required.total) { out.noRequirements++; continue; }
    out.read++;
    const pa = a.required.percent ?? 0, pb = b.required.percent ?? 0;
    out.before.push(pa); out.after.push(pb);
    if (a.preferred.total) { out.prefBefore.push(a.preferred.percent ?? 0); out.prefAfter.push(b.preferred.percent ?? 0); }
    if (pb > pa) out.better++; else if (pb === pa) out.same++; else out.worse++;
    const extra = unsupportedClaims(written, material);
    if (extra.length) { out.claims += extra.length; out.claimsJobs++; }
    out.wAfter.push(writingFindings(written).reduce((n, f) => n + f.count, 0));
    out.length.push(Math.round((100 * written.length) / Math.max(1, own.length)));
  }
  return out;
}

/**
 * Where the missing share comes from. Every required term of every posting
 * is put in exactly one place:
 *   - not a qualification: a frequent word of the posting, not a named
 *     skill, tool or credential (the reading of the posting is at fault);
 *   - named, and in the written resume (covered);
 *   - named, in the person's own material, left out of the written resume
 *     (the tailoring is at fault);
 *   - named, and nowhere in the person's material (the person does not
 *     claim it: a matter of which jobs are chosen, or of a thin profile).
 */
export function whereItGoes(material, rows) {
  const named = new Set(NAMED_TERMS.map((t) => String(t).toLowerCase()));
  const mat = String(material ?? "").toLowerCase();
  const o = { postings: 0, terms: 0, words: 0, wordsCovered: 0, named: 0, covered: 0, leftOut: 0, notClaimed: 0, marked: 0, byScore: {}, missingNamed: {}, commonWords: {} };
  for (const j of rows) {
    const posting = String(j.description ?? ""), written = String(j.tailored_resume ?? "").toLowerCase();
    if (posting.length < 300 || written.length < 300) continue;
    const seg = segmentPosting(posting);
    const marked = seg.marked && Boolean(seg.required.trim());
    const mustText = marked ? seg.required : `${seg.required}\n${seg.responsibilities}\n${seg.body}`;
    const terms = requirementTerms(mustText, 30, j.company ?? "").map((t) => String(t.term).toLowerCase());
    if (!terms.length) continue;
    o.postings++; if (marked) o.marked++;
    let n = 0, c = 0;
    for (const t of terms) {
      o.terms++;
      if (!named.has(t)) { o.words++; if (written.includes(t)) o.wordsCovered++; else o.commonWords[t] = (o.commonWords[t] ?? 0) + 1; continue; }
      o.named++; n++;
      if (written.includes(t)) { o.covered++; c++; }
      else if (mat.includes(t)) o.leftOut++;
      else { o.notClaimed++; o.missingNamed[t] = (o.missingNamed[t] ?? 0) + 1; }
    }
    const band = j.score == null ? "unscored" : j.score >= 8 ? "8-10" : j.score >= 6 ? "6-7" : "1-5";
    const b = (o.byScore[band] ??= { postings: 0, named: 0, covered: 0 });
    b.postings++; b.named += n; b.covered += c;
  }
  return o;
}

export function whereLines(o) {
  if (!o.terms) return [];
  const pc = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "-");
  const top = (m, k) => Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, k).map(([t, n]) => `${t} ${n}`).join(", ");
  return [
    `where the missing share comes from, over ${o.postings} posting(s) and ${o.terms} required term(s) (${o.marked} posting(s) set their requirements apart; the rest are read whole):`,
    `  ${o.words} term(s) (${pc(o.words, o.terms)}) are frequent words of the posting, not named skills, tools or credentials; the written resume happens to hold ${pc(o.wordsCovered, o.words)} of them`,
    `    the commonest of those it lacks: ${top(o.commonWords, 14)}`,
    `  ${o.named} term(s) (${pc(o.named, o.terms)}) are named skills, tools or credentials. Of those:`,
    `    in the written resume: ${o.covered} (${pc(o.covered, o.named)})`,
    `    in the person's own material but left out of the written resume: ${o.leftOut} (${pc(o.leftOut, o.named)})`,
    `    nowhere in the person's material: ${o.notClaimed} (${pc(o.notClaimed, o.named)}); the commonest: ${top(o.missingNamed, 14)}`,
    `  named qualifications covered, by the scorer's rating of the job: ${Object.entries(o.byScore).map(([k, v]) => `${k}: ${pc(v.covered, v.named)} over ${v.postings}`).join("; ")}`,
  ];
}

export function compareLines(o) {
  if (!o.read) return [`resume benchmark: no posting on record has both a written resume and requirements that could be read (${o.noRequirements} had no requirements to read)`];
  return [
    `resume benchmark over ${o.read} posting(s), the person's own resume against the one written for each, same postings, same measure:`,
    `  required qualifications named — own: ${mean(o.before)}% on average (middle ${median(o.before)}%, lowest ${Math.min(...o.before)}%); written: ${mean(o.after)}% (middle ${median(o.after)}%, lowest ${Math.min(...o.after)}%)`,
    `  written one names more of them on ${o.better}, the same on ${o.same}, fewer on ${o.worse}`,
    o.prefBefore.length ? `  preferred qualifications named (${o.prefBefore.length} posting(s) list any) — own: ${mean(o.prefBefore)}%; written: ${mean(o.prefAfter)}%` : `  no posting set its preferred qualifications apart`,
    `  figures or credentials in a written resume that the person's own material does not hold: ${o.claims} across ${o.claimsJobs} resume(s)${o.claims ? " — each of these is replaced by the person's own resume before sending" : ""}`,
    `  stock phrasing and weak openings — own: ${o.wBefore}; written: ${mean(o.wAfter)} on average, most ${Math.max(...o.wAfter)}`,
    `  length of the written one against the person's own: ${mean(o.length)}% on average (shortest ${Math.min(...o.length)}%, longest ${Math.max(...o.length)}%)`,
    `  these are this system's own readings of each posting, not any employer's score`,
  ];
}

async function main() {
  await signIn();
  const [profile] = await db("profile?select=resume_text,full_name,email,phone,city,state,linkedin_url&limit=1");
  const own = String(profile?.resume_text ?? "");
  if (own.length < 300) { console.log("resume benchmark: no resume text on the profile to measure"); return; }
  const roles = (await db("experience?select=company,title,location,start_date,end_date,details&limit=40").catch(() => [])) ?? [];
  const material = [own, ...roles.map((r) => Object.values(r).join(" ")), ...Object.values(profile ?? {}).map(String)].join("\n");
  const rows = await db("jobs?tailored_resume=not.is.null&description=not.is.null&select=company,description,tailored_resume,score&order=updated_at.desc&limit=120");
  for (const l of compareLines(compare(own, material, rows))) console.log(l);
  for (const l of whereLines(whereItGoes(material, rows))) console.log(l);
}

if (process.argv[1]?.endsWith("benchmark.mjs")) main().catch((e) => { console.error(`benchmark failed: ${String(e?.message ?? e).slice(0, 200)}`); process.exit(1); });
