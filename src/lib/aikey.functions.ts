import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** Whether this person has saved a key of their own. Never the key. */
export const aiKeyStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    // user_keys is newer than the generated types.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (context.supabase as any).from("user_keys").select("gemini_key, updated_at").limit(1).maybeSingle();
    if (error) return { ok: false as const, message: error.message };
    return { ok: true as const, set: Boolean(data?.gemini_key), since: (data?.updated_at as string | null) ?? null };
  });

/**
 * Save a key, once it has been seen to be one. It is checked by asking
 * Google which models it may use: that answers yes or no and spends none of
 * the key's allowance.
 */
export const saveAiKey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { key: string }) => d)
  .handler(async ({ context, data }) => {
    const key = String(data.key ?? "").trim();
    if (!/^[A-Za-z0-9_-]{20,80}$/.test(key)) return { ok: false as const, message: "That does not look like a key. Copy the whole key from Google AI Studio and paste it here." };
    try {
      const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", { headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(15_000) });
      if (res.status === 400 || res.status === 401 || res.status === 403) return { ok: false as const, message: "Google did not accept that key. Make a new one in Google AI Studio and paste it again." };
    } catch {
      /* Google not answering is no reason to turn a key away */
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (context.supabase as any).from("user_keys").upsert({ user_id: context.userId, gemini_key: key, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
    return error ? { ok: false as const, message: error.message } : { ok: true as const };
  });

/** Take the key away again; the shared one is used from then on. */
export const clearAiKey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (context.supabase as any).from("user_keys").update({ gemini_key: null, updated_at: new Date().toISOString() }).eq("user_id", context.userId);
    return error ? { ok: false as const, message: error.message } : { ok: true as const };
  });
