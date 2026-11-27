// ============================================================================
// scope.server.ts — the panel's server, working for one person at a time.
//
// The server holds a key that can read every row in the database. Code that
// was written when there was one person asks for "the profile" and "the
// jobs". Rather than rewrite all of it — and trust that no query anywhere
// was missed — the server never hands that code the all-seeing client. It
// hands it this instead: the same client with one person's id welded on.
// Every read, change and removal on a table of people's own rows is limited
// to that person, every new row is stamped with them, and "only one" rules
// are asked for per person. A table that is shared (places on the map, the
// server's own clock) passes through untouched.
// ============================================================================

/** The tables whose rows belong to a person. */
export const OWN_TABLES = new Set([
  "agent", "answers", "call_keys", "companies", "company_candidates", "email_sync", "emails", "experience",
  "google_tokens", "jobs", "outreach", "profile", "runs", "search_config", "site_accounts", "user_keys",
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUserId = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

/** "id" alone was the key of a one-row table; per person, the person is the key. */
export function perPerson(onConflict: string | undefined): string | undefined {
  if (!onConflict) return onConflict;
  const cols = onConflict.split(",").map((c) => c.trim()).filter(Boolean);
  if (cols.includes("user_id")) return cols.join(",");
  if (cols.length === 1 && cols[0] === "id") return "user_id";
  return ["user_id", ...cols].join(",");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** The client, limited to one person. Anything not about a person's own rows is the client's own. */
export function forUser(admin: Any, uid: string): Any {
  if (!isUserId(uid)) throw new Error("no person to work for");
  const stamp = (v: Any) => (Array.isArray(v) ? v.map((r) => ({ ...r, user_id: uid })) : { ...v, user_id: uid });
  return new Proxy(admin, {
    get(target, prop, receiver) {
      if (prop === "from") {
        return (table: string) => {
          const q = target.from(table);
          if (!OWN_TABLES.has(table)) {
            // A view answers with everybody's rows to this key, and has no
            // column to limit it by. Nothing on the server should read one.
            if (/^v_/.test(table)) throw new Error(`the server does not read the view ${table}; ask the tables`);
            return q;
          }
          return {
            select: (...a: Any[]) => q.select(...a).eq("user_id", uid),
            insert: (v: Any, o?: Any) => q.insert(stamp(v), o),
            upsert: (v: Any, o?: Any) => q.upsert(stamp(v), o ? { ...o, onConflict: perPerson(o.onConflict) } : o),
            update: (v: Any, o?: Any) => q.update(v, o).eq("user_id", uid),
            delete: (o?: Any) => q.delete(o).eq("user_id", uid),
          };
        };
      }
      if (prop === "forUserId") return uid;
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

/** The owner's id: who everything belonged to before there was anyone else. */
export async function ownerId(admin: Any): Promise<string | null> {
  const { data } = await admin.from("app_owner").select("user_id").limit(1).maybeSingle();
  return isUserId(data?.user_id) ? data.user_id : null;
}

/**
 * Who a request from the runner is for: the person it names, where that is
 * the owner or someone approved; the owner where it names nobody. Null for
 * a name that is neither — the caller stops there.
 */
export async function personFor(admin: Any, request: Request): Promise<string | null> {
  const owner = await ownerId(admin);
  // By place in the line, for a caller that is not told anybody's id: 0 is
  // the owner, 1 the first person approved, and so on. Past the end of the
  // line there is nobody, and the caller stops.
  const place = (request.headers.get("x-person") ?? "").trim();
  if (place && place !== "0") {
    if (!/^\d{1,3}$/.test(place)) return null;
    return (await roster(admin))[Number(place)] ?? null;
  }
  const named = (request.headers.get("x-act-as") ?? "").trim();
  if (!named) return owner;
  if (!isUserId(named)) return null;
  if (named === owner) return owner;
  const { data } = await admin.from("members").select("user_id").eq("user_id", named).eq("status", "approved").maybeSingle();
  return data?.user_id ? named : null;
}

/**
 * Everyone with a workspace, the owner first, then approved people whose
 * mailbox has waited longest — so that a pass that runs out of time has
 * still done the ones most overdue.
 */
export async function everyone(admin: Any): Promise<string[]> {
  const owner = await ownerId(admin);
  if (!owner) return [];
  const { data: approved } = await admin.from("members").select("user_id").eq("status", "approved").limit(200);
  const ids = new Set<string>((approved ?? []).map((m: Any) => m.user_id).filter(isUserId));
  ids.delete(owner);
  if (!ids.size) return [owner];
  const { data: synced } = await admin.from("email_sync").select("user_id, last_run_at").in("user_id", [...ids]);
  const last = new Map<string, number>((synced ?? []).map((s: Any) => [s.user_id, s.last_run_at ? Date.parse(s.last_run_at) : 0]));
  // Someone with no workspace yet has not come in; there is nothing to do for them.
  const rest = [...ids].filter((id) => last.has(id)).sort((a, b) => (last.get(a) ?? 0) - (last.get(b) ?? 0));
  return [owner, ...rest];
}

/**
 * Everyone with a workspace in an order that does not change from one call
 * to the next: the owner, then approved people in the order they asked.
 */
export async function roster(admin: Any): Promise<string[]> {
  const owner = await ownerId(admin);
  if (!owner) return [];
  const { data: approved } = await admin.from("members").select("user_id, created_at").eq("status", "approved").order("created_at", { ascending: true }).limit(200);
  const ids = (approved ?? []).map((m: Any) => m.user_id).filter((id: unknown) => isUserId(id) && id !== owner) as string[];
  if (!ids.length) return [owner];
  const { data: have } = await admin.from("profile").select("user_id").in("user_id", ids);
  const made = new Set((have ?? []).map((r: Any) => r.user_id));
  return [owner, ...ids.filter((id) => made.has(id))];
}
