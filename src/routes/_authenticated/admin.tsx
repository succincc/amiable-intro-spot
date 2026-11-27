import { useMemo, useState } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { Btn, ErrorLine } from "@/components/mission-control/async-state";
import { supabase } from "@/integrations/supabase/client";
import { FILTERS, ago, missing, narrow, totals, type Filter, type Person, type Sort } from "@/lib/admin";
import { removeMember } from "@/lib/members.functions";

export const Route = createFileRoute("/_authenticated/admin")({
  // The owner's page. Anyone else is sent back to their own dashboard; the
  // database would give them nothing here in any case.
  beforeLoad: ({ context }) => {
    if ((context as { access?: string }).access !== "owner") throw redirect({ to: "/dashboard" });
  },
  head: () => ({ meta: [{ title: "Admin · ApplyPilot" }, { name: "robots", content: "noindex" }] }),
  component: Admin,
});

const SORTS: Array<[Sort, string]> = [["newest", "newest first"], ["active", "last active"], ["applied", "most applications"], ["name", "name"]];

function Admin() {
  const qc = useQueryClient();
  const remove = useServerFn(removeMember);
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("newest");
  const [words, setWords] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const q = useQuery({
    queryKey: ["admin-overview"],
    refetchInterval: 60_000,
    queryFn: async () => {
      // admin_overview is newer than the generated types.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any).rpc("admin_overview");
      if (error) throw error;
      return (data ?? []) as Person[];
    },
  });
  const now = Date.now();
  const people = q.data ?? [];
  const sum = useMemo(() => totals(people, now), [people, now]);
  const shown = useMemo(() => narrow(people, { filter, words, sort, now }), [people, filter, words, sort, now]);
  const again = () => void qc.invalidateQueries({ queryKey: ["admin-overview"] });

  async function act(id: string, what: () => Promise<{ error?: { message: string } | null } | void>) {
    setErr(null);
    setBusy(id);
    try {
      const r = await what();
      if (r && r.error) setErr(r.error.message);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    }
    setBusy(null);
    again();
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const members = () => supabase.from("members" as never) as any;
  const decide = (p: Person, status: "approved" | "denied") => act(p.user_id, () => members().update({ status, decided_at: new Date().toISOString() }).eq("user_id", p.user_id));

  if (q.isLoading) return <p className="p-4 text-xs text-muted-foreground">loading…</p>;
  if (q.error) return <div className="p-4"><ErrorLine error={q.error} /></div>;

  const tile = (label: string, value: number, f?: Filter) => (
    <button type="button" onClick={() => f && setFilter(f)} className={`border border-border px-3 py-2 text-left ${f && filter === f ? "border-primary" : ""}`}>
      <div className="text-lg">{value}</div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </button>
  );
  const yes = (on: boolean, label: string) => <span className={on ? "text-success" : "text-muted-foreground"}>{on ? "●" : "○"} {label}</span>;

  return (
    <div className="space-y-4 p-4 text-xs">
      <div>
        <h1 className="text-sm font-semibold">admin</h1>
        <p className="text-muted-foreground">everyone who has asked to use the panel, and how each workspace is doing. counts and switches only: nobody's jobs, mail, resume or keys are shown here.</p>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
        {tile("waiting for you", sum.waiting, "pending")}
        {tile("approved", sum.approved, "approved")}
        {tile("running", sum.running, "running")}
        {tile("set up unfinished", sum.stuck, "stuck")}
        {tile("denied", sum.denied, "denied")}
        {tile("sent, last 24h", sum.applied_24h)}
        {tile("sent, all time", sum.applied)}
        {tile("interviews and offers", sum.interviews)}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input className="w-56 border border-border bg-background px-2 py-1" placeholder="search name or email" value={words} onChange={(e) => setWords(e.target.value)} />
        <div className="flex flex-wrap gap-1">
          {FILTERS.map(([f, label]) => (
            <button key={f} type="button" onClick={() => setFilter(f)} className={`border px-2 py-1 ${filter === f ? "border-primary text-primary" : "border-border text-muted-foreground"}`}>{label}</button>
          ))}
        </div>
        <select className="ml-auto border border-border bg-background px-1 py-1" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
          {SORTS.map(([s, label]) => <option key={s} value={s}>{label}</option>)}
        </select>
      </div>

      {err ? <div className="text-destructive">{err}</div> : null}
      <div className="text-muted-foreground">{shown.length} of {people.length} shown</div>

      <div className="border-t border-border">
        {shown.map((p) => {
          const left = missing(p);
          const isOpen = open === p.user_id;
          return (
            <div key={p.user_id} className="border-b border-border py-2">
              <button type="button" className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 text-left" onClick={() => setOpen(isOpen ? null : p.user_id)}>
                <span className="w-44 truncate font-semibold">{p.full_name || "(no name)"}{p.is_owner ? " · you" : ""}</span>
                <span className="w-56 truncate text-muted-foreground">{p.email}</span>
                <span className={p.status === "approved" ? "text-success" : p.status === "denied" ? "text-destructive" : "text-warning"}>{p.is_owner ? "owner" : p.status}</span>
                {p.status === "approved" ? <span>{p.applied} sent · {p.applied_24h} in 24h · {p.queued} queued</span> : <span className="text-muted-foreground">asked {ago(p.created_at, now)}</span>}
                {left.length ? <span className="text-warning">needs: {left.join(", ")}</span> : null}
                <span className="ml-auto text-muted-foreground">{isOpen ? "▾" : "▸"}</span>
              </button>

              {isOpen ? (
                <div className="mt-2 space-y-2 pl-1">
                  {p.status === "approved" ? (
                    <>
                      <div className="flex flex-wrap gap-x-4 gap-y-1">
                        {yes(p.has_workspace, "workspace")}
                        {yes(p.has_resume, "resume")}
                        {yes(Number(p.titles) > 0, `${p.titles ?? 0} job titles`)}
                        {yes(p.mail_connected, "mailbox")}
                        {yes(p.own_key, "own writing key")}
                        {yes(p.autopilot, "running")}
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
                        <span>{p.employers} employers</span>
                        <span>{p.jobs} postings found</span>
                        <span>{p.needs_help} stopped</span>
                        <span>{p.questions_waiting} questions waiting</span>
                        <span>{p.interviews} interviews/offers</span>
                        <span>last applied {ago(p.last_applied_at, now)}</span>
                        <span>mail read {ago(p.mail_last_read, now)}</span>
                        <span>signed in {ago(p.last_sign_in_at, now)}</span>
                      </div>
                    </>
                  ) : null}
                  {!p.is_owner ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        className="w-44 border border-border bg-background px-1 py-0.5"
                        value={names[p.user_id] ?? p.full_name}
                        onChange={(e) => setNames({ ...names, [p.user_id]: e.target.value })}
                        onBlur={() => { const v = (names[p.user_id] ?? p.full_name).trim(); if (v && v !== p.full_name) void act(p.user_id, () => members().update({ full_name: v.slice(0, 120) }).eq("user_id", p.user_id)); }}
                      />
                      {p.status !== "approved" ? <Btn variant="primary" disabled={busy === p.user_id} onClick={() => void decide(p, "approved")}>approve</Btn> : null}
                      {p.status !== "denied" ? <Btn disabled={busy === p.user_id} onClick={() => void decide(p, "denied")}>{p.status === "approved" ? "suspend" : "deny"}</Btn> : null}
                      {p.status === "approved" ? <Btn disabled={busy === p.user_id} onClick={() => {
                        if (!window.confirm(`Empty ${p.email}'s workspace? Their profile, resume, jobs, applications, answers, mail and connected accounts are deleted. Their login, name and email stay. This cannot be undone.`)) return;
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        void act(p.user_id, () => (supabase as any).rpc("admin_reset_workspace", { p_user: p.user_id }));
                      }}>full reset</Btn> : null}
                      <Btn disabled={busy === p.user_id} onClick={() => {
                        if (!window.confirm(`Remove ${p.email} altogether? Their login and everything in their workspace are deleted and cannot be brought back.`)) return;
                        void act(p.user_id, async () => { const r = await remove({ data: { user_id: p.user_id } }); return r.ok ? undefined : { error: { message: r.message } }; });
                      }}>remove</Btn>
                      <span className="text-muted-foreground">asked {ago(p.created_at, now)}{p.decided_at ? ` · decided ${ago(p.decided_at, now)}` : ""}</span>
                    </div>
                  ) : <div className="text-muted-foreground">your own account is not changed from here.</div>}
                </div>
              ) : null}
            </div>
          );
        })}
        {!shown.length ? <div className="py-4 text-muted-foreground">nobody matches.</div> : null}
      </div>
    </div>
  );
}
