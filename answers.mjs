// ============================================================================
// answers.mjs — writes the open-ended answers, so you never get asked.
//
// "Why do you want to work at Target?" and "Why are you a good fit for this
// specific role?" are the questions that stall an automated application.
// They cannot be answered from a profile field, and a canned paragraph reads
// like one.
//
// THE TRAP THIS FILE EXISTS TO AVOID:
//
// The obvious implementation caches every generated answer and reuses it on
// the next form with a similar question. That quietly puts the Target answer
// on a JPMorgan application — "I have long admired Target's commitment to..."
// submitted to a bank. One wrong paragraph like that is worse than a hundred
// blank fields, because it is visible to a human and unmistakable.
//
// So answers are classified before anything is stored: generic ones are
// cached and reused, employer-specific ones are generated fresh every time
// and never saved.
// ============================================================================

// Google retires these on its own schedule: 2.0-flash went away with the
// message "no longer available. Please update your code to use
// models/gemini-3.8-flash". GEMINI_MODEL overrides this without a code change.
// This file runs standalone in GitHub Actions and cannot import the app's
// TypeScript, so it keeps its own copy of the retry below.
// Everything printed here goes through the nets in quiet.mjs: this log is public.
import "./quiet.mjs";
let MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";

/**
 * Does this question's answer depend on WHICH company is asking?
 *
 * Erring toward "yes" only costs an extra model call. Erring toward "no"
 * sends the wrong company's name to an employer.
 */
export function isEmployerSpecific(question, company) {
  const q = (question || "").toLowerCase();

  if (company) {
    const words = company.toLowerCase()
      .replace(/\b(inc|llc|ltd|corp|corporation|company|co|group|holdings)\b/g, "")
      .split(/[^a-z0-9]+/).filter((w) => w.length > 2);
    if (words.some((w) => q.includes(w))) return true;
  }

  // Phrases that point at the employer asking, rather than at the candidate.
  // Matched as regex so an adjective can sit in the middle: "this role" has
  // to catch "this specific role" and "this particular position" too, which
  // plain substring matching misses.
  const pointsAtEmployer = [
    /\bthis\s+(?:\w+\s+){0,2}(role|position|job|team|company|opportunity|organi[sz]ation|firm)\b/,
    /\bour\s+(?:\w+\s+){0,2}(company|team|mission|values|culture|organi[sz]ation|firm)\b/,
    /\bwork(?:ing)?\s+(?:here|for us|with us)\b/,
    /\bjoin\s+(?:us|our)\b/,
    /\babout\s+us\b/,
    /\bwhy\s+us\b/,
    /\b(interested|drawn|attracted)\s+(?:in|to)\s+this\b/,
    /\bgood\s+fit\s+for\s+this\b/,
    /\bwhy\s+(?:do|are|would)\s+you\b.*\b(here|this|us|our)\b/,
  ];

  return pointsAtEmployer.some((re) => re.test(q));
}

// "The model is overloaded" — Google's own wording — is a 503 that clears on
// its own in a second or two. Without a retry it leaves every open-ended
// question on a form unanswered, which parks the whole application.
const TRANSIENT = new Set([408, 500, 502, 503, 504, 522, 524, 525]);

// Models that have answered 429, and when. A per-minute limit clears in a
// minute, so one is tried again after that; a daily limit will simply say
// 429 again and be set aside again.
const SPENT = new Map();
let OFFERED = null;

/** The text models this key may call, as Google lists them — never a guess. */
async function offeredModels(apiKey) {
  if (OFFERED) return OFFERED;
  OFFERED = [];
  try {
    const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", {
      headers: { "x-goog-api-key": apiKey },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      const j = await res.json();
      OFFERED = (j.models ?? [])
        .filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
        .map((m) => String(m.name ?? "").replace(/^models\//, ""))
        // The quick general-purpose ones; not speech, image, embedding or
        // experimental variants.
        .filter((n) => /^gemini-/.test(n) && /flash/.test(n) && !/tts|image|audio|live|embed|vision|exp|thinking|native|robotics|computer/.test(n))
        // Plain "flash" before "flash-lite", newest version first.
        .sort((a, b) => Number(/lite/.test(a)) - Number(/lite/.test(b)) || b.localeCompare(a, undefined, { numeric: true }));
    }
  } catch {
    /* no list; there is nothing to fall back to */
  }
  return OFFERED;
}

async function anotherModel(apiKey) {
  SPENT.set(MODEL, Date.now());
  const list = await offeredModels(apiKey);
  return list.find((m) => !SPENT.has(m) || Date.now() - SPENT.get(m) > 70_000) ?? null;
}

// How many times one request may be handed to another model before it is
// given up. Without a limit, a day when every free model is busy turns into
// a loop: each becomes eligible again after its minute, and the request
// goes round them for ever while the job it belongs to waits.
const MAX_HOPS = 5;

async function geminiOnly(prompt, apiKey, maxTokens = 600, attempt = 0, temperature = 0.6, hops = 0) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // The key goes in a header, never in the URL. Query strings end up in
        // proxy logs, error reports and the GitHub Actions run log, and this
        // one runs in CI where that log is retained.
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature, maxOutputTokens: maxTokens },
      }),
      // Without a limit a request that never answers is held for five
      // minutes by the runtime's own default, and one such request took five
      // of the twelve minutes an application is allowed.
      signal: AbortSignal.timeout(90_000),
    },
  );
  if (res.status === 429) {
    // The free tier counts each model separately, and a key with no billing
    // on it cannot be charged — past its allowance a model simply answers
    // 429. So when one is used up, ask the next free one instead of giving
    // up: same key, same cost of nothing, and the work still gets done.
    const next = hops < MAX_HOPS ? await anotherModel(apiKey) : null;
    if (next) {
      console.warn(`[answers] ${MODEL} is at its free limit for now; using ${next}.`);
      MODEL = next;
      return geminiOnly(prompt, apiKey, maxTokens, attempt, temperature, hops + 1);
    }
    throw new Error("RATE_LIMIT");
  }

  if (TRANSIENT.has(res.status) && attempt < 3) {
    const wait = 1500 * 2 ** attempt;
    console.warn(`[answers] Gemini ${res.status}; retrying in ${wait}ms.`);
    await new Promise((r) => setTimeout(r, wait));
    return geminiOnly(prompt, apiKey, maxTokens, attempt + 1, temperature, hops);
  }

  // Google's deprecation error names the model to move to, so one retry
  // recovers by itself instead of leaving every open-ended question unanswered
  // until someone reads the run log.
  if (res.status === 404) {
    const detail = await res.clone().text().catch(() => "");
    const next = (detail.match(/models\/([a-z0-9][a-z0-9.\-]*)/g) || [])
      .map((m) => m.replace("models/", ""))
      .find((m) => m !== MODEL);
    if (next) {
      console.warn(
        `[answers] ${MODEL} has been retired; Google suggests ${next}. Retrying — ` +
          `set GEMINI_MODEL=${next} to make this permanent.`,
      );
      // A retired model is not asked again this run, however the list reads.
      SPENT.set(MODEL, Infinity);
      MODEL = next;
      return geminiOnly(prompt, apiKey, maxTokens, attempt, temperature, hops + 1);
    }
  }

  // Still overloaded after the retries: that model is busy, not the service.
  // Another free one is asked before the job goes without.
  if (TRANSIENT.has(res.status)) {
    const next = hops < MAX_HOPS ? await anotherModel(apiKey) : null;
    if (next) {
      console.warn(`[answers] ${MODEL} is still answering ${res.status}; using ${next}.`);
      MODEL = next;
      // One quick retry on the next model, not the full three.
      return geminiOnly(prompt, apiKey, maxTokens, 2, temperature, hops + 1);
    }
  }

  if (!res.ok) {
    // Include the body. A 404 means the model name is wrong or no longer
    // offered on this key's tier, and Google's free-tier model list changes;
    // without the body all you see is "answers stopped working", which looks
    // identical to the quota running out and needs a different fix.
    const detail = await res.text().catch(() => "");

    // One failure is worth naming outright, because the fix is not obvious.
    // AI Studio now issues keys beginning "AQ." instead of the older "AIza",
    // and the generative-language REST endpoint rejects that token type.
    if (/ACCESS_TOKEN_TYPE_UNSUPPORTED/.test(detail)) {
      throw new Error(
        "Gemini rejected the key's TYPE, not its value. Keys beginning \"AQ.\" " +
          "are not accepted by this endpoint. Create an AIza-format key — in " +
          "Google Cloud Console, enable the Generative Language API and make " +
          "an API key there — and replace GEMINI_API_KEY with it.",
      );
    }
    throw new Error(`Gemini HTTP ${res.status} (model=${MODEL}) ${detail.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("empty response");
  return text.trim();
}

// --------------------------------------------------------------------------
// A second free model, for the hours the first has none left to give.
// --------------------------------------------------------------------------
// One night every free Gemini model was at its limit by eleven, and until
// three in the morning every list question on every form went unanswered.
// Groq and OpenRouter each give a free allowance of their own on a key of
// their own, and both speak the same plain chat protocol. Where a key for
// either is set, a request Gemini cannot take is put to it instead: same
// prompt, same checks on the reply afterwards, and still nothing to pay.
// (The fall-back order and the protocol follow billmal071/job-agent, MIT.)
// A model on the machine itself, where one is running: Ollama, llama.cpp's
// server, LM Studio and the like all speak the same chat protocol on a local
// port. LOCAL_AI_URL names it ("http://127.0.0.1:11434/v1" for Ollama) and
// LOCAL_AI_MODEL which model; with LOCAL_AI_FIRST=1 it is asked before
// anything outside, and with no Gemini key at all it is the only one asked.
// Nothing leaves the machine, and there is nothing to pay or run out of.
const LOCAL = {
  name: "the local model",
  key: () => (process.env.LOCAL_AI_URL ? "local" : ""),
  get base() { return String(process.env.LOCAL_AI_URL ?? "").replace(/\/+$/, ""); },
  model: () => process.env.LOCAL_AI_MODEL,
  prefer: /./,
};
// Every caller in this system hands over GEMINI_API_KEY and does nothing
// without one. Where only a local model is set, the stand-in is put there,
// so that none of them needs to know.
if (!process.env.GEMINI_API_KEY && process.env.LOCAL_AI_URL) process.env.GEMINI_API_KEY = "local";
export const localOnly = () => Boolean(process.env.LOCAL_AI_URL) && (process.env.GEMINI_API_KEY === "local" || process.env.LOCAL_AI_FIRST === "1");
/** The key callers hand to this module: Gemini's, or a stand-in where only a local model is set. */
export function modelKey() {
  return process.env.GEMINI_API_KEY || (process.env.LOCAL_AI_URL ? "local" : "");
}

const SECOND = [
  LOCAL,
  { name: "groq", key: () => process.env.GROQ_API_KEY, base: "https://api.groq.com/openai/v1", model: () => process.env.GROQ_MODEL, prefer: /llama.*70b|versatile/i },
  { name: "openrouter", key: () => process.env.OPENROUTER_API_KEY, base: "https://openrouter.ai/api/v1", model: () => process.env.OPENROUTER_MODEL, prefer: /:free$/i },
];
const SECOND_MODEL = new Map();
const SECOND_SPENT = new Map();

/** Which of a provider's models to ask: the one named, or one it offers now. */
async function secondModel(p) {
  if (p.model()) return p.model();
  if (SECOND_MODEL.has(p.name)) return SECOND_MODEL.get(p.name);
  let pick = null;
  try {
    const res = await fetch(`${p.base}/models`, { headers: { Authorization: `Bearer ${p.key()}` }, signal: AbortSignal.timeout(15_000) });
    const ids = ((await res.json())?.data ?? []).map((m) => String(m.id ?? "")).filter((id) => id && !/whisper|guard|tts|embed|vision|audio|image/i.test(id));
    // OpenRouter lists paid models beside free ones; only a free one is ever chosen there.
    const usable = p.name === "openrouter" ? ids.filter((id) => /:free$/i.test(id)) : ids;
    pick = usable.find((id) => p.prefer.test(id) && /llama|gemini|mistral|qwen|deepseek/i.test(id)) ?? usable.find((id) => p.prefer.test(id)) ?? usable[0] ?? null;
  } catch {
    /* the list did not come; nothing is asked of this provider */
  }
  SECOND_MODEL.set(p.name, pick);
  return pick;
}

/** Whether a second free model is there to ask at all. */
export function hasSecondModel() {
  return SECOND.some((p) => p.key());
}

async function secondOpinion(prompt, maxTokens, temperature) {
  for (const p of SECOND) {
    if (!p.key()) continue;
    if (Date.now() - (SECOND_SPENT.get(p.name) ?? 0) < 60_000) continue;
    const model = await secondModel(p);
    if (!model) continue;
    try {
      const res = await fetch(`${p.base}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${p.key()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: maxTokens, temperature }),
        signal: AbortSignal.timeout(90_000),
      });
      if (res.status === 429) { SECOND_SPENT.set(p.name, Date.now()); continue; }
      if (!res.ok) continue;
      const text = String((await res.json())?.choices?.[0]?.message?.content ?? "").trim();
      if (!text) continue;
      if (!SECOND_SAID.has(p.name)) { SECOND_SAID.add(p.name); console.warn(localOnly() ? `[answers] ${p.name} is answering.` : `[answers] Gemini has no free allowance left for now; ${p.name} is answering instead.`); }
      return text;
    } catch {
      /* this one did not answer; the next is asked */
    }
  }
  return null;
}
const SECOND_SAID = new Set();

async function gemini(prompt, apiKey, maxTokens = 600, attempt = 0, temperature = 0.6, hops = 0) {
  // The machine's own model first, where that is what has been asked for;
  // only if it gives nothing is anything outside asked, and only with a key.
  if (localOnly()) {
    const own = await secondOpinion(prompt, maxTokens, temperature);
    if (own !== null) return own;
    if (process.env.GEMINI_API_KEY === "local" || apiKey === "local") throw new Error("the local model gave no answer");
  }
  try {
    return await geminiOnly(prompt, apiKey, maxTokens, attempt, temperature, hops);
  } catch (e) {
    // Only where Gemini is spent or not answering — a reply it did give is
    // never swapped for another model's.
    const why = String(e?.message ?? e);
    if (!hasSecondModel() || !/RATE_LIMIT|\b(429|500|502|503|504)\b|timeout|aborted/i.test(why)) throw e;
    const other = await secondOpinion(prompt, maxTokens, temperature);
    if (other === null) throw e;
    return other;
  }
}


const PROMPT = `You are answering one question on a job application, as the candidate.

RULES
- Write in first person, as the candidate. Never mention being an AI.
- Use ONLY facts present in the resume. Never invent an employer, a job title,
  a date, a degree, a certification, a metric or a skill.
- Be specific to THIS job: name something real from the posting and connect it
  to something real from the resume.
- Plain prose. No bullet points, no headings, no markdown, no placeholders
  like [Company] — write the actual name.
- No throat-clearing. Do not open with "I am excited" or "I am passionate".
  Start with substance.
- {LENGTH}

Return ONLY the answer text. Nothing before or after it.

COMPANY: {COMPANY}
ROLE: {TITLE}

JOB POSTING:
{POSTING}

CANDIDATE RESUME:
{RESUME}

QUESTION:
{QUESTION}`;

/** Rough length guidance from the form's own field limit. */
function lengthRule(maxLength) {
  if (maxLength && maxLength < 300) return "Two sentences at most. The field is short.";
  if (maxLength && maxLength < 800) return "Three or four sentences.";
  return "Four to six sentences. One tight paragraph.";
}

/**
 * Produce an answer for one open-ended question.
 *
 * Returns { answer, cacheable } or null if it could not be generated.
 * Caching is the caller's job, but `cacheable` tells it whether storing this
 * answer would be safe.
 */
export async function generateAnswer({
  question, job, resume, profile, apiKey, maxLength,
}) {
  if (!apiKey) return null;
  if (!question || question.length < 5) return null;

  const specific = isEmployerSpecific(question, job?.company);

  const prompt = PROMPT
    .replace("{LENGTH}", lengthRule(maxLength))
    .replace("{COMPANY}", job?.company || "the company")
    .replace("{TITLE}", job?.title || "this role")
    .replace("{POSTING}", (job?.description || "No posting text available.").slice(0, 3000))
    .replace("{RESUME}", (resume || "").slice(0, 4000))
    .replace("{QUESTION}", question);

  let text;
  try {
    text = await gemini(prompt, apiKey, maxLength && maxLength < 400 ? 300 : 700);
  } catch (e) {
    // Returning null is right — the field is left for a human rather than
    // filled with something invented. But say why, once per failure, in the
    // run log. Silence here is indistinguishable from "no open-ended
    // questions on this form", and the two need completely different fixes:
    // a daily quota runs out and recovers tomorrow, a wrong model name never
    // recovers at all.
    const why = String(e?.message ?? e);
    console.warn(
      why === "RATE_LIMIT"
        ? "[answers] Gemini daily quota reached — leaving this question for a human."
        : `[answers] could not write an answer: ${why}`,
    );
    return null;
  }

  // Strip anything that reads as a model preamble or markdown leaking through.
  let answer = text
    .replace(/^(here'?s?|here is|sure[,!]?|certainly[,!]?)[^\n]*\n+/i, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\*\*/g, "")
    .replace(/^#+\s*/gm, "")
    .trim();

  if (maxLength && answer.length > maxLength) {
    // Cut at a sentence boundary rather than mid-word.
    const cut = answer.slice(0, maxLength);
    const lastStop = Math.max(cut.lastIndexOf("."), cut.lastIndexOf("!"), cut.lastIndexOf("?"));
    answer = lastStop > maxLength * 0.5 ? cut.slice(0, lastStop + 1) : cut.trim();
  }

  if (answer.length < 20) return null;

  // A fabrication guard that is cheap and catches the common case: if the
  // model named a company that is neither the employer nor in the resume,
  // something was invented.
  const named = answer.match(/\b[A-Z][a-zA-Z]{2,}(?:\s+[A-Z][a-zA-Z]{2,})?\b/g) || [];
  const resumeLower = (resume || "").toLowerCase();
  const companyLower = (job?.company || "").toLowerCase();
  const suspicious = named.filter((n) => {
    const l = n.toLowerCase();
    if (l.length < 4) return false;
    if (companyLower.includes(l) || l.includes(companyLower)) return false;
    if (resumeLower.includes(l)) return false;
    if ((job?.title || "").toLowerCase().includes(l)) return false;
    return /\b(Inc|LLC|Corp|Technologies|Solutions|Systems|Group)\b/.test(n);
  });
  if (suspicious.length) return null;   // let a human handle it rather than risk it

  return { answer, cacheable: !specific };
}

/**
 * Choose one of the employer's own options, grounded in the resume.
 *
 * Constrained on purpose: the model is given the list and told to answer
 * with one of them or with UNKNOWN, and the caller then checks the reply
 * really is one of them. A free-text answer here would be a fabrication
 * going to an employer under someone's name; a wrong pick from a list the
 * employer wrote is at least an answer to the question they asked.
 */
export async function chooseOption({ question, options, resume, apiKey }) {
  if (!apiKey || !question || !options?.length || !resume) return null;

  const list = options.slice(0, 30).map((o, i) => `${i + 1}. ${o}`).join("\n");
  // One call that either reads the answer off the resume or applies the
  // ordinary rule for the kind of question it is. The first version stopped
  // at "the resume does not say", which is true of nearly every screening
  // question — nobody's resume says whether they have been a contractor for
  // this employer — and left each of them waiting for a person.
  const prompt =
    `You are filling in a job application form on behalf of the candidate ` +
    `whose resume appears below. Choose the answer the candidate would ` +
    `truthfully give.\n\n` +
    `Question: ${question}\n\n` +
    `Allowed answers:\n${list}\n\n` +
    `Rules, in order:\n` +
    `1. If the resume states the answer, use it.\n` +
    `2. If the question asks whether the candidate holds a specific licence, ` +
    `certification, degree or clearance, has worked for or with a named ` +
    `organisation, has a relationship, restriction or conflict, or any other ` +
    `fact about them, and the resume does not show it, choose the answer ` +
    `that says they do not.\n` +
    `3. If the question asks about willingness, availability or agreement to ` +
    `ordinary conditions of the job (schedule, shifts, travel, on-site work, ` +
    `background checks, policies, being contacted), choose the agreeable answer.\n` +
    `4. If the question asks for a level or an amount (years, team size, ` +
    `proficiency) and the resume gives no figure, choose the most modest ` +
    `answer the resume can support.\n` +
    `5. If the question concerns race, ethnicity, gender, sexual orientation, ` +
    `disability, veteran status, religion, age, criminal history or ` +
    `immigration status, reply with exactly: UNKNOWN\n\n` +
    `Reply with exactly one of the allowed answers, copied word for word, or ` +
    `UNKNOWN. Do not explain. Do not add anything else.\n\n` +
    `RESUME:\n${String(resume).slice(0, 6000)}`;

  // Room to answer: a model that thinks before it writes spends part of this
  // on the thinking, and sixty tokens left some replies empty.
  let text;
  try {
    text = await gemini(prompt, apiKey, 512, 0, 0);
  } catch (e) {
    // The free tier is a few requests a minute and four applications fill in
    // side by side. One wait is cheaper than an unanswered question.
    if (String(e?.message ?? e) !== "RATE_LIMIT") throw e;
    await new Promise((r) => setTimeout(r, 13_000));
    text = await gemini(prompt, apiKey, 512, 0, 0);
  }
  const reply = String(text ?? "").trim().replace(/^["']|["']$/g, "").replace(/^\d+\.\s*/, "");
  if (!reply || /^unknown\b/i.test(reply)) return null;
  return reply;
}

/**
 * The candidate's most recent job, as structured fields.
 *
 * Work-history sections ask for job title, employer and start/end dates in
 * separate boxes, and a resume states all of it in prose. Without this the
 * applier fills the personal details perfectly and then stops on "job title"
 * with the answer sitting in the document it just uploaded.
 */
export async function resumeFacts({ resume, apiKey }) {
  if (!apiKey || !resume) return null;

  const prompt =
    `Read this resume and report the candidate's MOST RECENT job.\n\n` +
    `Reply with JSON only, no prose, exactly these keys:\n` +
    `{"title":"","company":"","start_month":"","start_year":"","end_month":"","end_year":"","current":true}\n\n` +
    `Months are full names ("March"). Years are four digits. If the job is ` +
    `their current one set "current" to true and leave the end fields "". ` +
    `Use "" for anything the resume does not state. Invent nothing.\n\n` +
    `RESUME:\n${String(resume).slice(0, 8000)}`;

  const text = await gemini(prompt, apiKey, 220);
  const match = String(text ?? "").match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const o = JSON.parse(match[0]);
    return {
      title: String(o.title ?? "").trim(),
      company: String(o.company ?? "").trim(),
      start_month: String(o.start_month ?? "").trim(),
      start_year: String(o.start_year ?? "").trim(),
      end_month: String(o.end_month ?? "").trim(),
      end_year: String(o.end_year ?? "").trim(),
      current: o.current === true,
    };
  } catch {
    return null;
  }
}

/**
 * The raw model call, for callers outside this module.
 *
 * suggest-titles.mjs needs the same retry, model-fallback and quota
 * handling that every other call here gets; exporting the function beats
 * giving it a second, worse copy.
 */
export function geminiForTitles(prompt, apiKey, maxTokens = 600) {
  return gemini(prompt, apiKey, maxTokens);
}
