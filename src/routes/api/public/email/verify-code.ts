import { createFileRoute } from "@tanstack/react-router";

/**
 * The one-time code a portal has just emailed, for the applier to type back.
 *
 *   POST /api/public/email/verify-code    header  x-engine-key: <ENGINE_API_KEY>
 *   { "host": "job-boards.greenhouse.io" }
 *
 * Greenhouse answers a submitted application with "Copy and paste this code
 * into the security code field on your application", eight digits, and
 * "after you enter the code, resubmit your application". Without reading it
 * every Greenhouse application stops one step from done: form filled, resume
 * attached, and the last thing between it and submission sitting in a
 * mailbox the panel can already read.
 *
 * The sibling of verify-link, which does the same for Workday's activation
 * URL. Errors come back as 200 with an error field, because the caller is a
 * workflow with no console and a failed read must not fail the run.
 */
export const Route = createFileRoute("/api/public/email/verify-code")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = process.env["ENGINE_API_KEY"];
        if (!expected || request.headers.get("x-engine-key") !== expected) {
          return new Response("Unauthorized", { status: 401 });
        }

        try {
          const body = (await request.json()) as { host?: string; company?: string; since?: string } | null;
          // When this application asked for its code; older messages are
          // some other application's, however alike they look.
          const asked = Date.parse(String(body?.since ?? ""));
          const since = Number.isFinite(asked) ? asked : null;
          const host = String(body?.host ?? "").trim();
          // The employer, so a run applying to four companies at once does not
          // take the wrong one's code. Every Greenhouse form shares a host.
          const company = String(body?.company ?? "").trim() || null;
          if (!host) return Response.json({ error: "no host given" });

          const { supabaseAdmin: everybody } = await import("@/integrations/supabase/client.server");
          const { forUser, personFor } = await import("@/lib/scope.server");
          const who = await personFor(everybody, request);
          if (!who) return Response.json({ ok: false, error: "not a person with a workspace" }, { status: 403 });
          const supabaseAdmin = forUser(everybody, who);
          const { findVerificationCode } = await import("@/lib/gmail.server");
          const code = await findVerificationCode(supabaseAdmin, host, company, since);
          return Response.json({ code: code ?? null });
        } catch (e) {
          return Response.json({ error: String((e as Error)?.message ?? e).slice(0, 200) });
        }
      },
    },
  },
});
