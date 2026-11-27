import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { Btn, ErrorLine, inputCls } from "@/components/mission-control/async-state";
import { supabase } from "@/integrations/supabase/client";
import { callingStatus, clearCallingKeys, saveCallingKeys } from "@/lib/calling.functions";

/**
 * Calling, as an optional extra. Each user connects their own voice and
 * phone accounts and is billed by those services directly; nothing is paid
 * to or through this site. Off until switched on, and it only ever calls
 * for the applications the rule below allows.
 */
export function CallingExtra({ initial }: { initial: Record<string, unknown> }) {
  const qc = useQueryClient();
  const status = useServerFn(callingStatus);
  const save = useServerFn(saveCallingKeys);
  const clear = useServerFn(clearCallingKeys);
  const q = useQuery({ queryKey: ["calling"], queryFn: () => status() });
  const [keys, setKeys] = useState({ voice_key: "", voice_id: "", phone_sid: "", phone_token: "", phone_number: "" });
  const [on, setOn] = useState(initial["calls_enabled"] === true);
  const [min, setMin] = useState(Number(initial["calls_min_score"] ?? 7));
  const [targets, setTargets] = useState(initial["calls_targets_only"] === true);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const connected = q.data?.ok === true && q.data.voice && q.data.voiceId && q.data.phone && Boolean(q.data.number);

  async function rule(patch: Record<string, boolean | number>) {
    setErr(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase.from("profile") as any).update(patch).eq("id", 1);
    if (error) setErr(error.message);
    else void qc.invalidateQueries({ queryKey: ["settings"] });
  }

  const box = (k: keyof typeof keys, label: string, set: boolean) => (
    <label className="block space-y-1 text-xs">
      <span className="text-muted-foreground">{label}{set ? " (set)" : ""}</span>
      <input className={inputCls} type={k === "phone_number" || k === "voice_id" ? "text" : "password"} autoComplete="off" placeholder={set ? "leave empty to keep" : ""} value={keys[k]} onChange={(e) => setKeys({ ...keys, [k]: e.target.value })} />
    </label>
  );

  return (
    <div className="space-y-3 text-xs">
      <p className="text-muted-foreground">
        optional, and not part of the free service. an assistant phones a place you applied to, says it is an AI assistant calling about your application, asks for the hiring manager and makes your case in your own recorded voice. you connect your own accounts and those services bill you directly: a voice service (about $5 to $22 a month) and a phone number (about $1 to $2 a month, plus a few cents a minute). rehearse it free on the <a className="underline" href="/practice">practice page</a> first.
      </p>
      <ol className="list-decimal space-y-1 pl-4 text-muted-foreground">
        <li><b>voice.</b> open an account at <a className="underline" href="https://elevenlabs.io/app/sign-up" target="_blank" rel="noreferrer">elevenlabs.io</a> and choose a paid plan (the smallest one includes cloning your voice). go to <a className="underline" href="https://elevenlabs.io/app/voice-lab" target="_blank" rel="noreferrer">Voices</a>, add a voice, choose Instant Voice Clone, and record or upload about a minute of yourself talking normally. open the new voice and copy its Voice ID into "your cloned voice's id".</li>
        <li><b>voice key.</b> open <a className="underline" href="https://elevenlabs.io/app/settings/api-keys" target="_blank" rel="noreferrer">API Keys at elevenlabs.io</a> (under Developers, or your profile), and create a key. paste it into "voice service key".</li>
        <li><b>phone.</b> open an account at <a className="underline" href="https://www.twilio.com/try-twilio" target="_blank" rel="noreferrer">twilio.com</a> and upgrade it by adding credit ($20 is the usual minimum); a trial account can only ring your own phone. under <a className="underline" href="https://console.twilio.com/us1/develop/phone-numbers/manage/search" target="_blank" rel="noreferrer">Phone Numbers</a>, buy one local number with Voice.</li>
        <li><b>phone keys.</b> on the <a className="underline" href="https://console.twilio.com/" target="_blank" rel="noreferrer">Twilio console</a>'s first page, copy Account SID into "phone account id" and Auth Token into "phone account token". put the number you bought into "your number there", like +17325550100.</li>
        <li><b>save, then switch calls on.</b> nothing else to set up: the panel creates the assistant and attaches the number in your voice account on the first call. calls go out on weekdays, 10 to 12 and 2 to 4, one per place, a dozen a day at most. each conversation is filed beside its application and an agreed time is emailed to you with a calendar entry.</li>
        <li><b>to stop,</b> switch calls off, or press disconnect to remove your keys. both services bill you directly and can be cancelled there at any time.</li>
      </ol>
      <div className={connected ? "text-success" : "text-muted-foreground"}>{connected ? `● connected, calling from ${q.data?.ok ? q.data.number : ""}` : "○ not connected"}</div>
      <div className="grid gap-2 sm:grid-cols-2">
        {box("voice_key", "voice service key", q.data?.ok === true && q.data.voice)}
        {box("voice_id", "your cloned voice's id", q.data?.ok === true && q.data.voiceId)}
        {box("phone_sid", "phone account id", q.data?.ok === true && q.data.phone)}
        {box("phone_token", "phone account token", q.data?.ok === true && q.data.phone)}
        {box("phone_number", "your number there", q.data?.ok === true && Boolean(q.data.number))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Btn variant="primary" onClick={async () => {
          setErr(null); setMsg(null);
          const r = await save({ data: keys });
          if (!r.ok) return setErr(r.message);
          setKeys({ voice_key: "", voice_id: "", phone_sid: "", phone_token: "", phone_number: "" });
          setMsg(r.saved ? "saved" : "nothing to save");
          void q.refetch();
        }}>save keys</Btn>
        <Btn variant="danger" onClick={async () => { setErr(null); const r = await clear(); if (!r.ok) setErr(r.message); else { setMsg("disconnected"); setOn(false); void rule({ calls_enabled: false }); void q.refetch(); } }}>disconnect</Btn>
        {msg ? <span className="self-center text-muted-foreground">{msg}</span> : null}
      </div>

      <label className="flex items-center gap-2">
        <input type="checkbox" checked={on} disabled={!connected} onChange={(e) => { setOn(e.target.checked); void rule({ calls_enabled: e.target.checked }); }} />
        call after applying{!connected ? " (connect your accounts first)" : ""}
      </label>
      <label className="flex items-center gap-2">
        only when the match is at least
        <select className="border border-border bg-background px-1 py-0.5" value={min} onChange={(e) => { const v = Number(e.target.value); setMin(v); void rule({ calls_min_score: v }); }}>
          {[5, 6, 7, 8, 9].map((n) => <option key={n} value={n}>{n * 10}%</option>)}
        </select>
      </label>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={targets} onChange={(e) => { setTargets(e.target.checked); void rule({ calls_targets_only: e.target.checked }); }} />
        only for my target titles
      </label>
      <p className="text-muted-foreground">calls are made on weekdays between 10 and 12 or 2 and 4, to the location's own published number, once per application. every call is kept as a transcript beside the job.</p>
      {err ? <ErrorLine error={err} /> : null}
    </div>
  );
}
