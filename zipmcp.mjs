// ZipRecruiter's own published search, for AI assistants and their tools.
//
// ZipRecruiter publishes a search endpoint that speaks the Model Context
// Protocol, with no account and no key: one tool, a job search. This reads
// it as any such client would — says who it is, asks what the tool takes,
// and searches. It is used for one thing: the names of employers hiring for
// the owner's titles near them, which the resolver then looks up on the
// employer's own careers site. Nothing is applied to on ZipRecruiter and no
// ZipRecruiter page is opened.
//
// What the tool takes and gives back is asked of the endpoint itself rather
// than assumed, so a change on their side is met and not guessed at.

export const ENDPOINT = "https://api.ziprecruiter.com/mcp";

/** One reply, whether it came as plain JSON or as an event stream. */
export function readReply(text, contentType = "") {
  const t = String(text ?? "");
  if (!/event-stream/i.test(contentType) && !/^\s*(event|data):/m.test(t)) {
    try { return JSON.parse(t); } catch { return null; }
  }
  let last = null;
  for (const block of t.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
    if (!data) continue;
    try {
      const j = JSON.parse(data);
      if (j && (j.result !== undefined || j.error !== undefined)) last = j;
    } catch { /* a keep-alive or a partial line */ }
  }
  return last;
}

/**
 * The search, in the tool's own parameter names. Only names the tool
 * declares are sent; a value it has no place for is left out.
 */
export function argsFor(schema, want) {
  const props = schema?.properties ?? {};
  const names = Object.keys(props);
  const pick = (...res) => names.find((n) => res.some((re) => re.test(n)));
  const out = {};
  const put = (name, value) => {
    if (!name || value === null || value === undefined || value === "") return;
    const type = props[name]?.type;
    const allowed = Array.isArray(props[name]?.enum) ? props[name].enum : null;
    let v = type === "integer" || type === "number" ? Number(value) : type === "string" ? String(value) : value;
    if (allowed && !allowed.includes(v)) return;
    out[name] = v;
  };
  put(pick(/^(search|query|q|keywords?|what|job_?title|title)$/i, /keyword|search|query/i), want.title);
  put(pick(/^(location|where|city)$/i, /location/i), want.where);
  put(pick(/radius|distance/i), want.radius);
  put(pick(/days|recency|posted|age|fresh/i), want.days);
  put(pick(/^(offset|page|start)$/i, /offset/i), want.offset);
  return out;
}

const TITLE = /^(title|job_?title|name|position)$/i;
const COMPANY = /^(company|company_?name|hiring_?company|employer|employer_?name|organization)$/i;

/** The postings in a tool's answer, wherever in it they sit: title and employer. */
export function jobsIn(result) {
  const found = [];
  const seen = new Set();
  const walk = (v, depth) => {
    if (depth > 6 || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    const keys = Object.keys(v);
    const tk = keys.find((k) => TITLE.test(k));
    const ck = keys.find((k) => COMPANY.test(k));
    if (tk && ck) {
      const company = typeof v[ck] === "object" && v[ck] ? v[ck].name ?? v[ck].display_name : v[ck];
      if (typeof v[tk] === "string" && typeof company === "string" && company.trim()) {
        const key = `${v[tk]}|${company}`;
        if (!seen.has(key)) {
          seen.add(key);
          const posted = keys.find((k) => /posted|date|created/i.test(k));
          found.push({ title: v[tk], company: company.trim(), posted: posted ? v[posted] : null, keys });
        }
        return;
      }
    }
    for (const k of keys) walk(v[k], depth + 1);
  };
  walk(result?.structuredContent, 0);
  for (const c of result?.content ?? []) {
    if (c?.type !== "text" || typeof c.text !== "string") continue;
    try { walk(JSON.parse(c.text), 0); } catch { /* prose, not a list */ }
  }
  return found;
}

/** A session with the endpoint: who is asking, what the tool is, and a way to call it. */
export async function open(fetchImpl = fetch) {
  let session = null;
  let id = 0;
  const send = async (method, params, notify = false) => {
    const res = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "User-Agent": "ApplyPilot",
        ...(session ? { "Mcp-Session-Id": session } : {}),
      },
      body: JSON.stringify(notify ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: ++id, method, params }),
      signal: AbortSignal.timeout(30_000),
    });
    session = res.headers.get("mcp-session-id") ?? session;
    if (notify) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const reply = readReply(await res.text(), res.headers.get("content-type") ?? "");
    if (!reply) throw new Error("no answer that could be read");
    if (reply.error) throw new Error(`refused: ${String(reply.error.message ?? reply.error.code).slice(0, 60)}`);
    return reply.result;
  };
  await send("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "ApplyPilot", version: "1.0" } });
  await send("notifications/initialized", {}, true).catch(() => {});
  const listed = await send("tools/list", {});
  const tool = (listed?.tools ?? []).find((t) => /search/i.test(t.name)) ?? null;
  return { tool, call: (args) => send("tools/call", { name: tool.name, arguments: args }) };
}
