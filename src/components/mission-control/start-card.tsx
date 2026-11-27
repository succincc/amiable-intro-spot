import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { Btn, Cursor, ErrorLine, Section } from "@/components/mission-control/async-state";
import { supabase } from "@/integrations/supabase/client";
import { startBackfill } from "@/lib/engine.functions";
import { STARTED, isStarted, readyToStart, setupSteps } from "@/lib/start";

/**
 * The first thing on the dashboard: what is left to set up, one button that
 * switches the whole thing on, and — once it is on — whether anything is
 * wrong. After "start" the only mail that needs the owner is an interview,
 * an assessment or an offer.
 */
export function StartCard() {
  const qc = useQueryClient();
  const backfill = useServerFn(startBackfill);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["start"],
    refetchInterval: 60_000,
    queryFn: async () => {
      const [p, c, m, a, r, g] = await Promise.all([
        supabase.from("profile").select("*").eq("id", 1).maybeSingle(),
        supabase.from("search_config").select("titles").eq("id", 1).maybeSingle(),
        supabase.from("email_sync").select("last_run_at").eq("id", 1).maybeSingle(),
        supabase.from("answers").select("id", { count: "exact", head: true }).eq("confirmed", false).eq("answer", ""),
        supabase.from("jobs").select("id", { count: "exact", head: true }).eq("status", "review"),
        supabase.from("google_tokens").select("connected_at,refresh_token").eq("id", 1).maybeSingle(),
      ]);
      if (p.error) throw p.error;
      return { profile: (p.data ?? null) as Record<string, unknown> | null, titles: c.data?.titles ?? [], mailLastRun: m.data?.last_run_at ?? null, mailConnectedAt: g.data?.refresh_token ? (g.data.connected_at ?? null) : null, waiting: a.count ?? 0, reviewing: r.count ?? 0 };
    },
  });

  async function set(patch: Record<string, boolean>) {
    setBusy(true);
    setErr(null);
    // The switches are newer than the generated types.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase.from("profile") as any).update(patch).eq("id", 1);
    setBusy(false);
    if (error) return setErr(error.message);
    for (const key of ["start", "autopilot", "settings"]) void qc.invalidateQueries({ queryKey: [key] });
  }

  if (q.isLoading) return <Section title="start"><Cursor /></Section>;
  if (q.error || !q.data) return <Section title="start"><ErrorLine error={q.error ?? "could not read the profile"} onRetry={() => q.refetch()} /></Section>;

  const steps = setupSteps({ ...q.data, now: new Date() });
  const ready = readyToStart(steps);
  const on = isStarted(q.data.profile);
  const wrong = String(q.data.profile?.["health_state"] ?? "").split("\n").filter(Boolean);
  const undone = steps.filter((s) => !s.done);

  return (
    <Section title={on ? "running" : "start"}>
      <div className={`space-y-3 border p-4 ${wrong.length ? "border-destructive/60" : on ? "border-success/50 bg-success/5" : "border-primary/60 bg-card"}`}>
        {wrong.length ? (
          <div className="space-y-1 text-xs text-destructive">
            <div className="font-medium">needs a look</div>
            {wrong.map((w) => <div key={w}>- {w}</div>)}
          </div>
        ) : null}

        {on ? (
          <>
            <p className="text-sm text-success">● on. finding, applying and answering every hour.</p>
            <p className="text-xs text-muted-foreground">
              you are emailed for three things only: an interview (with the time, a brief and a calendar file), an assessment to take, and an offer. everything else is in the morning summary.
            </p>
            {undone.length ? (
              <div className="space-y-1 text-xs">
                <div className="text-muted-foreground">would make it ask you less:</div>
                {undone.map((s) => (
                  <Link key={s.key} to={s.to} className="block text-warning hover:underline">○ {s.label} <span className="text-muted-foreground">- {s.hint}</span></Link>
                ))}
              </div>
            ) : null}
            <Btn disabled={busy} onClick={() => void set({ autopilot: false, auto_reply: false })}>pause</Btn>
          </>
        ) : (
          <>
            <div className="space-y-1 text-xs">
              {steps.map((s) => (
                <Link key={s.key} to={s.to} className="flex items-baseline gap-2 hover:underline">
                  <span className={s.done ? "text-success" : s.required ? "text-destructive" : "text-warning"}>{s.done ? "●" : "○"}</span>
                  <span className={s.done ? "text-muted-foreground" : ""}>{s.label}</span>
                  {!s.done ? <span className="text-muted-foreground">- {s.hint}{s.required ? "" : " (optional)"}</span> : null}
                </Link>
              ))}
            </div>
            <Btn variant="primary" className="w-full py-3 text-base" disabled={busy || !ready} onClick={() => void set({ ...STARTED }).then(() => backfill().catch(() => undefined))}>
              {busy ? <>starting<span className="ap-cursor">_</span></> : "START"}
            </Btn>
            <p className="text-xs text-muted-foreground">
              {ready
                ? "switches on: applying every hour, replies to interview requests with your open times, a summary each morning, and an email to you for an interview, an assessment or an offer. follow-up notes to employers stay off unless you switch them on in settings."
                : "the red ones first; the rest can wait."}
            </p>
          </>
        )}
        {err ? <ErrorLine error={err} /> : null}
      </div>
    </Section>
  );
}
