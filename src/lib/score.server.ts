/* eslint-disable @typescript-eslint/no-explicit-any */
// @ts-nocheck — ported verbatim from the user's Deno function.
// Ported from the user's `score` function.
const BATCH = 20;
const MAX_BATCHES = 12; // ceiling per invocation; cron calls it again

// The keys this run scores on: the person's own where they have saved one,
// the shared one otherwise, and their second key for when the first is spent.
const KEYS: { first: string; second: string } = { first: "", second: "" };

async function gemini(prompt: string, maxTokens = 8192): Promise<string> {
  const { callGemini } = await import("@/lib/gemini.server");
  try {
    return await callGemini({
      prompt,
      apiKey: KEYS.first || (process.env["GEMINI_API_KEY"] ?? ""),
      temperature: 0.2,
      maxTokens,
    });
  } catch (e) {
    // Spent for the day, or not answering: the second free model is asked
    // before the word counter is. Any other failure is the first model's
    // to report, as before.
    if (!KEYS.second) throw e;
    const { callSecond } = await import("@/lib/second-model.server");
    const other = await callSecond({ prompt, apiKey: KEYS.second, maxTokens, temperature: 0.2 });
    if (other === null) throw e;
    return other;
  }
}

/** Pull a JSON array out of a model response that may be fenced or chatty. */
function extractArray(text: string): any[] | null {
  const fenced = text.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/);
  const raw = fenced?.[1] ?? text.match(/\[[\s\S]*\]/)?.[0];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractObject(text: string): any | null {
  const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  const raw = fenced?.[1] ?? text.match(/\{[\s\S]*\}/)?.[0];
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const SCORE_PROMPT = `You rate how well one candidate fits each job posting.

Scoring:
 9-10  Direct experience in nearly everything required.
 7-8   Most requirements met, small gaps that are easily bridged.
 5-6   Real overlap but missing some key requirements.
 3-4   Significant gaps, would need substantial ramp-up.
 1-2   Wrong field or wrong level entirely.

Be realistic about seniority and years of experience. Credit transferable
experience. Do not inflate scores to be encouraging — a wrong score wastes
an application.

Return ONLY a JSON array, one object per job, in the SAME ORDER given, with
every job present exactly once. Keys: "n" (the job number), "score" (1-10
integer), "reason" (one sentence). No text outside the array.`;

// Most of the gap between a resume's real fit and its ATS score is
// vocabulary and formatting, not ability. A person writes "handled upset
// customers" and the posting says "de-escalation and conflict resolution";
// the screener matches text, finds neither phrase, and scores a genuine fit
// at twenty per cent. Closing THAT gap is what this prompt is for, and it is
// worth a great deal.
//
// What it will not do is manufacture a fit that is not there. Not because
// the screener would catch it — it would not — but because the interview,
// the reference check and the first week on the job all will, and the
// candidate is the one holding that bag. A resume that wins a screen it
// cannot survive costs more than the screen was worth.
const TAILOR_PROMPT = `Rewrite this candidate's resume for this specific job so
that an applicant tracking system scores it as high as the candidate's REAL
experience can honestly support.

NEVER:
- invent employers, job titles, dates, degrees, certifications or numbers
- claim a skill, tool or responsibility the resume does not evidence
- repeat keywords unnaturally, or list a term the candidate cannot discuss

ALWAYS, because this is what the screener measures:
- Use the posting's EXACT wording for anything the candidate genuinely did.
  If they "handled upset customers" and the posting says "de-escalation",
  write de-escalation. Same work, the employer's words.
- Give every acronym once with its expansion: "SQL (Structured Query
  Language)", "POS (point of sale)". Screeners match one or the other.
- Open with a headline that matches the posted title where their experience
  honestly supports it.
- Work the posting's required skills in wherever the resume evidences them,
  in the posting's phrasing, in the bullet where they actually did it.
- Put the most relevant role and bullets first. Drop detail this job does
  not care about.
- Keep tense, person and formatting plain: no tables, columns or graphics,
  standard section headings, dates as "Mon YYYY - Mon YYYY".

AND, because a person reads it after the screener:
- Every bullet is an accomplishment, not a duty. Say what was done, at what
  scale, and what came of it. "Responsible for inventory" is a duty; "Ran
  weekly inventory counts across a 20,000-item store, keeping shrink under
  target" is an accomplishment — when the resume supports each part of it.
- Lead each role with the bullet this employer would most want to see.
- The summary says, in the employer's terms, who this is and why they suit
  THIS role. No "results-driven", "team player", "proven track record".

ONE PAGE. The finished resume is printed on a single page, so write to fit:
- summary: at most 45 words
- skills: at most 3 categories, at most 9 terms each
- experience: at most 4 roles. The most relevant role gets up to 5 bullets,
  the next up to 4, any others 2 or 3.
- every bullet: one sentence of at most 24 words that opens with a strong
  verb and says what was done and what came of it. Where the resume gives a
  number, a scale or a result, lead with it. Never write a number it does
  not give.
- education: one line each
A page that is full of the right things reads better than two pages of
everything. Cut what this posting does not care about.

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
  "summary": 2-3 sentence professional summary aimed at this job, using the
             posting's language for the experience they really have
  "skills": object of category -> comma-separated string, led by the terms
            this posting asks for that the candidate genuinely has
  "experience": array of { "company", "title", "dates", "bullets": [string] }
  "education": array of { "school", "degree", "dates" }
No text outside the JSON.`;

function renderResume(data: any, profile: any): string {
  const out: string[] = [];
  out.push(profile.full_name ?? "");
  // The headline written for this posting; the profile's own when there is none.
  const headline = String(data.headline ?? "").trim().slice(0, 90) || profile.target_role;
  if (headline) out.push(headline);
  const contact = [
    profile.email,
    profile.phone,
    [profile.city, profile.state].filter(Boolean).join(", "),
    profile.linkedin_url,
  ]
    .filter(Boolean)
    .join(" | ");
  if (contact) out.push(contact);
  out.push("");

  if (data.summary) {
    out.push("SUMMARY", String(data.summary), "");
  }

  if (data.skills && typeof data.skills === "object") {
    out.push("SKILLS");
    for (const [k, v] of Object.entries(data.skills)) out.push(`${k}: ${v}`);
    out.push("");
  }

  if (Array.isArray(data.experience) && data.experience.length) {
    out.push("EXPERIENCE");
    for (const e of data.experience) {
      const head = [e.company, e.title].filter(Boolean).join(" - ");
      out.push(e.dates ? `${head} (${e.dates})` : head);
      for (const b of e.bullets ?? []) out.push(`- ${String(b).replace(/^[-•*]\s*/, "")}`);
      out.push("");
    }
  }

  if (Array.isArray(data.education) && data.education.length) {
    out.push("EDUCATION");
    for (const e of data.education) {
      const line = [e.school, e.degree].filter(Boolean).join(" - ");
      out.push(e.dates ? `${line} (${e.dates})` : line);
    }
  }
  return out.join("\n").trim();
}

// --------------------------------------------------------------------------
// free local fallback — used when no GEMINI_API_KEY is set. Zero cost.
// --------------------------------------------------------------------------
const STOP = new Set(
  "the and for with you your our are will that this from have has who all any can not but job role work team years experience ability skills strong including".split(
    " ",
  ),
);
function terms(text: string) {
  return new Set(
    (text.toLowerCase().match(/[a-z][a-z+#.]{2,}/g) ?? []).filter((w) => !STOP.has(w)),
  );
}
function localScore(resume: string, job: any, titles: string[]): { score: number; reason: string } {
  const r = terms(resume);
  const d = terms(`${job.title} ${job.description ?? ""}`.slice(0, 6000));
  let hit = 0;
  for (const w of d) if (r.has(w)) hit++;
  const overlap = d.size ? hit / Math.min(d.size, 120) : 0;
  const t = (job.title ?? "").toLowerCase();
  const titleHit = titles.some((x) =>
    x
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2)
      .every((w) => t.includes(w)),
  );
  let score = Math.round(2 + overlap * 10 + (titleHit ? 2 : 0));
  score = Math.max(1, Math.min(10, score));
  return {
    score,
    reason: `keyword match ${Math.round(overlap * 100)}%${titleHit ? ", title matches a target" : ""} (free local scorer)`,
  };
}

export async function runScore(supabase: any) {
  const { data: run } = await supabase.from("runs").insert({ kind: "score" }).select().single();
  const stats = { scored: 0, tailored: 0, errors: 0 };
  let note = "";
  // This person's own keys, where they have saved any.
  KEYS.first = "";
  KEYS.second = "";
  try {
    const { data: own } = await supabase.from("user_keys").select("*").limit(1).maybeSingle();
    if (/^[A-Za-z0-9_-]{20,80}$/.test(String(own?.gemini_key ?? "").trim())) KEYS.first = String(own.gemini_key).trim();
    if (/^gsk_[A-Za-z0-9]{20,120}$/.test(String(own?.groq_key ?? "").trim())) KEYS.second = String(own.groq_key).trim();
  } catch {
    /* no keys of their own: the shared one stands */
  }
  const useAi = !!(KEYS.first || process.env["GEMINI_API_KEY"] || KEYS.second);
  // Set when the model stops answering mid-run, for any reason. Scoring then
  // carries on with the free local scorer instead of abandoning the run.
  let aiDead = false;
  try {
    const { data: profile } = await supabase.from("profile").select("*").eq("id", 1).single();
    if (!profile?.resume_text?.trim())
      throw new Error("No resume yet. Paste one in Settings → Resume before scoring.");
    // Every job the owner has entered in settings, beyond the one resume.
    // A missing table (the update not yet published) is simply no list.
    let roles = "";
    try {
      const { data: held } = await supabase
        .from("experience")
        .select("company,title,location,start_date,end_date,details")
        .order("created_at", { ascending: false })
        .limit(40);
      roles = (held ?? [])
        .map(
          (e: any) =>
            `${e.company} - ${e.title} (${e.start_date || "?"} - ${e.end_date || "Present"})` +
            `${e.location ? `, ${e.location}` : ""}\n${String(e.details ?? "").trim().slice(0, 1200)}`,
        )
        .join("\n\n")
        .slice(0, 7000);
    } catch {
      roles = "";
    }
    const resume =
      profile.resume_text.slice(0, 8000) + (roles ? `\n\nALL ROLES HELD:\n${roles}` : "");
    const { data: cfg } = await supabase
      .from("search_config")
      .select("titles")
      .eq("id", 1)
      .single();
    const titles: string[] = cfg?.titles ?? [];

    for (let b = 0; b < (useAi ? MAX_BATCHES : 25); b++) {
      const { data: batch } = await supabase
        .from("jobs")
        .select("id,title,company,location,salary_text,description")
        .is("score", null)
        .eq("status", "new")
        .order("found_at", { ascending: false })
        .limit(BATCH);
      if (!batch?.length) break;

      if (!useAi || aiDead) {
        for (const j of batch) {
          const r = localScore(resume, j, titles);
          await supabase
            .from("jobs")
            .update({ score: r.score, score_reason: r.reason, scored_at: new Date().toISOString() })
            .eq("id", j.id);
          stats.scored++;
        }
        continue;
      }

      const listing = batch
        .map(
          (j: any, i: number) =>
            `--- JOB ${i + 1} ---\nTITLE: ${j.title}\nCOMPANY: ${j.company ?? "?"}\nLOCATION: ${j.location ?? "?"}\nSALARY: ${j.salary_text ?? "not listed"}\nDESCRIPTION:\n${(j.description ?? "").slice(0, 1800)}`,
        )
        .join("\n\n");
      let parsed: any[] | null = null;
      try {
        const text = await gemini(
          `${SCORE_PROMPT}\n\nCANDIDATE RESUME:\n${resume}\n\n=== ${batch.length} JOBS ===\n\n${listing}`,
          Math.min(8192, batch.length * 160 + 512),
        );
        parsed = extractArray(text);
      } catch (e) {
        // Any failure to reach the model is survivable, and the run must not
        // be thrown away over it. A quota reset tomorrow, a retired model and
        // an exhausted prepaid balance all arrive here, and only the first is
        // a 429 — credits running out is a billing error, which used to kill
        // the whole run and score nothing.
        //
        // The local keyword scorer needs no key and no quota, so the rest of
        // the batch is scored with it. Worse scores beat no scores.
        aiDead = true;
        const why = String((e as Error).message ?? e);
        note = why.startsWith("RATE_LIMIT")
          ? why
          : `AI scoring stopped (${why.slice(0, 160)}). Continued with the free local scorer.`;
        b--; // redo this batch locally rather than skipping it
        continue;
      }
      if (!parsed || parsed.length !== batch.length) {
        stats.errors++;
        note = "A scoring batch came back incomplete and was skipped.";
        continue;
      }
      const byIndex = new Map<number, any>();
      for (const item of parsed) {
        const n = Number(item?.n);
        if (Number.isInteger(n) && n >= 1 && n <= batch.length) byIndex.set(n, item);
      }
      if (byIndex.size !== batch.length) {
        stats.errors++;
        continue;
      }
      for (let i = 0; i < batch.length; i++) {
        const r = byIndex.get(i + 1);
        const score = Math.max(1, Math.min(10, Math.round(Number(r.score) || 1)));
        await supabase
          .from("jobs")
          .update({
            score,
            score_reason: String(r.reason ?? "").slice(0, 500),
            scored_at: new Date().toISOString(),
          })
          .eq("id", batch[i].id);
        stats.scored++;
      }
    }

    // What the word counter marked down while no model was answering is put
    // back to be read properly. It counts shared words, which is a fair
    // guess and a poor judge: one morning it set aside 184 postings as below
    // the review score. Only once a model has answered through this whole
    // run, only postings found in the last three days, and two hundred at a
    // time — the next run scores them.
    if (useAi && !aiDead) {
      try {
        const since = new Date(Date.now() - 3 * 86_400_000).toISOString();
        const { data: marked } = await supabase
          .from("jobs")
          .select("id")
          .eq("status", "skipped")
          .like("score_reason", "%(free local scorer)%")
          .gte("found_at", since)
          .limit(200);
        const ids = (marked ?? []).map((m: any) => m.id);
        if (ids.length) {
          await supabase.from("jobs").update({ status: "new", score: null, score_reason: null, skip_reason: null }).in("id", ids);
          note = `${note ? `${note} ` : ""}${ids.length} posting(s) the word counter had marked down are put back to be read by the model.`;
        }
      } catch {
        /* a second look is a courtesy; the scoring already done stands */
      }
    }

    // Resumes are written by the applier's side now (tailor.mjs, hourly and
    // again at the moment of applying): there each one is held against the
    // resume it came from before it is kept — an employer, a number or a
    // school that is not in the source is taken out — and the requests are
    // paced so the free allowance lasts the day. Writing ten more here, in a
    // burst and without that check, spent the same allowance on a weaker
    // page. Left in place behind a switch in case the runner is ever retired.
    if (useAi && !aiDead && process.env["PANEL_WRITES_RESUMES"] === "true") {
      const { data: queued } = await supabase
        .from("jobs")
        .select("id,title,company,description")
        .eq("status", "queued")
        .is("tailored_resume", null)
        .order("score", { ascending: false })
        .limit(10);
      for (const job of queued ?? []) {
        try {
          const text = await gemini(
            `${TAILOR_PROMPT}\n\nJOB: ${job.title} at ${job.company ?? ""}\nPOSTING:\n${(job.description ?? "").slice(0, 4000)}\n\nCANDIDATE RESUME:\n${resume}`,
            3072,
          );
          const data = extractObject(text);
          if (!data?.experience) {
            stats.errors++;
            continue;
          }
          await supabase
            .from("jobs")
            .update({
              tailored_resume: renderResume(data, profile),
              tailored_at: new Date().toISOString(),
            })
            .eq("id", job.id);
          stats.tailored++;
        } catch (e) {
          if (String((e as Error).message).startsWith("RATE_LIMIT")) {
            note = (e as Error).message;
            break;
          }
          stats.errors++;
        }
      }
    }

    const message =
      note ||
      (stats.scored === 0 && stats.tailored === 0
        ? "Nothing to score — no new jobs waiting. Run discovery first."
        : `Scored ${stats.scored}, tailored ${stats.tailored}${useAi ? "" : " (free local scorer — add a free Gemini key for AI scoring + tailoring)"}`);
    await supabase
      .from("runs")
      .update({
        status: "done",
        processed: stats.scored,
        errors: stats.errors,
        detail: stats,
        message,
        ended_at: new Date().toISOString(),
      })
      .eq("id", run!.id);
    return { ok: true as const, ...stats, message };
  } catch (e) {
    const message = String((e as Error)?.message ?? e);
    await supabase
      .from("runs")
      .update({
        status: "error",
        message,
        errors: stats.errors + 1,
        ended_at: new Date().toISOString(),
      })
      .eq("id", run!.id);
    return { ok: false as const, error: message, message };
  }
}
