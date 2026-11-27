import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import { Btn, Cursor, Empty, ErrorLine, Section } from "@/components/mission-control/async-state";
import { supabase } from "@/integrations/supabase/client";
import { questionsFor, readAnswer } from "@/lib/practice";
import { CallRehearsal } from "@/components/mission-control/call-rehearsal";

export const Route = createFileRoute("/_authenticated/practice")({
  head: () => ({
    meta: [
      { title: "Practice · ApplyPilot" },
      { name: "description", content: "A practice interviewer for the job you are interviewing for." },
    ],
  }),
  component: Practice,
});

type JobLite = { id: string; title: string; company: string | null; description: string | null; status: string };

/**
 * An interviewer to practise against, for one of the owner's own
 * applications. It asks aloud with the browser's voice and listens with the
 * browser's own speech recognition where there is one; typing always works.
 * Nothing is sent anywhere: the questions and the reading of each answer are
 * rules that run on this page.
 */
function Practice() {
  const [jobId, setJobId] = useState<string>("");
  const [at, setAt] = useState(0);
  const [answer, setAnswer] = useState("");
  const [done, setDone] = useState<Array<{ ask: string; answer: string; good: string[]; fix: string[] }>>([]);
  const [listening, setListening] = useState(false);
  const [timed, setTimed] = useState(false);
  const [left, setLeft] = useState(120);
  const rec = useRef<{ stop: () => void } | null>(null);

  const q = useQuery({
    queryKey: ["practice"],
    queryFn: async () => {
      const [jobs, profile] = await Promise.all([
        supabase.from("jobs").select("id,title,company,description,status").in("status", ["interview", "applied", "offer"]).order("applied_at", { ascending: false, nullsFirst: false }).limit(60),
        supabase.from("profile").select("*").eq("id", 1).maybeSingle(),
      ]);
      if (jobs.error) throw jobs.error;
      // Interviews first: those are what this is for.
      const list = ((jobs.data ?? []) as JobLite[]).sort((a, b) => Number(b.status === "interview") - Number(a.status === "interview"));
      return { jobs: list, resume: String(profile.data?.resume_text ?? ""), me: (profile.data ?? {}) as Record<string, unknown> };
    },
  });

  const job = q.data?.jobs.find((j) => j.id === jobId) ?? null;
  const questions = useMemo(() => questionsFor(job, q.data?.resume ?? ""), [job, q.data?.resume]);
  const current = questions[at];
  const speechIn = typeof window !== "undefined" && ("SpeechRecognition" in window || "webkitSpeechRecognition" in window);

  const say = (text: string) => {
    try {
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
    } catch {
      /* a browser without a voice still shows the words */
    }
  };

  // Each question is asked aloud as it comes up.
  useEffect(() => {
    if (jobId && current) {
      say(current.ask);
      setLeft(120);
    }
    return () => {
      try { window.speechSynthesis.cancel(); } catch { /* nothing to stop */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, at]);

  // The clock of a recorded interview: two minutes an answer.
  useEffect(() => {
    if (!timed || !jobId || !current) return;
    if (left <= 0) { next(); return; }
    const t = setTimeout(() => setLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timed, left, jobId, at]);

  function listen() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const R = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    if (!R) return;
    if (listening) { rec.current?.stop(); return; }
    const r = new R();
    r.continuous = true;
    r.interimResults = false;
    r.lang = "en-US";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    r.onresult = (e: any) => {
      let heard = "";
      for (let i = e.resultIndex; i < e.results.length; i++) heard += e.results[i][0].transcript + " ";
      setAnswer((a) => `${a} ${heard}`.trim());
    };
    r.onend = () => setListening(false);
    r.onerror = () => setListening(false);
    rec.current = r;
    setListening(true);
    r.start();
  }

  function next() {
    rec.current?.stop();
    if (!current) return;
    const read = readAnswer(current, answer, q.data?.resume);
    setDone((d) => [...d, { ask: current.ask, answer, ...read }]);
    setAnswer("");
    setAt((n) => n + 1);
  }

  function start(id: string) {
    setJobId(id);
    setAt(0);
    setDone([]);
    setAnswer("");
  }

  if (q.isLoading) return <Cursor />;
  if (q.error) return <ErrorLine error={q.error} onRetry={() => q.refetch()} />;

  if (!jobId) {
    return (
      <div className="space-y-6">
        <Section title="practice interview">
          <p className="text-xs text-muted-foreground">
            pick the job. it asks out loud, from that posting and your resume; you answer by speaking or typing; it tells you what each answer had and what it was missing. nothing leaves this page.
          </p>
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={timed} onChange={(e) => setTimed(e.target.checked)} /> timed, like a recorded interview: two minutes an answer
          </label>
          {!q.data?.jobs.length ? <Empty>nothing applied to yet.</Empty> : (
            <div className="divide-y divide-border border border-border">
              {q.data.jobs.map((j) => (
                <button key={j.id} onClick={() => start(j.id)} className="flex w-full items-center gap-2 px-2 py-2 text-left text-xs hover:bg-accent">
                  <span className={j.status === "interview" ? "text-success" : "text-muted-foreground"}>{j.status === "interview" ? "●" : "○"}</span>
                  <span className="min-w-0 flex-1 truncate">{j.title} <span className="text-muted-foreground">- {j.company}</span></span>
                  <span className="text-muted-foreground">{j.status}</span>
                </button>
              ))}
            </div>
          )}
        </Section>
        {q.data?.jobs.length ? <CallRehearsal jobs={q.data.jobs} me={q.data.me} /> : null}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Section title={`practice: ${job?.title ?? ""}`} right={<Btn variant="ghost" onClick={() => setJobId("")}>change job</Btn>}>
        {current ? (
          <div className="space-y-3 border border-border bg-card p-4">
            <div className="text-[10px] text-muted-foreground">question {at + 1} of {questions.length}{timed ? ` - ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} left` : ""}</div>
            <p className="text-sm">{current.ask}</p>
            <textarea
              className="h-36 w-full border border-border bg-background p-2 text-xs"
              placeholder={speechIn ? "press speak and answer out loud, or type" : "type your answer as you would say it"}
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
            />
            <div className="flex flex-wrap gap-2">
              {speechIn ? <Btn variant={listening ? "danger" : "primary"} onClick={listen}>{listening ? "stop" : "speak"}</Btn> : null}
              <Btn onClick={() => say(current.ask)}>hear it again</Btn>
              <Btn variant="primary" onClick={next}>{at + 1 === questions.length ? "finish" : "next question"}</Btn>
            </div>
          </div>
        ) : (
          <p className="border border-success/50 bg-success/5 p-3 text-sm text-success">that is the interview. read each answer below, then run it again: the second pass is where it gets better.</p>
        )}
      </Section>

      {done.length ? (
        <Section title="your answers">
          <div className="space-y-3">
            {done.map((d, i) => (
              <div key={i} className="space-y-1 border border-border p-3 text-xs">
                <div className="text-muted-foreground">{d.ask}</div>
                <div>{d.answer || <span className="text-muted-foreground">(no answer)</span>}</div>
                {d.good.map((g) => <div key={g} className="text-success">+ {g}</div>)}
                {d.fix.map((f) => <div key={f} className="text-warning">- {f}</div>)}
              </div>
            ))}
          </div>
          {!current ? <Btn variant="primary" onClick={() => start(jobId)}>run it again</Btn> : null}
        </Section>
      ) : null}
    </div>
  );
}
