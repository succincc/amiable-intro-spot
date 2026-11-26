import { createFileRoute } from "@tanstack/react-router";

/**
 * The day in one email, to the owner's own mailbox.
 *
 * Everything this system does happens while nobody is looking, and until now
 * the only way to know what it had done was to open the panel — or a run log.
 * This writes it down once a day: what was sent, who wrote back, what is
 * stuck and why, and how much is waiting. Call with
 * x-engine-key: <ENGINE_API_KEY>
 *
 *   POST /api/public/email/summary      { "dry": false }
 *   -> { "ok": true, "state": "sent", "sent": 48, "replies": 3, "stuck": 6 }
 *
 * Nothing is sent unless the owner has switched the summary on in settings,
 * and it only ever goes to the connected Gmail account's own address. With
 * "dry": true it is counted and not sent. The reply carries counts, never the
 * text: the caller is a public runner and its log is public too.
 */
const DAY = 24 * 60 * 60_000;

export const Route = createFileRoute("/api/public/email/summary")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = process.env["ENGINE_API_KEY"];
        if (!expected || request.headers.get("x-engine-key") !== expected) {
          return new Response("Unauthorized", { status: 401 });
        }
        let b: any = null;
        try {
          b = await request.json();
        } catch {
          /* an empty body is fine */
        }
        const dry = b?.dry === true;

        try {
          const { supabaseAdmin: typed } = await import("@/integrations/supabase/client.server");
          // daily_summary is newer than the generated types.
          const supabaseAdmin = typed as any;

          const { data: profile } = await supabaseAdmin.from("profile").select("daily_summary").eq("id", 1).maybeSingle();
          const on = profile?.daily_summary === true;
          if (!on && !dry) return Response.json({ ok: true, state: "off" });

          const since = new Date(Date.now() - DAY).toISOString();
          const [sent, replies, stuck, ready, review, followUps, questions] = await Promise.all([
            supabaseAdmin.from("jobs").select("company,title,ats,applied_at").gte("applied_at", since).order("applied_at", { ascending: false }).limit(400),
            supabaseAdmin.from("emails").select("from_addr,subject,category,received_at,reply_state").eq("direction", "in").gte("received_at", since).order("received_at", { ascending: false }).limit(200),
            supabaseAdmin.from("jobs").select("company,help_reason").eq("status", "needs_help").limit(400),
            supabaseAdmin.from("jobs").select("id", { count: "exact", head: true }).eq("status", "queued"),
            supabaseAdmin.from("jobs").select("id", { count: "exact", head: true }).eq("status", "review"),
            supabaseAdmin.from("outreach").select("id", { count: "exact", head: true }).eq("state", "sent").gte("sent_at", since),
            supabaseAdmin.from("answers").select("id", { count: "exact", head: true }).eq("confirmed", false).eq("answer", ""),
          ]);

          // The week's booked interviews, and how the month has been answered.
          const coming: Array<{ when: string; what: string }> = [];
          let month: { sent: number; interviews: number; offers: number; rejected: number } | undefined;
          try {
            const { cleanHolds } = await import("@/lib/availability");
            const { sayWhen } = await import("@/lib/moments");
            const { data: p } = await supabaseAdmin.from("profile").select("interview_holds, timezone").eq("id", 1).maybeSingle();
            const zone = String(p?.timezone ?? "").trim() || "America/New_York";
            const now = new Date();
            const booked = cleanHolds(p?.interview_holds, now)
              .filter((h) => h.state === "booked" && new Date(h.start).getTime() < now.getTime() + 7 * DAY)
              .sort((a, b) => a.start.localeCompare(b.start));
            const ids = booked.map((h) => h.ref).filter((r) => /^[0-9a-f-]{36}$/i.test(r));
            const { data: named } = ids.length ? await supabaseAdmin.from("jobs").select("id, title, company").in("id", ids) : { data: [] };
            for (const h of booked) {
              const j = (named ?? []).find((x: any) => x.id === h.ref);
              coming.push({ when: sayWhen(new Date(h.start), zone), what: j ? `${j.title} at ${j.company}` : "an interview" });
            }
            const since30 = new Date(Date.now() - 30 * DAY).toISOString();
            const count = (status?: string) => {
              const q = supabaseAdmin.from("jobs").select("id", { count: "exact", head: true }).gte("applied_at", since30);
              return status ? q.eq("status", status) : q;
            };
            const [all, iv, of, rj] = await Promise.all([count(), count("interview"), count("offer"), count("rejected")]);
            month = { sent: all.count ?? 0, interviews: iv.count ?? 0, offers: of.count ?? 0, rejected: rj.count ?? 0 };
          } catch {
            /* the summary goes out without them */
          }

          const { composeSummary } = await import("@/lib/summary");
          const made = composeSummary({
            coming,
            ...(month ? { month } : {}),
            sent: sent.data ?? [],
            replies: replies.data ?? [],
            stuck: stuck.data ?? [],
            ready: ready.count ?? 0,
            review: review.count ?? 0,
            followUps: followUps.count ?? 0,
            questions: questions.count ?? 0,
          });
          const counts = {
            sent: (sent.data ?? []).length,
            replies: (replies.data ?? []).length,
            stuck: (stuck.data ?? []).length,
            ready: ready.count ?? 0,
            review: review.count ?? 0,
          };
          if (dry) return Response.json({ ok: true, state: on ? "dry" : "dry (switched off)", ...counts });

          const { sendToSelf } = await import("@/lib/gmail.server");
          const out = await sendToSelf(supabaseAdmin, made.subject, made.body);
          if (!out.ok) return Response.json({ ok: false, state: "failed", error: out.error, ...counts }, { status: 502 });
          return Response.json({ ok: true, state: "sent", ...counts });
        } catch (e) {
          return Response.json({ ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) }, { status: 500 });
        }
      },
    },
  },
});
