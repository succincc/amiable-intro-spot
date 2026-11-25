import { createFileRoute } from "@tanstack/react-router";

/**
 * Scheduled discovery + scoring. Call with header  x-engine-key: <ENGINE_API_KEY>
 *   POST /api/public/cron/sweep
 */
export const Route = createFileRoute("/api/public/cron/sweep")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = process.env["ENGINE_API_KEY"];
        if (!expected || request.headers.get("x-engine-key") !== expected) {
          return new Response("Unauthorized", { status: 401 });
        }
        // Either part on its own, or both. Hosts cap how long a single
        // request may run, and discovery followed by scoring can exceed that
        // on a large queue — at which point the request is killed partway and
        // the panel is told nothing. Running them as two calls keeps each one
        // comfortably inside the limit.
        let only = "both";
        // When the caller began its round of requests: discovery reports how
        // many employers have not been read since then, so it knows when to
        // stop asking.
        let since: string | undefined;
        try {
          const body = (await request.json()) as { only?: string; since?: string } | null;
          if (body?.only === "discover" || body?.only === "score") only = body.only;
          if (typeof body?.since === "string" && Number.isFinite(Date.parse(body.since))) {
            since = body.since;
          }
        } catch {
          // No body, or not JSON. "both" is the right default for a plain
          // scheduled POST, which is how this endpoint started.
        }

        // An error that escapes this handler reaches the caller as a bare
        // "502 Internal server error" from the host, which says nothing about
        // what failed — and the caller is a workflow, so there is no console
        // to look in. Catching it here is the difference between a diagnosis
        // and another guess.
        const started = Date.now();
        try {
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          const discover =
            only === "score"
              ? null
              : await (await import("@/lib/discover.server")).runDiscover(supabaseAdmin, { since });
          const score =
            only === "discover"
              ? null
              : await (await import("@/lib/score.server")).runScore(supabaseAdmin);
          return Response.json({ only, ms: Date.now() - started, discover, score });
        } catch (e) {
          const err = e as Error;
          return Response.json(
            {
              only,
              ms: Date.now() - started,
              ok: false,
              error: String(err?.message ?? e).slice(0, 500),
              // The first few frames are usually enough to name the call that
              // threw, and the whole trace would not fit a log line.
              stack: String(err?.stack ?? "").split("\n").slice(0, 6).join(" | ").slice(0, 800),
            },
            // 200 on purpose: the request completed and this IS its result.
            // A non-200 here is indistinguishable from the host refusing,
            // which is the confusion this exists to end.
            { status: 200 },
          );
        }
      },
    },
  },
});
