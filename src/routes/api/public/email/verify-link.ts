import { createFileRoute } from "@tanstack/react-router";

/**
 * The activation link a portal just emailed, for the applier to open.
 *
 * The applier runs on a GitHub runner and cannot call a server function, so
 * it asks here. Call with  x-engine-key: <ENGINE_API_KEY>
 *
 *   POST /api/public/email/verify-link   { "host": "comcast.wd115.myworkdayjobs.com" }
 *   -> { "url": "https://comcast.wd115.myworkdayjobs.com/.../activate/..." }
 *
 * Returns url: null when nothing has arrived yet, which is an ordinary
 * answer — mail takes a moment, and the caller polls.
 */
export const Route = createFileRoute("/api/public/email/verify-link")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = process.env["ENGINE_API_KEY"];
        if (!expected || request.headers.get("x-engine-key") !== expected) {
          return new Response("Unauthorized", { status: 401 });
        }

        let host = "";
        // "reset" asks for a password-reset link instead of an activation one.
        let kind: "activate" | "reset" = "activate";
        try {
          const body = (await request.json()) as { host?: string; kind?: string } | null;
          host = String(body?.host ?? "").trim();
          if (body?.kind === "reset") kind = "reset";
        } catch {
          /* handled below */
        }
        if (!host) return Response.json({ url: null, error: "host required" }, { status: 400 });

        try {
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          const { findVerificationLink } = await import("@/lib/gmail.server");
          const url = await findVerificationLink(supabaseAdmin, host, 30, kind);
          return Response.json({ url: url ?? null });
        } catch (e) {
          // Reported rather than thrown, for the same reason the sweep
          // endpoint reports: the caller is a workflow with no console, and a
          // bare 502 from the host says nothing about what failed.
          return Response.json({
            url: null,
            error: String((e as Error)?.message ?? e).slice(0, 300),
          });
        }
      },
    },
  },
});
