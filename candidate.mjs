/**
 * What a person has confirmed about themselves beyond their resume.
 *
 * A resume is a page. The person behind it has usually done more than fits
 * on it, and a posting often asks for something they have and never wrote
 * down. This system does not guess at that. Where postings keep asking for
 * a named skill the person's material nowhere shows, it asks them — once,
 * on the Answers page they already use — and only a Yes from them makes it
 * part of what the tailoring may draw on.
 *
 * Kept in the answers table, so there is nothing new to store or to show:
 *   question  "About you: do you have real experience with SQL? …"
 *   answer    "Yes - wrote the weekly sales queries at …"   (or "No")
 */
export const ABOUT_YOU = "About you:";

const flat = (t) => String(t ?? "").toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();

export const qualQuestion = (term, postings) =>
  `${ABOUT_YOU} do you have real experience with ${term}? ${postings} posting(s) matched to you ask for it and nothing on your profile shows it. Answer Yes and say where in a line, or No.`;
export const qualKey = (term) => flat(`${ABOUT_YOU} do you have real experience with ${term}`).slice(0, 200);

const KEY = /^about you do you have real experience with (.+)$/;

/** Every qualification question already on the page, answered or not: term -> "yes" | "no" | "waiting". */
export function askedQualifications(rows) {
  const out = new Map();
  for (const r of rows ?? []) {
    const m = flat(r.q_key ?? "").match(KEY);
    if (!m) continue;
    const a = String(r.answer ?? "").trim();
    out.set(m[1], r.confirmed && /^y(es)?\b/i.test(a) ? "yes" : r.confirmed && a ? "no" : "waiting");
  }
  return out;
}

/** What the person has said Yes to: the term, and their own line about it. */
export function confirmedQualifications(rows) {
  const out = [];
  for (const r of rows ?? []) {
    const m = flat(r.q_key ?? "").match(KEY);
    if (!m || r.confirmed === false) continue;
    const a = String(r.answer ?? "").trim();
    if (!/^y(es)?\b/i.test(a)) continue;
    out.push({ term: m[1], detail: a.replace(/^y(es)?\b[\s,.:;–—-]*/i, "").trim().slice(0, 300) });
  }
  return out;
}

/** The same, as lines of the person's own material. */
export const qualificationLines = (quals) => (quals ?? []).map((q) => (q.detail ? `${q.term}: ${q.detail}` : q.term)).join("\n");
