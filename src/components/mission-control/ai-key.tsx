import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { Btn } from "@/components/mission-control/async-state";
import { aiKeyStatus, clearAiKey, clearBackupKey, saveAiKey, saveBackupKey } from "@/lib/aikey.functions";

/**
 * A person's own free key to the model that writes their resumes and
 * answers. Three minutes, no card. The page is told only whether one is
 * saved.
 */
export function AiKey() {
  const qc = useQueryClient();
  const status = useServerFn(aiKeyStatus);
  const save = useServerFn(saveAiKey);
  const clear = useServerFn(clearAiKey);
  const q = useQuery({ queryKey: ["ai-key"], queryFn: () => status() });
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const set = q.data?.ok === true && q.data.set;
  const saveBackup = useServerFn(saveBackupKey);
  const clearBackup = useServerFn(clearBackupKey);
  const [backupKey, setBackupKey] = useState("");
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupMsg, setBackupMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const backupSet = q.data?.ok === true && q.data.backup;

  return (
    <div className="space-y-3 text-xs">
      <p className="text-muted-foreground">
        the model that writes a resume for each posting and answers the open questions on forms is free, but its daily allowance belongs to a Google account. with your own key, your applications are written on your own allowance. free, no card.
      </p>
      <ol className="list-decimal space-y-1 pl-4 text-muted-foreground">
        <li>open <a className="underline" href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">aistudio.google.com/apikey</a> and sign in with any Google account.</li>
        <li>press <b>Create API key</b>. if it asks for a project, let it create a new one.</li>
        <li>press copy beside the new key, paste it below, and save.</li>
        <li>do not turn on billing in Google: the free allowance is all this uses, and it resets every day.</li>
      </ol>
      <div className={set ? "text-success" : "text-muted-foreground"}>{set ? "● your own key is saved and in use" : "○ no key of your own; the shared one is used while its allowance lasts"}</div>
      <label className="block space-y-1">
        <span className="text-muted-foreground">your key{set ? " (saved; paste a new one to replace it)" : ""}</span>
        <input className="w-full border border-border bg-background px-2 py-1" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} />
      </label>
      <div className="flex flex-wrap gap-2">
        <Btn variant="primary" disabled={busy || !key.trim()} onClick={async () => {
          setBusy(true); setMsg(null);
          const r = await save({ data: { key } });
          setBusy(false);
          setMsg(r.ok ? { ok: true, text: "saved. your next round is written on your own allowance." } : { ok: false, text: r.message });
          if (r.ok) setKey("");
          void qc.invalidateQueries({ queryKey: ["ai-key"] });
        }}>{busy ? "checking…" : "save"}</Btn>
        {set ? <Btn disabled={busy} onClick={async () => { setMsg(null); const r = await clear(); setMsg(r.ok ? { ok: true, text: "removed." } : { ok: false, text: r.message }); void qc.invalidateQueries({ queryKey: ["ai-key"] }); }}>remove my key</Btn> : null}
      </div>
      {msg ? <div className={msg.ok ? "text-success" : "text-destructive"}>{msg.text}</div> : null}

      <div className="space-y-3 border-t border-border pt-3">
        <p className="text-muted-foreground">
          optional: a backup key. on a busy day the first key's free allowance runs out before midnight, and forms that need the model wait until it resets. a second free key from Groq is used only then. free, no card.
        </p>
        <ol className="list-decimal space-y-1 pl-4 text-muted-foreground">
          <li>open <a className="underline" href="https://console.groq.com/keys" target="_blank" rel="noreferrer">console.groq.com/keys</a> and sign up with an email address.</li>
          <li>press <b>Create API Key</b>, name it anything, and copy it (it starts with gsk_).</li>
          <li>paste it below and save. do not add a payment method there: the free allowance is all this uses.</li>
        </ol>
        <div className={backupSet ? "text-success" : "text-muted-foreground"}>{backupSet ? "● a backup key is saved" : "○ no backup key"}</div>
        <label className="block space-y-1">
          <span className="text-muted-foreground">backup key{backupSet ? " (saved; paste a new one to replace it)" : ""}</span>
          <input className="w-full border border-border bg-background px-2 py-1" type="password" autoComplete="off" value={backupKey} onChange={(e) => setBackupKey(e.target.value)} />
        </label>
        <div className="flex flex-wrap gap-2">
          <Btn variant="primary" disabled={backupBusy || !backupKey.trim()} onClick={async () => {
            setBackupBusy(true); setBackupMsg(null);
            const r = await saveBackup({ data: { key: backupKey } });
            setBackupBusy(false);
            setBackupMsg(r.ok ? { ok: true, text: "saved. it is used only when the first key has nothing left." } : { ok: false, text: r.message });
            if (r.ok) setBackupKey("");
            void qc.invalidateQueries({ queryKey: ["ai-key"] });
          }}>{backupBusy ? "checking…" : "save backup"}</Btn>
          {backupSet ? <Btn disabled={backupBusy} onClick={async () => { setBackupMsg(null); const r = await clearBackup(); setBackupMsg(r.ok ? { ok: true, text: "removed." } : { ok: false, text: r.message }); void qc.invalidateQueries({ queryKey: ["ai-key"] }); }}>remove backup key</Btn> : null}
        </div>
        {backupMsg ? <div className={backupMsg.ok ? "text-success" : "text-destructive"}>{backupMsg.text}</div> : null}
      </div>
    </div>
  );
}
