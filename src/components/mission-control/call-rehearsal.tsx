import { useState } from "react";

import { Btn, Section } from "@/components/mission-control/async-state";
import { supabase } from "@/integrations/supabase/client";
import { reply, start, transcript, type Call, type Me } from "@/lib/caller";

type J = { id: string; title: string; company: string | null; location?: string | null; description: string | null };

/**
 * The calling assistant, rehearsed. It "calls" about one of the owner's
 * applications and the owner plays the store: type or say what the person
 * on the other end would, and hear what the assistant answers. No phone is
 * involved and nothing is dialled; this is the conversation it would hold,
 * so it can be judged before it is ever given a line.
 */
export function CallRehearsal({ jobs, me }: { jobs: J[]; me: Me }) {
  const [job, setJob] = useState<J | null>(null);
  const [call, setCall] = useState<Call | null>(null);
  const [heard, setHeard] = useState("");
  const [saved, setSaved] = useState<string | null>(null);

  const speak = (text: string) => {
    try {
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
    } catch {
      /* the words are on the page either way */
    }
  };

  function begin(j: J) {
    const c = start(j, me);
    setJob(j);
    setCall(c);
    setSaved(null);
    speak(c.lines[0]?.said ?? "");
  }

  function send() {
    if (!job || !call || !heard.trim()) return;
    const c = reply(call, heard.trim(), job, me);
    setCall(c);
    setHeard("");
    const last = c.lines.at(-1);
    if (last?.who === "assistant") speak(last.said);
  }

  async function keep() {
    if (!job || !call) return;
    // Kept with the application as a rehearsal, marked as one.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase.from("jobs") as any).update({ call_note: `REHEARSAL\n${transcript(call, job)}`.slice(0, 4000) }).eq("id", job.id);
    setSaved(error ? error.message : "kept with the application");
  }

  return (
    <Section title="call rehearsal">
      <p className="text-xs text-muted-foreground">
        the assistant that would phone a place you applied to. it opens by saying it is an AI assistant calling for you, asks for the hiring manager, and makes your case from your resume. here you play the store. nothing is dialled.
      </p>
      {!job || !call ? (
        <div className="divide-y divide-border border border-border">
          {jobs.slice(0, 25).map((j) => (
            <button key={j.id} onClick={() => begin(j)} className="block w-full truncate px-2 py-2 text-left text-xs hover:bg-accent">
              {j.company} <span className="text-muted-foreground">- {j.title}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="space-y-2 border border-border bg-card p-3 text-xs">
          <div className="text-muted-foreground">{job.company} - {job.title}</div>
          {call.lines.map((l, i) => (
            <div key={i} className={l.who === "assistant" ? "" : "text-cyan"}>
              <span className="text-muted-foreground">{l.who === "assistant" ? "assistant: " : "you, as the store: "}</span>{l.said}
            </div>
          ))}
          {call.stage === "done" ? (
            <div className="space-y-2">
              <div className="text-success">call ended: {call.outcome}</div>
              <div className="flex flex-wrap gap-2">
                <Btn onClick={() => void keep()}>keep this transcript</Btn>
                <Btn onClick={() => begin(job)}>again</Btn>
                <Btn variant="ghost" onClick={() => { setJob(null); setCall(null); }}>another job</Btn>
              </div>
              {saved ? <div className="text-muted-foreground">{saved}</div> : null}
            </div>
          ) : (
            <div className="flex gap-2">
              <input
                className="min-w-0 flex-1 border border-border bg-background px-2 py-1"
                placeholder={'what the store says, e.g. "one moment" or "this is the manager"'}
                value={heard}
                onChange={(e) => setHeard(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); send(); } }}
              />
              <Btn variant="primary" onClick={send}>say it</Btn>
              <Btn variant="ghost" onClick={() => { setJob(null); setCall(null); }}>hang up</Btn>
            </div>
          )}
        </div>
      )}
    </Section>
  );
}
