// ============================================================================
// admin.ts — the owner's list of people, sorted and narrowed.
//
// What the database hands back is one line per person: who they are, where
// their request stands, and how their workspace is doing, in counts and
// switches. This is the part with no database in it: finding people,
// narrowing the list, and saying in a few words what a person still has to
// set up. Pure, so each part has a test.
// ============================================================================

export type Person = {
  user_id: string;
  is_owner: boolean;
  full_name: string;
  email: string;
  status: "pending" | "approved" | "denied";
  created_at: string | null;
  decided_at: string | null;
  last_sign_in_at: string | null;
  has_workspace: boolean;
  autopilot: boolean;
  has_resume: boolean;
  titles: number | null;
  mail_connected: boolean;
  mail_last_read: string | null;
  own_key: boolean;
  employers: number;
  jobs: number;
  queued: number;
  needs_help: number;
  applied: number;
  applied_24h: number;
  interviews: number;
  last_applied_at: string | null;
  questions_waiting: number;
};

export type Filter = "all" | "pending" | "approved" | "denied" | "running" | "stuck" | "idle";
export type Sort = "newest" | "name" | "applied" | "active";

export const FILTERS: Array<[Filter, string]> = [
  ["all", "everyone"],
  ["pending", "waiting for you"],
  ["approved", "approved"],
  ["denied", "denied"],
  ["running", "running"],
  ["stuck", "set up unfinished"],
  ["idle", "quiet 3 days"],
];

/** What an approved person has yet to do before their workspace can apply for them. */
export function missing(p: Person): string[] {
  if (p.status !== "approved") return [];
  if (!p.has_workspace) return ["has not signed in yet"];
  const out: string[] = [];
  if (!p.has_resume) out.push("resume");
  if (!(Number(p.titles) > 0)) out.push("job titles");
  if (!p.mail_connected) out.push("mailbox");
  if (!p.autopilot) out.push("START not pressed");
  return out;
}

const DAY = 86_400_000;
const at = (v: string | null) => (v ? Date.parse(v) : 0);

/** A person's most recent sign of life: a sign-in or an application. */
export const lastActive = (p: Person) => Math.max(at(p.last_sign_in_at), at(p.last_applied_at), at(p.mail_last_read));

export function matches(p: Person, filter: Filter, now: number): boolean {
  switch (filter) {
    case "all": return true;
    case "pending": case "approved": case "denied": return p.status === filter;
    case "running": return p.status === "approved" && p.autopilot && missing(p).length === 0;
    case "stuck": return p.status === "approved" && missing(p).length > 0;
    case "idle": return p.status === "approved" && now - lastActive(p) > 3 * DAY;
  }
}

/** The list, narrowed by a filter and by words typed, in the order asked for. The owner's own line stays first. */
export function narrow(people: Person[], opts: { filter: Filter; words: string; sort: Sort; now: number }): Person[] {
  const words = opts.words.toLowerCase().split(/\s+/).filter(Boolean);
  const kept = people.filter((p) => matches(p, opts.filter, opts.now) && words.every((w) => `${p.full_name} ${p.email}`.toLowerCase().includes(w)));
  const by: Record<Sort, (a: Person, b: Person) => number> = {
    newest: (a, b) => at(b.created_at) - at(a.created_at),
    name: (a, b) => (a.full_name || a.email).localeCompare(b.full_name || b.email),
    applied: (a, b) => b.applied - a.applied,
    active: (a, b) => lastActive(b) - lastActive(a),
  };
  return kept.sort((a, b) => Number(b.is_owner) - Number(a.is_owner) || by[opts.sort](a, b));
}

/** The numbers across the top. */
export function totals(people: Person[], now: number) {
  const others = people.filter((p) => !p.is_owner);
  return {
    waiting: others.filter((p) => p.status === "pending").length,
    approved: others.filter((p) => p.status === "approved").length,
    denied: others.filter((p) => p.status === "denied").length,
    running: people.filter((p) => matches(p, "running", now)).length,
    stuck: others.filter((p) => matches(p, "stuck", now)).length,
    applied_24h: people.reduce((n, p) => n + p.applied_24h, 0),
    applied: people.reduce((n, p) => n + p.applied, 0),
    interviews: people.reduce((n, p) => n + p.interviews, 0),
  };
}

/** "3 h ago", "2 d ago", "never". */
export function ago(v: string | null, now: number): string {
  if (!v) return "never";
  const ms = now - Date.parse(v);
  if (!Number.isFinite(ms)) return "never";
  if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))} min ago`;
  if (ms < DAY) return `${Math.round(ms / 3_600_000)} h ago`;
  return `${Math.round(ms / DAY)} d ago`;
}
