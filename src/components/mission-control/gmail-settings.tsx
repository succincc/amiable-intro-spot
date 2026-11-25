import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Btn, Cursor, ErrorLine } from "./async-state";
import { stamp } from "@/hooks/use-mission-control";
import { gmailAuthUrl, gmailDisconnect, gmailStatus, gmailSync } from "@/lib/engine.functions";

export function GmailSettings() {
  const qc = useQueryClient();
  const getStatus = useServerFn(gmailStatus);
  const connect = useServerFn(gmailAuthUrl);
  const sync = useServerFn(gmailSync);
  const disconnect = useServerFn(gmailDisconnect);
  const q = useQuery({ queryKey: ["gmail-connection"], queryFn: () => getStatus(), refetchInterval: 60_000 });
  const [busy, setBusy] = useState<"connect" | "sync" | "catchup" | "disconnect" | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function act(action: "connect" | "sync" | "catchup" | "disconnect") {
    if (busy) return;
    setBusy(action); setMessage(null);
    try {
      if (action === "connect") {
        const result = await connect();
        if (result.ok) { window.location.assign(result.url); return; }
        setMessage({ ok: false, text: result.message });
      } else {
        const result =
          action === "disconnect"
            ? await disconnect()
            : await sync({
                // A catch-up reads two months instead of three days, to find
                // receipts for applications sent before Gmail was connected.
                data:
                  action === "catchup" ? { query: "in:inbox newer_than:60d", max: 200 } : {},
              });
        setMessage({ ok: result.ok, text: result.message });
        await Promise.all([
          qc.invalidateQueries({ queryKey: ["gmail-connection"] }),
          qc.invalidateQueries({ queryKey: ["email-sync"] }),
          qc.invalidateQueries({ queryKey: ["emails"] }),
          qc.invalidateQueries({ queryKey: ["stats"] }),
        ]);
      }
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : String(error) });
    } finally { setBusy(null); }
  }

  return (
    <section aria-label="Gmail connection" className="space-y-3 border-b border-border pb-3 text-xs">
      <h2 className="text-sm">Gmail</h2>
      {q.isPending ? <Cursor label="checking Gmail connection" /> : q.error ? <ErrorLine error={q.error} onRetry={() => void q.refetch()} /> : q.data?.connected ? (
        <>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
            <dt className="text-muted-foreground">connected address</dt><dd className="break-all">{q.data.email ?? "—"}</dd>
            <dt className="text-muted-foreground">connected at</dt><dd>{stamp(q.data.connected_at)}</dd>
            <dt className="text-muted-foreground">last sync</dt><dd>{q.data.last_sync_at ? stamp(q.data.last_sync_at) : "never"}</dd>
          </dl>
          {q.data.mismatch ? <p role="alert" className="break-words text-warning">{q.data.mismatch}</p> : null}
          {q.data.last_error ? <p role="alert" className="break-words text-warning">{q.data.last_error}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Btn variant="primary" disabled={busy !== null} onClick={() => void act("sync")}>{busy === "sync" ? "syncing…" : "SYNC NOW"}</Btn>
            <Btn disabled={busy !== null} onClick={() => void act("catchup")}>{busy === "catchup" ? "reading 60 days…" : "CATCH UP · 60d"}</Btn>
            <Btn variant="danger" disabled={busy !== null} onClick={() => void act("disconnect")}>{busy === "disconnect" ? "disconnecting…" : "DISCONNECT"}</Btn>
          </div>
        </>
      ) : <Btn variant="primary" disabled={busy !== null} onClick={() => void act("connect")}>{busy === "connect" ? "connecting…" : "CONNECT GMAIL"}</Btn>}
      {message ? <p role="status" className={`break-words ${message.ok ? "text-success" : "text-warning"}`}>{message.text}</p> : null}
    </section>
  );
}