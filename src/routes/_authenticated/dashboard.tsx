import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { Btn, Cursor, Empty, ErrorLine, Section, inputCls } from "@/components/mission-control/async-state";
import { StartCard } from "@/components/mission-control/start-card";
import { supabase } from "@/integrations/supabase/client";
import {
  relTime, clockTime,
  confirmationGap, parseDailyCap, setJobStatus, useAutopilot, useEmailStats, useAgent, useJobsByStatus, useRealtimeInvalidate, useRuns, useStats,
} from "@/hooks/use-mission-control";
import { runApplier, runDiscovery, runScoring, runSweep } from "@/lib/engine.functions";

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({
    meta: [
      { title: "Dashboard · ApplyPilot" },
      { name: "description", content: "Pipeline, agent status and run log for ApplyPilot." },
      { property: "og:title", content: "Dashboard · ApplyPilot" },
      { property: "og:description", content: "Pipeline, agent status and run log for ApplyPilot." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Dashboard,
});

const PIPE = [
  ["new", "new"], ["review", "review"], ["queued", "queued"], ["applied", "applied"],
  ["needs_help", "need_you"], ["interviews", "interview"], ["offers", "offer"], ["rejected", "rejected"],
] as const;
const PIPE_STATUS: Record<string, string> = { interviews: "interview", offers: "offer" };

type Log = { kind: "ok" | "err"; text: string } | null;

function Dashboard() {
  const qc = useQueryClient();
  const { data: agent } = useAgent();
  const stats = useStats();
  const emailStats = useEmailStats();
  const runs = useRuns(10);
  useRealtimeInvalidate("jobs", [["jobs"]]);
  const help = useJobsByStatus("needs_help", 50);

  const discover = useServerFn(runDiscovery);
  const score = useServerFn(runScoring);
  const apply = useServerFn(runApplier);
  const sweep = useServerFn(runSweep);
  const [busy, setBusy] = useState<"discover" | "score" | "apply" | null>(null);
  const [log, setLog] = useState<Log>(null);
  const [dryRun, setDryRun] = useState(false);
  const lastApply = runs.data?.find((r) => r.kind === "apply");
  const lastApplyAt = lastApply?.ended_at ?? lastApply?.started_at ?? null;
  const recentApply = !!lastApplyAt && Date.now() - new Date(lastApplyAt).getTime() < 6 * 3600_000;
  const agentLabel = agent?.online && agent.version === "cloud-agent" ? "● cloud agent applying"
    : agent?.online ? "● extension applying"
    : recentApply ? `○ agent idle - last run ${relTime(lastApplyAt)}: ${lastApply?.message ?? ""}`
    : "○ agent never run";

  async function run(kind: "discover" | "score" | "apply") {
    setBusy(kind);
    setLog(null);
    try {
      let res;
      if (kind === "apply") {
        res = await apply({ data: { max_jobs: 25, dry_run: dryRun } });
      } else {
        // Hand it to the cloud runner, so closing the app does not kill it.
        res = await sweep({ data: { only: kind === "discover" ? "discover" : "score" } });
        // If the runner is not connected, fall back to running it here. That
        // still dies if the browser navigates away, so say so rather than
        // letting it look like it simply failed.
        if (!res.ok && /not connected|workflow is not/i.test(res.message)) {
          setLog({ kind: "ok", text: `${res.message} Running here instead — keep this screen open.` });
          res = kind === "discover" ? await discover() : await score();
        }
      }
      setLog({ kind: res.ok ? "ok" : "err", text: res.message });
    } catch (e) {
      setLog({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(null);
      void qc.invalidateQueries({ queryKey: ["jobs"] });
      void qc.invalidateQueries({ queryKey: ["stats"] });
      void qc.invalidateQueries({ queryKey: ["runs"] });
    }
  }

  const s = stats.data;

  return (
    <div className="space-y-6">
      <div className="text-sm">
        <span className="text-primary">$</span> status{" "}
        <span className={agent?.online ? "text-success" : "text-muted-foreground"}>{agentLabel}</span>
        <span className="ml-4">queue <span className="text-cyan">{s?.queued ?? "…"}</span></span>
      </div>
      {!agent?.online && !recentApply ? (
        <p className="border-l-2 border-warning pl-2 text-xs text-warning">
          No applications submitted yet. Press RUN APPLY, or wait for the scheduled run.
        </p>
      ) : null}

      <StartCard />

      <AutopilotCard />

      <Section title="pipeline">
        {stats.isLoading ? <Cursor /> : stats.error ? <ErrorLine error={stats.error} /> : (
          <div className="grid grid-cols-4 gap-px border border-border bg-border sm:grid-cols-8">
            {PIPE.map(([k, label]) => (
              <Link key={k} to="/jobs" search={{ status: PIPE_STATUS[k] ?? k }} className="bg-card px-2 py-2 hover:bg-accent">
                <div className="text-xl">{s?.[k] ?? 0}</div>
                <div className="text-[10px] text-muted-foreground">{label}</div>
              </Link>
            ))}
          </div>
        )}
      </Section>

      <ConfirmationCard q={emailStats} />

      <Section title="today">
        <div className="grid grid-cols-3 gap-4">
          <Big n={s?.applied_today} label="applied today" />
          <Big n={Math.max(s?.interviews ?? 0, emailStats.data?.interviews ?? 0)} label="interviews" />
          <Big n={Math.max(s?.offers ?? 0, emailStats.data?.offers ?? 0)} label="offers" />
        </div>
      </Section>

      <Section title="actions">
        <div className="grid grid-cols-2 gap-2">
          <Btn variant="primary" disabled={!!busy} onClick={() => run("discover")}>
            {busy === "discover" ? <>running<span className="ap-cursor">_</span></> : "RUN DISCOVERY"}
          </Btn>
          <Btn variant="primary" disabled={!!busy} onClick={() => run("score")}>
            {busy === "score" ? <>running<span className="ap-cursor">_</span></> : "RUN SCORING"}
          </Btn>
          <Btn variant="primary" className="col-span-2" disabled={!!busy} onClick={() => run("apply")}>
            {busy === "apply" ? <>starting<span className="ap-cursor">_</span></> : "RUN APPLY"}
          </Btn>
          <label className="col-span-2 flex items-center gap-2 text-xs">
            <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} /> dry run
          </label>
          {dryRun ? <p className="col-span-2 text-xs text-muted-foreground">fills real forms and stops before submitting.</p> : null}
        </div>
        {log ? (
          <div className={`flex justify-between gap-2 border px-2 py-1 text-xs ${log.kind === "ok" ? "border-success/40 text-success" : "border-destructive/50 text-destructive"}`}>
            <span>{log.text}</span>
            <button onClick={() => setLog(null)} aria-label="dismiss">x</button>
          </div>
        ) : null}
        <p className="text-xs text-muted-foreground">
          discovery finds jobs. scoring rates them and tailors your resume for the good ones. start applying runs a real browser in the cloud (every hour too) — or use the chrome extension.
        </p>
      </Section>

      <Section title={`needs you (${help.data?.length ?? 0})`}>
        {help.isLoading ? <Cursor /> : help.error ? <ErrorLine error={help.error} /> : !help.data?.length ? (
          <Empty>nothing needs you.</Empty>
        ) : (
          <div className="divide-y divide-border border border-border">
            {help.data.map((j) => (
              <div key={j.id} className="flex flex-wrap items-center gap-2 px-2 py-2 text-xs">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{j.title}</div>
                  <div className="text-muted-foreground">{j.company}</div>
                  {j.last_error ? <div className="text-destructive">{j.last_error}</div> : null}
                </div>
                <span className={`border px-1 ${tagColor(j.help_reason)}`}>{j.help_reason ?? "error"}</span>
                <a href={j.apply_url ?? j.url} target="_blank" rel="noreferrer" className="border border-border px-2 py-1 uppercase">open</a>
                <Btn onClick={() => void setJobStatus(j.id, "queued", { attempts: 0 }).then(() => qc.invalidateQueries({ queryKey: ["jobs"] }))}>done</Btn>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="log">
        {runs.isLoading ? <Cursor /> : runs.error ? <ErrorLine error={runs.error} /> : !runs.data?.length ? (
          <Empty>no runs yet. press RUN DISCOVERY.</Empty>
        ) : (
          <div className="overflow-x-auto border border-border bg-card p-2 text-xs leading-6">
            {runs.data.map((r) => (
              <div key={r.id} className="whitespace-nowrap">
                <span className="text-muted-foreground">{clockTime(r.started_at)}</span>{"  "}
                <span className="inline-block w-16">{r.kind}</span>
                <span className={`inline-block w-14 ${r.status === "done" ? "text-success" : r.status === "error" ? "text-destructive" : "text-warning"}`}>{r.status}</span>
                <span>{r.message}</span>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

function Big({ n, label }: { n: number | undefined; label: string }) {
  return (
    <div>
      <div className="text-3xl">{n ?? 0}</div>
      <div className="text-[10px] text-muted-foreground">{label}</div>
    </div>
  );
}

function tagColor(r: string | null) {
  if (r === "captcha") return "border-warning/60 text-warning";
  if (r === "login") return "border-cyan/60 text-cyan";
  if (r === "unknown_question") return "border-primary/60 text-primary";
  // Not reaching the form, and reaching it without finishing it, are both
  // ordinary outcomes rather than breakages — red for everything taught the
  // eye to ignore the colour.
  if (r === "no_form" || r === "incomplete") return "border-warning/60 text-warning";
  if (r === "unconfirmed") return "border-cyan/60 text-cyan";
  // Registering is a step completed, not a failure.
  if (r === "registered") return "border-success/60 text-success";
  if (r === "email_verification") return "border-cyan/60 text-cyan";
  if (r === "dry_run") return "border-muted-foreground/60 text-muted-foreground";
  return "border-destructive/60 text-destructive";
}

function ConfirmationCard({ q }: { q: ReturnType<typeof useEmailStats> }) {
  const sent = q.data?.applications_sent ?? 0;
  const confirmed = q.data?.applications_confirmed ?? 0;
  const gap = confirmationGap(sent, confirmed);
  return (
    <Section title="confirmation gap">
      {q.isLoading ? <Cursor /> : q.error ? <ErrorLine error={q.error} onRetry={() => q.refetch()} /> : (
        <div className={`space-y-2 border p-3 ${gap.warn ? "border-warning" : "border-border"}`}>
          <div className="grid grid-cols-2 gap-4">
            <Big n={sent} label="applications sent" />
            <div>
              <div className={`text-3xl ${gap.warn ? "text-warning" : "text-success"}`}>{confirmed}</div>
              <div className="text-[10px] text-muted-foreground">confirmed by employer</div>
            </div>
          </div>
          {gap.warn ? (
            <p className="text-xs text-warning">
              {gap.missing} applications have no confirmation email. The applier may be reporting submissions that did not land.
            </p>
          ) : null}
        </div>
      )}
    </Section>
  );
}

function AutopilotCard() {
  const qc = useQueryClient();
  const q = useAutopilot();
  const [capInput, setCapInput] = useState("");
  const [savingAuto, setSavingAuto] = useState(false);
  const [capState, setCapState] = useState<{ k: "ok" | "err"; t: string } | null>(null);
  const [autoErr, setAutoErr] = useState<string | null>(null);

  useEffect(() => {
    if (q.data) setCapInput(String(q.data.daily_cap));
  }, [q.data?.daily_cap]);

  async function toggleAutopilot(next: boolean) {
    setSavingAuto(true);
    setAutoErr(null);
    const { error } = await supabase.from("profile").update({ autopilot: next }).eq("id", 1);
    setSavingAuto(false);
    if (error) {
      setAutoErr(error.message);
      return;
    }
    void qc.invalidateQueries({ queryKey: ["autopilot"] });
    void qc.invalidateQueries({ queryKey: ["settings"] });
  }

  async function commitCap() {
    if (!q.data) return;
    const parsed = parseDailyCap(capInput);
    if (parsed == null) {
      setCapState({ k: "err", t: "must be a whole number from 1 to 1000" });
      return;
    }
    if (parsed === q.data.daily_cap) {
      setCapState(null);
      return;
    }
    setCapState(null);
    const { error } = await supabase.from("search_config").update({ daily_cap: parsed }).eq("id", 1);
    if (error) {
      setCapState({ k: "err", t: error.message });
      return;
    }
    setCapState({ k: "ok", t: "saved" });
    void qc.invalidateQueries({ queryKey: ["autopilot"] });
    void qc.invalidateQueries({ queryKey: ["settings"] });
  }

  const on = q.data?.autopilot ?? false;
  const cap = q.data?.daily_cap ?? 50;
  const sentToday = q.data?.applications_today ?? 0;

  return (
    <Section title="autopilot">
      {q.isLoading ? <Cursor /> : q.error ? <ErrorLine error={q.error} onRetry={() => q.refetch()} /> : (
        <div className={`grid gap-4 border p-4 sm:grid-cols-[1fr_220px] ${on ? "border-warning bg-warning/5" : "border-border bg-card"}`}>
          <div className="space-y-2">
            <label className="flex cursor-pointer items-center gap-2.5 text-sm font-medium">
              <input
                type="checkbox"
                checked={on}
                disabled={savingAuto}
                onChange={(e) => void toggleAutopilot(e.target.checked)}
                className="h-4 w-4 accent-primary"
              />
              <span className={on ? "text-warning" : "text-foreground"}>apply automatically every hour</span>
            </label>
            {on ? (
              <p className="text-xs text-warning">
                Applications are being submitted without review. {sentToday} of {cap} sent today.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Nothing is submitted unless you press RUN APPLY.
              </p>
            )}
            {autoErr ? <ErrorLine error={autoErr} /> : null}
          </div>

          <label className="block space-y-1 text-xs">
            <span className="text-muted-foreground">daily cap</span>
            <input
              type="number"
              min={1}
              max={1000}
              step={1}
              className={inputCls}
              value={capInput}
              onChange={(e) => { setCapInput(e.target.value); setCapState(null); }}
              onBlur={() => void commitCap()}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void commitCap(); } }}
            />
            <span className="block text-muted-foreground">hard limit — the applier stops when it's reached.</span>
            {capState ? (
              <span className={`block ${capState.k === "ok" ? "text-success" : "text-destructive"}`}>{capState.t}</span>
            ) : null}
          </label>
        </div>
      )}
    </Section>
  );
}
