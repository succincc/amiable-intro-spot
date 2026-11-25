import { useEffect, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";

import { Btn, Cursor, Empty, ErrorLine } from "@/components/mission-control/async-state";
import { scoreClass, setJobStatus, useJobsByStatus, useRealtimeInvalidate } from "@/hooks/use-mission-control";

export const Route = createFileRoute("/_authenticated/review")({
  head: () => ({
    meta: [
      { title: "Review · ApplyPilot" },
      { name: "description", content: "Queue or pass on borderline jobs, one at a time." },
      { property: "og:title", content: "Review · ApplyPilot" },
      { property: "og:description", content: "Queue or pass on borderline jobs, one at a time." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Review,
});

function Review() {
  const qc = useQueryClient();
  useRealtimeInvalidate("jobs", [["jobs"]]);
  const q = useJobsByStatus("review", 300);
  const [done, setDone] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const touchX = useRef<number | null>(null);
  const list = (q.data ?? []).filter((j) => !done.has(j.id));
  const job = list[0];

  async function decide(next: "queued" | "skipped") {
    if (!job) return;
    const id = job.id;
    setDone((d) => new Set(d).add(id));
    setExpanded(false);
    try {
      await setJobStatus(id, next, next === "skipped" ? { skip_reason: "passed in review" } : { attempts: 0 });
      void qc.invalidateQueries({ queryKey: ["stats"] });
    } catch (e) {
      setDone((d) => { const n = new Set(d); n.delete(id); return n; });
      setErr((e as Error).message);
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") void decide("queued");
      if (e.key === "ArrowLeft") void decide("skipped");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (q.isLoading) return <Cursor />;
  if (q.error) return <ErrorLine error={q.error} onRetry={() => q.refetch()} />;
  if (!job) return <Empty>nothing to review.</Empty>;

  const lines = (job.description ?? "").split("\n");
  return (
    <div
      className="space-y-3"
      onTouchStart={(e) => { touchX.current = (e.touches[0]?.clientX ?? 0); }}
      onTouchEnd={(e) => {
        if (touchX.current == null) return;
        const dx = (e.changedTouches[0]?.clientX ?? 0) - touchX.current;
        touchX.current = null;
        if (dx > 80) void decide("queued");
        else if (dx < -80) void decide("skipped");
      }}
    >
      <div className="text-xs text-muted-foreground">{list.length} remaining · ← pass · → queue · swipe works too</div>
      {err ? <ErrorLine error={err} /> : null}
      <div className="space-y-2 border border-border bg-card p-3">
        <h1 className="text-lg">{job.title}</h1>
        <div className="text-sm text-muted-foreground">{job.company} · {job.location} · {job.salary_text ?? "salary not listed"}</div>
        <div className="text-sm"><span className={scoreClass(job.score)}>{job.score ?? "--"}/10</span> <span className="text-muted-foreground">{job.score_reason}</span></div>
        <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap border border-border p-2 text-xs">
          {expanded ? job.description : lines.slice(0, 40).join("\n")}
        </pre>
        {lines.length > 40 ? <button className="text-xs text-primary" onClick={() => setExpanded(!expanded)}>{expanded ? "collapse" : "expand"}</button> : null}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Btn className="min-h-14" onClick={() => decide("skipped")}>PASS</Btn>
        <Btn className="min-h-14" variant="primary" onClick={() => decide("queued")}>QUEUE IT</Btn>
      </div>
    </div>
  );
}
