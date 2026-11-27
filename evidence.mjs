/**
 * The record held against the evidence, as plain arithmetic.
 *
 * Takes the jobs on record as sent, the employer mail that was read, and the
 * jobs that were tried and did not go. Returns lines to print and a list of
 * failures: things that are wrong whoever looks at them, and that a later
 * change must not bring back. No names in or out — counts and systems only.
 */
import { jobKey, employerKey } from "./samejob.mjs";

const count = (list, of) => { const o = {}; for (const x of list) { const k = of(x) ?? "none"; o[k] = (o[k] ?? 0) + 1; } return o; };
const sys = (j) => j.ats ?? "own site";
const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : "-");

// The kind of a mail from its subject alone, for mail stored before the
// kind was. The mailbox sync's own rules (emailKind in classify.server.ts)
// also read the body; this is the cruder reading, used only as a stand-in.
export function kindFromSubject(category, subject) {
  const s = String(subject ?? "");
  if (category === "offer") return "offer";
  if (category === "rejection") return "rejection";
  if (category === "confirmation") return "acknowledgement";
  if (category === "interview") return /schedul|availab|pick a time|calendly|invit|phone screen/i.test(s) ? "interview_invitation" : "recruiter_inquiry";
  if (category === "action_needed") {
    if (/verification code|one[- ]time|\botp\b|security code|passcode|access code|(verify|confirm|validate|activate) your|(e-?mail|account) (verification|activation)/i.test(s)) return "verification_code";
    if (/password|new device|sign-?in attempt/i.test(s)) return "account_notice";
    if (/assessment|skills? test|questionnaire|coding|online test|video interview|hirevue|hackerrank|codility/i.test(s)) return "assessment";
    if (/received your application|thank(s| you) for (applying|your application|your interest)|application (received|confirmation|submitted)/i.test(s)) return "acknowledgement";
    return "action_needed";
  }
  return "other";
}

/**
 * @param sent  jobs with status applied | interview | offer | rejected
 * @param mail  inbound emails: { category, kind?, subject, job_id }
 * @param tried jobs with status needs_help | failed: { ats, status, help_reason }
 * @param now   ms
 */
export function evidence(sent, mail, tried = [], now = Date.now()) {
  const lines = [];
  const failures = [];
  const say = (t) => lines.push(t);

  for (const m of mail) m.kind = m.kind ?? kindFromSubject(m.category, m.subject);
  const mailOf = {};
  for (const m of mail) if (m.job_id) (mailOf[m.job_id] ??= []).push(m);
  const has = (j, cat) => (mailOf[j.id] ?? []).some((m) => m.category === cat);
  const receipt = (j) => j.confirm_state === "confirmed" || (mailOf[j.id] ?? []).some((m) => m.kind === "acknowledgement");
  const anyWord = (j) => (mailOf[j.id] ?? []).some((m) => ["acknowledgement", "rejection", "interview_invitation", "recruiter_inquiry", "offer", "assessment"].includes(m.kind));

  say(`on record as sent: ${sent.length}; by status ${JSON.stringify(count(sent, (j) => j.status))}`);

  // 1. Each application, by the strongest evidence for it.
  const strength = (j) => (receipt(j) ? "a receipt in the mailbox" : anyWord(j) ? "no receipt, but the employer wrote about it" : "the applier's word only");
  say(`  evidence for each: ${JSON.stringify(count(sent, strength))}`);
  const unverified = tried.filter((j) => j.help_reason === "unconfirmed").length;
  const firm = sent.filter((j) => receipt(j) || anyWord(j)).length;
  say(`  confidence: confirmed by the employer ${firm}; probable (the portal showed its confirmation, nothing since) ${sent.length - firm}; unverified (sent, no confirmation seen — held, never sent again) ${unverified}`);
  const bare = sent.filter((j) => !receipt(j) && !anyWord(j));
  const age = (j) => { const h = (now - new Date(j.applied_at ?? now).getTime()) / 3_600_000; return h < 24 ? "under a day old" : h < 72 ? "one to three days" : "over three days"; };
  if (bare.length) say(`  those on the applier's word only, by age: ${JSON.stringify(count(bare, age))}; by system: ${JSON.stringify(count(bare, sys))}`);

  // Why the bare ones are bare. A receipt names the employer far more often
  // than the job, so where several jobs went to one employer the receipts
  // can pile up on one of them and leave the rest looking unanswered.
  if (bare.length) {
    const byEmp = {};
    for (const j of sent) (byEmp[employerKey(j.company)] ??= []).push(j);
    const acks = (j) => (mailOf[j.id] ?? []).filter((m) => m.kind === "acknowledgement");
    const why = (j) => {
      const sibs = (byEmp[employerKey(j.company)] ?? []).filter((x) => x.id !== j.id);
      const spare = sibs.flatMap((x) => acks(x).slice(1).concat(acks(x).length > 1 ? acks(x).slice(0, 1) : []));
      const t = new Date(j.applied_at ?? 0).getTime();
      if (spare.some((m) => { const d = new Date(m.received_at ?? 0).getTime() - t; return d > -120_000 && d < 45 * 60_000; })) return "a receipt came within 45 minutes of it and is filed under another job at the same employer";
      if (spare.length) return "another job at the same employer holds more than one receipt, none close in time";
      if (sibs.some((x) => (mailOf[x.id] ?? []).length)) return "the employer has written, about another job only";
      const key = employerKey(j.company).split(" ").filter((w) => w.length >= 4);
      if (mail.some((m) => !m.job_id && key.some((w) => `${m.from_addr ?? ""} ${m.subject ?? ""}`.toLowerCase().includes(w)))) return "mail naming the employer is on file, matched to no job";
      return "no mail from this employer at all";
    };
    say(`  why: ${JSON.stringify(count(bare, why))}`);
    say(`  employers sent to more than once: ${Object.values(byEmp).filter((g) => g.length > 1).length} of ${Object.keys(byEmp).length}; jobs holding two or more receipts: ${sent.filter((j) => acks(j).length > 1).length}`);
  }

  // Sent against the scorer's own rating: what it rated low should not have gone.
  say(`  by the scorer's rating when sent: ${JSON.stringify(count(sent, (j) => (j.score == null ? "unscored" : String(Math.round(j.score)))))}`);

  // 2. Sent twice.
  const groups = {};
  for (const j of sent) { const k = jobKey(j); if (k) (groups[k] ??= []).push(j); }
  const twice = Object.values(groups).filter((g) => g.length > 1);
  const extra = twice.reduce((n, g) => n + g.length - 1, 0);
  say(`  sent more than once to the same role, employer and place: ${twice.length} group(s), ${extra} extra application(s)`);
  let fresh = 0;
  for (const g of twice) {
    const at = g.map((j) => new Date(j.applied_at ?? 0).getTime()).sort((a, b) => a - b);
    const apart = Math.round((at[at.length - 1] - at[0]) / 3_600_000);
    const sameUrl = new Set(g.map((j) => String(j.url ?? "").split("?")[0])).size < g.length;
    const ago = Math.round((now - at[at.length - 1]) / 3_600_000);
    const sameTitle = new Set(g.map((j) => String(j.title ?? "").trim().toLowerCase())).size === 1;
    say(`    ${g.length} times, ${apart}h apart, the later ${ago}h ago, through ${[...new Set(g.map(sys))].join(" and ")}, ${sameUrl ? "the same address" : "different addresses"}, ${sameTitle ? "the same title to the letter" : "titles that differ in wording"}`);
    if (now - at[at.length - 1] < 48 * 3_600_000) fresh++;
  }
  if (fresh) failures.push(`${fresh} job(s) sent a second time within the last two days`);

  // 3. Stages nobody at the employer put the job in.
  for (const [status, cat] of [["interview", "interview"], ["offer", "offer"]]) {
    const marked = sent.filter((j) => j.status === status);
    const unsupported = marked.filter((j) => !has(j, cat));
    say(`  marked ${status}: ${marked.length}; with mail saying so: ${marked.length - unsupported.length}; with none: ${unsupported.length}`);
    if (unsupported.length) {
      say(`    what mail those ${unsupported.length} do have: ${JSON.stringify(count(unsupported.flatMap((j) => (mailOf[j.id] ?? [{ kind: "no mail at all" }])), (m) => m.kind))}`);
      failures.push(`${unsupported.length} job(s) marked ${status} with no ${cat} mail attached`);
    }
  }
  const quietNo = sent.filter((j) => j.status !== "rejected" && j.status !== "offer" && j.status !== "interview" && has(j, "rejection"));
  if (quietNo.length) say(`  turned down by mail but not marked so: ${quietNo.length}`);

  // 4. The mail itself.
  say(`employer mail read: ${mail.length}; by category ${JSON.stringify(count(mail, (m) => m.category))}`);
  say(`  by kind: ${JSON.stringify(count(mail, (m) => m.kind))}`);
  say(`  about a job on record: ${mail.filter((m) => m.job_id).length}; about none: ${mail.filter((m) => !m.job_id).length}`);
  const lostReceipts = mail.filter((m) => m.kind === "acknowledgement" && !m.job_id).length;
  say(`  receipts matched to no job: ${lostReceipts}`);
  if (lostReceipts) {
    const keys = [...new Set(sent.map((j) => employerKey(j.company)))].map((k) => k.split(" ").filter((w) => w.length >= 4)).filter((w) => w.length);
    const named = (m) => keys.some((ws) => ws.some((w) => `${m.from_addr ?? ""} ${m.subject ?? ""}`.toLowerCase().includes(w)));
    const lost = mail.filter((m) => m.kind === "acknowledgement" && !m.job_id);
    say(`    of those: ${lost.filter(named).length} name an employer that was applied to, ${lost.filter((m) => !named(m)).length} name none on record`);
  }

  // 5. Each system on its own, from what really happened. A job counts as
  // an interview or an offer here only with the mail to show for it.
  const real = (j) => (j.status === "interview" && !has(j, "interview")) || (j.status === "offer" && !has(j, "offer")) ? "applied" : j.status;
  const systems = [...new Set([...sent.map(sys), ...tried.map(sys)])].sort();
  say(`each system, from the record (sent / with receipt / turned down / interview with mail / tried and stopped):`);
  for (const k of systems) {
    const s = sent.filter((j) => sys(j) === k);
    const t = tried.filter((j) => sys(j) === k);
    const why = Object.entries(count(t, (j) => j.help_reason ?? j.status)).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([r, n]) => `${r} ${n}`).join(", ");
    say(`  ${k}: ${s.length} / ${s.filter(receipt).length} (${pct(s.filter(receipt).length, s.length)}) / ${s.filter((j) => real(j) === "rejected").length} / ${s.filter((j) => real(j) === "interview").length} / ${t.length}${why ? ` (${why})` : ""}${s.length < 20 ? "  [under 20 sent: too few to call a rate]" : ""}`);
  }

  return { lines, failures, corrected: sent.map((j) => ({ ...j, status: real(j) })) };
}
