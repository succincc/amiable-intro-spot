import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Btn, Cursor, Empty, ErrorLine, inputCls } from "@/components/mission-control/async-state";
import { supabase } from "@/integrations/supabase/client";
import { relTime, useRealtimeInvalidate, type Answer } from "@/hooks/use-mission-control";

export const Route = createFileRoute("/_authenticated/answers")({
  head: () => ({
    meta: [
      { title: "Answers · ApplyPilot" },
      { name: "description", content: "Screening-question memory the agent answers from." },
      { property: "og:title", content: "Answers · ApplyPilot" },
      { property: "og:description", content: "Screening-question memory the agent answers from." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Answers,
});

function Answers() {
  const qc = useQueryClient();
  useRealtimeInvalidate("answers", [["answers"]]);
  const [tab, setTab] = useState<"need" | "saved">("need");
  const [filter, setFilter] = useState("");
  const q = useQuery({
    queryKey: ["answers", "list"],
    queryFn: async (): Promise<Answer[]> => {
      const { data, error } = await supabase.from("answers").select("*").order("created_at", { ascending: false }).limit(1000);
      if (error) throw error;
      return data ?? [];
    },
  });
  const rows = (q.data ?? []).filter((a) => (tab === "need" ? !a.confirmed : a.confirmed))
    .filter((a) => !filter || `${a.question} ${a.answer}`.toLowerCase().includes(filter.toLowerCase()));
  const needCount = (q.data ?? []).filter((a) => !a.confirmed).length;

  async function save(a: Answer, answer: string) {
    const { error } = await supabase.from("answers").update({ answer, confirmed: true }).eq("id", a.id);
    if (error) throw error;
    void qc.invalidateQueries({ queryKey: ["answers"] });
  }
  async function remove(a: Answer) {
    if (!confirm(`Delete "${a.question}"?`)) return;
    await supabase.from("answers").delete().eq("id", a.id);
    void qc.invalidateQueries({ queryKey: ["answers"] });
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">the agent answers from this list first. anything it could not answer lands here — fill it once and it is used forever.</p>
      <div className="flex gap-1 text-xs">
        <button onClick={() => setTab("need")} className={`border px-2 py-1 ${tab === "need" ? "border-primary text-primary" : "border-border text-muted-foreground"}`}>needs answer {needCount}</button>
        <button onClick={() => setTab("saved")} className={`border px-2 py-1 ${tab === "saved" ? "border-primary text-primary" : "border-border text-muted-foreground"}`}>saved</button>
      </div>
      {tab === "saved" ? <input className={inputCls} placeholder="search" value={filter} onChange={(e) => setFilter(e.target.value)} /> : null}
      {q.isLoading ? <Cursor /> : q.error ? <ErrorLine error={q.error} /> : !rows.length ? (
        <Empty>{tab === "need" ? "every question has an answer." : "no saved answers yet."}</Empty>
      ) : (
        <div className="divide-y divide-border border border-border">
          {rows.map((a) => <Row key={a.id} a={a} onSave={save} onDelete={remove} />)}
        </div>
      )}
    </div>
  );
}

function Row({ a, onSave, onDelete }: { a: Answer; onSave: (a: Answer, v: string) => Promise<void>; onDelete: (a: Answer) => void }) {
  const [v, setV] = useState(a.answer);
  const [msg, setMsg] = useState<string | null>(null);

  // The employer's own wording, where the applier managed to read it.
  //
  // Typing an answer into a box is guessing at a spelling. One real
  // questionnaire offers "Bachelor’s Degree" with a curly apostrophe, and a
  // typed straight one misses in silence — you would be left certain you had
  // answered it. Tapping the portal's own words cannot miss.
  // Read defensively: the generated types do not carry this column until the
  // migration has been applied and the types regenerated.
  const raw = (a as Answer & { options?: unknown }).options;
  const options = Array.isArray(raw)
    ? (raw as unknown[]).map(String).filter(Boolean).slice(0, 40)
    : [];

  function keep(value: string) {
    setV(value);
    onSave(a, value).then(() => setMsg("saved")).catch((e: Error) => setMsg(e.message));
  }

  return (
    <div className="space-y-2 p-2 text-xs">
      <div className="text-sm">{a.question}</div>
      {options.length ? (
        <div className="flex flex-wrap gap-1">
          {options.map((o) => (
            <button
              key={o}
              onClick={() => keep(o)}
              className={`border px-2 py-1 text-left ${
                v === o ? "border-primary text-primary" : "border-border text-muted-foreground"
              }`}
            >
              {o}
            </button>
          ))}
        </div>
      ) : null}
      <div className="flex gap-2">
        <input
          className={inputCls}
          value={v}
          onChange={(e) => setV(e.target.value)}
          placeholder={options.length ? "or type it" : undefined}
        />
        <Btn variant="primary" onClick={() => keep(v)}>save</Btn>
        {a.confirmed ? <Btn variant="danger" onClick={() => onDelete(a)}>del</Btn> : null}
      </div>
      <div className="text-muted-foreground">
        {a.field_type} · used {a.times_used ?? 0}× · last {relTime(a.last_used)} {msg ? <span className="text-success">· {msg}</span> : null}
      </div>
    </div>
  );
}
