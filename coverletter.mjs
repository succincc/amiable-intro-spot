// A cover letter, where a form asks for one.
//
// Written for the posting from the person's own resume, and from nothing
// else: every claim in it is a line of their resume. The model writes it
// where its allowance lasts; where it does not, or where what it wrote
// cannot be stood behind, the letter is put together here from the resume's
// own lines that answer the posting. Either way it is a letter the person
// could sign: nothing invented, no placeholder left in, no figure that is
// not theirs.

import { geminiForTitles } from "./answers.mjs";

/** Is this box, or this upload, asking for a cover letter? */
export function isCoverLetter(label) {
  const l = String(label ?? "").toLowerCase();
  if (/\b(resume|cv)\b/.test(l) && !/cover/.test(l)) return false;
  return /cover[\s_-]*letter|coverletter|letter of (interest|introduction|motivation|intent)|motivation(al)? letter|introductory letter/.test(l);
}

// A word as the thing it names: "hired" and "hiring" are "hir", "staff." is
// "staff". Rough, and only ever used to tell which lines answer a posting.
const stem = (w) => w.replace(/[.\-]+$/, "").replace(/(ing|ed|es|s)$/, (m, _s, i) => (i >= 3 ? "" : m)).replace(/e$/, "");
const words = (t) => (String(t ?? "").toLowerCase().match(/[a-z][a-z+#.-]{2,}/g) ?? []).map(stem).filter((w) => w.length >= 3);
const STOP = new Set(["with", "that", "this", "from", "have", "will", "your", "their", "them", "they", "were", "been", "into", "more", "than", "other", "such", "each", "also", "able", "must", "work", "team", "role", "position", "company", "including", "ability", "skills", "experience", "years", "strong", "required", "preferred", "responsibilities", "qualifications"]);

/** The lines of a resume that say what was done: bullets and sentences, not headings or dates. */
export function resumeLines(resume) {
  return String(resume ?? "")
    .split(/\n/)
    .map((l) => l.replace(/^\s*[•●▪◦·\-*–]\s*/, "").replace(/\s+/g, " ").trim())
    .filter((l) => l.length >= 30 && l.length <= 240 && /[a-z]{3}\s[a-z]{2}/i.test(l) && !/@|https?:|\b\d{3}[-.)\s]\d{3}[-.\s]\d{4}\b/.test(l) && !/\|/.test(l));
}

/** The resume's own lines that best answer the posting, best first. */
export function proofFor(description, resume, most = 3) {
  const stop = new Set([...STOP].map(stem));
  const asked = new Set(words(description).filter((w) => !stop.has(w)));
  return resumeLines(resume)
    .map((line) => ({ line, hits: new Set(words(line).filter((w) => asked.has(w))).size }))
    .filter((x) => x.hits >= 2)
    .sort((a, b) => b.hits - a.hits || b.line.length - a.line.length)
    .slice(0, most)
    .map((x) => x.line);
}

/** A resume bullet as a sentence in a letter: "Ran a team of 12" is "I ran a team of 12." */
export function asSentence(line) {
  let t = String(line).replace(/[.;,\s]+$/, "");
  if (/^(i|my|we|our)\b/i.test(t)) return `${t[0].toUpperCase()}${t.slice(1)}.`;
  // A bullet opens with what was done, in the past: that reads as "I did".
  if (/^[A-Z][a-z]*(ed|ght|ilt|ew|an|old|ld|ore|ept|ent|ave|ook|ade|on|un|et|id)\b/.test(t)) return `I ${t[0].toLowerCase()}${t.slice(1)}.`;
  return `${t}.`;
}

/** The letter, from the resume's own lines and nothing else. Always answers. */
export function composeCoverLetter({ job, profile, resume }) {
  const name = String(profile?.full_name ?? "").trim();
  const title = String(job?.title ?? "").trim();
  const company = String(job?.company ?? "").trim();
  const proof = proofFor(job?.description, resume, 3);
  const lines = proof.length ? proof : resumeLines(resume).slice(0, 2);
  const start = String(profile?.earliest_start ?? "").trim();
  const reach = [profile?.phone, profile?.email].map((v) => String(v ?? "").trim()).filter(Boolean).join(" or ");
  return [
    "Dear Hiring Manager,",
    "",
    `I am applying for ${title ? `the ${title} position` : "the open position"}${company ? ` at ${company}` : ""}. My resume is attached, and the part of it that matters most for this role is below.`,
    "",
    lines.length ? lines.map(asSentence).join(" ") : "My resume sets out the work I have done and the results of it.",
    "",
    `${proof.length ? "That is the kind of work your posting describes, and it is work I would like to do for you. " : ""}${start ? `I am available to start ${/^immediately$/i.test(start) ? "immediately" : start.toLowerCase()}. ` : ""}${reach ? `I can be reached at ${reach} and ` : "I "}would welcome the chance to talk.`,
    "",
    "Thank you for your time.",
    "",
    "Sincerely,",
    name || "",
  ].join("\n").trim();
}

/** Can a letter the model wrote be signed as it stands? */
export function standsBehind(letter, { resume, job, profile }) {
  const t = String(letter ?? "");
  const count = t.split(/\s+/).filter(Boolean).length;
  if (count < 90 || count > 420) return false;
  // A blank left to fill in, or the model talking about itself.
  if (/\[[^\]]{2,40}\]|\{[^}]{2,40}\}|<[^>]{2,40}>|\bas an ai\b|\byour name\b|\bcompany name\b/i.test(t)) return false;
  // A figure that is not on the resume, in the posting, or the person's own.
  const known = `${resume ?? ""} ${job?.description ?? ""} ${job?.title ?? ""} ${profile?.phone ?? ""} ${profile?.email ?? ""} ${profile?.earliest_start ?? ""}`;
  for (const n of t.match(/\d[\d,.]*%?/g) ?? []) {
    const bare = n.replace(/[,.%]+$/, "");
    if (bare.length >= 2 && !known.includes(bare)) return false;
  }
  return true;
}

const PROMPT = `Write a cover letter for a job application.

RULES
- Use ONLY facts found in the RESUME below. Do not invent employers, titles, numbers, degrees, tools or achievements. If the resume does not show something the posting asks for, leave it out.
- 170 to 230 words. Plain text. No headings, no bullet points, no markdown.
- Open with "Dear Hiring Manager," and end with "Sincerely," followed by the applicant's name on its own line.
- First paragraph: the position and company, and one sentence on why the applicant fits. Middle: two or three specific things from the resume that answer what this posting asks for, in the posting's own wording where the resume supports it. Last: availability if given, and a plain request to talk.
- First person. Warm and direct. No clichés ("I am writing to express my interest", "team player", "passionate"). No placeholders or brackets of any kind.

APPLICANT NAME: {NAME}
POSITION: {TITLE}
COMPANY: {COMPANY}
AVAILABLE TO START: {START}

POSTING
{POSTING}

RESUME
{RESUME}`;

/** The letter: the model's where it can be stood behind, the composed one otherwise. */
export async function writeCoverLetter({ job, profile, resume, apiKey }) {
  if (apiKey && String(resume ?? "").trim().length > 200) {
    try {
      const raw = await geminiForTitles(
        PROMPT.replace("{NAME}", String(profile?.full_name ?? "").trim() || "the applicant")
          .replace("{TITLE}", job?.title || "the open position")
          .replace("{COMPANY}", job?.company || "the company")
          .replace("{START}", String(profile?.earliest_start ?? "").trim() || "not stated")
          .replace("{POSTING}", String(job?.description ?? "No posting text available.").slice(0, 3000))
          .replace("{RESUME}", String(resume).slice(0, 4500)),
        apiKey,
        900,
      );
      const letter = String(raw ?? "").replace(/^(here'?s?|here is|sure[,!]?|certainly[,!]?)[^\n]*\n+/i, "").replace(/\*\*/g, "").replace(/^#+\s*/gm, "").trim();
      if (standsBehind(letter, { resume, job, profile })) return { text: letter, by: "model" };
    } catch {
      /* the allowance is spent, or the model is away: the composed letter stands in */
    }
  }
  return { text: composeCoverLetter({ job, profile, resume }), by: "rules" };
}
