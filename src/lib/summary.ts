/**
 * The words of the daily summary: what was sent, who wrote back, what is
 * stuck and why. Kept apart from the route that sends it so it can be tested
 * without a database or a mailbox.
 */
const short = (s: unknown, n: number) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

/** "Workday 24, Greenhouse 23" */
function tally(rows: any[], key: (r: any) => string): string {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const k = key(r) || "other";
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}`)
    .join(", ");
}

/**
 * Why a job is waiting, in a few words a person can act on. The stored reason
 * is the applier's own sentence and can run to a paragraph.
 */
export function whyStuck(reason: unknown): string {
  const r = String(reason ?? "").toLowerCase();
  if (!r) return "no reason recorded";
  if (/social security|\bssn\b|date of birth|birth ?date/.test(r)) return "asks for SSN digits or a birth date, which are never filled in";
  if (/captcha|confirm you are human|robot/.test(r)) return "a human check the applier does not pass";
  if (/sign-?in|log-?in|registration|password|account/.test(r)) return "could not get past the portal's sign-in";
  if (/verification|verify|code/.test(r)) return "waiting on an emailed code or link";
  if (/file|resume|upload/.test(r)) return "the resume could not be attached";
  if (/required item|still empty|no answer/.test(r)) return "a required question had no answer on file";
  if (/no submit|no form|button/.test(r)) return "the form's next step could not be found";
  if (/closed|no longer|expired|not accepting/.test(r)) return "the posting has closed";
  return short(reason, 70);
}

export function composeSummary(d: {
  sent: any[];
  replies: any[];
  stuck: any[];
  ready: number;
  review: number;
  followUps: number;
  /** Questions employers asked that nothing on file answers yet. */
  questions?: number;
  /** Interviews booked for the week ahead, already worded: when, and what for. */
  coming?: Array<{ when: string; what: string }>;
  /** Every assessment still to take, wherever it was asked for: by email or on a portal. */
  assessments?: Array<{ what: string; due?: string | null; link?: string | null }>;
  /** How the last thirty days of applications have been answered. */
  month?: { sent: number; interviews: number; offers: number; rejected: number };
}): { subject: string; body: string } {
  const lines: string[] = [];
  const say = (s = "") => lines.push(s);

  if (d.coming?.length) {
    say(`COMING UP: ${d.coming.length} interview${d.coming.length === 1 ? "" : "s"} this week`);
    for (const c of d.coming.slice(0, 10)) say(`  ${c.when} - ${short(c.what, 70)}`);
    say();
  }
  if (d.assessments?.length) {
    say(`ASSESSMENTS TO TAKE: ${d.assessments.length}`);
    for (const x of d.assessments.slice(0, 12)) say(`  ${short(x.what, 60)}${x.due ? ` - due ${x.due}` : ""}${x.link ? `\n    ${x.link}` : ""}`);
    say();
  }
  say("The last 24 hours.");
  say();
  say(`SENT: ${d.sent.length}${d.sent.length ? `  (${tally(d.sent, (r) => String(r.ats ?? "employer's own site"))})` : ""}`);
  for (const r of d.sent.slice(0, 40)) say(`  ${short(r.company, 28)} - ${short(r.title, 52)}`);
  if (d.sent.length > 40) say(`  ...and ${d.sent.length - 40} more, all in the panel.`);
  if (!d.sent.length) say("  Nothing went out. If that is a surprise, the reasons are below.");
  say();

  const worth = d.replies.filter((r) => ["interview", "offer", "action_needed"].includes(String(r.category)));
  const no = d.replies.filter((r) => r.category === "rejection").length;
  say(`REPLIES: ${worth.length} to read${no ? `, ${no} turned down` : ""}`);
  for (const r of worth.slice(0, 15)) {
    const kind = r.category === "interview" ? "interview" : r.category === "offer" ? "OFFER" : "needs you";
    // Whether it has been answered already, so nobody answers it twice or
    // assumes it was handled when it was not.
    const answered =
      r.reply_state === "sent" ? "replied" : r.reply_state === "approved" ? "reply going out" : r.reply_state === "draft" ? "a draft is waiting for you" : r.reply_state === "failed" ? "the reply FAILED to send" : "not replied to";
    say(`  [${kind}] ${short(r.from_addr, 34)} - ${short(r.subject, 60)} (${answered})`);
  }
  say();

  say(`STUCK: ${d.stuck.length}`);
  const byWhy = new Map<string, string[]>();
  for (const r of d.stuck) {
    const w = whyStuck(r.help_reason);
    byWhy.set(w, [...(byWhy.get(w) ?? []), short(r.company, 24)]);
  }
  for (const [w, who] of [...byWhy.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 8)) {
    const names = [...new Set(who)];
    say(`  ${who.length} - ${w}: ${names.slice(0, 5).join(", ")}${names.length > 5 ? "..." : ""}`);
  }
  say();

  say(`WAITING: ${d.ready} ready to apply, ${d.review} held for review.`);
  if (d.questions) say(`QUESTIONS: ${d.questions} that employers asked and nothing on file answers. Answer each once on the Answers page and it is never asked again.`);
  if (d.followUps) say(`FOLLOW-UP EMAILS SENT: ${d.followUps}`);
  if (d.month && d.month.sent >= 10) {
    const m = d.month;
    const heard = m.interviews + m.offers + m.rejected;
    const pct = (n: number) => `${Math.round((n / m.sent) * 1000) / 10}%`;
    say();
    say(`LAST 30 DAYS: ${m.sent} sent. ${m.interviews} asked to interview (${pct(m.interviews)}), ${m.offers} offer${m.offers === 1 ? "" : "s"}, ${m.rejected} turned down, ${m.sent - heard} no word yet.`);
  }
  say();
  say("This is sent because the daily summary is switched on in settings. Switch it off there to stop it.");

  const subject = `ApplyPilot: ${d.sent.length} sent, ${worth.length} to read, ${d.stuck.length} stuck`;
  return { subject, body: lines.join("\n") };
}
