/* eslint-disable @typescript-eslint/no-explicit-any */
// The request body is arbitrary JSON from the Gmail bridge; it is validated
// by shape at each branch below rather than by a type.
import { createFileRoute } from "@tanstack/react-router";

/**
 * The Gmail bridge's only door in.
 *
 *   POST /api/public/email/ingest     header  x-engine-key: <ENGINE_API_KEY>
 *
 * Three shapes of body:
 *   { messages: [...] }              store and classify new mail
 *   { action: "pending_replies" }    what is cleared to send
 *   { action: "reply_result", ... }  record a send outcome
 *
 * Public (no session) on purpose: the caller is an Apps Script running in the
 * user's own Google account, not a browser. It authenticates with the same
 * shared key as the cron sweep, so there is one secret to configure rather
 * than two.
 */
export const Route = createFileRoute("/api/public/email/ingest")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = process.env["ENGINE_API_KEY"];
        if (!expected || request.headers.get("x-engine-key") !== expected) {
          return new Response("Unauthorized", { status: 401 });
        }

        let payload: any;
        try {
          payload = await request.json();
        } catch {
          return Response.json({ error: "body must be JSON" }, { status: 400 });
        }

        const { supabaseAdmin: everybody } = await import("@/integrations/supabase/client.server");
        const { forUser, personFor } = await import("@/lib/scope.server");
        const who = await personFor(everybody, request);
        if (!who) return Response.json({ ok: false, error: "not a person with a workspace" }, { status: 403 });
        const supabaseAdmin = forUser(everybody, who);
        const email = await import("@/lib/email.server");

        try {
          if (payload?.action === "pending_replies") {
            return Response.json(await email.pendingReplies(supabaseAdmin));
          }
          if (payload?.action === "reply_result") {
            return Response.json(await email.recordReplyResult(supabaseAdmin, payload.result));
          }
          return Response.json(await email.ingestMessages(supabaseAdmin, payload?.messages ?? []));
        } catch (e) {
          const message = String((e as Error)?.message ?? e);
          // Record it where Settings can show it. A bridge that has quietly
          // stopped looks exactly like an empty inbox, and this is the only
          // thing that tells them apart.
          await email.recordSyncError(supabaseAdmin, message).catch(() => {});
          return Response.json({ error: message }, { status: 500 });
        }
      },
    },
  },
});
