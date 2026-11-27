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
 *   calls  at most every half hour, and only for a user who has connected
 *          their own phone and voice accounts: read back the calls already
 *          made, place the few that are due.
 *   health at most once in fifty minutes: is the mailbox being read, are
 *          rounds running, is anything going out. The owner is emailed
 *          when the answer changes.
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
// Every half hour, at the owner's asking: an invitation is answered inside
// thirty minutes. Each read wakes the database, which is billed for the
// hours it is awake, so this is as often as it goes.
const MAIL_EVERY_MIN = 25;
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
  const out: { ok: boolean; mail: string; watch: string; health?: string; calls?: string; people?: string; counts?: { read: number; stored?: number; drafted?: number; sent?: number; failed?: number; told?: number; booked?: number } } = {
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

  // Everyone with a workspace: the owner first, then whoever's mailbox has
  // waited longest. Each is done with a client that can see only that
  // person's rows. A pass that runs short of time stops between people; the
  // ones it did not reach are first in line next time.
  const everybody = supabase;
  const began = Date.now();
  const ROOM_MS = 25_000;
  let people: string[] = [];
  let forUser: (admin: any, uid: string) => any = () => everybody;
  try {
    const scope = await import("@/lib/scope.server");
    forUser = scope.forUser;
    people = await scope.everyone(everybody);
    // Whatever the shared list of employers has gained is copied into each
    // person's own list of boards to read. Cheap, and quiet when nothing is new.
    if (people.length > 1) await everybody.rpc("catalogue_sync").then(() => undefined, () => undefined);
  } catch (e) {
    return { ok: false, error: `could not tell whose turn it is: ${String((e as Error)?.message ?? e).slice(0, 80)}` };
  }

  /** One person's mailbox: read, filed, answered, and the person told what needs them. */
  const mailFor = async (supabase: any) => {
      const { fetchMessages } = await import("@/lib/gmail.server");
      const { ingestMessages, sendApprovedReplies } = await import("@/lib/email.server");
      const messages = await fetchMessages(supabase, "in:inbox newer_than:6h", 30);
      const counts: { read: number; stored?: number; drafted?: number; sent?: number; failed?: number; told?: number; booked?: number } = { read: messages.length };
      if (messages.length) {
        const r: any = await ingestMessages(supabase, messages);
        counts.stored = r?.stored ?? 0;
        counts.drafted = r?.drafted ?? 0;
        try {
          const { harvestAlerts, recordBoardApplications } = await import("@/lib/alerts.server");
          await harvestAlerts(supabase, messages);
          // Applications a board says were sent on the board itself.
          await recordBoardApplications(supabase, messages);
        } catch {
          /* the employers named in alerts are a bonus, never a reason to fail */
        }
      } else {
        // An empty inbox was still read: say so, or a quiet night looks to
        // the health check like a mailbox nobody is reading.
        await ingestMessages(supabase, []);
      }
      // Mail filed under interviews by an older reading is read again by
      // the current one, so a receipt that was called an interview stops
      // being one. Only ever from "interview" to something lesser.
      try {
        const { classifyEmail } = await import("@/lib/classify.server");
        const { data: filed } = await supabase
          .from("emails")
          .select("message_id, subject, body, reply_state")
          .eq("category", "interview")
          .order("received_at", { ascending: false })
          .limit(200);
        for (const e of filed ?? []) {
          const now = classifyEmail(e.subject, e.body).category;
          if (now === "interview") continue;
          // A reply drafted to a receipt is withdrawn with the label, unless
          // it has already gone or been approved by the owner.
          const withdraw = e.reply_state !== "sent" && e.reply_state !== "approved";
          await supabase
            .from("emails")
            .update(withdraw ? { category: now, reply_draft: null, reply_state: "none" } : { category: now })
            .eq("message_id", e.message_id);
        }
      } catch {
        /* tidying the labels never stops the mail */
      }
      const replies = await sendApprovedReplies(supabase);
      counts.sent = replies.sent;
      counts.failed = replies.failed;
      // The few messages the owner has to know about: an interview with a
      // time on it, a link to pick one, an assessment, an offer.
      try {
        const { tellOwner } = await import("@/lib/moments.server");
        const told = await tellOwner(supabase);
        counts.told = told.told;
        counts.booked = told.booked;
      } catch {
        /* telling the owner never stops the mail; it is tried again next hour */
      }
      return counts;
  };

  try {
    if (await claim(everybody, "mail", MAIL_EVERY_MIN)) {
      let done = 0;
      for (const uid of people) {
        if (done > 0 && Date.now() - began > ROOM_MS) break;
        try {
          const counts = await mailFor(forUser(everybody, uid));
          // The counts reported are the first person's, as they always were.
          if (done === 0) out.counts = counts;
        } catch (e) {
          if (done === 0) throw e;
        }
        done++;
      }
      out.mail = "done";
      if (people.length > 1) out.people = `${done} of ${people.length}`;
    }
  } catch (e) {
    out.mail = `failed: ${String((e as Error)?.message ?? e).slice(0, 80)}`;
  }

  // Its own turn, so that a mailbox that cannot be read — the commonest
  // thing to go wrong — does not also silence the check that would say so.
  try {
    if (await claim(everybody, "health", MAIL_EVERY_MIN)) {
      const { healthCheck } = await import("@/lib/moments.server");
      let first = true;
      for (const uid of people) {
        if (!first && Date.now() - began > ROOM_MS) break;
        const h = await healthCheck(forUser(everybody, uid)).catch((e) => {
          if (first) throw e;
          return null;
        });
        if (first && h) out.health = h.problems ? `${h.problems} to look at${h.emailed ? ", owner told" : ""}` : "well";
        first = false;
      }
    }
  } catch (e) {
    out.health = `failed: ${String((e as Error)?.message ?? e).slice(0, 80)}`;
  }
  // Calls, where the user has connected their own accounts and switched
  // them on. Every round, because a call placed last round is read back on
  // this one; without the accounts it is one small read and nothing more.
  try {
    if (await claim(everybody, "calls", WATCH_EVERY_MIN)) {
      const { runCalls } = await import("@/lib/dial.server");
      const c = { state: "off", placed: 0, read: 0, booked: 0 };
      let first = true;
      for (const uid of people) {
        if (!first && Date.now() - began > ROOM_MS) break;
        const one = await runCalls(forUser(everybody, uid)).catch((e) => {
          if (first) throw e;
          return null;
        });
        if (one) {
          if (first || (c.state === "off" && one.state !== "off")) c.state = one.state;
          c.placed += one.placed;
          c.read += one.read;
          c.booked += one.booked;
        }
        first = false;
      }
      out.calls = c.state === "off" && !c.read ? "off" : `${c.state}: ${c.placed} placed, ${c.read} read back${c.booked ? `, ${c.booked} time(s) sent to the owner` : ""}`;
    }
  } catch (e) {
    out.calls = `failed: ${String((e as Error)?.message ?? e).slice(0, 80)}`;
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
