import { createFileRoute } from "@tanstack/react-router";

/**
 * Read the mailbox, without a browser session.
 *
 *   POST /api/public/email/sync     header  x-engine-key: <ENGINE_API_KEY>
 *   { "query": "in:inbox newer_than:3d", "max": 50 }     both optional
 *
 * Syncing Gmail was something a person had to press, which means the
 * confirmations for an unattended run sat unread until someone happened to
 * open the panel. The applier finishes a run knowing exactly when new mail is
 * worth looking for — an employer's acknowledgement arrives within minutes of
 * a submission — so it should be the thing that asks.
 *
 * Public in the same sense as the cron sweep and the Gmail bridge beside it:
 * no session, one shared key, and it reads the owner's own mailbox with the
 * owner's own stored token. It cannot be made to read anyone else's.
 */
export const Route = createFileRoute("/api/public/email/sync")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = process.env["ENGINE_API_KEY"];
        if (!expected || request.headers.get("x-engine-key") !== expected) {
          return new Response("Unauthorized", { status: 401 });
        }

        let body: { query?: string; max?: number } = {};
        try {
          body = ((await request.json()) as typeof body) ?? {};
        } catch {
          body = {};
        }

        try {
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          const { fetchMessages } = await import("@/lib/gmail.server");
          const { ingestMessages, sendApprovedReplies } = await import("@/lib/email.server");
          // Whatever was cleared to go goes now, whether or not there is new
          // mail: a reply approved by hand an hour ago is waiting on this.
          const flush = async () => {
            try {
              return await sendApprovedReplies(supabaseAdmin);
            } catch (e) {
              return { sent: 0, failed: 0, error: String((e as Error)?.message ?? e).slice(0, 120) };
            }
          };

          const max = Math.min(Math.max(Math.trunc(body.max ?? 40), 1), 200);
          const messages = await fetchMessages(
            supabaseAdmin,
            body.query ?? "in:inbox newer_than:2d",
            max,
          );
          if (!messages.length) {
            return Response.json({ ok: true, stored: 0, message: "nothing new", replies: await flush() });
          }

          const result = await ingestMessages(supabaseAdmin, messages);
          // Job-board alerts are never stored as mail, but the employers
          // they name are worth knowing about. A failure here must not cost
          // the sync its result.
          let alerts: unknown = null;
          try {
            const { harvestAlerts } = await import("@/lib/alerts.server");
            alerts = await harvestAlerts(supabaseAdmin, messages);
          } catch (e) {
            alerts = { error: String((e as Error)?.message ?? e).slice(0, 160) };
          }
          // Spread first: ingestMessages reports its own ok, and letting
          // it land after this one would overwrite the answer with its own.
          // After the reading, so a request that arrived a minute ago is
          // drafted, cleared and answered in this same pass.
          return Response.json({ ...result, alerts, replies: await flush(), ok: true });
        } catch (e) {
          // Reported as 200 with an error field, like the sweep: a caller
          // with no console needs to be able to read what went wrong, and a
          // failed mailbox read must never fail the run that asked for it.
          const message = String((e as Error)?.message ?? e);
          try {
            const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
            const { recordSyncError } = await import("@/lib/email.server");
            await recordSyncError(supabaseAdmin, message);
          } catch {
            /* recording the failure must not become a second failure */
          }
          return Response.json({ ok: false, error: message.slice(0, 300) });
        }
      },
    },
  },
});
