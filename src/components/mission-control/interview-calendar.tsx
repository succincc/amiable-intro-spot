import { useMemo, useState } from "react";

import { supabase } from "@/integrations/supabase/client";
import { cleanHolds, cleanSlots, clock, KINDS, KIND_LABEL, weekdaysOfMonth, type Hold, type Kind, type Slot } from "@/lib/availability";

// The month, with the days the owner is free for interviews marked on it.
//
// Tap a day, give it a from and a to, tick what it is good for — in person,
// phone, virtual, any mix — and add it. A day can carry several windows.
// Replies to interview requests offer times only from inside these windows,
// only for the kind of interview asked for, and never the same hour to two
// employers; anything already offered shows on its day.

const pad = (n: number) => String(n).padStart(2, "0");
const dayKey = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function InterviewCalendar({ initialSlots, initialHolds, zone }: { initialSlots: unknown; initialHolds: unknown; zone: string }) {
  const today = new Date();
  const todayKey = dayKey(today.getFullYear(), today.getMonth() + 1, today.getDate());
  const [slots, setSlots] = useState<Slot[]>(() => cleanSlots(initialSlots));
  const holds = useMemo<Hold[]>(() => cleanHolds(initialHolds, new Date()), [initialHolds]);
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth() + 1);
  const [picked, setPicked] = useState<string>(todayKey);
  const [from, setFrom] = useState("09:00");
  const [to, setTo] = useState("17:00");
  const [kinds, setKinds] = useState<Kind[]>(["phone", "virtual"]);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const byDay = useMemo(() => {
    const m = new Map<string, Slot[]>();
    for (const s of slots) m.set(s.day, [...(m.get(s.day) ?? []), s]);
    return m;
  }, [slots]);
  const holdsByDay = useMemo(() => {
    const m = new Map<string, Hold[]>();
    const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
    for (const h of holds) {
      const k = fmt.format(new Date(h.start));
      m.set(k, [...(m.get(k) ?? []), h]);
    }
    return m;
  }, [holds, zone]);

  async function save(next: Slot[], said: string) {
    const clean = cleanSlots(next);
    const before = slots;
    setSlots(clean);
    setErr(null);
    setNote(null);
    const { error } = await supabase.from("profile").update({ availability_slots: clean }).eq("id", 1);
    if (error) {
      setSlots(before);
      setErr(error.message);
    } else setNote(said);
  }

  function windowFor(day: string): Slot | string {
    const f = toMinutes(from);
    const t = toMinutes(to);
    if (!kinds.length) return "tick at least one kind of interview.";
    if (t - f < 30) return "the end has to be at least half an hour after the start.";
    if (day < todayKey) return "that day has passed.";
    return { day, from: f, to: t, kinds };
  }

  function addTo(days: string[], said: string) {
    const made: Slot[] = [];
    for (const d of days) {
      const w = windowFor(d);
      if (typeof w === "string") {
        if (days.length === 1) { setErr(w); setNote(null); return; }
        continue;
      }
      made.push(w);
    }
    if (!made.length) { setErr("nothing to add: those days have passed."); return; }
    void save([...slots, ...made], said.replace("{n}", String(made.length)));
  }

  const first = new Date(year, month - 1, 1).getDay();
  const count = new Date(year, month, 0).getDate();
  const cells: Array<number | null> = [...Array(first).fill(null), ...Array.from({ length: count }, (_, i) => i + 1)];
  const step = (by: number) => {
    const d = new Date(year, month - 1 + by, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth() + 1);
  };
  const pickedSlots = byDay.get(picked) ?? [];
  const pickedHolds = holdsByDay.get(picked) ?? [];

  return (
    <div className="space-y-2 border border-border p-2">
      <div className="flex items-center justify-between text-xs">
        <button type="button" className="border border-border px-2 py-1" onClick={() => step(-1)} aria-label="previous month">‹</button>
        <span>{MONTHS[month - 1]} {year}</span>
        <button type="button" className="border border-border px-2 py-1" onClick={() => step(1)} aria-label="next month">›</button>
      </div>
      <div className="grid grid-cols-7 gap-px text-center text-[10px] text-muted-foreground">
        {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => <div key={i}>{d}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-px">
        {cells.map((d, i) => {
          if (d === null) return <div key={`b${i}`} />;
          const k = dayKey(year, month, d);
          const has = (byDay.get(k) ?? []).length;
          const held = (holdsByDay.get(k) ?? []).length;
          const past = k < todayKey;
          return (
            <button
              key={k}
              type="button"
              onClick={() => { setPicked(k); setErr(null); setNote(null); }}
              className={`aspect-square border text-xs ${picked === k ? "border-primary text-primary" : "border-border"} ${has ? "bg-primary/15" : ""} ${past ? "opacity-40" : ""}`}
            >
              <div>{d}</div>
              <div className="text-[9px] leading-none text-muted-foreground">{has ? `${has} open` : ""}{held ? ` · ${held} held` : ""}</div>
            </button>
          );
        })}
      </div>

      <div className="space-y-2 border-t border-border pt-2 text-xs">
        <div>{picked}{picked === todayKey ? " (today)" : ""}</div>
        {pickedSlots.length ? (
          <ul className="space-y-1">
            {pickedSlots.map((s, i) => (
              <li key={`${s.from}-${s.to}-${i}`} className="flex items-center justify-between gap-2">
                <span>{clock(s.from)} – {clock(s.to)} · {s.kinds.map((k) => KIND_LABEL[k]).join(", ")}</span>
                <button type="button" className="border border-border px-2 py-0.5 text-muted-foreground" onClick={() => void save(slots.filter((x) => x !== s), "removed.")}>remove</button>
              </li>
            ))}
          </ul>
        ) : <div className="text-muted-foreground">nothing marked on this day.</div>}
        {pickedHolds.length ? (
          <ul className="space-y-0.5 text-muted-foreground">
            {pickedHolds.map((h, i) => (
              <li key={i}>
                {h.state === "booked" ? "booked" : "offered to an employer"}: {new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit" }).format(new Date(h.start))}
                {h.kind ? ` · ${KIND_LABEL[h.kind]}` : ""}
              </li>
            ))}
          </ul>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1">from <input type="time" step={1800} className="border border-border bg-background px-1 py-0.5" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="flex items-center gap-1">to <input type="time" step={1800} className="border border-border bg-background px-1 py-0.5" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        </div>
        <div className="flex flex-wrap gap-3">
          {KINDS.map((k) => (
            <label key={k} className="flex items-center gap-1">
              <input type="checkbox" checked={kinds.includes(k)} onChange={(e) => setKinds(e.target.checked ? [...kinds, k] : kinds.filter((x) => x !== k))} />
              {KIND_LABEL[k]}
            </label>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="border border-primary px-2 py-1 text-primary" onClick={() => addTo([picked], "added.")}>add to this day</button>
          <button type="button" className="border border-border px-2 py-1" onClick={() => addTo(weekdaysOfMonth(year, month).filter((d) => d >= todayKey), "added to {n} weekday(s).")}>add to every weekday left this month</button>
          {slots.some((s) => s.day.startsWith(`${year}-${pad(month)}-`)) ? (
            <button type="button" className="border border-border px-2 py-1 text-muted-foreground" onClick={() => { if (confirm(`Clear every window in ${MONTHS[month - 1]}?`)) void save(slots.filter((s) => !s.day.startsWith(`${year}-${pad(month)}-`)), "month cleared."); }}>clear this month</button>
          ) : null}
        </div>
        {err ? <div className="text-destructive">{err}</div> : null}
        {note ? <div className="text-success">{note}</div> : null}
        <p className="text-muted-foreground">times are in {zone}. replies to interview requests offer hour-long times from inside these windows only, for the kind of interview asked for, and never the same hour to two employers. a window can be good for several kinds at once. with nothing marked, the sentence below is used.</p>
      </div>
    </div>
  );
}
