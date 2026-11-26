// ============================================================================
// availability.ts — the times the owner has marked as free for interviews,
// and which of them may be offered to an employer.
//
// The owner marks windows on a calendar: a day, a from and a to, and which
// kinds of interview each window is good for — in person, by phone, on video.
// A window may be good for several kinds at once. What is offered out of
// those windows has three rules, and they are the whole of this file:
//
//   1. Only a time inside a window marked for that kind of interview.
//   2. Never a time that is busy on the calendar, or within a quarter of an
//      hour of something that is.
//   3. Never a time already offered to, or booked with, someone else. Two
//      employers are never given the same hour, whatever kind each is.
//
// Pure functions, so every rule has a test and none needs a mailbox.
// ============================================================================

export type Kind = "in_person" | "phone" | "virtual";
export const KINDS: Kind[] = ["in_person", "phone", "virtual"];
export const KIND_LABEL: Record<Kind, string> = { in_person: "in person", phone: "phone", virtual: "virtual" };

/** One marked window: a day, minutes from midnight, and what it is good for. */
export type Slot = { day: string; from: number; to: number; kinds: Kind[] };
/** A time held for someone: offered and not yet answered, or booked. */
export type Hold = { start: string; end: string; kind: Kind | null; ref: string; state: "offered" | "booked" };
export type Busy = { start: string; end: string };

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Whatever was stored, as windows that can be relied on: well formed, in order, no duplicates. */
export function cleanSlots(raw: unknown): Slot[] {
  if (!Array.isArray(raw)) return [];
  const out: Slot[] = [];
  const seen = new Set<string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const r of raw as any[]) {
    const day = String(r?.day ?? "");
    const from = Math.round(Number(r?.from));
    const to = Math.round(Number(r?.to));
    const kinds = (Array.isArray(r?.kinds) ? (r.kinds as unknown[]) : []).filter((k: unknown): k is Kind => KINDS.includes(k as Kind));
    if (!DAY_RE.test(day) || !Number.isFinite(from) || !Number.isFinite(to)) continue;
    if (from < 0 || to > 24 * 60 || to - from < 30 || !kinds.length) continue;
    const key = `${day}|${from}|${to}|${[...new Set(kinds)].sort().join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ day, from, to, kinds: [...new Set(kinds)] });
  }
  return out.sort((a, b) => a.day.localeCompare(b.day) || a.from - b.from);
}

export function cleanHolds(raw: unknown, now: Date): Hold[] {
  if (!Array.isArray(raw)) return [];
  const out: Hold[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const r of raw as any[]) {
    const start = new Date(String(r?.start ?? ""));
    const end = new Date(String(r?.end ?? ""));
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) continue;
    // A time that has passed holds nothing.
    if (end.getTime() < now.getTime()) continue;
    const kind = KINDS.includes(r?.kind as Kind) ? (r.kind as Kind) : null;
    out.push({ start: start.toISOString(), end: end.toISOString(), kind, ref: String(r?.ref ?? ""), state: r?.state === "booked" ? "booked" : "offered" });
  }
  return out;
}

/**
 * Which kind of interview an email is asking for, where it says.
 * Null when it does not: any window will do then.
 */
export function kindOf(text: string | null | undefined): Kind | null {
  const t = String(text ?? "").toLowerCase();
  if (/\b(on[- ]?site|in[- ]person|face[- ]to[- ]face|come in(to)?\b|at our (office|store|location|facility)|visit (us|our))/.test(t)) return "in_person";
  if (/\b(zoom|teams meeting|microsoft teams|google meet|webex|video (call|interview|chat|conference)|virtual (interview|meeting|call)|hirevue)\b/.test(t)) return "virtual";
  if (/\b(phone (call|screen|interview|conversation)|call you|give you a call|by phone|telephone|quick call|brief call|\d{1,2}[- ]minute call)\b/.test(t)) return "phone";
  return null;
}

/** The wall-clock date and minutes of an instant, in a time zone. */
function wallClock(zone: string, at: Date): { day: string; minutes: number } {
  const p: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(at)) p[part.type] = part.value;
  return { day: `${p["year"]}-${p["month"]}-${p["day"]}`, minutes: (Number(p["hour"]) % 24) * 60 + Number(p["minute"]) };
}

/** The instant at which a zone's clock reads the given day and minutes. */
export function instantAt(zone: string, day: string, minutes: number): Date {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const want = Date.UTC(y, m - 1, d, 0, minutes);
  let t = want;
  for (let i = 0; i < 3; i++) {
    const w = wallClock(zone, new Date(t));
    const [wy, wm, wd] = w.day.split("-").map(Number) as [number, number, number];
    t += want - Date.UTC(wy, wm - 1, wd, 0, w.minutes);
  }
  return new Date(t);
}

const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number) => aStart < bEnd && aEnd > bStart;

/**
 * The times to offer one employer: hour-long, inside the owner's windows for
 * that kind, clear of the calendar and of everything held for anyone else.
 * At most two a day, so the choice is spread over days rather than one
 * afternoon, and none sooner than `noticeHours` from now.
 */
export function offerable(
  slotsRaw: Slot[],
  busy: Busy[],
  holds: Hold[],
  opts: { now: Date; zone: string; kind: Kind | null; want?: number; noticeHours?: number; minutes?: number },
): Array<{ start: Date; end: Date; kind: Kind }> {
  const want = opts.want ?? 4;
  const length = (opts.minutes ?? 60) * 60_000;
  const earliest = opts.now.getTime() + (opts.noticeHours ?? 18) * 3_600_000;
  const pad = 15 * 60_000;
  const taken: Array<[number, number]> = [
    ...busy.map((b) => [new Date(b.start).getTime() - pad, new Date(b.end).getTime() + pad] as [number, number]),
    ...holds.map((h) => [new Date(h.start).getTime() - pad, new Date(h.end).getTime() + pad] as [number, number]),
  ].filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e));

  const out: Array<{ start: Date; end: Date; kind: Kind }> = [];
  const perDay = new Map<string, number>();
  for (const slot of cleanSlots(slotsRaw)) {
    if (opts.kind && !slot.kinds.includes(opts.kind)) continue;
    const kind: Kind = opts.kind ?? slot.kinds[0]!;
    // On the hour and the half hour, as a person would say a time.
    for (let m = Math.ceil(slot.from / 30) * 30; m + (opts.minutes ?? 60) <= slot.to; m += 30) {
      if ((perDay.get(slot.day) ?? 0) >= 2) break;
      const start = instantAt(opts.zone, slot.day, m);
      const s = start.getTime();
      const e = s + length;
      if (s < earliest) continue;
      if (taken.some(([bs, be]) => overlaps(s, e, bs, be))) continue;
      // Not two of this employer's own choices back to back either: the
      // second is taken from at least two hours on.
      if (out.some((o) => o.start.getTime() <= s && s < o.end.getTime() + 60 * 60_000 && wallClock(opts.zone, o.start).day === slot.day)) continue;
      out.push({ start, end: new Date(e), kind });
      perDay.set(slot.day, (perDay.get(slot.day) ?? 0) + 1);
      if (out.length >= want) return out;
    }
  }
  return out;
}

/** The holds to keep once new times have been offered to `ref`: what was held, less anything stale for the same ref, plus these. */
export function withOffers(holds: Hold[], ref: string, offers: Array<{ start: Date; end: Date; kind: Kind }>, now: Date): Hold[] {
  const kept = cleanHolds(holds, now).filter((h) => !(h.ref === ref && h.state === "offered"));
  return [...kept, ...offers.map((o) => ({ start: o.start.toISOString(), end: o.end.toISOString(), kind: o.kind, ref, state: "offered" as const }))].slice(-200);
}

/** A window laid over every weekday of a month, for marking a month in one go. */
export function weekdaysOfMonth(year: number, month: number): string[] {
  const out: string[] = [];
  for (let d = 1; d <= 31; d++) {
    const dt = new Date(Date.UTC(year, month - 1, d));
    if (dt.getUTCMonth() !== month - 1) break;
    const wd = dt.getUTCDay();
    if (wd >= 1 && wd <= 5) out.push(`${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
  }
  return out;
}

export const clock = (minutes: number) => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};
