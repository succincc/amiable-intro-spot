import { createFileRoute } from "@tanstack/react-router";

/**
 * "Anything due?" — asked every few minutes, by anyone.
 *
 * Asked once an hour by the watch job on GitHub, which keeps the time for
 * the whole system. (The database asked every five minutes for one
 * afternoon; a timer inside the database never lets it sleep, and it is
 * billed for the hours it is awake. That timer is gone.) Each time, two
 * things are considered:
 *
 *   mail   at most once in fifty minutes: read the mailbox, draft what needs
 *          a reply, and send the replies that have been cleared to go.
 *   watch  at most every half hour: wake the job on GitHub that starts
 *          whatever else has come round, in case its own chain has broken.
 *
 * No key is asked for, on purpose: a key the database had to hold would have
 * to be written into a migration in a public repository. It is safe without
 * one because asking changes nothing about WHEN things happen. Each thing is
 * claimed in the database before it is done — "mail, if it was last done
 * more than fifty minutes ago" — in a single statement, so a thousand callers
 * in a minute get one read of the mailbox between them, the same as one
 * caller would. And nothing comes back but which of the two were done and a
 * few counts: no mail, no names.
 *
 *   GET or POST /api/public/cron/tick
 *   -> { "ok": true, "mail": "done" | "not due" | "failed", "watch": … }
 */
// Hourly, not every few minutes. Each read wakes the database, which is
// billed for the hours it is awake; a reply inside the hour is soon enough.
const MAIL_EVERY_MIN = 50;
const WATCH_EVERY_MIN = 25;

/** Take the turn, if it has come round. True for exactly one caller. */
async function claim(supabase: any, name: string, everyMin: number): Promise<boolean> {
  const cutoff = new Date(Date.now() - everyMin * 60_000).toISOString();
  const { data, error } = await supabase
    .from("heartbeat")
    .update({ at: new Date().toISOString() })
    .eq("name", name)
    .lt("at", cutoff)
    .select("name");
  if (error) throw new Error(error.message);
  return (data?.length ?? 0) > 0;
}

async function tick() {
  const out: { ok: boolean; mail: string; watch: string; counts?: { read: number; stored?: number; drafted?: number; sent?: number; failed?: number } } = {
    ok: true,
    mail: "not due",
    watch: "not due",
  };
  let supabase: any;
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // heartbeat is newer than the generated types.
    supabase = supabaseAdmin as any;
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 120) };
  }

  // The watch first: it is one quick request, and must not wait behind a
  // slow mailbox.
  try {
    if (await claim(supabase, "watch", WATCH_EVERY_MIN)) {
      const token = process.env["GITHUB_TOKEN"];
      const repo = process.env["GITHUB_REPO"];
      if (!token || !repo) {
        out.watch = "no GitHub connection in the panel";
      } else {
        const res = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
            "User-Agent": "ApplyPilot",
          },
          body: JSON.stringify({ event_type: "tick" }),
          signal: AbortSignal.timeout(15_000),
        });
        out.watch = res.status === 204 ? "woken" : `GitHub answered ${res.status}`;
      }
    }
  } catch (e) {
    out.watch = `failed: ${String((e as Error)?.message ?? e).slice(0, 80)}`;
  }

  try {
    if (await claim(supabase, "mail", MAIL_EVERY_MIN)) {
      const { fetchMessages } = await import("@/lib/gmail.server");
      const { ingestMessages, sendApprovedReplies } = await import("@/lib/email.server");
      const messages = await fetchMessages(supabase, "in:inbox newer_than:6h", 30);
      const counts: { read: number; stored?: number; drafted?: number; sent?: number; failed?: number } = { read: messages.length };
      if (messages.length) {
        const r: any = await ingestMessages(supabase, messages);
        counts.stored = r?.stored ?? 0;
        counts.drafted = r?.drafted ?? 0;
        try {
          const { harvestAlerts } = await import("@/lib/alerts.server");
          await harvestAlerts(supabase, messages);
        } catch {
          /* the employers named in alerts are a bonus, never a reason to fail */
        }
      }
      // Mail filed under interviews by an older reading is read again by
      // the current one, so a receipt that was called an interview stops
      // being one. Only ever from "interview" to something lesser.
      try {
        const { classifyEmail } = await import("@/lib/classify.server");
        const { data: filed } = await supabase
          .from("emails")
          .select("message_id, subject, body")
          .eq("category", "interview")
          .order("received_at", { ascending: false })
          .limit(60);
        for (const e of filed ?? []) {
          const now = classifyEmail(e.subject, e.body).category;
          if (now !== "interview") await supabase.from("emails").update({ category: now }).eq("message_id", e.message_id);
        }
      } catch {
        /* tidying the labels never stops the mail */
      }
      const replies = await sendApprovedReplies(supabase);
      counts.sent = replies.sent;
      counts.failed = replies.failed;
      out.mail = "done";
      out.counts = counts;
    }
  } catch (e) {
    out.mail = `failed: ${String((e as Error)?.message ?? e).slice(0, 80)}`;
  }
  return out;
}

export const Route = createFileRoute("/api/public/cron/tick")({
  server: {
    handlers: {
      GET: async () => Response.json(await tick()),
      POST: async () => Response.json(await tick()),
    },
  },
});
