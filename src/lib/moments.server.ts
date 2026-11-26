/* eslint-disable @typescript-eslint/no-explicit-any */
// ============================================================================
// moments.server.ts — telling the owner, and only when it matters.
//
// Called once an hour, after the mailbox has been read and filed:
//
//   tellOwner    looks at mail filed in the last day and a half that the
//                owner has not been told about. An interview with a settled
//                time is marked booked on the owner's calendar of windows,
//                the other times held for that employer are let go, and the
//                owner is sent the brief with a calendar file. A link to
//                pick a time, an assessment and an offer are each sent on,
//                once. A rejection frees whatever was held and says nothing.
//
//   healthCheck  asks whether the system is still doing its job, and emails
//                the owner when the answer changes.
//
// Everything is sent to the connected mailbox's own address and nowhere
// else. What comes back to the caller is counts: the caller's log is public.
// The reading rules are moments.ts, each with a test.
// ============================================================================

import { afterBooking, afterRejection, healthProblems, icsFor, momentOf, noticeFor } from "@/lib/moments";

const HOUR = 60 * 60_000;
/** No more than this many emails to the owner in one pass. */
const MOST = 6;

export async function tellOwner(supabase: any, now = new Date()): Promise<{ told: number; booked: number; released: number; looked: number }> {
  const out = { told: 0, booked: 0, released: 0, looked: 0 };
  const { data: profile } = await supabase.from("profile").select("*").eq("id", 1).maybeSingle();
  if (!profile) return out;
  const zone = String(profile.timezone ?? "").trim() || "America/New_York";
  const own = String(profile.email ?? "").trim().toLowerCase();
  const speak = profile.notify_moments !== false;

  const { data: rows, error } = await supabase
    .from("emails")
    .select("message_id, thread_id, from_addr, to_addr, subject, body, category, job_id, received_at")
    .eq("direction", "in")
    .is("notified_at", null)
    .in("category", ["interview", "offer", "action_needed", "rejection"])
    .gte("received_at", new Date(now.getTime() - 36 * HOUR).toISOString())
    .order("received_at", { ascending: true })
    .limit(40);
  // The column is newer than the panel on a database not yet migrated.
  if (error || !rows?.length) return out;

  const { kindOf, cleanSlots, cleanHolds, offerable } = await import("@/lib/availability");
  const { sendToSelf, sendWithAttachment, ownAddress } = await import("@/lib/gmail.server");
  let to: string | null | undefined;

  for (const e of rows) {
    out.looked++;
    const done = (moment: string | null) =>
      supabase.from("emails").update({ notified_at: new Date().toISOString(), moment }).eq("message_id", e.message_id);

    // What this system sent the owner is not news to the owner.
    const sender = String(e.from_addr ?? "").toLowerCase();
    if ((own && sender.includes(own)) || /^\s*applypilot:/i.test(String(e.subject ?? ""))) {
      await done(null);
      continue;
    }
    const moment = momentOf(e, zone, now);
    if (!moment) {
      await done(null);
      continue;
    }

    // Everything this employer's holds may be filed under: the job, this
    // message, and the rest of its conversation.
    const refs: string[] = [e.job_id, e.message_id].filter(Boolean).map(String);
    if (e.thread_id) {
      const { data: thread } = await supabase.from("emails").select("message_id").eq("thread_id", e.thread_id).limit(30);
      for (const t of thread ?? []) if (t.message_id && !refs.includes(t.message_id)) refs.push(t.message_id);
    }

    if (moment.kind === "rejection") {
      const { data: fresh } = await supabase.from("profile").select("interview_holds").eq("id", 1).maybeSingle();
      const freed = afterRejection(fresh?.interview_holds, refs, now);
      if (freed.released) {
        await supabase.from("profile").update({ interview_holds: freed.holds }).eq("id", 1);
        out.released += freed.released;
      }
      await done("rejection");
      continue;
    }

    // The rest are emails to the owner, a few at a time. What is not sent
    // this hour is left unmarked and sent the next.
    if (speak && out.told >= MOST) continue;

    const { data: job } = e.job_id
      ? await supabase.from("jobs").select("id, title, company, location, url, apply_url, description, salary_text, applied_at").eq("id", e.job_id).maybeSingle()
      : { data: null };
    const text = `${e.subject ?? ""}\n${e.body ?? ""}`;
    const kind = kindOf(text);

    let clash = null;
    if (moment.kind === "interview_time") {
      const { data: fresh } = await supabase.from("profile").select("interview_holds").eq("id", 1).maybeSingle();
      const booked = afterBooking(fresh?.interview_holds, refs, moment.when, kind, now);
      clash = booked.clash;
      const { error: held } = await supabase.from("profile").update({ interview_holds: booked.holds }).eq("id", 1);
      if (!held) out.booked++;
    }

    let openTimes: string | null = null;
    if (moment.kind === "pick_a_time") {
      try {
        const { sayTimes } = await import("@/lib/calendar.server");
        const { data: fresh } = await supabase.from("profile").select("interview_holds, availability_slots").eq("id", 1).maybeSingle();
        const open = offerable(cleanSlots(fresh?.availability_slots), [], cleanHolds(fresh?.interview_holds, now), { now, zone, kind });
        openTimes = open.length ? sayTimes(open.map((o) => o.start), zone) : null;
      } catch {
        openTimes = null;
      }
    }

    if (!speak) {
      await done(moment.kind);
      continue;
    }

    const note = noticeFor({ moment, job, from: e.from_addr, subject: e.subject, body: e.body, zone, resume: profile.resume_text, kind, clash, openTimes });
    let sent: { ok: boolean; error?: string };
    if (note.event) {
      if (to === undefined) to = await ownAddress(supabase);
      sent = to
        ? await sendWithAttachment(supabase, {
            to,
            subject: note.subject,
            body: note.body,
            attachment: {
              filename: "interview.ics",
              mime: "text/calendar; charset=UTF-8; method=PUBLISH",
              base64: Buffer.from(icsFor({ uid: `${e.message_id}@applypilot`, ...note.event, now }), "utf8").toString("base64"),
            },
          })
        : { ok: false, error: "Gmail is not connected" };
    } else {
      sent = await sendToSelf(supabase, note.subject, note.body);
    }
    // Not sent is not told: it is tried again next hour, for as long as the
    // message is recent.
    if (!sent.ok) continue;
    out.told++;
    await done(moment.kind);
  }
  return out;
}

/**
 * Is the system still doing its job? The answer is kept on the profile for
 * the dashboard, and emailed when it changes: once when something breaks,
 * once a day while it stays broken, once when it is right again.
 */
export async function healthCheck(supabase: any, now = new Date()): Promise<{ problems: number; emailed: boolean }> {
  const since = new Date(now.getTime() - 72 * HOUR).toISOString();
  const [profile, token, sync, agent, run, sent, ready] = await Promise.all([
    supabase.from("profile").select("autopilot, health_state, health_notified_at").eq("id", 1).maybeSingle(),
    supabase.from("google_tokens").select("refresh_token, last_error").limit(1).maybeSingle(),
    supabase.from("email_sync").select("last_run_at, last_error").eq("id", 1).maybeSingle(),
    supabase.from("agent").select("last_seen").eq("id", 1).maybeSingle(),
    supabase.from("runs").select("started_at").eq("kind", "apply").order("started_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("jobs").select("id", { count: "exact", head: true }).gte("applied_at", since),
    supabase.from("jobs").select("id", { count: "exact", head: true }).eq("status", "queued"),
  ]);
  // Without the columns this is kept in, there is nothing to compare with.
  if (profile.error || !profile.data) return { problems: 0, emailed: false };

  const seen = [agent.data?.last_seen, run.data?.started_at].filter(Boolean).sort().pop() ?? null;
  const problems = healthProblems({
    now,
    autopilot: profile.data.autopilot === true,
    agentLastSeen: seen,
    mailLastRun: sync.data?.last_run_at ?? null,
    mailError: sync.data?.last_error ?? null,
    gmailConnected: Boolean(token.data?.refresh_token),
    gmailError: token.data?.last_error ?? null,
    sent72h: sent.count ?? 0,
    ready: ready.count ?? 0,
  });

  const state = problems.length ? problems.join("\n") : null;
  const was: string | null = profile.data.health_state ?? null;
  const last = profile.data.health_notified_at ? new Date(profile.data.health_notified_at).getTime() : 0;
  const due = state ? state !== was || now.getTime() - last > 24 * HOUR : Boolean(was);

  let emailed = false;
  if (due) {
    const { sendToSelf } = await import("@/lib/gmail.server");
    const r = state
      ? await sendToSelf(supabase, `ApplyPilot: needs a look (${problems.length})`, `${problems.map((p) => `- ${p}`).join("\n")}\n\nEverything else is running. This is sent when something changes, and once a day while it stays this way.`)
      : await sendToSelf(supabase, "ApplyPilot: running normally again", "What was wrong has cleared. Nothing is needed from you.");
    emailed = r.ok;
  }
  if (state !== was || emailed) {
    await supabase.from("profile").update({ health_state: state, ...(emailed ? { health_notified_at: now.toISOString() } : {}) }).eq("id", 1);
  }
  return { problems: problems.length, emailed };
}
