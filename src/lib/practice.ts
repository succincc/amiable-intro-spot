// ============================================================================
// practice.ts — an interviewer to practise against.
//
// The interview is the one step that has to be the owner. This gets them
// into it prepared: questions drawn from the posting they are interviewing
// for and from their own resume, asked aloud by the browser's own voice,
// and a plain reading of each answer afterwards. Nothing here is a model
// and nothing costs anything; every rule is a function with a test.
// ============================================================================

import { requirementsMet } from "@/lib/moments";

export type Question = { ask: string; about: "opening" | "requirement" | "gap" | "behaviour" | "closing"; from?: string };

const BEHAVIOUR = [
  "Tell me about a time something went wrong at work. What did you do?",
  "Tell me about a disagreement with a coworker or a manager, and how it ended.",
  "Describe a time you had more to do than time to do it. How did you decide what came first?",
  "Tell me about something you improved that nobody asked you to.",
];

/**
 * The questions for one posting: an opening, one for each thing the posting
 * asks for (worded differently where the resume shows it and where it does
 * not), a few about how the owner works, and a close.
 */
export function questionsFor(job: { title?: string | null; company?: string | null; description?: string | null } | null, resume: string | null | undefined, max = 9): Question[] {
  const role = job?.title ? `the ${job.title} role` : "this role";
  const out: Question[] = [{ ask: `Tell me about yourself, and why ${role}${job?.company ? ` at ${job.company}` : ""}.`, about: "opening" }];
  for (const r of requirementsMet(job?.description, resume, 5)) {
    const thing = r.line.replace(/[.;:]+$/, "");
    out.push(
      r.shown
        ? { ask: `The posting asks for this: "${thing}". Give me a specific example from your own work.`, about: "requirement", from: r.line }
        : { ask: `The posting asks for this: "${thing}". Your resume does not show it. What would you say to that?`, about: "gap", from: r.line },
    );
  }
  for (const b of BEHAVIOUR) {
    if (out.length >= max - 1) break;
    out.push({ ask: b, about: "behaviour" });
  }
  out.push({ ask: "What questions do you have for me?", about: "closing" });
  return out.slice(0, max);
}

const words = (t: string): string[] => String(t ?? "").toLowerCase().match(/[a-z][a-z'+#]{2,}/g) ?? [];

/**
 * A plain reading of one spoken or typed answer. Not a score of the person:
 * a list of what the answer had and what it was missing, said so that the
 * next attempt is better.
 */
export function readAnswer(q: Question, answer: string, resume?: string | null): { good: string[]; fix: string[] } {
  const a = String(answer ?? "").trim();
  const w = words(a);
  const good: string[] = [];
  const fix: string[] = [];
  if (w.length < 25) fix.push("Too short to judge you by. Aim for about a minute: what the situation was, what you did, what came of it.");
  else if (w.length > 320) fix.push("Long. Past two minutes an interviewer stops listening; cut the setup and keep what you did.");
  else good.push("A good length.");

  if (q.about === "closing") {
    if (/\?/.test(a) || /\b(what|how|who|when|why|could you|can you)\b/i.test(a)) good.push("You asked something, which is what this question is for.");
    else fix.push("Have two questions ready: what the first ninety days look like, and how success in the role is measured.");
    return { good, fix };
  }
  if (/\b(i|i've|i'd|my)\b/i.test(a) && /\b(led|built|ran|managed|made|fixed|trained|sold|handled|organi[sz]ed|reduced|increased|opened|closed|solved|wrote|set up|took)\b/i.test(a)) good.push("You said what you did, in the first person.");
  else if (w.length >= 25) fix.push("Say what YOU did. 'We' and 'the team' hide your part.");

  if (/\d/.test(a) || /\b(half|double|twice|every|weekly|daily|percent|hundred|thousand|dozen)\b/i.test(a)) good.push("You gave a number or a scale.");
  else if (w.length >= 25 && q.about !== "opening") fix.push("No number in it. How many, how much, how often, how long? One figure makes it real.");

  if (/\b(so|as a result|which meant|in the end|after that|resulted|outcome|led to|ended)\b/i.test(a)) good.push("You said how it ended.");
  else if (w.length >= 25 && q.about !== "opening") fix.push("It has no ending. Finish with what came of it.");

  if (q.from) {
    const need = words(q.from).filter((x) => x.length > 4 && !["experience", "ability", "years", "strong", "skills", "including", "required", "preferred", "knowledge"].includes(x));
    const hit = need.filter((x) => w.includes(x));
    if (need.length && hit.length / need.length >= 0.25) good.push("You used the posting's own words, which is what they are listening for.");
    else if (need.length) fix.push(`You did not touch what they asked about. Their words: ${need.slice(0, 4).join(", ")}.`);
  }
  if (q.about === "gap") {
    if (/\b(haven't|have not|no direct|not yet|new to)\b/i.test(a) && /\b(but|however|closest|similar|learn|picked up|taught myself)\b/i.test(a)) good.push("You were honest about the gap and said what is closest to it.");
    else fix.push("For something your resume does not show: say so plainly, then the nearest thing you have done and how fast you picked that up. Do not claim it.");
  }
  // A better example may be sitting on the resume unused.
  if (q.about === "requirement" && resume && q.from) {
    const line = String(resume).split(/\n|•/).map((x) => x.trim()).find((x) => x.length > 30 && words(q.from ?? "").filter((k) => k.length > 4 && words(x).includes(k)).length >= 2);
    if (line && !words(line).filter((k) => k.length > 5).some((k) => w.includes(k))) fix.push(`Your resume has an example you did not use: "${line.slice(0, 140)}"`);
  }
  return { good, fix };
}
