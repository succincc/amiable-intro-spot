import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * The server's client, limited to the signed-in person. The keys are kept
 * where no browser can read them, so they are read with the server's own
 * key — and only ever that person's row.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function own(userId: string): Promise<any> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { forUser } = await import("@/lib/scope.server");
  return forUser(supabaseAdmin, userId);
}

type Keys = { voice_key?: string; voice_id?: string; phone_sid?: string; phone_token?: string; phone_number?: string };

/** Which of the user's own provider keys are set. Never the keys themselves. */
export const callingStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const supabaseAdmin = await own(context.userId);
    // call_keys is newer than the generated types.
    const { data, error } = await supabaseAdmin.from("call_keys").select("voice_key, voice_id, phone_sid, phone_token, phone_number").eq("id", 1).maybeSingle();
    if (error) return { ok: false as const, message: error.message };
    return {
      ok: true as const,
      voice: Boolean(data?.voice_key),
      voiceId: Boolean(data?.voice_id),
      phone: Boolean(data?.phone_sid && data?.phone_token),
      // The number is the user's own and is shown back; the secrets are not.
      number: (data?.phone_number as string | null) ?? null,
    };
  });

/** Save the keys a user pasted. An empty box leaves what is there alone. */
export const saveCallingKeys = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: Keys) => d)
  .handler(async ({ context, data }) => {
    const supabaseAdmin = await own(context.userId);
    const patch: Record<string, string> = {};
    for (const k of ["voice_key", "voice_id", "phone_sid", "phone_token", "phone_number"] as const) {
      const v = String(data[k] ?? "").trim();
      if (v) patch[k] = v.slice(0, 200);
    }
    if (!Object.keys(patch).length) return { ok: true as const, saved: 0 };
    // The assistant and the number are set up in the voice account from
    // these; anything changed here means setting them up again.
    const fresh: Record<string, null> = {};
    if (patch["voice_key"] || patch["voice_id"]) fresh["agent_id"] = null;
    if (patch["voice_key"] || patch["phone_sid"] || patch["phone_token"] || patch["phone_number"]) fresh["phone_id"] = null;
    const { error } = await supabaseAdmin.from("call_keys").upsert({ id: 1, ...patch, ...fresh, updated_at: new Date().toISOString() }, { onConflict: "id" });
    return error ? { ok: false as const, message: error.message } : { ok: true as const, saved: Object.keys(patch).length };
  });

/** Remove every key: the extra is disconnected and nothing more can be billed through it. */
export const clearCallingKeys = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const supabaseAdmin = await own(context.userId);
    const { error } = await supabaseAdmin.from("call_keys").delete().eq("id", 1);
    return error ? { ok: false as const, message: error.message } : { ok: true as const };
  });
