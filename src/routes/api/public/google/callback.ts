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

        const { supabaseAdmin: everybody } = await import("@/integrations/supabase/client.server");
        const { exchangeCode, expiryFrom, readState } = await import("@/lib/google.server");
        const { forUser, personFor } = await import("@/lib/scope.server");

        // Whose mailbox this is: the person who started the connection, as
        // sealed into the state, and only if they have a workspace.
        const named = await readState(url.searchParams.get("state"));
        const who = named ? await personFor(everybody, new Request(request.url, { headers: { "x-act-as": named } })) : null;
        if (!who) return back("This connection was not started from your panel, or took too long. Press connect again.", false);
        const supabaseAdmin = forUser(everybody, who);

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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const db = supabaseAdmin as any;

        // The person's one row: made the first time, updated after.
        await db.from("google_tokens").upsert(
          {
            id: 1,
            access_token: token.access_token,
            expires_at: expiryFrom(token.expires_in),
            scope: token.scope ?? null,
            email,
            connected_at: new Date().toISOString(),
            last_error: null,
            // Google issues a refresh token only at first consent. Never
            // overwrite a working one with the null a later grant returns.
            ...(token.refresh_token ? { refresh_token: token.refresh_token } : {}),
          },
          { onConflict: "id" },
        );

        if (!token.refresh_token) {
          const { data } = await db.from("google_tokens").select("refresh_token").eq("id", 1).maybeSingle();
          if (!data?.refresh_token) {
            return back(
              "Google did not return a refresh token, so access would expire within the hour. " +
                "Remove ApplyPilot at myaccount.google.com/permissions and connect again.",
              false,
            );
          }
        }

        // The first reading, now, rather than at the next half hour: so the
        // panel shows a mailbox that is being read as soon as it is connected.
        // Given a few seconds and no more; the regular reading catches up.
        try {
          await Promise.race([
            (async () => {
              const { fetchMessages } = await import("@/lib/gmail.server");
              const { ingestMessages } = await import("@/lib/email.server");
              const messages = await fetchMessages(supabaseAdmin, "in:inbox newer_than:2d", 15);
              await ingestMessages(supabaseAdmin, messages);
            })(),
            new Promise((done) => setTimeout(done, 12_000)),
          ]);
        } catch {
          /* connected either way */
        }

        return back(email ? `Connected ${email}` : "Connected", true);
      },
    },
  },
});
