/* eslint-disable @typescript-eslint/no-explicit-any */
// The Supabase client is passed in untyped, as in discover.server.ts: this
// runs against columns added by a migration that the generated types do not
// know about until they are regenerated.
// ============================================================================
// email.server.ts — what happens to a message once the Gmail bridge posts it.
//
// Three operations, called from /api/public/email/ingest:
//   ingestMessages      store, classify, match to a job, draft a reply
//   pendingReplies      hand the bridge whatever is cleared to send
//   recordReplyResult   note that a reply went out, or did not
//
// The classification rules themselves live in classify.server.ts. The comment
// at the top of that file explains why their order is the design.
// ============================================================================

import {
  classifyEmail,
  emailKind,
  spreadReceipts,
  sameEmployer,
  matchJob,
  isReplyable,
  replyPolicy,
  draftReply,
} from "@/lib/classify.server";

// Whether the emails table has its newer "kind" column, learned once.
const HAS_KIND = { no: false };
import { momentOf } from "@/lib/moments";

export type InboundMessage = {
  message_id: string;
  thread_id?: string | null;
  from_addr?: string | null;
  to_addr?: string | null;
  subject?: string | null;
  body?: string | null;
  received_at?: string | null;
};

export async function ingestMessages(supabase: any, messages: InboundMessage[]) {
  const startedAt = Date.now();
  const stats = {
    received: messages.length,
    stored: 0,
    skipped: 0,
    drafted: 0,
    matched: 0,
    errors: 0,
    removed: 0,
  };

  if (messages.length) {
    const { data: profile } = await supabase.from("profile").select("*").limit(1).maybeSingle();

    // Only applications can be receiving a reply. Newest first, so a company
    // applied to twice resolves to the recent one.
    const { data: jobs } = await supabase
      .from("jobs")
      .select("id, company, title, status, applied_at")
      .in("status", ["applied", "interview", "offer", "rejected", "needs_help"])
      .order("applied_at", { ascending: false, nullsFirst: false })
      .limit(1000);

    const apiKey = process.env["GEMINI_API_KEY"] ?? "";
    const autoReply = profile?.auto_reply === true;
    const ownAddress = String(profile?.email ?? "").trim().toLowerCase();
    const zone = String(profile?.timezone ?? "").trim() || "America/New_York";
    const startedNow = new Date(startedAt);

    // What do we already have? Every sync re-reads the same few days, so
    // without this the same messages are re-drafted on every run — minutes of
    // sequential Gemini calls, and quota spent recomputing drafts that exist.
    //
    // It also closes a worse hole. recordReplyResult marks a sent reply
    // "sent", but this loop used to overwrite reply_state unconditionally,
    // resetting it to "approved" — and pendingReplies sends everything
    // "approved". With auto-reply on, one recruiter would receive the same
    // message again after every sync. Prior state is now preserved.
    const ids = messages.map((m) => m?.message_id).filter(Boolean);
    const { data: existingRows } = ids.length
      ? await supabase.from("emails").select("message_id, reply_draft, reply_state, reply_error, job_id").in("message_id", ids)
      : { data: [] };
    const prior = new Map<string, { reply_draft: string | null; reply_state: string | null; reply_error: string | null; job_id?: string | null }>(
      (existingRows ?? []).map((r: any) => [r.message_id, r]),
    );

    // Drafting is the only slow step, so it is rationed rather than unbounded.
    // Whatever is left over is drafted on the next sync, which by then reuses
    // everything already done instead of starting over.
    let draftsLeft = 6;

    // Messages that no longer qualify to be stored at all.
    const dropped: string[] = [];
    // Messages stored without a reply that should have one.
    const toDraft: Array<{
      m: InboundMessage;
      category: ReturnType<typeof classifyEmail>["category"];
      job: any;
      policy: string;
    }> = [];

    for (const m of messages) {
      if (!m?.message_id) continue;

      const verdict = classifyEmail(m.subject, m.body);

      // Mail from the applicant's own address is not a reply from anyone.
      // A test message sent to oneself matched a Ramp application, and the
      // database trigger that reads categories walked that job to
      // "interview" — a stage no employer had any part in. A receipt has to
      // come from outside, so self-sent mail never matches a job, and with
      // no job_id the trigger leaves the pipeline alone.
      const sender = String(m.from_addr ?? "").trim().toLowerCase();
      const recipient = String(m.to_addr ?? "").trim().toLowerCase();
      const selfSent = Boolean(sender) && (sender === ownAddress || sender === recipient);

      // What this system sends the owner — the summary, an interview brief,
      // a health notice — arrives in the same inbox it reads. It is not mail
      // from an employer and is not filed as any.
      if (selfSent && /^\s*applypilot:/i.test(String(m.subject ?? ""))) {
        stats.skipped++;
        if (prior.has(m.message_id)) dropped.push(m.message_id);
        continue;
      }

      let jobId = selfSent ? null : matchJob(m, jobs ?? []);
      // A message already filed under one application at an employer stays
      // there when read again. The same few days are re-read on every sync,
      // and matchJob knows only the employer: without this, a receipt set
      // right by spreadReceipts below would be put back wrong each time.
      {
        const was = prior.get(m.message_id)?.job_id ?? null;
        if (jobId && was && was !== jobId) {
          const a = (jobs ?? []).find((j: any) => j.id === was);
          const b = (jobs ?? []).find((j: any) => j.id === jobId);
          if (a && b && sameEmployer(a.company, b.company)) jobId = was;
        }
      }

      // PRIVACY, and signal. The bridge reads the whole inbox, because asking
      // someone to hand-label their mail defeats the point of automating any
      // of this. But personal email has no business in this database, so
      // anything that neither matches an application nor looks like
      // recruiting mail is dropped here and never stored. Grocery deals
      // classify as "other" with no job match, and stop at this line.
      if (!jobId && verdict.category === "other") {
        stats.skipped++;
        // Rules get corrected; rows written under the old ones do not fix
        // themselves. A message stored by a looser classifier — the
        // promotions and prize draws that a bare "expires in 3 days" once
        // filed as action_needed — is removed rather than left in the panel
        // as permanent noise. Anything already replied to is left alone.
        const stored = prior.get(m.message_id);
        if (stored && stored.reply_state !== "sent" && stored.reply_state !== "approved") {
          dropped.push(m.message_id);
        }
        continue;
      }
      if (jobId) stats.matched++;

      const job = (jobs ?? []).find((j: any) => j.id === jobId) ?? null;

      // Start from what is already stored, so a reply that has been sent,
      // approved or failed keeps that state across re-syncs.
      const seen = prior.get(m.message_id);
      const reply_draft: string | null = seen?.reply_draft ?? null;
      const reply_state = seen?.reply_state ?? "none";
      const policy = replyPolicy(verdict.category);

      // Drafting waits until every message has been stored.
      //
      // It used to happen here, in line: up to six model calls, one after
      // another, in the middle of the loop that files the mail. The applier
      // asks for a sync at the end of every run and gives it a minute, and
      // run after run that minute ran out with receipts still unfiled — so
      // applications that had been acknowledged sat marked unconfirmed.
      // Filing is quick and is what the run is waiting for; writing replies
      // is slow and nobody is waiting for it.
      const wantsDraft =
        // An interview request is answered with or without a model.
        !reply_draft && policy !== "none" && isReplyable(m.from_addr) && (Boolean(apiKey) || policy === "auto") &&
        // Once only. The mailbox is read every ten minutes now, and a
        // message whose draft was thrown away, or that the model had nothing
        // to say to, would otherwise be drafted again on every one of them —
        // a discarded reply coming back like a weed, and the day's free
        // allowance spent asking the same question a hundred times.
        reply_state === "none" && !seen?.reply_error &&
        // A link to pick a time is answered by picking one, and a time
        // already settled is not answered by offering others. Both go to
        // the owner instead (moments.server.ts).
        !(verdict.category === "interview" && momentOf({ category: "interview", subject: m.subject, body: m.body }, zone, startedNow));

      const row: Record<string, unknown> = {
          message_id: m.message_id,
          thread_id: m.thread_id ?? null,
          from_addr: m.from_addr ?? null,
          to_addr: m.to_addr ?? null,
          subject: m.subject ?? null,
          snippet: (m.body ?? "").replace(/\s+/g, " ").trim().slice(0, 300),
          body: m.body ?? null,
          received_at: m.received_at ?? new Date().toISOString(),
          category: verdict.category,
          confidence: verdict.confidence,
          classify_why: verdict.why,
          job_id: jobId,
          direction: "in",
          reply_draft,
          reply_state,
          // is_read is deliberately untouched: on a re-delivery of a message
          // already read, marking it unread again would be maddening.
      };
      const put = (r: Record<string, unknown>) =>
        (supabase.from("emails") as any).upsert(r, { onConflict: "message_id", ignoreDuplicates: false });
      // The finer kind is a newer column. Where it is not there yet the mail
      // is filed without it rather than not filed.
      let { error } = HAS_KIND.no ? await put(row) : await put({ ...row, kind: emailKind(verdict.category, m.subject, m.body) });
      if (error && !HAS_KIND.no && /kind/i.test(String(error.message ?? ""))) {
        HAS_KIND.no = true;
        ({ error } = await put(row));
      }

      if (error) stats.errors++;
      else {
        stats.stored++;
        if (wantsDraft) toDraft.push({ m, category: verdict.category, job, policy });
      }
    }

    // Receipts at an employer applied to more than once, each put with the
    // application it answers (spreadReceipts). Moving one runs the trigger
    // that marks its job confirmed. Quick, and never allowed to stop a sync.
    try {
      const { data: receipts } = await (supabase.from("emails") as any)
        .select("message_id, job_id, received_at, subject, snippet")
        .eq("direction", "in").eq("category", "confirmation").not("job_id", "is", null)
        .order("received_at", { ascending: false }).limit(2000);
      const moves = spreadReceipts(
        (jobs ?? []) as any[],
        (receipts ?? []).map((r: any) => ({ message_id: r.message_id, job_id: r.job_id, received_at: r.received_at, text: `${r.subject ?? ""} ${r.snippet ?? ""}` })),
      );
      for (const mv of moves.slice(0, 200)) {
        await supabase.from("emails").update({ job_id: mv.job_id }).eq("message_id", mv.message_id);
      }
      (stats as any).receipts_moved = moves.length;
    } catch {
      /* the next sync tries again */
    }

    // Specific free times to offer, where the calendar can be read. Asked
    // once, and only when there is an interview request to answer.
    let offered: string | null = null;
    if (toDraft.some((d) => d.category === "interview")) {
      try {
        const { timesToOffer } = await import("@/lib/calendar.server");
        offered = await timesToOffer(supabase, profile ?? {});
      } catch {
        offered = null;
      }
    }

    // Now the replies, for as long as there is time.
    for (const d of toDraft) {
      if (draftsLeft <= 0 || Date.now() - startedAt > 35_000) break;
      draftsLeft--;
      const draft = await draftReply({
        email: d.m,
        category: d.category,
        job: d.job,
        profile: await (async () => {
          if (d.category !== "interview") return profile ?? {};
          // The owner's marked windows first, held per employer so no two
          // are offered the same hour; then the general free times; then
          // whatever the owner wrote in words.
          let mine: string | null = null;
          try {
            const { timesFromWindows } = await import("@/lib/calendar.server");
            mine = await timesFromWindows(supabase, profile ?? {}, {
              text: `${d.m.subject ?? ""}\n${d.m.body ?? ""}`,
              ref: String(d.job?.id ?? d.m.message_id ?? ""),
            });
          } catch {
            mine = null;
          }
          const say = mine ?? offered;
          return say ? { ...(profile ?? {}), availability: say } : (profile ?? {});
        })(),
        apiKey,
      }).catch(() => null);
      if (!draft) {
        // Noted, so it is not asked for again. It can still be written by
        // hand from the inbox.
        await supabase.from("emails").update({ reply_error: "no draft was written" }).eq("message_id", d.m.message_id).is("reply_draft", null);
        continue;
      }
      // "auto" only takes effect once auto-reply is switched on. Otherwise
      // even an interview invitation waits to be read, which is the right
      // default for something that mails a stranger in your name.
      const state = d.policy === "auto" && autoReply ? "approved" : "draft";
      const { error } = await supabase
        .from("emails")
        .update({ reply_draft: draft, reply_state: state })
        .eq("message_id", d.m.message_id);
      if (!error) stats.drafted++;
    }

    if (dropped.length) {
      await supabase.from("emails").delete().in("message_id", dropped);
      stats.removed = dropped.length;
    }
  }

  const newest = messages
    .map((m) => m?.received_at)
    .filter(Boolean)
    .sort()
    .pop();

  await supabase
    .from("email_sync")
    .update({
      last_run_at: new Date().toISOString(),
      last_status: stats.errors ? "partial" : "ok",
      last_error: null,
      seen_count: stats.stored,
      ...(newest ? { last_seen_at: newest } : {}),
    })
    .eq("id", 1);

  return { ok: true as const, ...stats };
}

export async function pendingReplies(supabase: any) {
  const { data } = await supabase
    .from("emails")
    .select("id, message_id, reply_draft")
    .eq("reply_state", "approved")
    .not("reply_draft", "is", null)
    .not("message_id", "is", null)
    .order("received_at", { ascending: true })
    // Consumer Gmail allows 100 recipients a day. Staying well under keeps a
    // runaway loop from burning the quota the whole system depends on.
    .limit(20);

  return { replies: data ?? [] };
}

/**
 * Send every reply that has been cleared to go, from the owner's own Gmail.
 *
 * Replies used to leave by one road only: a script in the owner's Google
 * account that asked for them every few minutes. Where that script was never
 * set up, or stopped, an approved reply simply stayed approved — an
 * interview request answered on paper and not in fact. The panel holds the
 * mailbox itself now, so it sends them itself, whenever the mailbox is read.
 *
 * Each reply is claimed before it is sent, by moving it out of "approved" in
 * the one statement that also checks it is still there. Two callers — this
 * and the script, or this twice — cannot both win that, so nothing is sent
 * twice; and a send that dies halfway is left marked as failed, to be looked
 * at, never retried blind.
 */
export async function sendApprovedReplies(supabase: any): Promise<{ sent: number; failed: number }> {
  const out = { sent: 0, failed: 0 };
  const { data: waiting } = await supabase
    .from("emails")
    .select("id, message_id, thread_id, from_addr, subject, reply_draft")
    .eq("reply_state", "approved")
    .not("reply_draft", "is", null)
    .order("received_at", { ascending: true })
    // Well under Gmail's daily ceiling, and a runaway cannot spend it.
    .limit(10);
  if (!waiting?.length) return out;

  const { sendReply, messageIdHeader } = await import("@/lib/gmail.server");
  for (const row of waiting) {
    if (!isReplyable(row.from_addr) || !String(row.reply_draft ?? "").trim()) continue;
    const { data: claimed } = await supabase
      .from("emails")
      .update({ reply_state: "failed", reply_error: "sending" })
      .eq("id", row.id)
      .eq("reply_state", "approved")
      .select("id");
    if (!claimed?.length) continue;

    const quoted = await messageIdHeader(supabase, row.message_id).catch(() => null);
    const result = await sendReply(supabase, {
      to: row.from_addr,
      subject: row.subject || "your message",
      body: row.reply_draft,
      ...(row.thread_id ? { threadId: row.thread_id } : {}),
      ...(quoted ? { messageIdHeader: quoted } : {}),
    }).catch((e: unknown) => ({ ok: false, error: String((e as Error)?.message ?? e) }));

    await recordReplyResult(supabase, { id: row.id, state: result.ok ? "sent" : "failed", error: result.error ?? "" });
    if (result.ok) out.sent++;
    else out.failed++;
  }
  return out;
}

export async function recordReplyResult(
  supabase: any,
  result: { id?: string; state?: string; error?: string },
) {
  if (!result?.id) return { ok: false as const, error: "result.id required" };

  const sent = result.state === "sent";
  await supabase
    .from("emails")
    .update({
      reply_state: sent ? "sent" : "failed",
      replied_at: sent ? new Date().toISOString() : null,
      reply_error: sent ? null : String(result.error ?? "unknown error").slice(0, 500),
    })
    .eq("id", result.id);

  return { ok: true as const };
}

export async function recordSyncError(supabase: any, message: string) {
  await supabase
    .from("email_sync")
    .update({
      last_run_at: new Date().toISOString(),
      last_status: "error",
      last_error: message.slice(0, 500),
    })
    .eq("id", 1);
}
