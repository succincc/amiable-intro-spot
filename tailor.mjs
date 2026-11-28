// A resume written for one posting, at the moment it is needed.
//
// The panel writes tailored resumes in batches of ten when it scores, and
// only for jobs still waiting in the queue. With hundreds of postings and a
// free model that is often busy, most applications reached the form before
// their turn came — and went in with the general resume instead. The follow-
// up email then attached that same general resume, and the owner noticed.
//
// So the applier no longer depends on the batch. If a job arrives without
// its own resume, one is written here, for that posting, before anything is
// filled in; it is saved back to the job so the email that follows carries
// the same document.
//
// The rules are the panel's rules (src/lib/score.server.ts) and must stay in
// step with them. What is added here is a check after the writing: the model
// is asked not to invent, and then what it returns is compared with what the
// owner actually gave it. A role at an employer that appears nowhere in the
// source is removed. A bullet carrying a number the source does not contain
// is removed. A school that is not in the source is removed. The page can
// lose a line that way; it cannot gain a claim.

import { fenced, asInformation, ordersIn, soundAnswer, FENCE_RULE } from "./untrusted.mjs";
import { geminiForTitles } from "./answers.mjs";
import { requirementTerms, NAMED_TERMS } from "./ats.mjs";

export const TAILOR_PROMPT = `Rewrite this candidate's resume for this specific job so
that an applicant tracking system scores it as high as the candidate's REAL
experience can honestly support, and so that the person who reads it next
wants to pick up the phone.

NEVER:
- invent employers, job titles, dates, degrees, certifications or numbers
- claim a skill, tool or responsibility the source does not evidence
- repeat keywords unnaturally, or list a term the candidate cannot discuss

ALWAYS, because this is what the screener measures:
- Use the posting's EXACT wording for anything the candidate genuinely did.
  If they "handled upset customers" and the posting says "de-escalation",
  write de-escalation. Same work, the employer's words.
- Give every acronym once with its expansion: "SQL (Structured Query
  Language)", "POS (point of sale)". Screeners match one or the other.
- Open with a headline that matches the posted title where their experience
  honestly supports it.
- Work the posting's required skills in wherever the source evidences them,
  in the posting's phrasing, in the bullet where they actually did it.
- Put the most relevant role and bullets first. Drop detail this job does
  not care about.
- Keep tense, person and formatting plain: no tables, columns or graphics,
  standard section headings, dates as "Mon YYYY - Mon YYYY".

AND, because a person reads it after the screener:
- Every bullet is an accomplishment, not a duty. Say what was done, at what
  scale, and what came of it. "Responsible for inventory" is a duty; "Ran
  weekly inventory counts across a 20,000-item store, keeping shrink under
  target" is an accomplishment — when the source supports each part of it.
- Lead each role with the bullet this employer would most want to see.
- The summary says, in the employer's terms, who this is and why they suit
  THIS role. No "results-driven", "team player", "proven track record".

ONE PAGE. The finished resume is printed on a single page, so write to fit:
- summary: at most 45 words
- skills: at most 3 categories, at most 9 terms each
- experience: at most 4 roles. The most relevant role gets up to 5 bullets,
  the next up to 4, any others 2 or 3.
- every bullet: one sentence of at most 24 words that opens with a strong
  verb. Where the source gives a number, a scale or a result, lead with it.
  Never write a number it does not give.
- education: one line each

IF A LIST OF "ALL ROLES HELD" FOLLOWS THE RESUME: that list is the complete
record of the candidate's jobs, and more of them than fit on a page. Choose
the roles that bear most on this posting — usually three or four — and write
those. Leave the others off entirely. A role that is chosen must carry its
company, title and dates exactly as the list gives them, and its bullets may
only say what that role's own notes or the resume support.

For a requirement the candidate does NOT meet, say nothing about it. Do not
hedge, do not imply, do not pad. An honest resume with the employer's own
vocabulary beats a padded one, and it survives the interview.

Return ONLY JSON with these keys:
  "headline": the title line under the name, matched to the posting where honest
  "summary": 2-3 sentence professional summary aimed at this job
  "skills": object of category -> comma-separated string, led by the terms
            this posting asks for that the candidate genuinely has
  "experience": array of { "company", "title", "dates", "bullets": [string] }
  "education": array of { "school", "degree", "dates" }
No text outside the JSON.`;

export function extractObject(text) {
  const t = String(text ?? "");
  const fenced = t.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  const raw = fenced?.[1] ?? t.match(/\{[\s\S]*\}/)?.[0];
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const squash = (s) => String(s ?? "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "");

/**
 * Hold what the model wrote against what it was given. Returns the cleaned
 * data and a count of what was taken out, or null if no role survives.
 */
export function checkAgainstSource(data, source) {
  if (!data || !Array.isArray(data.experience)) return null;
  const flatSource = squash(source);
  const digits = new Set((String(source).match(/\d[\d,.]*/g) ?? []).map((n) => n.replace(/[,.]+$/, "").replace(/,/g, "")));
  const numberOk = (n) => {
    const v = n.replace(/[,.]+$/, "").replace(/,/g, "");
    // Years and small counts written out in the source as words pass as they
    // are common in dates and "two years"; anything else has to be there.
    return digits.has(v) || /^(19|20)\d{2}$/.test(v);
  };
  const removed = { roles: 0, bullets: 0, schools: 0 };

  const experience = [];
  for (const e of data.experience) {
    const company = squash(e?.company);
    if (!company || company.length < 2 || !flatSource.includes(company)) {
      removed.roles++;
      continue;
    }
    const bullets = [];
    for (const b of Array.isArray(e.bullets) ? e.bullets : []) {
      const line = String(b ?? "").replace(/^[-•*]\s*/, "").trim();
      if (!line) continue;
      const nums = line.match(/\d[\d,.]*/g) ?? [];
      if (!nums.every(numberOk)) {
        removed.bullets++;
        continue;
      }
      bullets.push(line);
    }
    experience.push({ company: String(e.company).trim(), title: String(e.title ?? "").trim(), dates: String(e.dates ?? "").trim(), bullets });
  }
  if (!experience.length) return null;

  const education = [];
  for (const e of Array.isArray(data.education) ? data.education : []) {
    const school = squash(e?.school);
    if (!school || !flatSource.includes(school)) {
      removed.schools++;
      continue;
    }
    education.push({ school: String(e.school).trim(), degree: String(e.degree ?? "").trim(), dates: String(e.dates ?? "").trim() });
  }

  // A summary that carries a number the source does not is not kept either.
  const summary = String(data.summary ?? "").trim();
  const summaryOk = (summary.match(/\d[\d,.]*/g) ?? []).every(numberOk);

  return {
    data: {
      headline: String(data.headline ?? "").trim().slice(0, 90),
      summary: summaryOk ? summary : "",
      skills: data.skills && typeof data.skills === "object" && !Array.isArray(data.skills) ? data.skills : {},
      experience,
      education,
    },
    removed,
  };
}

/** The same layout the panel writes, which the PDF renderer reads back. */
export function renderResume(data, profile) {
  const out = [];
  out.push(profile.full_name ?? "");
  const headline = data.headline || profile.target_role;
  if (headline) out.push(headline);
  const contact = [profile.email, profile.phone, [profile.city, profile.state].filter(Boolean).join(", "), profile.linkedin_url]
    .filter(Boolean)
    .join(" | ");
  if (contact) out.push(contact);
  out.push("");

  if (data.summary) out.push("SUMMARY", String(data.summary), "");

  const skills = Object.entries(data.skills ?? {}).filter(([, v]) => String(v ?? "").trim());
  if (skills.length) {
    out.push("SKILLS");
    for (const [k, v] of skills.slice(0, 4)) out.push(`${k}: ${v}`);
    out.push("");
  }

  if (data.experience?.length) {
    out.push("EXPERIENCE");
    for (const e of data.experience) {
      const head = [e.company, e.title].filter(Boolean).join(" - ");
      out.push(e.dates ? `${head} (${e.dates})` : head);
      for (const b of e.bullets ?? []) out.push(`- ${b}`);
      out.push("");
    }
  }

  if (data.certifications?.length) {
    out.push("CERTIFICATIONS");
    for (const c of data.certifications) out.push(c.dates ? `${c.name} (${c.dates})` : c.name);
    out.push("");
  }

  if (data.education?.length) {
    out.push("EDUCATION");
    for (const e of data.education) {
      const line = [e.school, e.degree].filter(Boolean).join(" - ");
      out.push(e.dates ? `${line} (${e.dates})` : line);
    }
  }
  return out.join("\n").trim();
}

const MON = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.?";
const DATE_LINE = new RegExp(
  `^(?:${MON}\\s+)?(?:19|20)\\d{2}\\s*(?:-|–|—|to)\\s*(?:(?:${MON}\\s+)?(?:19|20)\\d{2}|present|current|now)$`,
  "i",
);
// A degree, not a job with a similar word in it: "Associate of Arts" is one,
// "Sales Associate" and "Scrum Master" are not.
const DEGREE_WORD = /\b(bachelor'?s?|doctorate|ph\.?d|mba|diploma|ged)\b|\b(associate|master)'?s?\s+(of|in|degree)\b|\b(associate|master)'s\b/i;
const DEGREE_LETTERS = /(^|[\s,(])(B\.?A\.?|B\.?S\.?|M\.?A\.?|M\.?S\.?|A\.?A\.?|A\.?S\.?)(?=[\s,)]|$)/;
const DEGREE = { test: (t) => DEGREE_WORD.test(t) || DEGREE_LETTERS.test(t) };

/**
 * Put a resume that has no headings into the standard layout, without a
 * model.
 *
 * Text taken from an uploaded PDF usually arrives as one field per line —
 * a title, a place, an employer, a date range, then the lines of that job —
 * with no "EXPERIENCE" above it and no bullet marks. Printed as it stands it
 * is a column of loose lines, which is what went out whenever the model was
 * busy. The date ranges are the one dependable landmark: the three lines
 * above each are the title, place and organisation, and what follows, up to
 * the next such group, belongs to it.
 *
 * Returns the same shape the model returns, or null when the text does not
 * have that structure (in which case it is left exactly as it is).
 */
export function structureResume(text, profile = {}) {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l && !/^page \d+( of \d+)?$/i.test(l));
  if (lines.length < 8) return null;
  // Already under headings: the renderer reads that as it is.
  if (lines.filter((l) => /^(experience|work experience|professional experience|employment|education|skills|summary)\b/i.test(l) && l.length < 40).length >= 2) return null;

  const dates = [];
  lines.forEach((l, i) => {
    if (DATE_LINE.test(l)) dates.push(i);
  });
  // A group needs its three lines above it, each short and not a sentence.
  const short = (l) => l && l.length <= 90 && !/[.!?]$/.test(l);
  const groups = dates.filter((d) => d >= 3 && short(lines[d - 1]) && short(lines[d - 2]) && short(lines[d - 3]));
  if (!groups.length) return null;

  const experience = [];
  const education = [];
  let tailFrom = lines.length;
  groups.forEach((d, k) => {
    const end = k + 1 < groups.length ? groups[k + 1] - 3 : lines.length;
    const body = lines.slice(d + 1, end);
    const [title, place, org] = [lines[d - 3], lines[d - 2], lines[d - 1]];
    if (DEGREE.test(title)) {
      education.push({ school: org, degree: title, dates: lines[d] });
      // Whatever follows the last school is certifications and skills.
      if (k === groups.length - 1) tailFrom = d + 1;
    } else {
      experience.push({ company: org, title, location: place, dates: lines[d], bullets: body.filter((b) => b.length > 20) });
      if (k === groups.length - 1) tailFrom = lines.length;
    }
  });
  if (!experience.length) return null;

  // Above the first group: the name and contact lines, then the summary.
  const top = lines.slice(0, groups[0] - 3);
  const summary = top.filter((l) => l.length > 90).join(" ");

  const certifications = [];
  const skills = [];
  const seen = new Set();
  const tail = lines.slice(tailFrom);
  for (let i = 0; i < tail.length; i++) {
    const l = tail[i];
    const dated = l.match(/^(.*?)\s*\(?((?:19|20)\d{2}\s*(?:-|–|—)\s*(?:19|20)\d{2})\)?$/);
    const name = (dated ? dated[1] : l).trim();
    const key = name.toLowerCase();
    if (/certif|licen[cs]e|certificate/i.test(l) || dated) {
      if (!name) continue;
      const at = certifications.findIndex((c) => c.name.toLowerCase() === key);
      if (at >= 0) {
        if (dated && !certifications[at].dates) certifications[at].dates = dated[2];
      } else {
        certifications.push({ name, dates: dated ? dated[2] : "" });
      }
      continue;
    }
    if (l.length <= 40 && !seen.has(key)) {
      seen.add(key);
      skills.push(l);
    }
  }

  return {
    headline: String(profile.target_role ?? "").trim(),
    summary,
    skills: skills.length ? { Tools: skills.join(", ") } : {},
    experience,
    education,
    certifications,
  };
}

/** The resume on file, in the standard layout where it can be put into it. */
export function standardResume(text, profile) {
  const data = structureResume(text, profile);
  return data ? renderResume(data, profile) : String(text ?? "");
}

/**
 * What this candidate has that this posting asks for, by name.
 *
 * Two sources, both the owner's own: a skill this file knows by name
 * ("inventory management") counts when the posting asks for it and the
 * resume's own words carry it — every word of it, not a loose hint — and a
 * skill the owner listed counts when the posting uses the same word. Nothing
 * the resume does not say is ever named.
 */
export function strengthsFor(job, data, bankRows = [], limit = 5) {
  const posting = String(job?.description ?? "").toLowerCase();
  if (!posting.trim()) return [];
  const source = [
    data?.summary,
    ...Object.values(data?.skills ?? {}),
    ...(data?.experience ?? []).flatMap((e) => [e.title, ...(e.bullets ?? [])]),
    ...(bankRows ?? []).flatMap((r) => [r?.title, r?.details]),
  ]
    .map((x) => String(x ?? ""))
    .join(" \n ")
    .toLowerCase();
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const weightOf = new Map(requirementTerms(job?.description ?? "", 90, job?.company ?? "").map((t) => [String(t.term).toLowerCase(), t.weight]));
  const out = [];
  const add = (label, w) => {
    if (!out.some((o) => o.label.toLowerCase() === label.toLowerCase())) out.push({ label, w });
  };
  for (const name of NAMED_TERMS) {
    const w = weightOf.get(name.toLowerCase());
    if (!w) continue;
    const words = name.toLowerCase().split(/[^a-z0-9&+#]+/).filter((x) => x.length > 1 && x !== "and" && x !== "of");
    const said = words.length > 0 && words.every((x) => (x.length <= 4 ? new RegExp(`(^|[^a-z0-9])${esc(x)}([^a-z0-9]|$)`).test(source) : source.includes(x.slice(0, 5))));
    if (said) add(name, w);
  }
  for (const v of Object.values(data?.skills ?? {})) {
    for (const item of String(v).split(/\s*,\s*/)) {
      const it = item.trim();
      if (it.length < 3 || it.length > 32) continue;
      if (new RegExp(`(^|[^a-z0-9])${esc(it.toLowerCase())}([^a-z0-9]|$)`).test(posting)) add(it, 2 + (weightOf.get(it.toLowerCase()) ?? 0));
    }
  }
  return out
    .sort((a, b) => b.w - a.w)
    .slice(0, limit)
    .map((o) => o.label);
}

// "inventory management" as a heading reads "Inventory Management"; a name
// that already carries its own capitals ("SQL", "Microsoft Excel") is left.
const asHeading = (t) => (/[A-Z]/.test(t) ? t : t.replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\b(And|Of)\b/g, (w) => w.toLowerCase()));
const inSentence = (t) => (/[A-Z]{2}|[A-Z].*[A-Z]/.test(t) ? t : t.toLowerCase());
const listed = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
// "Assistant Store Manager - Princeton, NJ (R-1234)" is the role "Assistant
// Store Manager".
const roleName = (title) =>
  String(title ?? "")
    .split(/\s[-–—|]\s|\s*\(|\s*,\s/)[0]
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);

/**
 * The resume arranged for one posting, with no model.
 *
 * The model rewrites; this only chooses and orders, which needs no one's
 * allowance and so can be done for every application without exception:
 *   - which roles go on the page, when there are more than fit (the current
 *     one always, then those whose work bears most on the posting);
 *   - which bullets each role keeps, and in what order — the ones that speak
 *     to what this employer is screening for come first;
 *   - which skills lead.
 * Every word on the result is the owner's own. Nothing is reworded here, so
 * nothing can be invented here.
 *
 * `bankRows` are the roles entered in settings; one not already on the
 * resume is a candidate like any other, its notes read as its bullets.
 */
export function arrangeForPosting(data, job, bankRows = []) {
  const terms = requirementTerms(job?.description ?? "", 60, job?.company ?? "");
  if (!data?.experience?.length || !terms.length) return null;
  const titleWords = String(job?.title ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3);
  const score = (text) => {
    const t = String(text ?? "").toLowerCase();
    let n = 0;
    for (const { term, weight } of terms) if (t.includes(String(term).toLowerCase())) n += weight;
    for (const w of titleWords) if (t.includes(w)) n += 1;
    return n;
  };
  const latest = (dates) => (/present|current|now/i.test(String(dates)) ? 9999 : Math.max(0, ...(String(dates).match(/(19|20)\d{2}/g) ?? []).map(Number)));

  const roles = data.experience.map((e) => ({ ...e, bullets: [...(e.bullets ?? [])] }));
  for (const r of bankRows ?? []) {
    if (!r?.company || !r?.title) continue;
    if (roles.some((e) => squash(e.company) === squash(r.company) && squash(e.title) === squash(r.title))) continue;
    const bullets = String(r.details ?? "")
      .split(/\r?\n|(?<=[.!?])\s+/)
      .map((b) => b.replace(/^[-•*–·]\s*/, "").trim())
      .filter((b) => b.length > 25 && b.length < 260);
    if (!bullets.length) continue;
    roles.push({ company: r.company, title: r.title, dates: `${r.start_date || "?"} - ${r.end_date || "Present"}`, bullets });
  }

  let moved = 0;
  const ranked = roles.map((e, i) => {
    const order = e.bullets.map((b, k) => ({ b, k, s: score(b) })).sort((x, y) => y.s - x.s || x.k - y.k);
    moved += order.filter((o, k) => o.k !== k).length;
    return { e, i, order, weight: order.slice(0, 3).reduce((n, o) => n + o.s, 0) + 2 * score(e.title) };
  });

  // The current role stays whatever its score; the rest earn their place.
  const current = ranked.reduce((best, r) => (latest(r.e.dates) > latest(best.e.dates) ? r : best), ranked[0]);
  const others = ranked.filter((r) => r !== current).sort((x, y) => y.weight - x.weight || x.i - y.i);
  const kept = [current, ...others.slice(0, 3)];
  const leftOff = ranked.length - kept.length;
  const byWeight = [...kept].sort((x, y) => y.weight - x.weight);

  let dropped = 0;
  const experience = kept
    // Most recent first, as a resume is read.
    .sort((x, y) => latest(y.e.dates) - latest(x.e.dates) || x.i - y.i)
    .map((r) => {
      const cap = r === byWeight[0] ? 5 : r === byWeight[1] ? 4 : 3;
      dropped += Math.max(0, r.order.length - cap);
      return { company: r.e.company, title: r.e.title, dates: r.e.dates, bullets: r.order.slice(0, cap).map((o) => o.b) };
    });

  const skills = {};
  for (const [k, v] of Object.entries(data.skills ?? {})) {
    const items = String(v).split(/\s*,\s*/).filter(Boolean);
    skills[k] = items
      .map((it, n) => ({ it, n, s: score(it) }))
      .sort((x, y) => y.s - x.s || x.n - y.n)
      .map((o) => o.it)
      .join(", ");
  }

  // The two lines a reader sees first, written for this posting out of the
  // owner's own material: the title they hold, and the things they have done
  // that this employer is asking for. Without them the page was arranged for
  // the posting and still opened exactly as every other copy did.
  const strengths = strengthsFor(job, data, bankRows);
  let headline = data.headline;
  let summary = data.summary;
  if (strengths.length >= 2) {
    const held = String(current.e.title ?? "").trim();
    const where = String(current.e.company ?? "").trim();
    const still = /present|current|now/i.test(String(current.e.dates ?? ""));
    const role = roleName(job?.title);
    const employer = String(job?.company ?? "").trim();
    const aim = role ? `the ${role} role${employer ? ` at ${employer}` : ""}` : employer ? `the role at ${employer}` : "";
    const focus = listed(strengths.slice(0, 4).map(inSentence));
    if (held) headline = `${held} | ${strengths.slice(0, 3).map(asHeading).join(" · ")}`.slice(0, 110);
    const opening = held ? `${held}${where ? (still ? ` at ${where}` : `, most recently at ${where},`) : ""} with hands-on experience in ${focus}` : `Hands-on experience in ${focus}`;
    const written = String(data.summary ?? "").trim();
    if (written) {
      // The owner's own summary stays; one sentence is added to say why here.
      const kept = written.split(/(?<=[.!?])\s+/).slice(0, 2).join(" ");
      summary = `${kept}${/[.!?]$/.test(kept) ? "" : "."} Experience in ${focus}${aim ? ` is what ${aim} calls for` : ""}.`;
    } else {
      summary = `${opening}${aim ? `, the work at the centre of ${aim}` : ""}.`;
    }
  }

  return { data: { ...data, headline, summary, skills, experience }, moved, dropped, leftOff, strengths };
}

/**
 * What goes out when the model cannot write: the resume on file put into
 * the standard layout and arranged for this posting. Null when the resume
 * has no structure to arrange.
 */
export function arrangedResume(profile, job, bankRows = []) {
  const base = structureResume(profile?.resume_text, profile);
  if (!base) return null;
  const arranged = arrangeForPosting(base, job, bankRows);
  if (!arranged) return null;
  return { text: renderResume(arranged.data, profile), moved: arranged.moved, dropped: arranged.dropped, leftOff: arranged.leftOff };
}

/** The owner's full list of roles, as one block of text for the prompt. */
export function rolesText(rows) {
  return (rows ?? [])
    .map(
      (e) =>
        `${e.company} - ${e.title} (${e.start_date || "?"} - ${e.end_date || "Present"})` +
        `${e.location ? `, ${e.location}` : ""}\n${String(e.details ?? "").trim().slice(0, 1200)}`,
    )
    .join("\n\n")
    .slice(0, 7000);
}

/**
 * Write the resume for this posting. Returns { text, roles, bullets, removed }
 * or { text: null, why } when it could not be done.
 */
export async function tailorResume({ job, profile, roles = "", apiKey }) {
  const base = String(profile?.resume_text ?? "").trim();
  if (!apiKey) return { text: null, why: "no model key here" };
  if (!base) return { text: null, why: "no resume on file" };
  if (String(job?.description ?? "").trim().length < 200) return { text: null, why: "the posting has too little text to write to" };

  const source = base.slice(0, 8000) + (roles ? `\n\nALL ROLES HELD:\n${roles}` : "");
  let raw = "";
  try {
    raw = await geminiForTitles(
      `${TAILOR_PROMPT}\n\n${FENCE_RULE}\n\nJOB: ${asInformation(job.title, 120)} at ${asInformation(job.company ?? "", 80)}\nPOSTING:\n${fenced("POSTING", job.description, 4000)}\n\nCANDIDATE RESUME:\n${source}`,
      apiKey,
      // Generous: the newer models spend part of this thinking before they
      // write, and a page cut off mid-way cannot be used at all.
      8192,
    );
  } catch (e) {
    return { text: null, why: `the model failed: ${String(e?.message ?? e).slice(0, 40)}` };
  }
  const checked = checkAgainstSource(extractObject(raw), source);
  if (!checked) return { text: null, why: "what the model returned could not be used" };
  const bullets = checked.data.experience.reduce((n, e) => n + e.bullets.length, 0);
  if (bullets < 3) return { text: null, why: "too little survived the check against the source" };
  return {
    text: renderResume(checked.data, profile),
    roles: checked.data.experience.length,
    bullets,
    removed: checked.removed,
  };
}
