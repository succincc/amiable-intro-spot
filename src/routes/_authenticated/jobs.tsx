import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";

import { Btn, Cursor, Empty, ErrorLine, inputCls } from "@/components/mission-control/async-state";
import { supabase } from "@/integrations/supabase/client";
import { distanceLabel, relTime, scoreClass, setJobStatus, useRealtimeInvalidate, type Job } from "@/hooks/use-mission-control";

type Search = { status?: string | undefined };

export const Route = createFileRoute("/_authenticated/jobs")({
  validateSearch: (s: Record<string, unknown>): Search => ({ status: typeof s["status"] === "string" ? s["status"] : undefined }),
  head: () => ({
    meta: [
      { title: "Jobs · ApplyPilot" },
      { name: "description", content: "Every job ApplyPilot found, scored and filterable." },
      { property: "og:title", content: "Jobs · ApplyPilot" },
      { property: "og:description", content: "Every job ApplyPilot found, scored and filterable." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: JobsPage,
});

const STATUSES = ["new", "review", "queued", "applying", "applied", "needs_help", "interview", "offer", "rejected", "skipped", "failed"];
const PAGE = 50;

function JobsPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const qc = useQueryClient();
  useRealtimeInvalidate("jobs", [["jobs"]]);
  const [text, setText] = useState("");
  const [minScore, setMinScore] = useState("");
  const [maxMiles, setMaxMiles] = useState("");
  const [sortDist, setSortDist] = useState(false);
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const status = search.status;

  const q = useQuery({
    queryKey: ["jobs", "list", status ?? "all", text, minScore, maxMiles, sortDist, page],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      let query = supabase.from("jobs").select("*", { count: "exact" });
      query = sortDist
        ? query.order("distance_miles", { ascending: true, nullsFirst: false }).order("found_at", { ascending: false })
        : query.order("found_at", { ascending: false });
      query = query.range(page * PAGE, page * PAGE + PAGE - 1);
      if (maxMiles) query = query.or(`distance_miles.lte.${Number(maxMiles)},remote.eq.true`);
      if (status) query = query.eq("status", status);
      if (minScore) query = query.gte("score", Number(minScore));
      const t = text.trim().replace(/[,()%]/g, " ");
      if (t) query = query.or(`title.ilike.%${t}%,company.ilike.%${t}%`);
      const { data, error, count } = await query;
      if (error) throw error;
      return { rows: data ?? [], count: count ?? 0 };
    },
  });

  async function act(job: Job, next: string) {
    try {
      await setJobStatus(job.id, next, next === "queued" ? { attempts: 0 } : {});
    } finally {
      void qc.invalidateQueries({ queryKey: ["jobs"] });
    }
  }

  async function block(job: Job) {
    const { data } = await supabase.from("search_config").select("exclude_companies").eq("id", 1).single();
    const list = new Set(data?.exclude_companies ?? []);
    if (job.company) list.add(job.company);
    await supabase.from("search_config").update({ exclude_companies: [...list] }).eq("id", 1);
    await act(job, "skipped");
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <input className={`${inputCls} flex-1`} placeholder="filter title / company" value={text} onChange={(e) => { setText(e.target.value); setPage(0); }} />
        <input className={`${inputCls} w-24`} type="number" min={1} max={10} placeholder="min score" value={minScore} onChange={(e) => { setMinScore(e.target.value); setPage(0); }} />
        <input className={`${inputCls} w-24`} type="number" min={0} placeholder="max mi" aria-label="max distance in miles" value={maxMiles} onChange={(e) => { setMaxMiles(e.target.value); setPage(0); }} />
        <Btn onClick={() => { setSortDist(!sortDist); setPage(0); }}>{sortDist ? "sort: nearest" : "sort: newest"}</Btn>
      </div>
      <div className="flex gap-1 overflow-x-auto pb-1 text-xs">
        {[undefined, ...STATUSES].map((s) => (
          <button key={s ?? "all"} onClick={() => { setPage(0); void navigate({ search: { status: s } }); }}
            className={`whitespace-nowrap border px-2 py-1 ${status === s ? "border-primary text-primary" : "border-border text-muted-foreground"}`}>
            {s ?? "all"}
          </button>
        ))}
      </div>

      {q.isLoading ? <Cursor /> : q.error ? <ErrorLine error={q.error} onRetry={() => q.refetch()} /> : !q.data?.rows.length ? (
        <Empty>no jobs match. run discovery from the dashboard.</Empty>
      ) : (
        <div className="border border-border text-xs">
          {q.data.rows.map((j) => (
            <div key={j.id} className="border-b border-border last:border-b-0">
              <button onClick={() => setOpen(open === j.id ? null : j.id)} className="flex h-9 w-full items-center gap-2 px-2 text-left hover:bg-accent">
                <span className={`w-5 ${scoreClass(j.score)}`}>{j.score ?? "--"}</span>
                <span className="min-w-0 flex-1 truncate">{j.title}</span>
                <span className="hidden w-32 truncate text-muted-foreground sm:block">{j.company}</span>
                <span className="hidden w-32 truncate text-muted-foreground md:block">{j.location}</span>
                <span className="w-14 text-right text-muted-foreground">{distanceLabel(j)}</span>
                <span className="w-20 truncate text-cyan">{j.status}</span>
                <span className="w-8 text-right text-muted-foreground">{relTime(j.found_at)}</span>
              </button>
              {open === j.id ? (
                <div className="space-y-2 bg-card px-2 py-3">
                  <div className="text-muted-foreground">{j.company} · {j.location} · {j.salary_text ?? "salary not listed"} · {j.source}</div>
                  {j.score_reason ? <div><span className="text-muted-foreground">score:</span> {j.score_reason}</div> : null}
                  {j.skip_reason ? <div className="text-warning">skipped: {j.skip_reason}</div> : null}
                  {j.last_error ? <div className="text-destructive">{j.last_error}</div> : null}
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap border border-border p-2">{j.description}</pre>
                  {j.tailored_resume ? (
                    <details><summary className="cursor-pointer text-primary">tailored resume</summary>
                      <pre className="max-h-64 overflow-auto whitespace-pre-wrap border border-border p-2">{j.tailored_resume}</pre>
                    </details>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    <Btn variant="primary" onClick={() => act(j, "queued")}>queue</Btn>
                    <Btn onClick={() => act(j, "skipped")}>skip</Btn>
                    <a href={j.apply_url ?? j.url} target="_blank" rel="noreferrer" className="flex min-h-9 items-center border border-border px-3 uppercase tracking-widest">open</a>
                    <Btn variant="danger" onClick={() => block(j)}>block</Btn>
                  </div>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
      {q.data && q.data.count > PAGE ? (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <Btn disabled={page === 0} onClick={() => setPage(page - 1)}>prev</Btn>
          <span>{page * PAGE + 1}–{Math.min(q.data.count, (page + 1) * PAGE)} of {q.data.count}</span>
          <Btn disabled={(page + 1) * PAGE >= q.data.count} onClick={() => setPage(page + 1)}>next</Btn>
        </div>
      ) : null}
    </div>
  );
}
