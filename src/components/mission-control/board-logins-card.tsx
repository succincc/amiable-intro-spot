import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Btn, inputCls } from "@/components/mission-control/async-state";
import { supabase } from "@/integrations/supabase/client";

const BOARDS = [
  { id: "linkedin", host: "linkedin.com", label: "LinkedIn", hint: "Easy Apply + direct employer links" },
  { id: "indeed", host: "indeed.com", label: "Indeed", hint: "Indeed Apply + company site links" },
  { id: "ziprecruiter", host: "ziprecruiter.com", label: "ZipRecruiter", hint: "1-Click Apply + external ATS links" },
] as const;

type BoardAccount = {
  host: string;
  email: string;
  password: string;
  status: string;
  note: string | null;
  session_updated_at?: string | null;
};

export function BoardLoginsCard({ defaultEmail }: { defaultEmail: string }) {
  const qc = useQueryClient();
  const [openBoard, setOpenBoard] = useState<string | null>(null);
  const [email, setEmail] = useState(defaultEmail);
  const [password, setPassword] = useState("");
  const [sessionJson, setSessionJson] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ board: string; ok: boolean; text: string } | null>(null);
  const { data: accounts = [] } = useQuery({
    queryKey: ["site-accounts"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("site_accounts")
        .select("host,email,password,status,note,created_at,session_updated_at")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as BoardAccount[];
    },
  });

  function openEditor(board: (typeof BOARDS)[number], existing?: BoardAccount) {
    setOpenBoard(openBoard === board.id ? null : board.id);
    setEmail(existing?.email || defaultEmail);
    setPassword("");
    setSessionJson("");
    setMsg(null);
  }

  async function connectBoard(board: (typeof BOARDS)[number]) {
    const cleanEmail = email.trim();
    const hasCreds = Boolean(cleanEmail && password);
    const hasSession = Boolean(sessionJson.trim());
    if (!hasCreds && !hasSession) {
      setMsg({ board: board.id, ok: false, text: "Enter your email & password, or paste session cookies JSON." });
      return;
    }
    let parsedSession: unknown = undefined;
    if (hasSession) {
      try {
        parsedSession = JSON.parse(sessionJson.trim());
      } catch {
        setMsg({ board: board.id, ok: false, text: "Session cookies must be valid JSON." });
        return;
      }
    }
    setBusy(board.id);
    setMsg(null);
    const { error } = await supabase.from("site_accounts").upsert(
      {
        host: board.host,
        email: cleanEmail || defaultEmail,
        password,
        status: "active",
        note: parsedSession ? "session synced in settings" : "connected in settings",
        last_used_at: null,
        ...(parsedSession ? { session_state: parsedSession as never, session_updated_at: new Date().toISOString() } : {}),
      },
      { onConflict: "user_id,host" },
    );
    if (error) {
      setBusy(null);
      setMsg({ board: board.id, ok: false, text: error.message });
      return;
    }

    // Automatically enable this board in search_config.sources so discovery + auto-apply run it.
    const { data: cfg } = await supabase.from("search_config").select("sources").eq("id", 1).maybeSingle();
    const currentSources = Array.isArray(cfg?.sources) ? cfg.sources : [];
    if (!currentSources.includes(board.id)) {
      await supabase
        .from("search_config")
        .update({ sources: [...currentSources, board.id], updated_at: new Date().toISOString() })
        .eq("id", 1);
    }

    setBusy(null);
    setPassword("");
    setSessionJson("");
    setOpenBoard(null);
    setMsg({ board: board.id, ok: true, text: `${board.label} connected and enabled for discovery & auto-apply.` });
    void qc.invalidateQueries({ queryKey: ["site-accounts"] });
    void qc.invalidateQueries({ queryKey: ["settings"] });
  }

  async function disconnectBoard(board: (typeof BOARDS)[number]) {
    setBusy(board.id);
    setMsg(null);
    const { error } = await supabase.from("site_accounts").delete().eq("host", board.host);
    setBusy(null);
    if (error) {
      setMsg({ board: board.id, ok: false, text: error.message });
      return;
    }
    setMsg({ board: board.id, ok: true, text: `${board.label} disconnected.` });
    void qc.invalidateQueries({ queryKey: ["site-accounts"] });
  }

  return (
    <div className="space-y-2 border border-border p-2 text-xs">
      <div className="text-muted-foreground">job board logins (LinkedIn, Indeed, ZipRecruiter)</div>
      <p className="text-muted-foreground">
        Enter your LinkedIn, Indeed, or ZipRecruiter login here — no browser or extension needed.
        Once saved, just press RUN APPLY on the Dashboard and the cloud runner signs in, finds jobs,
        and applies automatically.
      </p>
      <div className="divide-y divide-border border border-border">
        {BOARDS.map((b) => {
          const acct = accounts.find((a) => a.host.toLowerCase().includes(b.host));
          const connected = Boolean(acct && (acct.password || acct.session_updated_at));
          const isOpen = openBoard === b.id;
          return (
            <div key={b.id} className="space-y-2 p-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="font-medium">{b.label}</div>
                  <div className="text-muted-foreground">{b.hint}</div>
                  <div className={connected ? "text-success" : "text-muted-foreground"}>
                    {acct?.session_updated_at
                      ? `● connected (${acct.email || b.host}) · browser session synced`
                      : connected
                        ? `● connected (${acct?.email})`
                        : "○ not connected"}
                  </div>
                </div>
                <div className="flex gap-1">
                  <Btn onClick={() => openEditor(b, acct)}>
                    {isOpen ? "close" : connected ? "update login" : "log in"}
                  </Btn>
                  {connected ? (
                    <Btn disabled={busy === b.id} onClick={() => void disconnectBoard(b)}>
                      disconnect
                    </Btn>
                  ) : null}
                </div>
              </div>
              {isOpen ? (
                <div className="space-y-2 border-t border-border pt-2">
                  <input
                    className={inputCls}
                    type="email"
                    placeholder={`${b.label} email`}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoCapitalize="off"
                    autoCorrect="off"
                  />
                  <input
                    className={inputCls}
                    type="password"
                    placeholder={`${b.label} password`}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <textarea
                    className={`${inputCls} min-h-[48px]`}
                    placeholder="optional: session cookies JSON (for Google/Apple SSO or 2FA)"
                    value={sessionJson}
                    onChange={(e) => setSessionJson(e.target.value)}
                    spellCheck={false}
                  />
                  <Btn variant="primary" disabled={busy === b.id} onClick={() => void connectBoard(b)}>
                    {busy === b.id ? "saving…" : `SAVE ${b.label.toUpperCase()} LOGIN`}
                  </Btn>
                </div>
              ) : null}
              {msg?.board === b.id ? (
                <p className={msg.ok ? "text-success" : "text-warning"}>{msg.text}</p>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}