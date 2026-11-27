import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { Btn, ErrorLine } from "@/components/mission-control/async-state";
import { supabase } from "@/integrations/supabase/client";
import { removeMember } from "@/lib/members.functions";

type Member = { user_id: string; email: string; full_name: string; status: "pending" | "approved" | "denied"; created_at: string; decided_at: string | null };

/**
 * The owner's list of everyone who has asked to come in: say yes or no,
 * correct a name, or remove a login altogether. Nobody but the owner can
 * read this list; the database holds it to that.
 */
export function PeopleAdmin() {
  const qc = useQueryClient();
  const remove = useServerFn(removeMember);
  const [err, setErr] = useState<string | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const q = useQuery({
    queryKey: ["members"],
    queryFn: async () => {
      // members is newer than the generated types.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from("members" as never) as any).select("*").order("created_at", { ascending: false }).limit(200);
      if (error) throw error;
      return (data ?? []) as Member[];
    },
  });

  async function patch(id: string, change: Partial<Member>) {
    setErr(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase.from("members" as never) as any).update(change).eq("user_id", id);
    if (error) setErr(error.message);
    void qc.invalidateQueries({ queryKey: ["members"] });
  }
  const decide = (id: string, status: Member["status"]) => patch(id, { status, decided_at: new Date().toISOString() });

  if (q.isLoading) return <p className="text-xs text-muted-foreground">loading…</p>;
  if (q.error) return <ErrorLine error={q.error} />;
  const rows = q.data ?? [];
  const waiting = rows.filter((r) => r.status === "pending");
  const rest = rows.filter((r) => r.status !== "pending");

  const line = (m: Member) => (
    <div key={m.user_id} className="flex flex-wrap items-center gap-2 border-b border-border py-2 text-xs">
      <input
        className="w-40 border border-border bg-background px-1 py-0.5"
        value={names[m.user_id] ?? m.full_name}
        onChange={(e) => setNames({ ...names, [m.user_id]: e.target.value })}
        onBlur={() => { const v = (names[m.user_id] ?? m.full_name).trim(); if (v && v !== m.full_name) void patch(m.user_id, { full_name: v.slice(0, 120) }); }}
      />
      <span className="text-muted-foreground">{m.email}</span>
      <span className={m.status === "approved" ? "text-success" : m.status === "denied" ? "text-destructive" : "text-warning"}>{m.status}</span>
      <span className="ml-auto flex gap-2">
        {m.status !== "approved" ? <Btn variant="primary" onClick={() => void decide(m.user_id, "approved")}>approve</Btn> : null}
        {m.status !== "denied" ? <Btn onClick={() => void decide(m.user_id, "denied")}>deny</Btn> : null}
        {m.status === "approved" ? <Btn onClick={async () => {
          if (!window.confirm(`Empty ${m.email}'s workspace? Their profile, resume, jobs, applications, answers, mail and connected accounts are deleted. Their login, name and email stay. This cannot be undone.`)) return;
          setErr(null);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { error } = await (supabase as any).rpc("admin_reset_workspace", { p_user: m.user_id });
          if (error) setErr(error.message);
          else setErr(null);
          void qc.invalidateQueries({ queryKey: ["members"] });
        }}>full reset</Btn> : null}
        <Btn onClick={async () => {
          if (!window.confirm(`Remove ${m.email} altogether? Their login and everything in their workspace are deleted and cannot be brought back.`)) return;
          setErr(null);
          const r = await remove({ data: { user_id: m.user_id } });
          if (!r.ok) setErr(r.message);
          void qc.invalidateQueries({ queryKey: ["members"] });
        }}>remove</Btn>
      </span>
    </div>
  );

  return (
    <div className="space-y-3 text-xs">
      <p className="text-muted-foreground">
        people who asked to use the panel from the sign-in page. nobody comes in without your yes. an approved person gets a workspace of their own, starting from the employer boards yours has already found; nothing else of yours is shown to them, and nothing of theirs to each other. full reset empties a person's workspace and keeps their login; remove deletes the login and everything with it.
      </p>
      {err ? <div className="text-destructive">{err}</div> : null}
      <div>
        <div className="mb-1 font-semibold">waiting for you ({waiting.length})</div>
        {waiting.length ? waiting.map(line) : <div className="text-muted-foreground">no requests waiting.</div>}
      </div>
      <div>
        <div className="mb-1 font-semibold">decided ({rest.length})</div>
        {rest.length ? rest.map(line) : <div className="text-muted-foreground">nobody yet.</div>}
      </div>
    </div>
  );
}
