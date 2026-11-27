import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Remove a person's login altogether: the request, the account, and the way
 * back in. Only the owner may, and never their own. Done on the server
 * because a login can only be deleted with the server's key.
 */
export const removeMember = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { user_id: string }) => d)
  .handler(async ({ context, data }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = context.supabase as any;
    const { data: owner, error } = await sb.rpc("is_app_owner");
    if (error || owner !== true) return { ok: false as const, message: "Only the owner can do this." };
    const id = String(data.user_id ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(id)) return { ok: false as const, message: "Not a person on the list." };
    if (context.userId === id) return { ok: false as const, message: "The owner's own login is not removed from here." };
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // Only someone on the list of requests: never a login that is not there.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: row } = await (supabaseAdmin as any).from("members").select("user_id").eq("user_id", id).maybeSingle();
    if (!row) return { ok: false as const, message: "Not a person on the list." };
    const gone = await supabaseAdmin.auth.admin.deleteUser(id);
    if (gone.error) return { ok: false as const, message: gone.error.message };
    return { ok: true as const };
  });
