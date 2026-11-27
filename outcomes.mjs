/**
 * What became of the applications that were sent, set against how they
 * were sent.
 *
 * Every application carries what was known when it went: the hiring system,
 * how old the posting was, how the scorer rated it, how closely the resume
 * matched what the posting required, and whether a resume was written for
 * it. The mailbox reader later marks the same job as an interview, an
 * offer, or a rejection. Nothing put the two side by side, so "what is
 * working" could only be a feeling.
 *
 * This counts; it does not conclude. A rate over a handful of applications
 * is noise, and is printed as a count with no percentage until there are
 * enough to mean something. Nothing here changes what is applied to: an
 * order drawn from five replies would be an order drawn from chance.
 */

const SENT = new Set(["applied", "interview", "offer", "rejected"]);
const GOOD = new Set(["interview", "offer"]);

/** The fewest applications in a group before a percentage is worth printing. */
export const ENOUGH = 20;

const FAMILIES = [
  ["analyst", /\banalyst|analytics\b/], ["engineer or developer", /\bengineer|developer|programmer|architect\b/],
  ["marketing", /\bmarketing|brand|content|seo|social media|communications\b/], ["sales or account", /\bsales|account (executive|manager)|business development\b/],
  ["operations", /\boperations|logistics|supply chain|procurement\b/], ["project or program", /\bproject|program|scrum|product (manager|owner)\b/],
  ["customer or support", /\bcustomer|support|success|service\b/], ["finance or accounting", /\bfinanc|account(ant|ing)|payroll|audit\b/],
  ["people or recruiting", /\bhuman resources|\bhr\b|recruit|talent\b/], ["coordinator or assistant", /\bcoordinator|assistant|administrat|associate\b/],
  ["manager or director", /\bmanager|director|lead|head of|supervisor\b/], ["specialist", /\bspecialist\b/],
];

const bucket = {
  system: (j) => j.ats ?? "own site",
  "posting age when sent": (j) => {
    if (!j.posted_at || !j.applied_at) return "not dated";
    const days = (new Date(j.applied_at) - new Date(j.posted_at)) / 86_400_000;
    if (!(days >= 0)) return "not dated";
    return days <= 2 ? "0-2 days" : days <= 7 ? "3-7 days" : days <= 14 ? "8-14 days" : "15+ days";
  },
  "scorer's rating": (j) => (j.score == null ? "unscored" : j.score >= 8 ? "8-10" : j.score >= 6 ? "6-7" : "1-5"),
  "match to requirements": (j) => (j.ats_match == null ? "not measured" : j.ats_match >= 80 ? "80%+" : j.ats_match >= 60 ? "60-79%" : "under 60%"),
  // The kind of work, by the plain word in the title. Generic words only,
  // so the list says nothing about who is looking.
  "kind of job": (j) => {
    const t = String(j.title ?? "").toLowerCase();
    for (const [name, re] of FAMILIES) if (re.test(t)) return name;
    return t ? "other" : "untitled";
  },
  "where the posting was found": (j) => String(j.source ?? "not recorded").toLowerCase().slice(0, 24),
  // Per employer would name them; what matters is whether writing to one
  // employer many times does better or worse than writing once.
  "applications to the same employer": (j) => (j.employer_count == null ? "not counted" : j.employer_count === 1 ? "the only one" : j.employer_count <= 3 ? "2-3" : "4 or more"),
  resume: (j) => (j.has_tailored ?? Boolean(j.tailored_resume) ? "written for the posting" : "the general one"),
};

/**
 * Applications sent, by each thing known about them, with what came back.
 * `rows` are jobs; only those that were sent are counted.
 */
export function outcomes(rows) {
  const sent = (rows ?? []).filter((j) => SENT.has(j.status));
  {
    const per = {};
    const key = (j) => String(j.company ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
    for (const j of sent) if (key(j)) per[key(j)] = (per[key(j)] ?? 0) + 1;
    for (const j of sent) if (key(j) && j.employer_count == null) j.employer_count = per[key(j)];
  }
  const tally = (list) => {
    const n = list.length;
    const good = list.filter((j) => GOOD.has(j.status)).length;
    const no = list.filter((j) => j.status === "rejected").length;
    return { sent: n, interviews: good, rejections: no, waiting: n - good - no, rate: n >= ENOUGH ? Math.round((1000 * good) / n) / 10 : null };
  };
  const by = {};
  for (const [name, of] of Object.entries(bucket)) {
    const groups = {};
    for (const j of sent) (groups[of(j)] ??= []).push(j);
    by[name] = Object.fromEntries(Object.entries(groups).sort((a, b) => b[1].length - a[1].length).map(([k, v]) => [k, tally(v)]));
  }
  return { all: tally(sent), by };
}

/** The same, as lines to print. */
export function outcomeLines(report) {
  const one = (t) => `${t.sent} sent, ${t.interviews} interview/offer, ${t.rejections} rejected, ${t.waiting} no word` + (t.rate == null ? "" : ` (${t.rate}% to interview)`);
  const lines = [`applications and what came back: ${one(report.all)}`];
  if (report.all.sent < ENOUGH) lines.push(`  fewer than ${ENOUGH} sent: counts only, no rates`);
  for (const [name, groups] of Object.entries(report.by)) {
    lines.push(`  by ${name}:`);
    for (const [k, t] of Object.entries(groups)) lines.push(`    ${k}: ${one(t)}`);
  }
  return lines;
}
