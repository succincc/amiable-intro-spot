/**
 * Measure how a resume reads to a keyword screener, and close the gap that
 * is honestly closable.
 *
 * Nothing in this system ever checked. A resume went out and whether it
 * scored 20 or 90 against the posting was invisible, so "make it score
 * better" could only ever be a hope. This gives a number before and after.
 *
 * What it closes is the VOCABULARY gap, which is most of the real one.
 * Someone writes "handled upset customers"; the posting says "de-escalation
 * and conflict resolution"; the screener matches text, finds neither phrase,
 * and rates a genuine fit at twenty per cent. Translating their own
 * experience into the employer's words costs nothing and is simply true.
 *
 * What it will not do is add a term the resume gives no evidence for. Every
 * phrase it can introduce is gated on something the candidate actually
 * wrote, through EVIDENCE below. A term with no evidence is reported as a
 * gap, never written in — a resume that wins a screen it cannot survive has
 * cost the candidate the interview, the employer's time and the reference.
 */

/** Terms worth matching, with the spellings a posting might use. */
const EVIDENCE = [
  { term: "de-escalation", proof: /\b(upset|angry|irate|difficult) (customers?|clients?|guests?)|escalat|complaint|conflict resolution/i },
  { term: "conflict resolution", proof: /\bconflict|dispute|escalat|mediat|complaint/i },
  { term: "customer service", proof: /\bcustomer|client|guest|patron|member service/i },
  { term: "client relationship management", proof: /\bclient|customer (account|relationship)|account manage/i },
  { term: "stakeholder management", proof: /\bstakeholder|vendor|partner|client|executive/i },
  { term: "vendor management", proof: /\bvendor|supplier|contract|procure/i },
  { term: "cross-functional collaboration", proof: /\bcross[- ]functional|collaborat|partnered with|worked with (teams|departments)/i },
  { term: "process improvement", proof: /\bimprov|streamlin|optimi|reduc(ed|ing) (time|cost)|efficien/i },
  { term: "project management", proof: /\bproject|timeline|deliverable|milestone|launch/i },
  { term: "team leadership", proof: /\b(led|lead|manage[dr]?|supervis|mentor|coach)\b/i },
  { term: "training and development", proof: /\btrain|onboard|mentor|coach|taught|curricul/i },
  { term: "scheduling", proof: /\bschedul|roster|shift|staffing|calendar/i },
  { term: "inventory management", proof: /\binventory|stock|supply|reorder|shrinkage/i },
  { term: "budget management", proof: /\bbudget|p&l|cost|expense|forecast/i },
  { term: "financial reporting", proof: /\bfinancial|revenue|invoice|reconcil|ledger|statement/i },
  { term: "data analysis", proof: /\b(analy[sz]|data|report|dashboard|metric|kpi|insight)/i },
  { term: "reporting", proof: /\breport|dashboard|metric|kpi|analytics/i },
  { term: "Microsoft Excel", proof: /\bexcel|spreadsheet|pivot|vlookup/i },
  { term: "SQL", proof: /\bsql|quer(y|ies)|database/i },
  { term: "Python", proof: /\bpython\b/i },
  { term: "JavaScript", proof: /\bjavascript|js\b|node|react/i },
  { term: "CRM", proof: /\bcrm|salesforce|hubspot|customer relationship/i },
  { term: "point of sale", proof: /\bpoint of sale|\bpos\b|register|checkout/i },
  { term: "social media management", proof: /\bsocial media|instagram|tiktok|facebook|twitter|linkedin (page|content)/i },
  { term: "content creation", proof: /\bcontent|copy|post|campaign|creative/i },
  { term: "digital marketing", proof: /\bmarketing|seo|campaign|ads?\b|advertis/i },
  { term: "sales", proof: /\bsales|sold|quota|revenue|upsell|closed/i },
  { term: "business development", proof: /\bbusiness development|new business|partnership|growth|prospect/i },
  { term: "account management", proof: /\baccount|client|renewal|retention/i },
  { term: "payroll", proof: /\bpayroll|wages|compensation|timesheet/i },
  { term: "hiring", proof: /\bhir|recruit|interview|staffing|onboard/i },
  { term: "compliance", proof: /\bcomplian|regulat|policy|audit|standard/i },
  { term: "quality assurance", proof: /\bquality|qa\b|inspect|defect|standard/i },
  { term: "logistics", proof: /\blogistic|shipping|receiving|freight|distribution|warehouse/i },
  { term: "problem solving", proof: /\bsolv|troubleshoot|diagnos|resolv|root cause/i },
  { term: "communication", proof: /\bcommunicat|present|wrote|liais|correspond/i },
  { term: "time management", proof: /\bdeadline|prioriti|time manage|multitask/i },
  { term: "attention to detail", proof: /\baccura|detail|audit|reconcil|proofread|verif/i },
];

// Written once with the expansion, because a screener matches one or the
// other and almost never both.
const ACRONYMS = [
  ["SQL", "Structured Query Language"],
  ["CRM", "customer relationship management"],
  ["POS", "point of sale"],
  ["KPI", "key performance indicator"],
  ["P&L", "profit and loss"],
  ["SEO", "search engine optimization"],
  ["QA", "quality assurance"],
  ["B2B", "business-to-business"],
  ["B2C", "business-to-consumer"],
  ["SaaS", "software as a service"],
  ["API", "application programming interface"],
  ["HR", "human resources"],
];

const STOP = new Set(
  ("the and for with you your our their this that are was will have has from " +
    "they them its it's been being able must should would could about into " +
    "who whom which what when where while over under more most other such " +
    "than then there here all any each every some both few many much work " +
    "working role position job candidate applicant company team years year " +
    "experience required requirements preferred qualifications responsibilities " +
    // Markup that survives a tag strip, and words that describe nothing.
    "nbsp span strong href class style div li ul br amp quot apos " +
    "strong excellent great good solid proven demonstrated ability skills " +
    "build building help helping make making take taking join joining " +
    "across within including include includes also well best better " +
    "opportunity opportunities benefits salary range equal employer diverse " +
    "inclusive applicants please apply applying hiring process offer offers " +
    "looking seeking want wants need needs like likes plus bonus nice have")
    .split(/\s+/),
);

// The skills this file knows by name, in the wording an employer uses.
export const NAMED_TERMS = [...EVIDENCE.map((e) => e.term), ...ACRONYMS.map(([short]) => short)];

/**
 * The terms a posting is actually screening on.
 *
 * Weighted towards the requirement lines, because "5 years of SQL" under
 * Requirements matters more than the same word in a culture paragraph.
 */
export function requirementTerms(posting, limit = 40, company = "") {
  // Postings arrive as HTML more often than not, and a first run on real
  // ones counted "nbsp", "span" and "strong" among the requirements. A
  // denominator full of markup makes the percentage meaningless.
  const text = String(posting ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;|&#\d+;/gi, " ")
    .replace(/\s+/g, " ");
  if (!text.trim()) return [];

  // The employer's own name is not a skill. "Airbnb" appeared as something
  // the candidate had failed to evidence.
  const ownWords = new Set(
    String(company ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2),
  );

  // The requirement sections carry the weight; the rest is context.
  const sections = text.split(/\n(?=[A-Z][^\n]{0,60}:?\s*$)/);
  const heavy = sections
    .filter((s) => /requirement|qualification|must have|you (will )?(have|bring)|skills|experience/i.test(s.slice(0, 80)))
    .join("\n");
  const weighted = `${heavy}\n${heavy}\n${text}`;

  const found = new Map();
  const add = (term, by) => found.set(term.toLowerCase(), (found.get(term.toLowerCase()) ?? 0) + by);

  for (const { term } of EVIDENCE) {
    const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
    const hits = (weighted.match(re) ?? []).length;
    if (hits) add(term, hits * 3);
  }
  for (const [short, long] of ACRONYMS) {
    const re = new RegExp(`\\b(${short}|${long.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})\\b`, "gi");
    const hits = (weighted.match(re) ?? []).length;
    if (hits) add(short, hits * 3);
  }

  // Plus the posting's own distinctive words, so a term nobody anticipated
  // still counts. A list written in advance can never cover every job.
  for (const raw of weighted.toLowerCase().match(/\b[a-z][a-z+#.-]{4,}\b/g) ?? []) {
    if (STOP.has(raw) || ownWords.has(raw)) continue;
    add(raw, 1);
  }

  return [...found.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([term, weight]) => ({ term, weight }));
}

/** How much of what the posting screens on this resume actually says. */
export function coverage(resumeText, terms) {
  const text = String(resumeText ?? "").toLowerCase();
  let have = 0;
  let total = 0;
  const missing = [];
  for (const { term, weight } of terms) {
    total += weight;
    if (text.includes(term.toLowerCase())) have += weight;
    else missing.push(term);
  }
  return { percent: total ? Math.round((have / total) * 100) : 0, missing };
}

/**
 * Add the employer's wording for experience the resume already evidences,
 * and expand its acronyms. Nothing else.
 *
 * Every phrase added has to clear a proof pattern drawn from the candidate's
 * own text. A posting term with no evidence behind it is left out and
 * reported as a gap, which is the honest answer and the useful one: it tells
 * the candidate what the job wants that they have not shown.
 */
export function alignToPosting(resumeText, posting, company = "") {
  const resume = String(resumeText ?? "");
  if (!resume.trim() || !String(posting ?? "").trim()) {
    return { text: resume, added: [], gaps: [] };
  }

  const terms = requirementTerms(posting, 40, company);
  const before = coverage(resume, terms);
  const lower = resume.toLowerCase();

  const added = [];
  const gaps = [];
  for (const term of before.missing) {
    const rule = EVIDENCE.find((e) => e.term.toLowerCase() === term.toLowerCase());
    if (rule && rule.proof.test(resume)) {
      added.push(rule.term);
      continue;
    }
    const pair = ACRONYMS.find(([s, l]) => s.toLowerCase() === term || l.toLowerCase() === term);
    if (pair && (lower.includes(pair[0].toLowerCase()) || lower.includes(pair[1].toLowerCase()))) {
      added.push(`${pair[0]} (${pair[1]})`);
      continue;
    }
    gaps.push(term);
  }

  if (!added.length) return { text: resume, added: [], gaps, before: before.percent, after: before.percent };

  // Placed as its own section, in the employer's words, before experience —
  // where a screener reads it and a human can see plainly what it claims.
  const block = `CORE COMPETENCIES\n${added.join(" · ")}\n`;
  const at = resume.search(/^\s*(EXPERIENCE|PROFESSIONAL EXPERIENCE|WORK HISTORY|EMPLOYMENT)\b/im);
  const text =
    at > 0 ? `${resume.slice(0, at)}${block}\n${resume.slice(at)}` : `${resume}\n\n${block}`;

  return { text, added, gaps, before: before.percent, after: coverage(text, terms).percent };
}

/**
 * An answer to an open-ended question, written from the resume and the
 * posting, with no model involved.
 *
 * These questions — "why are you applying", "what excites you about this
 * role" — are the commonest reason an otherwise complete application stops
 * and waits for a human. The model answers them well, and the model has a
 * daily quota that runs out, after which every one of them stops an
 * application. A feature that works while a quota lasts is not a feature.
 *
 * It is not trying to be eloquent. It names the role, cites the overlap
 * between the posting's own requirements and what the resume actually
 * shows, and says what the candidate has done — all of it true, all of it
 * specific to this posting. That beats a blank box, and it beats generic
 * enthusiasm, which reads as exactly what it is.
 */
export function composeAnswer({ question, job, resume, profile, maxLength }) {
  const q = String(question ?? "").toLowerCase();
  const text = String(resume ?? "");
  if (!text.trim()) return null;

  // Never into a box that wants one fact.
  //
  // A run wrote a paragraph about why the candidate was applying into the
  // LinkedIn profile field, because the profile had no URL on file and the
  // box was long enough to look open-ended. A field asking for a link, a
  // number or a name is not asking a question, and an essay in it is worse
  // than leaving it empty — a human reads that and it is unmistakable.
  // Word boundaries, because these are words and not letter sequences.
  // "date" with none of them matched "what interests you about this CANDIdate
  // experience role?" and refused to answer it — and candidate is one of the
  // most common words on a careers form. "state" matched "statement" and
  // "United States" the same way.
  if (
    /linkedin|github|portfolio|\bur[li]\b|\bwebsite\b|profile link|\bphone\b|\be-?mail\b|\bzip\b|\bpostal\b|\bsalary\b|compensation|\bdates?\b|\bname\b|\baddress\b|\bcity\b|\bstate\b|\bcountry\b/.test(
      q,
    )
  ) {
    return null;
  }

  // And only where something is actually being asked.
  if (!/\?|why|what|how|tell us|describe|explain|share|interest|excite|about you/.test(q)) {
    return null;
  }

  const title = String(job?.title ?? "this role").replace(/\s+/g, " ").trim();
  const company = String(job?.company ?? "").replace(/\s+/g, " ").trim();

  // What the posting asks for that the resume genuinely evidences. This is
  // the whole substance of the answer: real overlap, in the employer's words.
  // Named skills only, never the loose words the extractor also collects.
  // A first draft offered "vendor management and customer", because
  // "customer" is a word this posting uses often and nothing more.
  const named = new Set([
    ...EVIDENCE.map((e) => e.term.toLowerCase()),
    ...ACRONYMS.flatMap(([short, long]) => [short.toLowerCase(), long.toLowerCase()]),
  ]);

  const terms = requirementTerms(job?.description ?? "", 24, company);
  const have = [];
  for (const { term } of terms) {
    if (have.length >= 3) break;
    if (!named.has(term.toLowerCase())) continue;
    const rule = EVIDENCE.find((e) => e.term.toLowerCase() === term.toLowerCase());
    const proven = text.toLowerCase().includes(term.toLowerCase()) || (rule && rule.proof.test(text));
    if (proven && !have.some((h) => h.toLowerCase() === term.toLowerCase())) {
      have.push(rule ? rule.term : term);
    }
  }

  // The most recent job, named plainly.
  const roleLine = (() => {
    const m = text.match(
      /^(.{3,60}?)[,|•·–—]\s*(.{3,60}?)\s*[,|•·–—]?\s*(?:\b(?:19|20)\d{2})/m,
    );
    if (!m) return null;
    const a = m[1].trim();
    const b = m[2].trim();
    return /\b(inc|llc|co|corp|company|group|media|services|university)\b/i.test(b)
      ? { title: a, where: b }
      : { title: b, where: a };
  })();

  const parts = [];
  parts.push(
    company
      ? `I am applying for the ${title} position at ${company}.`
      : `I am applying for the ${title} position.`,
  );

  if (roleLine?.title) {
    parts.push(
      roleLine.where
        ? `Most recently I worked as ${roleLine.title} at ${roleLine.where}.`
        : `Most recently I worked as ${roleLine.title}.`,
    );
  }

  if (have.length) {
    const list =
      have.length > 1 ? `${have.slice(0, -1).join(", ")} and ${have[have.length - 1]}` : have[0];
    parts.push(
      `The posting asks for ${list}, which is the work I have spent the most time on.`,
    );
  }

  if (/excite|interest|why (this|our)|drew you|attract/.test(q)) {
    parts.push(
      have.length
        ? `What interests me about this one is that it is built around ${have[0]} rather than treating it as a side duty.`
        : `What interests me is the scope of the role and the chance to do this work full time.`,
    );
  }

  if (/why (are )?(you )?(applying|interested)|why us|why (do )?you want/.test(q)) {
    parts.push(
      company
        ? `I am looking for a role where that experience is used day to day, and this one at ${company} reads that way.`
        : `I am looking for a role where that experience is used day to day, and this one reads that way.`,
    );
  }

  if (/tell us about (yourself|you)|describe yourself|background/.test(q)) {
    parts.push(`I would bring that experience, and I learn a new system quickly.`);
  }

  // Always have something to say.
  //
  // A values question — "our purpose is economic empowerment, briefly tell us
  // what that means to you" — matches none of the shapes above and has no
  // requirement overlap to cite, so it came out one sentence long and was
  // thrown away as too thin. It then turned up on the answers page waiting
  // for a human, which is the opposite of the point: the person cannot answer
  // it generically either, because the answer belongs to one employer.
  //
  // This says only what the resume supports — the role applied for, the work
  // actually done, and that it is the lens being brought. It claims no skill,
  // employer or credential that is not already there.
  if (parts.length < 3) {
    const subject =
      q.match(/(?:purpose|mission|values?|culture)\s+is\s+([^.?!]{4,60})/i)?.[1] ??
      q.match(/what\s+(?:that|this)\s+([\w\s]{3,40}?)\s+means?\s+to\s+you/i)?.[1] ??
      null;
    if (subject) {
      const tidy = subject.trim().replace(/\s+/g, " ");
      parts.push(
        `${tidy.charAt(0).toUpperCase()}${tidy.slice(1)} is something I have seen up close rather ` +
          `than in the abstract, and it is the part of this role I would care about most.`,
      );
    }
    parts.push(
      have.length
        ? `The work I have done has been hands-on — ${have[0]} in particular — and that is what I would bring to it.`
        : `The experience I would bring is practical rather than theoretical, built doing the work directly.`,
    );
  }

  let answer = parts.join(" ").replace(/\s+/g, " ").trim();
  if (answer.split(/\s+/).length < 12) return null; // nothing usable at all

  const cap = Number(maxLength) || 0;
  if (cap > 40 && answer.length > cap) {
    // Trim on a sentence, never mid-word.
    const cut = answer.slice(0, cap);
    const end = cut.lastIndexOf(". ");
    answer = end > 60 ? cut.slice(0, end + 1) : cut.trimEnd();
  }
  return answer;
}
