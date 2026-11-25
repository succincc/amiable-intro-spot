import type { Tables } from "@/integrations/supabase/types";

type ConnectionRow = Pick<Tables<"google_tokens">, "refresh_token" | "email" | "connected_at" | "last_sync_at" | "last_error">;

/** Never send Gmail credentials to the Settings page. */
export function gmailConnectionState(row: ConnectionRow | null, profileEmail?: string | null) {
  const connected = Boolean(row?.refresh_token);
  const email = row?.email ?? null;
  const expected = (profileEmail ?? "").trim();

  // The applier submits every application as profile.email, so confirmations
  // and Workday verification codes arrive at THAT address. Connecting a
  // different mailbox raises no error anywhere: the sync succeeds and finds
  // nothing, forever, which is indistinguishable from "no replies yet". That
  // is a bad way to lose a week, so it gets said out loud.
  const mismatch =
    connected && email && expected && email.toLowerCase() !== expected.toLowerCase()
      ? `Applications are sent as ${expected}, but the connected mailbox is ${email}. ` +
        `Confirmations and verification codes arrive at ${expected}, so this sync cannot see them.`
      : null;

  return {
    connected,
    email,
    connected_at: row?.connected_at ?? null,
    last_sync_at: row?.last_sync_at ?? null,
    last_error: row?.last_error ?? null,
    mismatch,
  };
}