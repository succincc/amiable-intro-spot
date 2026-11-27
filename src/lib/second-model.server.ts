// ============================================================================
// second-model.server.ts — a second free model for when the first is spent.
//
// The free model's allowance is per day and per key. On a busy day it is gone
// by late evening, and scoring then falls back to counting words, which marks
// good postings down: one morning 184 were set aside as "score below the
// review threshold" by the word counter alone. Groq gives a free allowance of
// its own on a key of its own, and speaks the plain chat protocol. Where a
// person has saved a Groq key, a request the first model cannot take is put
// to it. The runner does the same for the forms it fills (answers.mjs).
// ============================================================================

const BASE = "https://api.groq.com/openai/v1";
let chosen: string | null | undefined;

/** Which model to ask: the one named in the environment, or one Groq offers now. */
async function pickModel(apiKey: string): Promise<string | null> {
  const named = process.env["GROQ_MODEL"];
  if (named) return named;
  if (chosen !== undefined) return chosen;
  try {
    const res = await fetch(`${BASE}/models`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10_000) });
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    const ids = (body.data ?? []).map((m) => String(m.id ?? "")).filter((id) => id && !/whisper|guard|tts|embed|vision|audio|image/i.test(id));
    chosen = ids.find((id) => /llama.*70b|versatile/i.test(id)) ?? ids[0] ?? null;
  } catch {
    chosen = null;
  }
  return chosen;
}

/**
 * What the second model last said when it did not answer: its status and
 * the name it gives the refusal, never the request. For the line a scoring
 * run leaves behind, so "not used" can be told from "used up".
 */
let lastRefusal = "";
export const secondRefusal = (): string => lastRefusal;

/** Whether this looks like a Groq key at all. */
export const looksLikeSecondKey = (key: unknown): key is string => /^gsk_[A-Za-z0-9]{20,120}$/.test(String(key ?? "").trim());

/** Ask the second model. Null where it has nothing to say; never throws. */
export async function callSecond(opts: { prompt: string; apiKey: string; maxTokens?: number; temperature?: number }): Promise<string | null> {
  if (!looksLikeSecondKey(opts.apiKey)) {
    lastRefusal = "the key on file is not shaped like a Groq key";
    return null;
  }
  const model = await pickModel(opts.apiKey);
  if (!model) {
    lastRefusal = "no model was offered to this key";
    return null;
  }
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: opts.prompt }], max_tokens: Math.min(opts.maxTokens ?? 2048, 8000), temperature: opts.temperature ?? 0.2 }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      let named = "";
      try {
        const said = (await res.json()) as { error?: { code?: string; type?: string } };
        named = String(said.error?.code ?? said.error?.type ?? "").slice(0, 40);
      } catch {
        named = "";
      }
      lastRefusal = `HTTP ${res.status}${named ? ` ${named}` : ""}`;
      return null;
    }
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = String(body.choices?.[0]?.message?.content ?? "").trim();
    if (!text) lastRefusal = "an empty answer";
    return text || null;
  } catch (e) {
    lastRefusal = String((e as Error)?.name ?? "failed").slice(0, 30);
    return null;
  }
}
