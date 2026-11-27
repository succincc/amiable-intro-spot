import { createFileRoute } from "@tanstack/react-router";

/**
 * Send one follow-up email after an application, with the resume attached.
 *
 * The outreach job runs on a GitHub runner: it finds the address the
 * employer publishes and writes the note. Sending needs the owner's Gmail,
 * which only the panel holds, so it asks here. Call with
 * x-engine-key: <ENGINE_API_KEY>
 *
 *   POST /api/public/email/outreach
 *   { "job_id": "…", "company": "…", "to": "careers@employer.com",
 *     "found_on": "https://employer.com/contact", "subject": "…", "body": "…",
 *     "attachment": { "filename": "…_Resume.pdf", "base64": "…" },
 *     "dry": false }
 *   -> { "ok": true, "state": "sent" }
 *
 * This is the gate, not the runner. Whatever is asked for, nothing is sent
 * unless the owner has switched follow-up emails on, the employer has not
 * been written to in the last thirty days, and today's count is under the
 * limit. With "dry": true the note is recorded and not sent. With
 * "preview": true it is sent to the owner's own mailbox instead of the
 * employer's, so it can be read exactly as it would arrive.
 */
const DAILY_LIMIT = 25;
const PER_EMPLOYER_DAYS = 30;

// Addresses that are not for this, whoever publishes them.
const NEVER =
  /^(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|abuse|security|privacy|legal|dmca|compliance|ethics|press|media|pr|investors?|ir|billing|invoices?|accounts?(payable|receivable)?|sales|orders?|webmaster|unsubscribe|accessibility|accommodations?)@/i;

export const Route = createFileRoute("/api/public/email/outreach")({
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
          /* handled below */
        }
        const company = String(b?.company ?? "").trim().slice(0, 200);
        const to = String(b?.to ?? "").trim().toLowerCase();
        const subject = String(b?.subject ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 200);
        const body = String(b?.body ?? "").trim().slice(0, 6000);
        const dry = b?.dry === true;
        // At most one address copied, held to the same rules as the first.
        const ccRaw = String(b?.cc ?? "").trim().toLowerCase();
        const cc =
          ccRaw && ccRaw !== to && /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(ccRaw) && !NEVER.test(ccRaw)
            ? ccRaw
            : null;
        const file = b?.attachment;
        if (!company || !subject || !body) {
          return Response.json({ ok: false, error: "company, subject and body required" }, { status: 400 });
        }
        if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(to) || NEVER.test(to)) {
          return Response.json({ ok: false, error: "not an address this is sent to" }, { status: 400 });
        }

        try {
          const { supabaseAdmin: everybody } = await import("@/integrations/supabase/client.server");
          const { forUser, personFor } = await import("@/lib/scope.server");
          const who = await personFor(everybody, request);
          if (!who) return Response.json({ ok: false, error: "not a person with a workspace" }, { status: 403 });
          // The outreach table is newer than the generated types.
          const supabaseAdmin = forUser(everybody, who);
          const record = async (state: string, reason: string | null) => {
            await supabaseAdmin.from("outreach").insert({
              job_id: b?.job_id ?? null,
              company,
              to_addr: cc ? `${to}, ${cc}` : to,
              found_on: String(b?.found_on ?? "").slice(0, 300) || null,
              subject,
              body,
              state,
              reason,
              sent_at: state === "sent" ? new Date().toISOString() : null,
            });
          };

          if (dry) {
            await record("dry", "written, not sent");
            return Response.json({ ok: true, state: "dry" });
          }

          // A preview goes to the owner's own mailbox and nowhere else: the
          // note exactly as the employer would get it, resume attached, to
          // read before the switch is turned on. It needs no switch and
          // counts against no limit, because nobody else receives it.
          if (b?.preview === true) {
            if (!file?.base64 || String(file.base64).length > 4_000_000) {
              return Response.json({ ok: false, error: "a resume file is required" }, { status: 400 });
            }
            const { sendWithAttachment, ownAddress } = await import("@/lib/gmail.server");
            const me = await ownAddress(supabaseAdmin);
            if (!me) return Response.json({ ok: false, error: "Gmail is not connected" });
            const sent = await sendWithAttachment(supabaseAdmin, {
              to: me,
              subject: `[preview — would go to ${to}${cc ? `, cc ${cc}` : ""}] ${subject}`.slice(0, 240),
              body,
              attachment: {
                filename: String(file.filename ?? "Resume.pdf"),
                mime: "application/pdf",
                base64: String(file.base64),
              },
            });
            await record("dry", sent.ok ? "preview sent to the owner's own mailbox" : `preview failed: ${sent.error ?? "unknown"}`);
            return Response.json({ ok: sent.ok, state: sent.ok ? "preview" : "failed", error: sent.error });
          }

          const { data: profile } = await supabaseAdmin
            .from("profile").select("follow_up").eq("id", 1).maybeSingle();
          if (profile?.follow_up !== true) {
            return Response.json({ ok: false, state: "off", error: "follow-up emails are switched off" });
          }

          const since = new Date(Date.now() - PER_EMPLOYER_DAYS * 86_400_000).toISOString();
          const { data: earlier } = await supabaseAdmin
            .from("outreach").select("id")
            .eq("state", "sent").ilike("company", company).gte("sent_at", since).limit(1);
          if (earlier?.length) {
            return Response.json({ ok: false, state: "skipped", error: "this employer was written to recently" });
          }

          const dayStart = new Date(Date.now() - 24 * 3_600_000).toISOString();
          const { count } = await supabaseAdmin
            .from("outreach").select("id", { count: "exact", head: true })
            .eq("state", "sent").gte("sent_at", dayStart);
          if ((count ?? 0) >= DAILY_LIMIT) {
            return Response.json({ ok: false, state: "limit", error: "today's limit is reached" });
          }

          if (!file?.base64 || String(file.base64).length > 4_000_000) {
            return Response.json({ ok: false, error: "a resume file is required" }, { status: 400 });
          }

          // An address that has already come back undelivered is not written
          // to again: the employer's site still prints it, but nobody is
          // there, and every bounce counts against the owner's own mailbox.
          const { fetchMessages } = await import("@/lib/gmail.server");
          const bounced = await fetchMessages(
            supabaseAdmin,
            `in:anywhere newer_than:120d from:mailer-daemon "${to.replace(/"/g, "")}"`,
            1,
          ).catch(() => []);
          if (bounced.length) {
            return Response.json({ ok: false, state: "skipped", error: "mail to this address came back undelivered before" });
          }

          const { sendWithAttachment } = await import("@/lib/gmail.server");
          const sent = await sendWithAttachment(supabaseAdmin, {
            to,
            cc,
            subject,
            body,
            attachment: {
              filename: String(file.filename ?? "Resume.pdf"),
              mime: "application/pdf",
              base64: String(file.base64),
            },
          });
          await record(sent.ok ? "sent" : "failed", sent.ok ? null : (sent.error ?? "unknown error"));
          return Response.json({ ok: sent.ok, state: sent.ok ? "sent" : "failed", error: sent.error });
        } catch (e) {
          return Response.json({ ok: false, error: String((e as Error)?.message ?? e).slice(0, 300) });
        }
      },
    },
  },
});
