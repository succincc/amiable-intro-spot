/* eslint-disable @typescript-eslint/no-explicit-any */
// ============================================================================
// gmail.server.ts — reading and sending, once OAuth has a token.
//
// Everything that decides what a message MEANS already exists in
// classify.server.ts and email.server.ts, built for the Apps Script bridge.
// This only changes where the messages come from, so the rules, the job
// matching and the reply drafting are reused rather than rewritten.
// ============================================================================

import { getAccessToken } from "@/lib/google.server";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

async function gmail(token: string, path: string, init?: RequestInit) {
  // A fetch with no timeout can hang forever, and because the panel's button
  // waits on the whole sync, one stalled request leaves it reading "syncing…"
  // with no error and no end. Fifteen seconds is far longer than Gmail needs
  // and far shorter than a user will stare at a spinner.
  const res = await fetch(`${API}${path}`, {
    ...init,
    signal: AbortSignal.timeout(15_000),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(`Gmail HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

/** Gmail returns bodies base64url-encoded, and often nested several parts deep. */
function decodeBody(data?: string): string {
  if (!data) return "";
  try {
    return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch {
    return "";
  }
}

/**
 * The plain-text body of a message.
 *
 * Prefers text/plain and falls back to stripping the HTML, because a good
 * number of ATS send HTML only — and the classifier reads words, so an
 * unstripped body of markup would match nothing.
 */
function extractText(payload: any): string {
  if (!payload) return "";
  const walk = (part: any, want: string): string => {
    if (!part) return "";
    if (part.mimeType === want && part.body?.data) return decodeBody(part.body.data);
    for (const child of part.parts ?? []) {
      const found = walk(child, want);
      if (found) return found;
    }
    return "";
  };

  const plain = walk(payload, "text/plain");
  if (plain.trim()) return plain;

  const html = walk(payload, "text/html");
  if (html.trim()) {
    return html
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
  return decodeBody(payload.body?.data);
}

function header(payload: any, name: string): string {
  const found = (payload?.headers ?? []).find(
    (h: any) => String(h.name).toLowerCase() === name.toLowerCase(),
  );
  return found?.value ?? "";
}

/** "Sarah Chen <sarah@target.com>" -> "sarah@target.com" */
export function parseAddress(raw: string): string {
  const match = String(raw ?? "").match(/<([^>]+)>/);
  return (match?.[1] ?? String(raw ?? "")).trim().toLowerCase();
}

export type FetchedMessage = {
  message_id: string;
  thread_id: string;
  from_addr: string;
  to_addr: string;
  subject: string;
  body: string;
  received_at: string;
};

/**
 * Recent inbox messages, in the shape ingestMessages() already expects.
 *
 * `query` is Gmail's own search syntax, which keeps the filtering on Google's
 * side: asking for the last two days costs one request instead of pulling a
 * mailbox and discarding most of it.
 */
export async function fetchMessages(
  supabase: any,
  query = "in:inbox newer_than:2d",
  max = 40,
): Promise<FetchedMessage[]> {
  const token = await getAccessToken(supabase);
  if (!token) return [];

  const list = await gmail(token, `/messages?q=${encodeURIComponent(query)}&maxResults=${max}`);
  const ids: string[] = (list.messages ?? []).map((m: any) => m.id);
  const out: FetchedMessage[] = [];

  // One request per message, so fifty messages read one at a time is fifty
  // round trips — slow enough on a phone to look broken. Ten at a time turns
  // that into five rounds, and allSettled keeps one unreadable message from
  // abandoning the sync.
  const BATCH = 10;
  for (let i = 0; i < ids.length; i += BATCH) {
    const settled = await Promise.allSettled(
      ids.slice(i, i + BATCH).map(async (id): Promise<FetchedMessage> => {
        const msg = await gmail(token, `/messages/${id}?format=full`);
        const payload = msg.payload;
        return {
          message_id: id,
          thread_id: msg.threadId,
          from_addr: parseAddress(header(payload, "From")),
          to_addr: parseAddress(header(payload, "To")),
          subject: header(payload, "Subject"),
          body: extractText(payload).slice(0, 20000),
          received_at: new Date(Number(msg.internalDate ?? Date.now())).toISOString(),
        };
      }),
    );
    for (const result of settled) {
      if (result.status === "fulfilled") out.push(result.value);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Verification codes
// ---------------------------------------------------------------------------

/**
 * Pull a one-time code out of an email body.
 *
 * Deliberately narrow. A recruiting inbox is full of numbers — salaries,
 * requisition ids, phone numbers, years — and typing a req number into a
 * verification box fails the signup silently. So a run of digits only counts
 * when the surrounding words say it is a code.
 */
export function extractCode(text: string): string | null {
  const body = String(text ?? "");

  const patterns: RegExp[] = [
    // The real Greenhouse message reads "Copy and paste this code into the
    // security code field on your application:" and then the digits. That
    // puts 29 characters between "security code" and the number — one short
    // of the 30 this allowed, so it passed by a single space. It is an HTML
    // email, and the whitespace left by converting one to text pushed the
    // same message to 31 and returned nothing. A limit that a real message
    // clears by one character is not a limit, it is a coincidence.
    // Oracle's reads "the one-time pass code: 478145".
    /\b(?:verification|security|confirmation|one[-\s]?time|access)\s+(?:pass\s*)?code[^0-9]{0,80}?(\d{4,8})\b/i,
    /\bpass\s*code[^0-9]{0,40}?(\d{4,8})\b/i,
    /\bcopy\s+and\s+paste\s+(?:this\s+)?code[^0-9]{0,80}?(\d{4,8})\b/i,
    /\bcode\s*(?:is|:)\s*(\d{4,8})\b/i,
    /\b(\d{4,8})\s+is\s+your\s+(?:verification|security|confirmation|one[-\s]?time)\s+code\b/i,
    /\benter\s+(?:the\s+|this\s+)?code[^0-9]{0,40}?(\d{4,8})\b/i,
    /\byour\s+code[^0-9]{0,40}?(\d{4,8})\b/i,
  ];

  for (const pattern of patterns) {
    const found = body.match(pattern);
    if (found?.[1]) return found[1];
  }
  return null;
}

/**
 * The most recent verification code sent by a portal.
 *
 * Scoped to the last fifteen minutes. A code from an hour ago has almost
 * certainly expired, and entering a stale one looks exactly like a wrong
 * password — the account gets locked rather than created.
 */
/** A company name reduced to what two spellings of it have in common. */
function companyKey(name?: string | null): string {
  return String(name ?? "")
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|limited|corp|corporation|co|plc|gmbh|holdings|group|the)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export async function findVerificationCode(
  supabase: any,
  portalHost: string,
  company?: string | null,
  // Only messages received after this moment, when the caller knows it.
  since?: number | null,
): Promise<string | null> {
  const brand = portalHost
    .replace(/^(www|careers?|jobs|apply|myworkdayjobs)\./, "")
    .split(".")
    .filter((p) => p.length > 3 && !/^(com|org|net|wd\d+)$/.test(p))[0];

  const query = `newer_than:1h (${brand ?? portalHost} OR verification OR code)`;
  // Six newest, not fifteen. Each one is a full read, the applier asks every
  // ten seconds while it waits, and four applications wait at once: Google
  // answered "quota exceeded" and a code that had arrived could not be read.
  const messages = await fetchMessages(supabase, query, 6);
  // The number in the message and the employer's name in it are both read
  // below — from the body as well as the subject. What neither can say is
  // WHICH application a code belongs to when one employer has sent several:
  // AutoZone's all read "Confirm Your Identity for AutoZone" with six digits.
  // The time can. A code that arrived before this application asked for one
  // is not its code.
  const cutoff = Math.max(Date.now() - 15 * 60_000, since ?? 0);

  const found: { code: string; text: string; at: number }[] = [];
  for (const message of messages) {
    const at = new Date(message.received_at).getTime();
    if (at < cutoff) continue;
    const text = `${message.subject}\n${message.body}`;
    const code = extractCode(text);
    if (code) found.push({ code, text, at });
  }
  if (!found.length) return null;

  // Which of these is for THIS employer?
  //
  // Four workers apply in parallel and every Greenhouse form is on
  // job-boards.greenhouse.io, so the host tells them apart not at all: the
  // brand works out to "job-boards" for all four. Taking the newest code in
  // the window therefore hands the worker applying to Block whichever code
  // arrived last, which may be Airbnb's. A wrong code is not a near miss —
  // it reads as a failed verification on an application that had already
  // gone through.
  //
  // The employer is in the subject: "Security code for your application to
  // Block". Match on that.
  const want = companyKey(company);
  if (want) {
    const mine = found.filter((f) => {
      const escaped = want.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`).test(companyKey(f.text));
    });
    const newest = mine.sort((a, b) => b.at - a.at)[0];
    if (newest) return newest.code;
  }

  // Nothing named this employer. One code in the window is unambiguous and
  // is almost certainly it. Several are not, and entering another
  // application's code is worse than entering none: this one can be finished
  // by hand, whereas a wrong code spends the attempt and tells the portal
  // the applicant failed verification.
  if (found.length === 1) return found[0]!.code;
  return null;
}

/**
 * The activation link a portal emails after registration.
 *
 * Workday does not send a code. It sends a URL — "Click this link to confirm
 * your email address and complete setup for your candidate account" — valid
 * for 24 hours. findVerificationCode looks for digits and would never have
 * found one, so a registration that worked still stopped here.
 *
 * Matched on the portal's own host rather than on wording, because the
 * sentence varies by employer and the host does not: a link to
 * comcast.wd115.myworkdayjobs.com in a message received minutes ago, for an
 * account just registered on that host, is the link.
 */
export async function findVerificationLink(
  supabase: any,
  portalHost: string,
  withinMinutes = 30,
  kind: "activate" | "reset" = "activate",
): Promise<string | null> {
  const host = String(portalHost ?? "").toLowerCase().replace(/^www\./, "");
  if (!host) return null;

  // The tenant, e.g. "comcast" from comcast.wd115.myworkdayjobs.com — the
  // mail can arrive from a different Workday host than the one registered on.
  const tenant = host.split(".")[0] ?? "";

  const messages = await fetchMessages(supabase, `newer_than:1h`, 8);
  const cutoff = Date.now() - withinMinutes * 60_000;

  for (const message of messages) {
    if (new Date(message.received_at).getTime() < cutoff) continue;
    const text = `${message.subject}\n${message.body}`;
    // Links in plain-text mail wrap across lines; join them back up before
    // matching or every URL is truncated at the first newline.
    const unwrapped = text.replace(/\r?\n(?=[^\s])/g, "");
    const urls = unwrapped.match(/https?:\/\/[^\s<>"')]+/g) ?? [];

    for (const raw of urls) {
      const url = raw.replace(/[.,;:]+$/, "");
      const lower = url.toLowerCase();
      if (!lower.includes(host) && !(tenant && lower.includes(tenant))) continue;
      // activate / verify / confirm is what these links are called; anything
      // else on that host is the posting itself or a privacy page.
      // A reset link is asked for by name and never returned otherwise: an
      // activation lookup must not open a link that changes a password.
      const isReset = /reset|forgot|password/i.test(lower.replace(host, ""));
      if (kind === "reset" ? !isReset : isReset) continue;
      if (kind !== "reset" && !/\/(activate|verify|confirm|activation|email-verif|verification)/i.test(lower)) continue;
      return url;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/** RFC 2822, base64url, which is all the Gmail send endpoint accepts. */
function buildRaw(to: string, subject: string, body: string, threadRef?: string): string {
  const lines = [`To: ${to}`, `Subject: ${subject}`, "Content-Type: text/plain; charset=UTF-8"];
  // Without these the reply starts a new conversation rather than continuing
  // the recruiter's, which is how it gets lost.
  if (threadRef) {
    lines.push(`In-Reply-To: ${threadRef}`, `References: ${threadRef}`);
  }
  lines.push("", body);
  return Buffer.from(lines.join("\r\n"), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function sendReply(
  supabase: any,
  opts: { to: string; subject: string; body: string; threadId?: string; messageIdHeader?: string },
): Promise<{ ok: boolean; error?: string }> {
  const token = await getAccessToken(supabase);
  if (!token) return { ok: false, error: "Gmail is not connected" };

  const subject = /^re:/i.test(opts.subject) ? opts.subject : `Re: ${opts.subject}`;
  try {
    await gmail(token, "/messages/send", {
      method: "POST",
      body: JSON.stringify({
        raw: buildRaw(opts.to, subject, opts.body, opts.messageIdHeader),
        ...(opts.threadId ? { threadId: opts.threadId } : {}),
      }),
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as Error).message).slice(0, 300) };
  }
}

/**
 * The Message-ID header of a stored message, which a reply has to quote for
 * the recipient's mail program to file it under the same conversation.
 * Null when it cannot be read; the reply is then sent on the thread alone.
 */
export async function messageIdHeader(supabase: any, gmailId: string): Promise<string | null> {
  const token = await getAccessToken(supabase);
  if (!token || !gmailId) return null;
  try {
    const msg = await gmail(token, `/messages/${encodeURIComponent(gmailId)}?format=metadata&metadataHeaders=Message-ID`);
    const value = header(msg?.payload, "Message-ID");
    return value ? String(value).trim() : null;
  } catch {
    return null;
  }
}

/**
 * A plain message to the owner's own mailbox, and nowhere else.
 *
 * There is no address to pass: it goes to whoever the connected Gmail
 * account is. Used for the daily summary.
 */
export async function sendToSelf(
  supabase: any,
  subject: string,
  body: string,
): Promise<{ ok: boolean; error?: string }> {
  const token = await getAccessToken(supabase);
  if (!token) return { ok: false, error: "Gmail is not connected" };
  try {
    const me = await gmail(token, "/profile");
    const to = typeof me?.emailAddress === "string" ? me.emailAddress : "";
    if (!to) return { ok: false, error: "could not read the connected address" };
    await gmail(token, "/messages/send", {
      method: "POST",
      body: JSON.stringify({ raw: buildRaw(to, subject.replace(/[\r\n]+/g, " ").slice(0, 150), body) }),
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as Error).message).slice(0, 300) };
  }
}

// ---------------------------------------------------------------------------
// Sending a new message with a file attached
// ---------------------------------------------------------------------------

const b64url = (buf: Buffer) =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A header value with anything outside ASCII encoded, as mail requires. */
function encodeHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/**
 * RFC 2822 with one attachment: a plain-text part and the file, base64 in
 * lines of 76 as the standard asks.
 */
export function buildRawWithAttachment(
  to: string,
  subject: string,
  body: string,
  attachment: { filename: string; mime: string; base64: string },
  cc?: string | null,
): string {
  const boundary = `ap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const name = attachment.filename.replace(/[\r\n"]/g, "").slice(0, 120) || "Resume.pdf";
  const file = attachment.base64.replace(/[^A-Za-z0-9+/=]/g, "").replace(/(.{76})/g, "$1\r\n");
  const lines = [
    `To: ${to}`,
    ...(cc ? [`Cc: ${cc}`] : []),
    `Subject: ${encodeHeader(subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(body, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n"),
    "",
    `--${boundary}`,
    `Content-Type: ${attachment.mime}; name="${name}"`,
    `Content-Disposition: attachment; filename="${name}"`,
    "Content-Transfer-Encoding: base64",
    "",
    file,
    "",
    `--${boundary}--`,
    "",
  ];
  return b64url(Buffer.from(lines.join("\r\n"), "utf8"));
}

/** The address of the connected mailbox itself. */
export async function ownAddress(supabase: any): Promise<string | null> {
  const token = await getAccessToken(supabase);
  if (!token) return null;
  try {
    const me = await gmail(token, "/profile");
    return typeof me?.emailAddress === "string" ? me.emailAddress : null;
  } catch {
    return null;
  }
}

/** A new message, not a reply, with one file attached. */
export async function sendWithAttachment(
  supabase: any,
  opts: {
    to: string;
    subject: string;
    body: string;
    attachment: { filename: string; mime: string; base64: string };
    cc?: string | null;
  },
): Promise<{ ok: boolean; error?: string }> {
  const token = await getAccessToken(supabase);
  if (!token) return { ok: false, error: "Gmail is not connected" };
  try {
    await gmail(token, "/messages/send", {
      method: "POST",
      body: JSON.stringify({
        raw: buildRawWithAttachment(opts.to, opts.subject, opts.body, opts.attachment, opts.cc),
      }),
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as Error).message).slice(0, 300) };
  }
}
