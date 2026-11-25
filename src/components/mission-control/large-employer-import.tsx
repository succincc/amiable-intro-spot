import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { LoaderCircle } from "lucide-react";

import { Btn, Cursor, ErrorLine } from "./async-state";
import { supabase } from "@/integrations/supabase/client";
import { verifyCandidates } from "@/lib/engine.functions";
import { importAllCandidates } from "@/lib/candidate-import";

export function LargeEmployerImport() {
  const qc = useQueryClient();
  const verify = useServerFn(verifyCandidates);
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState("");
  const stats = useQuery({
    queryKey: ["candidate-stats"],
    refetchInterval: busy ? 3000 : false,
    queryFn: async () => {
      const result = await supabase.from("v_candidate_stats").select("*").single();
      if (result.error) throw result.error;
      return result.data;
    },
  });
  const failed = useQuery({
    queryKey: ["failed-candidates"],
    refetchInterval: busy ? 5000 : false,
    queryFn: async () => {
      const result = await supabase.from("company_candidates").select("id,name,note")
        .eq("status", "failed").order("name");
      if (result.error) throw result.error;
      return result.data;
    },
  });

  async function start(retry = false) {
    if (running.current) return;
    running.current = true;
    setBusy(true); setError(null); setMessage("");
    setRetrying(retry);
    const retryBefore = new Date().toISOString();
    try {
      await importAllCandidates(() => verify({ data: { limit: 8, retry, ...(retry ? { retryBefore } : {}) } }), (result) => {
        if (result.stats) qc.setQueryData(["candidate-stats"], result.stats);
        setMessage(result.message);
        void qc.invalidateQueries({ queryKey: ["failed-candidates"] });
        void qc.invalidateQueries({ queryKey: ["companies"] });
      }, retry);
      setMessage(retry ? "Retry complete. Every pending or previously failed employer has been checked." : "Import complete.");
    } catch (e) { setError(e); }
    finally {
      running.current = false;
      setBusy(false);
      void qc.invalidateQueries({ queryKey: ["candidate-stats"] });
      void qc.invalidateQueries({ queryKey: ["failed-candidates"] });
      void qc.invalidateQueries({ queryKey: ["companies"] });
    }
  }

  return (
    <div className="space-y-3 border-b border-border pb-3">
      <div className="flex flex-wrap gap-2">
      <Btn variant="primary" disabled={busy || stats.isLoading || !!stats.error || stats.data?.pending === 0} onClick={() => void start()}>
        <span className="flex items-center gap-2">
          {busy ? <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
          {busy && !retrying ? "IMPORTING LARGE EMPLOYERS…" : "IMPORT LARGE EMPLOYERS"}
        </span>
      </Btn>
      <Btn disabled={busy || stats.isLoading || !!stats.error || !stats.data?.failed} onClick={() => void start(true)}>
        <span className="flex items-center gap-2">
          {busy && retrying ? <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
          {busy && retrying ? "RETRYING FAILED…" : "RETRY FAILED"}
        </span>
      </Btn>
      </div>
      <div role="status" aria-live="polite" aria-busy={busy} className="space-y-1 text-xs">
        {stats.isLoading ? <Cursor label="loading employer progress" /> : stats.error ? <ErrorLine error={stats.error} onRetry={() => void stats.refetch()} /> : (
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <span className="text-success">resolved: {stats.data?.resolved ?? 0}</span>
            <span className="text-destructive">failed: {stats.data?.failed ?? 0}</span>
            <span>pending: {stats.data?.pending ?? 0}</span>
          </div>
        )}
        {busy ? <div className="text-muted-foreground">Checking employer careers pages…</div> : null}
        {message ? <div className="text-muted-foreground">{message}</div> : null}
      </div>
      {error ? <ErrorLine error={error} /> : null}
      {failed.error ? <ErrorLine error={failed.error} onRetry={() => void failed.refetch()} /> : null}
      {failed.data?.length ? (
        <div className="space-y-2">
          <h3 className="text-xs text-muted-foreground">Failed employers ({failed.data.length})</h3>
          <ul className="max-h-80 divide-y divide-border overflow-y-auto text-xs">
            {failed.data.map((candidate) => (
              <li key={candidate.id} className="py-2">
                <div>{candidate.name}</div>
                <div className="break-words text-destructive">{candidate.note ?? "No failure note recorded"}</div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}