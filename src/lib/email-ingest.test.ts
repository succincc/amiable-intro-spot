import { beforeEach, describe, expect, it, vi } from "vitest";

// draftReply is the expensive call this test is about; everything else in
// classify.server.ts is pure and used as written.
const draftReply = vi.fn(async () => "drafted body");
vi.mock("@/lib/classify.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/classify.server")>()),
  draftReply,
}));

const { ingestMessages } = await import("./email.server");

type Row = Record<string, unknown>;

/**
 * A fake Supabase that records upserts.
 *
 * Only the four call shapes ingestMessages uses are supported, which is
 * enough to assert on what it writes without a database.
 */
function fakeSupabase(opts: { existing?: Row[]; autoReply?: boolean; jobs?: Row[] }) {
  const upserts: Row[] = [];
  const deleted: string[] = [];

  // Every filter method returns the builder; awaiting it, or calling
  // maybeSingle(), yields the result. That is the whole surface used here.
  const chain = (result: unknown): any => {
    const self: any = {
      maybeSingle: async () => result,
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
        Promise.resolve(result).then(ok, bad),
    };
    for (const method of ["select", "in", "order", "limit", "eq", "not", "update", "delete"]) {
      self[method] = () => self;
    }
    return self;
  };

  const supabase = {
    from(table: string) {
      if (table === "profile") return chain({ data: { auto_reply: opts.autoReply ?? false } });
      if (table === "jobs")
        return chain({
          data: opts.jobs ?? [
            { id: "job-1", company: "Ramp", title: "Operations Analyst", status: "applied" },
          ],
        });
      if (table === "emails") {
        const emails = chain({ data: opts.existing ?? [] });
        emails.upsert = async (row: Row) => {
          upserts.push(row);
          return { error: null };
        };
        emails.delete = () => ({
          in: async (_column: string, ids: string[]) => {
            deleted.push(...ids);
            return { error: null };
          },
        });
        return emails;
      }
      return chain({ data: null });
    },
  };
  return { supabase, upserts, deleted };
}

const message = {
  message_id: "msg-1",
  thread_id: "thread-1",
  from_addr: "recruiting@ramp.com",
  to_addr: "owner@example.com",
  subject: "Thank you for applying to Ramp",
  body: "Thank you for applying to Ramp. We have received your application for the Operations Analyst role.",
  received_at: "2026-11-23T02:00:00Z",
};

describe("ingestMessages on a re-sync", () => {
  beforeEach(() => {
    draftReply.mockClear();
    process.env["GEMINI_API_KEY"] = "test-key";
  });

  it("does not re-draft a message it has already drafted", async () => {
    const { supabase, upserts } = fakeSupabase({
      existing: [{ message_id: "msg-1", reply_draft: "drafted body", reply_state: "draft" }],
    });
    await ingestMessages(supabase, [message]);
    expect(draftReply).not.toHaveBeenCalled();
    expect(upserts[0]?.["reply_draft"]).toBe("drafted body");
  });

  it("keeps a sent reply sent, so it is never queued and sent twice", async () => {
    // pendingReplies sends everything marked "approved". Resetting a sent
    // reply to "approved" on re-sync would mail the recruiter again on every
    // sync, which is the bug this guards.
    const { supabase, upserts } = fakeSupabase({
      autoReply: true,
      existing: [{ message_id: "msg-1", reply_draft: "drafted body", reply_state: "sent" }],
    });
    await ingestMessages(supabase, [message]);
    expect(upserts[0]?.["reply_state"]).toBe("sent");
  });

  it("rations drafting so one sync cannot run for minutes", async () => {
    // A receipt is deliberately never drafted (replyPolicy -> "none"), so the
    // cap has to be shown with mail that does earn a reply: recruiter mail
    // that matches an application but fits no rule, which falls to "draft".
    const many = Array.from({ length: 20 }, (_, i) => ({
      ...message,
      message_id: `msg-${i}`,
      from_addr: `recruiter${i}@ramp.com`,
      subject: "Ramp - a question about your background",
      body: "Ramp here. Following up on the Operations Analyst role you applied to.",
    }));
    const { supabase } = fakeSupabase({});
    await ingestMessages(supabase, many);
    expect(draftReply.mock.calls.length).toBeLessThanOrEqual(6);
    // Everything still gets stored; only the drafting is capped.
    expect(draftReply.mock.calls.length).toBeGreaterThan(0);
  });

  // A promotional mail that an earlier, looser classifier stored as
  // action_needed. Correcting the rules does not unstore it, so the sync
  // that now classifies it as unrelated has to take it back out.
  const spam = {
    ...message,
    message_id: "spam-1",
    from_addr: "no-reply@doordash.example",
    subject: "Earn 8% credits back on Lyft rides",
    body: "Limited time only. This offer expires in 3 days. Terms apply.",
  };

  it("removes stored mail that no longer qualifies to be stored", async () => {
    const { supabase, deleted } = fakeSupabase({
      existing: [{ message_id: "spam-1", reply_draft: null, reply_state: "none" }],
    });
    await ingestMessages(supabase, [spam]);
    expect(deleted).toEqual(["spam-1"]);
  });

  // A message the applicant sent themselves once matched a Ramp application
  // and a database trigger walked that job to "interview". A receipt has to
  // come from outside.
  it("never matches a job to mail the applicant sent themselves", async () => {
    const { supabase, upserts } = fakeSupabase({});
    await ingestMessages(supabase, [
      { ...message, from_addr: "owner@example.com", to_addr: "owner@example.com" },
    ]);
    expect(upserts[0]?.["job_id"] ?? null).toBeNull();
  });

  it("still matches a receipt from the employer", async () => {
    const { supabase, upserts } = fakeSupabase({});
    await ingestMessages(supabase, [{ ...message, from_addr: "no-reply@ramp.com" }]);
    expect(upserts[0]?.["job_id"]).toBe("job-1");
  });

  it("never removes mail that has already been replied to", async () => {
    const { supabase, deleted } = fakeSupabase({
      existing: [{ message_id: "spam-1", reply_draft: "sent body", reply_state: "sent" }],
    });
    await ingestMessages(supabase, [spam]);
    expect(deleted).toEqual([]);
  });
});
