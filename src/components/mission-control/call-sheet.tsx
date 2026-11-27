import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Btn, Cursor, ErrorLine, Section } from "@/components/mission-control/async-state";
import { supabase } from "@/integrations/supabase/client";
import { dialable, goodHour, pitchFor } from "@/lib/calls";

type Row = { id: string; title: string; company: string | null; location: string | null; description: string | null; applied_at: string | null; phone: string | null; call_state: string | null; call_note: string | null; call_at: string | null };

const OUTCOMES = [
  ["spoke", "spoke to the manager"],
  ["message", "left a message"],
  ["callback", "call back"],
  ["no_answer", "no answer"],
  ["skip", "skip"],
] as const;

/**
 * Calls to make: places applied to in the last ten days whose own number is
 * known. The owner makes the call; this gives the number, what to say for
 * that job, and somewhere to put what happened. A call back is kept with
 * its day and shown again when the day comes.
 */
export function CallSheet() {
  const qc = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["calls"],
    refetchInterval: 120_000,
    queryFn: async () => {
      const since = new Date(Date.now() - 10 * 86_400_000).toISOString();
      const [jobs, profile] = await Promise.all([
        // The columns are newer than the generated types.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (supabase.from("jobs") as any).select("id,title,company,location,description,applied_at,phone,call_state,call_note,call_at").eq("status", "applied").gte("applied_at", since).not("phone", "is", null).order("applied_at", { ascending: false }).limit(60),
        supabase.from("profile").select("full_name,resume_text,timezone").eq("id", 1).maybeSingle(),
      ]);
      if (jobs.error) throw jobs.error;
      return { jobs: (jobs.data ?? []) as Row[], me: (profile.data ?? {}) as { full_name?: string | null; resume_text?: string | null; timezone?: string | null } };
    },
  });

  async function record(id: string, state: string) {
    setErr(null);
    const when = state === "callback" ? new Date(Date.now() + 2 * 86_400_000).toISOString() : new Date().toISOString();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase.from("jobs") as any).update({ call_state: state, call_note: note.trim() || null, call_at: when }).eq("id", id);
    if (error) return setErr(error.message);
    setOpen(null);
    setNote("");
    void qc.invalidateQueries({ queryKey: ["calls"] });
  }

  if (q.isLoading) return <Section title="calls to make"><Cursor /></Section>;
  // Before the columns exist there is nothing to show and nothing wrong.
  if (q.error || !q.data) return null;

  const now = Date.now();
  const due = q.data.jobs.filter((j) => !j.call_state || (j.call_state === "callback" && j.call_at && new Date(j.call_at).getTime() <= now));
  const made = q.data.jobs.filter((j) => j.call_state && j.call_state !== "skip" && !due.includes(j));
  if (!due.length && !made.length) return null;
  const zone = String(q.data.me.timezone ?? "") || "America/New_York";

  return (
    <Section title={`calls to make (${due.length})`}>
      {due.length ? (
        <p className="text-xs text-muted-foreground">
          {goodHour(new Date(), zone) ? "a good hour to call." : "best between 10 and 12 or 2 and 4 on a weekday, when a manager is on the floor and not at lunch."} you make the call; nothing here dials for you.
        </p>
      ) : null}
      <div className="divide-y divide-border border border-border">
        {due.map((j) => {
          const p = pitchFor(j, q.data.me);
          const number = dialable(j.phone) ?? j.phone;
          return (
            <div key={j.id} className="space-y-2 px-2 py-2 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{j.company} <span className="text-muted-foreground">- {j.title}</span></div>
                  <div className="text-muted-foreground">{j.location}{j.call_state === "callback" ? " - you said you would call back" : ""}</div>
                </div>
                <a href={`tel:${String(j.phone).replace(/[^0-9+]/g, "")}`} className="border border-primary px-2 py-1 text-primary">{number}</a>
                <Btn onClick={() => { setOpen(open === j.id ? null : j.id); setNote(j.call_note ?? ""); }}>{open === j.id ? "close" : "what to say"}</Btn>
              </div>
              {open === j.id ? (
                <div className="space-y-2 border-l-2 border-border pl-2">
                  <div><span className="text-muted-foreground">to whoever answers: </span>{p.ask}</div>
                  <div><span className="text-muted-foreground">to the manager: </span>{p.pitch}</div>
                  <div><span className="text-muted-foreground">to finish: </span>{p.close}</div>
                  <input className="w-full border border-border bg-background px-2 py-1" placeholder="what happened, who you spoke to (optional)" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
                  <div className="flex flex-wrap gap-2">
                    {OUTCOMES.map(([k, label]) => <Btn key={k} variant={k === "spoke" ? "primary" : "default"} onClick={() => void record(j.id, k)}>{label}</Btn>)}
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      {made.length ? (
        <div className="space-y-1 border border-border p-2 text-xs">
          <div className="text-muted-foreground">calls made</div>
          {made.slice(0, 12).map((j) => (
            <div key={j.id}>
              <span className={j.call_state === "spoke" ? "text-success" : "text-muted-foreground"}>{OUTCOMES.find(([k]) => k === j.call_state)?.[1] ?? j.call_state}</span>
              {" - "}{j.company}, {j.title}{j.call_note ? <span className="text-muted-foreground"> - {j.call_note}</span> : null}
            </div>
          ))}
        </div>
      ) : null}
      {err ? <ErrorLine error={err} /> : null}
    </Section>
  );
}
