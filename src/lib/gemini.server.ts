// ============================================================================
// gemini.server.ts — one place that knows how to call the model.
//
// Scoring, answer writing and reply drafting each had their own copy of this,
// each with the model name hardcoded. When Google retired gemini-2.0-flash
// that broke all three at once, and scoring failing meant nothing ever
// reached the queue, so pressing APPLY answered "run discovery then scoring"
// with no hint that a dead model name was the cause.
//
// So: one client, one default, and a retry that reads Google's own
// replacement suggestion out of the deprecation error.
// ============================================================================

/**
 * The default model.
 *
 * Google retires these on its own schedule — 2.0-flash went away with the
 * message "no longer available. Please update your code to use
 * models/gemini-3.8-flash". GEMINI_MODEL overrides it without a deploy, which
 * matters because the free tier's model list moves too.
 */
export const DEFAULT_MODEL = process.env["GEMINI_MODEL"] || "gemini-3.8-flash";

export class GeminiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly kind: "rate_limit" | "bad_key" | "dead_model" | "busy" | "other",
  ) {
    super(message);
    this.name = "GeminiError";
  }
}

/** Google names its own replacement in the deprecation message. Use it. */
function suggestedModel(detail: string): string | null {
  const m = detail.match(/models\/([a-z0-9][a-z0-9.\-]*)/g);
  if (!m) return null;
  for (const raw of m) {
    const name = raw.replace("models/", "");
    if (!/no longer|deprecated/i.test(name)) return name;
  }
  return null;
}

/**
 * Failures worth trying again.
 *
 * 503 "this model is currently experiencing high demand" is the common one:
 * nothing is wrong with the key, the request or the quota — the model was
 * busy for a moment. A single one of those used to end AI scoring for a whole
 * run and fall the rest of it back to the keyword scorer.
 *
 * 429 is included because it covers both limits Google enforces. A
 * per-MINUTE limit clears in well under a minute; a per-DAY one does not, and
 * that one surfaces as a second 429 after the wait, which then gives up
 * properly rather than hammering an exhausted quota.
 */
function retryable(status: number): boolean {
  // 408, 522, 524 and 525 come from Cloudflare rather than Google: the
  // request reached the edge and the origin was too slow to answer, or the
  // connection between them failed. A 524 cost a whole scoring run its AI
  // scores, and it means the same thing 504 does — try again.
  return (
    status === 408 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    status === 522 ||
    status === 524 ||
    status === 525
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Ask Google which models this key can actually use.
 *
 * A model name the key cannot serve does NOT reliably answer 404. It has been
 * answering 503 "experiencing high demand" all day, which reads as a busy
 * service, survives every retry, and sent each scoring run to the keyword
 * fallback while reporting that nothing was wrong with the key.
 *
 * The model list settles it: either the configured name is there, or it is
 * not and the service was never busy.
 */
async function usableModel(apiKey: string, avoid: string): Promise<string | null> {
  try {
    const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models", {
      headers: { "x-goog-api-key": apiKey },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
    };
    const names = (data.models ?? [])
      .filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
      .map((m) => String(m.name ?? "").replace(/^models\//, ""))
      .filter((n) => n && n !== avoid && !/embedding|aqa|vision|image|tts|live/i.test(n));

    // Flash first: it is the free tier's workhorse and the cheapest thing that
    // can do this job. Experimental and thinking variants are skipped — they
    // have their own quotas and their own ways of failing.
    return (
      names.find((n) => /flash/i.test(n) && !/exp|preview|thinking/i.test(n)) ??
      names.find((n) => /flash/i.test(n)) ??
      names[0] ??
      null
    );
  } catch {
    return null;
  }
}

async function once(
  model: string,
  apiKey: string,
  body: unknown,
): Promise<{ ok: true; text: string } | { ok: false; status: number; detail: string }> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Header, never the query string: a URL carrying a credential reaches
        // proxy logs, error reports and the CI run log.
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(body),
    },
  );

  if (!res.ok) {
    return { ok: false, status: res.status, detail: await res.text().catch(() => "") };
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) return { ok: false, status: 200, detail: "model returned no text" };
  return { ok: true, text: String(text).trim() };
}

/**
 * Call Gemini, retrying once on a model that has been retired.
 *
 * Throws GeminiError with a `kind` the caller can act on rather than a bare
 * string, because the three common failures need three different responses: a
 * quota recovers tomorrow, a retired model needs a config change, and a
 * rejected key type needs a different key entirely.
 */
export async function callGemini(opts: {
  prompt: string;
  apiKey: string;
  model?: string | undefined;
  temperature?: number;
  maxTokens?: number;
}): Promise<string> {
  const { prompt, apiKey } = opts;
  if (!apiKey) throw new GeminiError("GEMINI_API_KEY is not set", 0, "bad_key");

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: opts.temperature ?? 0.4,
      maxOutputTokens: opts.maxTokens ?? 1024,
    },
  };

  let model = opts.model || DEFAULT_MODEL;
  let result = await once(model, apiKey, body);

  // Back off and try again on a transient failure. Three attempts spread over
  // about twenty seconds covers a busy model without stalling a run that is
  // scoring a dozen batches.
  for (let attempt = 1; attempt <= 2 && !result.ok && retryable(result.status); attempt++) {
    const waitMs = result.status === 429 ? attempt * 12_000 : attempt * 4_000;
    console.warn(
      `[gemini] HTTP ${result.status} from ${model}; retrying in ${Math.round(waitMs / 1000)}s ` +
        `(attempt ${attempt} of 2).`,
    );
    await sleep(waitMs);
    result = await once(model, apiKey, body);
  }

  // Google's deprecation error names the model to move to, so one retry
  // recovers automatically instead of waiting for someone to notice that
  // scoring has quietly stopped.
  if (
    !result.ok &&
    result.status === 404 &&
    /no longer available|deprecated/i.test(result.detail)
  ) {
    const next = suggestedModel(result.detail);
    if (next && next !== model) {
      console.warn(
        `[gemini] ${model} has been retired; Google suggests ${next}. ` +
          `Retrying with it — set GEMINI_MODEL=${next} to make this permanent.`,
      );
      model = next;
      result = await once(model, apiKey, body);
    }
  }

  // Still failing. Before calling it a busy service, find out whether this key
  // has the model at all — because "busy" and "you cannot use this model" have
  // looked identical from here, and only one of them is worth waiting out.
  if (!result.ok && [400, 404, 429, 503].includes(result.status)) {
    const alt = await usableModel(apiKey, model);
    if (alt) {
      console.warn(
        `[gemini] ${model} kept failing (HTTP ${result.status}), and this key does list ` +
          `${alt}. Trying it. Set GEMINI_MODEL=${alt} to make that permanent.`,
      );
      const retry = await once(alt, apiKey, body);
      if (retry.ok) {
        console.warn(`[gemini] ${alt} worked. ${model} appears not to be usable with this key.`);
        model = alt;
        result = retry;
      }
    }
  }

  if (result.ok) return result.text;

  if (result.status === 429) {
    throw new GeminiError(
      "Gemini free-tier quota reached for today. This resumes automatically " +
        "tomorrow, and nothing was charged.",
      429,
      "rate_limit",
    );
  }
  if (/ACCESS_TOKEN_TYPE_UNSUPPORTED/.test(result.detail)) {
    throw new GeminiError(
      'Gemini rejected the key\'s TYPE, not its value. Keys beginning "AQ." are ' +
        "not accepted by this endpoint. Create an AIza-format key in Google Cloud " +
        "Console (enable the Generative Language API, then make an API key) and " +
        "replace GEMINI_API_KEY.",
      result.status,
      "bad_key",
    );
  }
  if (
    result.status === 503 ||
    result.status === 500 ||
    result.status === 502 ||
    result.status === 504
  ) {
    throw new GeminiError(
      `Gemini returned HTTP ${result.status} on ${model} after retries, and no other model ` +
        `this key lists worked either. If this keeps happening, the model name is the thing ` +
        `to check before the quota — open aistudio.google.com and set GEMINI_MODEL to one ` +
        `the key actually has.`,
      result.status,
      "busy",
    );
  }
  if (result.status === 404) {
    throw new GeminiError(
      `Model "${model}" is not available to this key. Set GEMINI_MODEL to one that is. ` +
        result.detail.slice(0, 200),
      404,
      "dead_model",
    );
  }
  throw new GeminiError(
    `Gemini HTTP ${result.status} (model=${model}) ${result.detail.slice(0, 250)}`,
    result.status,
    "other",
  );
}
