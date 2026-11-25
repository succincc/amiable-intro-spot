import { createFileRoute } from "@tanstack/react-router";

/**
 * Where Google sends the browser back after consent.
 *
 * Public by necessity: the user arrives here from accounts.google.com with
 * no session cookie of ours. The one-time code in the URL is the credential,
 * and it is worthless without the client secret, which never leaves the
 * server.
 */
export const Route = createFileRoute("/api/public/google/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");
        const base = url.origin;

        const back = (message: string, ok: boolean) =>
          new Response(null, {
            status: 302,
            headers: {
              Location: `${base}/settings?gmail=${ok ? "connected" : "failed"}&detail=${encodeURIComponent(message)}`,
            },
          });

        // The user pressed Cancel, or Google refused.
        if (error)
          return back(error === "access_denied" ? "You cancelled the connection." : error, false);
        if (!code) return back("Google sent no authorisation code.", false);

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { exchangeCode, expiryFrom } = await import("@/lib/google.server");

        const token = await exchangeCode(code);
        if (!token.access_token) {
          return back(
            `${token.error ?? "exchange failed"}: ${token.error_description ?? ""}`.slice(0, 200),
            false,
          );
        }

        // Which mailbox did they actually grant? Worth storing, so the panel
        // can show it and a wrong-account connection is obvious.
        let email: string | null = null;
        try {
          const who = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
            headers: { Authorization: `Bearer ${token.access_token}` },
          });
          if (who.ok) email = (await who.json())?.email ?? null;
        } catch {
          /* the grant still works without knowing the address */
        }

        // google_tokens arrives with this feature's migration; the generated
        // Supabase types will not know it until they are regenerated.
        const db = supabaseAdmin as unknown as {
          from(table: string): {
            update(patch: Record<string, unknown>): { eq(c: string, v: unknown): Promise<unknown> };
            select(cols: string): {
              eq(
                c: string,
                v: unknown,
              ): { maybeSingle(): Promise<{ data: { refresh_token?: string } | null }> };
            };
          };
        };

        await db
          .from("google_tokens")
          .update({
            access_token: token.access_token,
            expires_at: expiryFrom(token.expires_in),
            scope: token.scope ?? null,
            email,
            connected_at: new Date().toISOString(),
            last_error: null,
            // Google issues a refresh token only at first consent. Never
            // overwrite a working one with the null a later grant returns.
            ...(token.refresh_token ? { refresh_token: token.refresh_token } : {}),
          })
          .eq("id", 1);

        if (!token.refresh_token) {
          const { data } = await db
            .from("google_tokens")
            .select("refresh_token")
            .eq("id", 1)
            .maybeSingle();
          if (!data?.refresh_token) {
            return back(
              "Google did not return a refresh token, so access would expire within the hour. " +
                "Remove ApplyPilot at myaccount.google.com/permissions and connect again.",
              false,
            );
          }
        }

        return back(email ? `Connected ${email}` : "Connected", true);
      },
    },
  },
});
