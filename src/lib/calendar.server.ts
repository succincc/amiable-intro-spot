/* eslint-disable @typescript-eslint/no-explicit-any */
// ============================================================================
// calendar.server.ts — the times the owner is actually free.
//
// A reply to an interview request is better for naming times: "Tuesday at 10
// or Wednesday at 2" gets an answer in one message, where "I am flexible"
// starts a week of back and forth. To name times honestly the reply has to
// know which ones are already taken.
//
// This asks Google for one thing only — when the owner's calendar is busy —
// under the narrowest permission Google offers for it (calendar.freebusy).
// It cannot see what any event is, who it is with or where; it cannot create,
// change or delete anything. It gets back a list of start and end times.
//
// Everything here is optional. No permission, no calendar, a request that
// fails: the reply falls back to the availability written in settings, and
// then to "send me what works for you". Nothing waits on this.
// ============================================================================

import { getAccessToken } from "@/lib/google.server";

export type Busy = { start: string; end: string };

/** When the calendar is busy between two instants, or null if it cannot be read. */
export async function busyBetween(supabase: any, from: Date, to: Date): Promise<Busy[] | null> {
  const token = await getAccessToken(supabase);
  if (!token) return null;
  try {
    const res = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ timeMin: from.toISOString(), timeMax: to.toISOString(), items: [{ id: "primary" }] }),
    });
    // 403 is the ordinary case: the mailbox was connected before this
    // permission existed, or the owner chose not to grant it.
    if (!res.ok) return null;
    const j: any = await res.json();
    const busy = j?.calendars?.primary?.busy;
    return Array.isArray(busy) ? busy.filter((b: any) => b?.start && b?.end) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Wall-clock time in a named zone, without a date library
// ---------------------------------------------------------------------------

/** The wall-clock parts of an instant, as seen in a time zone. */
function partsIn(zone: string, at: Date) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    hour12: false,
  });
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(at)) p[part.type] = part.value;
  return {
    y: Number(p["year"]),
    m: Number(p["month"]),
    d: Number(p["day"]),
    h: Number(p["hour"]) % 24,
    min: Number(p["minute"]),
    weekday: p["weekday"] ?? "",
  };
}

/** The instant at which a zone's clock reads the given date and hour. */
function instantOf(zone: string, y: number, m: number, d: number, h: number, min = 0): Date {
  // Start from the same numbers read as UTC, then correct by however far the
  // zone's clock is from that — twice, so a daylight-saving boundary between
  // the guess and the answer does not leave it an hour out.
  let t = Date.UTC(y, m - 1, d, h, min);
  for (let i = 0; i < 2; i++) {
    const p = partsIn(zone, new Date(t));
    const shown = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
    t += Date.UTC(y, m - 1, d, h, min) - shown;
  }
  return new Date(t);
}

/**
 * The hours of the day the owner will take an interview, read from what they
 * wrote in settings: "weekdays between 9am and 5pm", "10 to 4", "after 1pm".
 * Nine to five where it says nothing that can be read.
 */
export function hoursFrom(text: string | null | undefined): { from: number; to: number; weekends: boolean } {
  const t = String(text ?? "").toLowerCase();
  const weekends = /\b(weekend|saturday|sunday|any day|seven days|7 days)\b/.test(t) && !/\bno weekends?\b|except weekends?/.test(t);
  const times = [...t.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/g)].map((m) => {
    let h = Number(m[1]) % 12;
    if (/^p/.test(m[3] ?? "")) h += 12;
    return h + (m[2] ? Number(m[2]) / 60 : 0);
  });
  let from = 9;
  let to = 17;
  if (times.length >= 2) {
    from = Math.min(times[0]!, times[1]!);
    to = Math.max(times[0]!, times[1]!);
  } else if (times.length === 1) {
    if (/\b(after|from|starting)\b/.test(t)) from = times[0]!;
    else if (/\b(before|until|till|by)\b/.test(t)) to = times[0]!;
  }
  // Nothing before seven or after eight, whatever was typed: "12am" for noon
  // is an easy slip and a 3am interview is not an offer anyone meant.
  from = Math.max(7, Math.min(from, 18));
  to = Math.max(from + 1, Math.min(to, 20));
  return { from, to, weekends };
}

/**
 * Up to `want` hour-long openings over the coming days: one in the morning
 * and one in the afternoon of each day, clear of everything on the calendar
 * with a quarter of an hour either side, and never sooner than a full day
 * from now.
 */
export function openSlots(
  busy: Busy[],
  opts: { now: Date; zone: string; from: number; to: number; weekends: boolean; want?: number; days?: number },
): Date[] {
  const { now, zone, from, to, weekends } = opts;
  const want = opts.want ?? 4;
  const days = opts.days ?? 7;
  const pad = 15 * 60_000;
  const taken = busy
    .map((b) => [new Date(b.start).getTime() - pad, new Date(b.end).getTime() + pad] as const)
    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e));
  const free = (start: Date) => {
    const s = start.getTime();
    const e = s + 60 * 60_000;
    return !taken.some(([bs, be]) => s < be && e > bs);
  };
  const earliest = now.getTime() + 24 * 60 * 60_000;

  const out: Date[] = [];
  for (let offset = 1; offset <= days + 4 && out.length < want; offset++) {
    const day = partsIn(zone, new Date(now.getTime() + offset * 24 * 60 * 60_000));
    if (!weekends && (day.weekday === "Sat" || day.weekday === "Sun")) continue;
    // The first free hour of the morning, and the first of the afternoon.
    // Ten and two are the hours people expect to be offered; earlier or
    // later only where the owner's own hours leave no room for them.
    const noon = Math.min(to, 12);
    const morning = Math.max(from, 10) + 1 <= noon ? Math.max(from, 10) : from;
    const afternoon = Math.max(from, 14) + 1 <= to ? Math.max(from, 14) : Math.max(from, 13);
    const halves: Array<[number, number]> = [
      [morning, noon],
      [afternoon, to],
    ];
    for (const [a, b] of halves) {
      for (let h = Math.ceil(a); h + 1 <= b; h++) {
        const at = instantOf(zone, day.y, day.m, day.d, h);
        if (at.getTime() < earliest) continue;
        if (!free(at)) continue;
        out.push(at);
        break;
      }
      if (out.length >= want) break;
    }
  }
  return out;
}

/** "Tuesday, December 1 at 10:00 AM or 2:00 PM; Wednesday, December 2 at 10:00 AM (Eastern time)" */
export function sayTimes(slots: Date[], zone: string): string {
  if (!slots.length) return "";
  const dayOf = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "long", month: "long", day: "numeric" });
  const timeOf = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit" });
  const zoneName =
    new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longGeneric" })
      .formatToParts(slots[0]!)
      .find((p) => p.type === "timeZoneName")?.value ?? zone;
  const byDay = new Map<string, string[]>();
  for (const s of slots) {
    const d = dayOf.format(s);
    byDay.set(d, [...(byDay.get(d) ?? []), timeOf.format(s)]);
  }
  const days = [...byDay.entries()].map(([d, times]) => `${d} at ${times.join(" or ")}`);
  return `${days.join("; ")} (${zoneName})`;
}

/**
 * Specific free times to offer, as one sentence fragment, or null when the
 * calendar cannot be read or shows nothing open — in which case the caller
 * says what the owner wrote in settings instead.
 */
export async function timesToOffer(
  supabase: any,
  profile: { availability?: string | null; timezone?: string | null },
  now = new Date(),
): Promise<string | null> {
  const zone = String(profile.timezone ?? "").trim() || "America/New_York";
  const busy = await busyBetween(supabase, now, new Date(now.getTime() + 12 * 24 * 60 * 60_000));
  if (!busy) return null;
  const hours = hoursFrom(profile.availability);
  const slots = openSlots(busy, { now, zone, ...hours });
  // Two or more, or it is not a choice.
  return slots.length >= 2 ? sayTimes(slots, zone) : null;
}
