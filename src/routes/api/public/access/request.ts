import { createFileRoute } from "@tanstack/react-router";

import { signupProblem } from "@/lib/access";

/**
 * A request to join.
 *
 * Signing up on one's own is switched off for this panel, and stays off: a
 * login is only ever made here, by the server, and always as a request the
 * owner has yet to answer. So nobody can make a login by going around the
 * page, and a login that exists has always been asked for by name.
 *
 * The door is public, so it is narrow: a full name, an address, a password
 * of some length; and it closes for a while if it is being knocked on too
 * often, so that it cannot be used to fill the owner's list with noise.
 *
 *   POST /api/public/access/request   { full_name, email, password }
 *   -> { ok: true } | { ok: false, message }
 */
const MOST_WAITING = 150;
const MOST_AN_HOUR = 25;

export const Route = createFileRoute("/api/public/access/request")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: { full_name?: unknown; email?: unknown; password?: unknown } = {};
        try {
          body = ((await request.json()) as typeof body) ?? {};
        } catch {
          body = {};
        }
        const fullName = String(body.full_name ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
        const email = String(body.email ?? "").trim().toLowerCase().slice(0, 200);
        const password = String(body.password ?? "");
        const problem = signupProblem({ fullName, email, password, confirm: password });
        if (problem) return Response.json({ ok: false, message: problem }, { status: 400 });
        if (password.length > 200) return Response.json({ ok: false, message: "That password is too long." }, { status: 400 });

        try {
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          // members is newer than the generated types.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const db = supabaseAdmin as any;
          const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
          const [{ count: waiting }, { count: lately }] = await Promise.all([
            db.from("members").select("user_id", { count: "exact", head: true }).eq("status", "pending"),
            db.from("members").select("user_id", { count: "exact", head: true }).gte("created_at", hourAgo),
          ]);
          if ((waiting ?? 0) >= MOST_WAITING || (lately ?? 0) >= MOST_AN_HOUR) {
            return Response.json({ ok: false, message: "Requests are not being taken right now. Try again later." }, { status: 429 });
          }

          const made = await supabaseAdmin.auth.admin.createUser({
            email,
            password,
            // The owner's yes is the check that matters; a person is not made
            // to wait on a confirmation email as well.
            email_confirm: true,
            user_metadata: { full_name: fullName },
          });
          if (made.error || !made.data.user) {
            const said = String(made.error?.message ?? "");
            if (/already|registered|exists/i.test(said)) {
              return Response.json({ ok: false, message: "There is already a login for that email. Sign in instead; if a request is waiting, the owner has yet to answer it." }, { status: 409 });
            }
            return Response.json({ ok: false, message: said.slice(0, 160) || "The request could not be made." }, { status: 400 });
          }
          const { error } = await db.from("members").upsert(
            { user_id: made.data.user.id, email, full_name: fullName, status: "pending" },
            { onConflict: "user_id", ignoreDuplicates: true },
          );
          if (error) {
            // A login with no request behind it would be a way in nobody can
            // see: take it away again.
            await supabaseAdmin.auth.admin.deleteUser(made.data.user.id).catch(() => undefined);
            return Response.json({ ok: false, message: "The request could not be filed. Try again." }, { status: 500 });
          }
          return Response.json({ ok: true });
        } catch (e) {
          return Response.json({ ok: false, message: String((e as Error)?.message ?? e).slice(0, 160) }, { status: 500 });
        }
      },
    },
  },
});
