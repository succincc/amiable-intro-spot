/* eslint-disable @typescript-eslint/no-explicit-any */
// ============================================================================
// google.server.ts — the OAuth half of Gmail access.
//
// Nothing here talks to Gmail; it only gets and keeps a usable access token.
// The mail itself is in gmail.server.ts.
//
// The one thing worth knowing: Google issues a refresh token ONCE, at the
// first consent, and later grants come back without one. Overwriting the
// stored value with the null from a second grant is the classic way to break
// this, and the symptom appears days later as a mailbox that will not
// reconnect. So a null refresh token never replaces a real one.
// ============================================================================

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

/**
 * Read mail, and send it. Deliberately not modify or full access, which
 * allow deleting mail.
 *
 * And, for offering interview times: when the calendar is busy. That is the
 * whole of it — calendar.freebusy returns start and end times and nothing
 * else. It cannot read an event, and cannot create, change or delete one.
 * A mailbox connected before this was added keeps working without it; the
 * replies simply fall back to the availability written in settings.
 */
export const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/calendar.freebusy",
].join(" ");

export function clientConfig() {
  const id = process.env["GOOGLE_CLIENT_ID"] ?? "";
  const secret = process.env["GOOGLE_CLIENT_SECRET"] ?? "";
  // The redirect must match what is registered in Google Cloud Console byte
  // for byte, so it is derived from one setting rather than guessed per call.
  const base = (process.env["APP_URL"] ?? "https://applynow.lol").replace(/\/+$/, "");
  return { id, secret, redirectUri: `${base}/api/public/google/callback` };
}

/**
 * The URL that asks the user for consent.
 *
 * access_type=offline and prompt=consent are both required to be handed a
 * refresh token. Without them Google returns only an access token, which
 * expires in an hour and cannot be renewed — the mailbox would then
 * disconnect the same afternoon.
 */
export function buildAuthUrl(state: string): string {
  const { id, redirectUri } = clientConfig();
  const url = new URL(AUTH_URL);
  url.searchParams.set("client_id", id);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);
  return url.toString();
}

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
};

async function postToken(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  return (await res.json()) as TokenResponse;
}

export async function exchangeCode(code: string): Promise<TokenResponse> {
  const { id, secret, redirectUri } = clientConfig();
  return postToken({
    code,
    client_id: id,
    client_secret: secret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
}

export async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const { id, secret } = clientConfig();
  return postToken({
    refresh_token: refreshToken,
    client_id: id,
    client_secret: secret,
    grant_type: "refresh_token",
  });
}

/** A minute of slack, so a token does not expire mid-request. */
export function isExpired(expiresAt: string | null | undefined): boolean {
  if (!expiresAt) return true;
  return new Date(expiresAt).getTime() - 60_000 <= Date.now();
}

export function expiryFrom(expiresIn: number | undefined): string {
  return new Date(Date.now() + (expiresIn ?? 3600) * 1000).toISOString();
}

/**
 * A valid access token, refreshing it if the stored one has aged out.
 *
 * Returns null rather than throwing when the mailbox is not connected, so a
 * caller can carry on without Gmail instead of failing a whole run over it.
 */
export async function getAccessToken(supabase: any): Promise<string | null> {
  const { data: row } = await supabase.from("google_tokens").select("*").eq("id", 1).maybeSingle();

  if (!row?.refresh_token) return null;
  if (row.access_token && !isExpired(row.expires_at)) return row.access_token;

  const fresh = await refreshAccessToken(row.refresh_token);
  if (!fresh.access_token) {
    // invalid_grant means the grant is gone for good: revoked, or the app was
    // left in Testing and Google expired it after seven days. Say which,
    // because the fix is completely different.
    const why =
      fresh.error === "invalid_grant"
        ? "Gmail access was revoked or expired. If this happened about a week " +
          "after connecting, the OAuth app is still in Testing — publish it to " +
          "production and reconnect."
        : `${fresh.error ?? "unknown"}: ${fresh.error_description ?? ""}`;
    await supabase.from("google_tokens").update({ last_error: why }).eq("id", 1);
    return null;
  }

  await supabase
    .from("google_tokens")
    .update({
      access_token: fresh.access_token,
      expires_at: expiryFrom(fresh.expires_in),
      // NEVER write a null over a working refresh token: a refresh response
      // does not include one, and clearing it would disconnect the mailbox.
      ...(fresh.refresh_token ? { refresh_token: fresh.refresh_token } : {}),
      last_error: null,
    })
    .eq("id", 1);

  return fresh.access_token;
}
