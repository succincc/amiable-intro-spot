import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Btn, Cursor, Empty, ErrorLine, inputCls } from "@/components/mission-control/async-state";
import { supabase } from "@/integrations/supabase/client";
import { relTime, clockTime, useRealtimeInvalidate } from "@/hooks/use-mission-control";

export const Route = createFileRoute("/_authenticated/inbox")({
  head: () => ({
    meta: [
      { title: "Inbox · ApplyPilot" },
      { name: "description", content: "Job email, sorted into interviews, offers and rejections." },
      { property: "og:title", content: "Inbox · ApplyPilot" },
      { property: "og:description", content: "Job email, sorted into interviews, offers and rejections." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Inbox,
});

const CATS = ["interview", "offer", "action_needed", "rejection", "confirmation", "other"];
const COLOR: Record<string, string> = {
  action_needed: "bg-warning", interview: "bg-success", offer: "bg-cyan", rejection: "bg-destructive",
  confirmation: "bg-primary", other: "bg-muted-foreground",
};

function Inbox() {
  const qc = useQueryClient();
  useRealtimeInvalidate("emails", [["emails"]]);
  const [cat, setCat] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["emails"],
    queryFn: async () => {
      const { data, error } = await supabase.from("emails").select("*, jobs(company)").order("received_at", { ascending: false }).limit(500);
      if (error) throw error;
      return data ?? [];
    },
  });
  const all = q.data ?? [];
  const pinned = (c: string | null) => (c === "interview" || c === "offer" ? 0 : c === "action_needed" ? 1 : 2);
  const rows = all.filter((e) => !cat || e.category === cat).sort((a, b) => pinned(a.category) - pinned(b.category));

  async function toggle(id: string, isRead: boolean | null) {
    setOpen(open === id ? null : id);
    if (!isRead) {
      await supabase.from("emails").update({ is_read: true }).eq("id", id);
      void qc.invalidateQueries({ queryKey: ["emails"] });
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-1 overflow-x-auto pb-1 text-xs">
        {CATS.map((c) => {
          const unread = all.filter((e) => e.category === c && !e.is_read).length;
          return (
            <button key={c} onClick={() => setCat(cat === c ? null : c)} className={`whitespace-nowrap border px-2 py-1 ${cat === c ? "border-primary text-primary" : "border-border text-muted-foreground"}`}>
              {c}{unread ? <span className="ml-1 text-warning">{unread}</span> : null}
            </button>
          );
        })}
      </div>
      {q.isLoading ? <Cursor /> : q.error ? <ErrorLine error={q.error} /> : !rows.length ? <Empty>no job email yet.</Empty> : (
        <div className="divide-y divide-border border border-border text-xs">
          {rows.map((e) => (
            <div key={e.id}>
              <button onClick={() => toggle(e.id, e.is_read)} className="flex w-full items-center gap-2 px-2 py-2 text-left hover:bg-accent">
                <span className={`h-3 w-1.5 ${COLOR[e.category ?? "other"] ?? "bg-muted-foreground"}`} />
                <span className={`w-32 truncate ${e.is_read ? "text-muted-foreground" : ""}`}>{e.from_addr}</span>
                <span className={`min-w-0 flex-1 truncate ${e.is_read ? "text-muted-foreground" : ""}`}>{e.subject}</span>
                {e.jobs?.company ? <span className="hidden text-cyan sm:block">{e.jobs.company}</span> : null}
                <ReplyState state={e.reply_state} at={e.replied_at} />
                <span className="w-8 text-right text-muted-foreground">{relTime(e.received_at)}</span>
              </button>
              {open === e.id ? (
                <div className="space-y-2 bg-card p-2">
                  <pre className="whitespace-pre-wrap">{e.body ?? e.snippet}</pre>
                  {e.reply_state === "failed" && e.reply_error ? (
                    <div className="border border-destructive/60 p-2 text-destructive">reply failed: {e.reply_error}</div>
                  ) : null}
                  {e.reply_draft && e.reply_state !== "sent" ? (
                    <ReplyEditor key={e.id + (e.reply_draft ?? "")} id={e.id} draft={e.reply_draft} state={e.reply_state} onDone={() => void qc.invalidateQueries({ queryKey: ["emails"] })} />
                  ) : null}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ReplyState({ state, at }: { state: string | null; at: string | null }) {
  if (state === "draft") return <span className="text-warning">drafted</span>;
  if (state === "approved") return <span className="text-cyan">queued</span>;
  if (state === "sent") return <span className="text-success">sent {at ? clockTime(at) : ""}</span>;
  if (state === "failed") return <span className="text-destructive">failed</span>;
  return null;
}

function ReplyEditor({ id, draft, state, onDone }: { id: string; draft: string; state: string | null; onDone: () => void }) {
  const [text, setText] = useState(draft);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function save(patch: { reply_state?: string; reply_draft?: string | null; reply_error?: string | null }) {
    setBusy(true); setErr(null);
    const { error } = await supabase.from("emails").update(patch).eq("id", id);
    setBusy(false);
    if (error) setErr(error.message); else onDone();
  }
  return (
    <div className="space-y-2 border border-border p-2">
      <div className="text-muted-foreground">reply draft{state === "approved" ? " — queued, the Gmail bridge sends it within 5 minutes" : ""}</div>
      <textarea rows={8} className={inputCls} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="flex flex-wrap gap-2">
        <Btn variant="primary" disabled={busy || !text.trim()} onClick={() => save({ reply_draft: text, reply_state: "approved", reply_error: null })}>send</Btn>
        <Btn disabled={busy} onClick={() => save({ reply_state: "none", reply_draft: null, reply_error: "discarded" })}>discard</Btn>
        <Btn disabled={busy} onClick={() => save({ reply_draft: null })}>rewrite</Btn>
      </div>
      {err ? <ErrorLine error={err} /> : null}
    </div>
  );
}
