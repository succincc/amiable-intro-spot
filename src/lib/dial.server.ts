// ============================================================================
// dial.server.ts — places the calls and reads them back.
//
// Through the user's own voice and phone accounts, with the keys they saved
// in Settings; those services bill the user directly. Nothing here runs
// unless the user has connected both and switched calls on.
//
// Each pass does two things: reads back the calls already made (the whole
// conversation is filed beside the application, and an agreed time is sent
// to the owner as a calendar entry), then places the few that are due.
// One call per application, one per phone number in a fortnight, a handful
// a day, and only in the hours a store would take a call.
// ============================================================================

import { BRIEF, FIRST_MESSAGE, callFacts, dueToCall, e164, readCall } from "@/lib/dial";
import { icsFor, googleCalendarLink, sayWhen } from "@/lib/moments";

const API = "https://api.elevenlabs.io/v1/convai";
/** No more than this many calls placed in one pass, or in one day. */
const PER_PASS = 3;
const PER_DAY = 12;
const DAY = 86_400_000;

type Keys = { voice_key?: string | null; voice_id?: string | null; phone_sid?: string | null; phone_token?: string | null; phone_number?: string | null; agent_id?: string | null; phone_id?: string | null };

async function voice(key: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${API}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* an answer with no body is still an answer */
  }
  return { status: res.status, json };
}

/**
 * The assistant and the number, set up once in the user's voice account and
 * remembered. The assistant is made with the standing brief and the fixed
 * opening; a call can fill in its facts and change nothing else.
 */
async function ensureLine(supabase: any, keys: Keys): Promise<{ agent: string; phone: string } | { error: string }> {
  const key = String(keys.voice_key);
  let agent = keys.agent_id ?? null;
  let phone = keys.phone_id ?? null;
  if (!agent) {
    const r = await voice(key, "/agents/create", {
      name: "ApplyPilot caller",
      conversation_config: {
        agent: { first_message: FIRST_MESSAGE, language: "en", prompt: { prompt: BRIEF } },
        tts: { voice_id: keys.voice_id },
        conversation: { max_duration_seconds: 240 },
      },
    });
    agent = typeof r.json?.agent_id === "string" ? r.json.agent_id : null;
    if (!agent) return { error: `the voice service would not set up the assistant (${r.status})` };
    await supabase.from("call_keys").update({ agent_id: agent }).eq("id", 1);
  }
  if (!phone) {
    const r = await voice(key, "/phone-numbers", {
      provider: "twilio",
      label: "ApplyPilot",
      phone_number: e164(keys.phone_number) ?? String(keys.phone_number ?? "").trim(),
      sid: keys.phone_sid,
      token: keys.phone_token,
      agent_id: agent,
      enable_sms: false,
    });
    phone = typeof r.json?.phone_number_id === "string" ? r.json.phone_number_id : null;
    if (!phone) return { error: `the voice service would not take the phone number (${r.status})` };
    await supabase.from("call_keys").update({ phone_id: phone }).eq("id", 1);
  }
  return { agent, phone };
}

export async function runCalls(supabase: any, now = new Date()): Promise<{ state: string; placed: number; read: number; booked: number }> {
  const out = { state: "off", placed: 0, read: 0, booked: 0 };
  const { data: profile } = await supabase.from("profile").select("*").eq("id", 1).maybeSingle();
  const { data: keys } = await supabase.from("call_keys").select("*").eq("id", 1).maybeSingle();
  if (!profile || !keys?.voice_key) return out;
  const zone = String(profile.timezone ?? "").trim() || "America/New_York";
  const key = String(keys.voice_key);

  // 1. What came of the calls already made. Read whether or not calls are
  //    still switched on: a call that was placed is always filed.
  const { data: open } = await supabase.from("jobs").select("id, title, company, location, call_ref, call_at").eq("call_state", "calling").limit(12);
  for (const j of open ?? []) {
    const age = now.getTime() - new Date(j.call_at ?? 0).getTime();
    const r = j.call_ref ? await voice(key, `/conversations/${encodeURIComponent(j.call_ref)}`) : { status: 0, json: null };
    const got = readCall(r.json, zone, now);
    if (!got.finished) {
      // A call is minutes long. One with no ending after two hours has none.
      if (age > 2 * 3_600_000) await supabase.from("jobs").update({ call_state: "no_answer", call_note: "AI CALL\nNo record of the call came back." }).eq("id", j.id);
      continue;
    }
    out.read++;
    await supabase.from("jobs").update({ call_state: got.state, call_note: `AI CALL\n${got.text}`.slice(0, 6500) }).eq("id", j.id);
    if (!got.when) continue;
    // A time was agreed: the owner is told at once, with the calendar entry.
    try {
      const { sendWithAttachment, ownAddress } = await import("@/lib/gmail.server");
      const to = await ownAddress(supabase);
      if (!to) continue;
      const event = { start: got.when, end: new Date(got.when.getTime() + 3_600_000), title: `Interview: ${j.company ?? "employer"} - ${j.title ?? "job"}`, where: j.location ?? null, notes: "Agreed on a phone call made for you. Confirm it with the employer." };
      const sent = await sendWithAttachment(supabase, {
        to,
        subject: `ApplyPilot: a time was agreed on the phone - ${j.company ?? "an employer"}, ${sayWhen(got.when, zone)}`,
        body: [`On a call about your application for ${j.title ?? "a job"} at ${j.company ?? "an employer"}, this time was agreed: ${sayWhen(got.when, zone)}.`, "", "The assistant heard it on a phone line, so check it against the conversation below and confirm with the employer.", "", `Add to Google Calendar: ${googleCalendarLink(event)}`, "", got.text].join("\n"),
        attachment: { filename: "interview.ics", mime: "text/calendar; charset=UTF-8; method=PUBLISH", base64: Buffer.from(icsFor({ uid: `call-${j.id}@applypilot`, ...event, now }), "utf8").toString("base64") },
      });
      if (sent.ok) out.booked++;
    } catch {
      /* the record is filed either way */
    }
  }

  // 2. The calls that are due.
  if (profile.calls_enabled !== true) return { ...out, state: "off" };
  if (!keys.voice_id || !keys.phone_sid || !keys.phone_token || !keys.phone_number) return { ...out, state: "not connected" };
  const { data: rows } = await supabase
    .from("jobs")
    .select("id, title, company, location, description, phone, call_state, score, status, applied_at")
    .eq("status", "applied")
    .is("call_state", null)
    .not("phone", "is", null)
    .gte("applied_at", new Date(now.getTime() - 14 * DAY).toISOString())
    .order("score", { ascending: false })
    .limit(40);
  const due = (rows ?? []).filter((j: any) => dueToCall(j, profile, now, zone));
  if (!due.length) return { ...out, state: "nothing due" };

  // A place is phoned once, however many of its postings were applied to.
  const { data: recent } = await supabase.from("jobs").select("phone, call_at").not("call_state", "is", null).gte("call_at", new Date(now.getTime() - 14 * DAY).toISOString()).limit(400);
  const rung = new Set<string>((recent ?? []).map((r: any) => e164(r.phone)).filter(Boolean) as string[]);
  const today = (recent ?? []).filter((r: any) => now.getTime() - new Date(r.call_at ?? 0).getTime() < DAY).length;
  let left = Math.min(PER_PASS, PER_DAY - today);
  if (left <= 0) return { ...out, state: "today's calls are made" };

  const line = await ensureLine(supabase, keys);
  if ("error" in line) return { ...out, state: line.error };

  let openTimes: string | null = null;
  try {
    const { cleanSlots, cleanHolds, offerable } = await import("@/lib/availability");
    const times = offerable(cleanSlots(profile.availability_slots), [], cleanHolds(profile.interview_holds, now), { now, zone, kind: "in_person", want: 3 });
    openTimes = times.length ? times.map((t) => sayWhen(t.start, zone)).join("; ") : null;
  } catch {
    openTimes = null;
  }

  for (const j of due) {
    if (left <= 0) break;
    const to = e164(j.phone)!;
    if (rung.has(to)) {
      await supabase.from("jobs").update({ call_state: "skip", call_note: "This place was already phoned about another application.", call_at: now.toISOString() }).eq("id", j.id);
      continue;
    }
    const r = await voice(key, "/twilio/outbound-call", {
      agent_id: line.agent,
      agent_phone_number_id: line.phone,
      to_number: to,
      conversation_initiation_client_data: { dynamic_variables: callFacts(j, profile, openTimes) },
    });
    if (r.status !== 200 || r.json?.success === false || !r.json?.conversation_id) {
      // The accounts are the user's; a refusal there stops the pass and
      // leaves the application as it was, to be tried again.
      return { ...out, state: `the call could not be placed (${r.status})` };
    }
    rung.add(to);
    left--;
    out.placed++;
    await supabase.from("jobs").update({ call_state: "calling", call_ref: String(r.json.conversation_id), call_at: now.toISOString() }).eq("id", j.id);
  }
  return { ...out, state: "done" };
}
