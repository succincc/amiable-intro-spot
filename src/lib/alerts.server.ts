// ============================================================================
// alerts.server.ts — job-board alert emails as a source of employers.
//
// LinkedIn, Indeed and ZipRecruiter will not be signed in to or applied
// through: automating a personal account is against their terms and gets the
// account closed. What they will do, for free and on their own schedule, is
// email the owner the postings that match a saved search. Those emails
// already reach the connected mailbox.
//
// An alert names the employer. The application itself belongs on the
// employer's own careers portal — which is where this system applies anyway —
// so an alert is read for one thing: which employers are hiring for the
// owner's search, near the owner. Any employer the panel has not heard of is
// added to the candidate list, where the resolver finds its portal and
// discovery starts pulling its postings like any other.
//
// Pure functions first, so they can be tested without a mailbox.
// ============================================================================

export type AlertMessage = {
  from_addr?: string | null;
  subject?: string | null;
  body?: string | null;
};

const BOARDS =
  /(?:^|[.@])(linkedin|indeed|ziprecruiter|glassdoor|monster|dice|simplyhired|careerbuilder)\.[a-z.]+$/i;

/** Is this a job board's alert rather than mail from an employer? */
export function isJobAlert(m: AlertMessage): boolean {
  const from = String(m.from_addr ?? "").toLowerCase();
  if (!BOARDS.test(from)) return false;
  const subject = String(m.subject ?? "");
  // Receipts for applications made on the board itself are not alerts.
  if (/application (was )?(sent|submitted|received|viewed)|you applied/i.test(subject)) return false;
  return true;
}

// Up to four capitalised words, a comma, a state: "Red Bank, NJ". Words, not
// any run of characters — "Garden State Foods - Princeton, NJ" is an employer
// beside a place, not a place.
const PLACE = /^[A-Z][A-Za-z.'-]*(?: [A-Z][A-Za-z.'-]*){0,3},\s*[A-Z]{2}\b|^(Remote|Hybrid|United States)\b/;
const NOT_A_COMPANY =
  /^(view|apply|see|new|jobs?|similar|recommended|easy apply|actively|promoted|unsubscribe|manage|privacy|help|linkedin|indeed|ziprecruiter|glassdoor|\$|\d|©)/i;

function tidy(name: string): string {
  return name
    .replace(/\s+/g, " ")
    .replace(/[|•·\-–—]\s*$/, "")
    .trim();
}

function plausibleCompany(name: string): boolean {
  const n = tidy(name);
  if (n.length < 2 || n.length > 60) return false;
  if (NOT_A_COMPANY.test(n)) return false;
  if (/https?:|@|\?$/.test(n)) return false;
  if (PLACE.test(n)) return false;
  // A sentence is not a name.
  if (n.split(" ").length > 7) return false;
  return /[A-Za-z]/.test(n);
}

/**
 * The employers an alert names.
 *
 * Every board lays its alert out as a list of postings, and whatever the
 * decoration, a posting is a title, an employer and a place. The employer is
 * found by the place beside it: "Acme Corp · Newark, NJ", "Acme Corp -
 * Newark, NJ", or a line that is followed by a line that is only a place.
 */
export function companiesFromAlert(m: AlertMessage): string[] {
  const lines = String(m.body ?? "")
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 600);

  const found = new Map<string, string>();
  const add = (raw: string) => {
    const name = tidy(raw);
    if (!plausibleCompany(name)) return;
    const key = name.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (key.length >= 2 && !found.has(key)) found.set(key, name);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // "Acme Corp · Newark, NJ"   "Acme Corp - Newark, NJ (Hybrid)"
    const beside = line.match(/^(.{2,60}?)\s+[·•|\-–—]\s+(.+)$/);
    if (beside && PLACE.test(beside[2]!.trim())) {
      add(beside[1]!);
      continue;
    }
    // "Acme Corp" on one line, "Newark, NJ" alone on the next.
    const next = lines[i + 1];
    if (next && PLACE.test(next) && next.length < 50 && !PLACE.test(line)) add(line);
  }
  return [...found.values()].slice(0, 40);
}

/**
 * A board's receipt for an application made on the board itself — by the
 * owner's own hand, or by a tool the board offers its members. Read for
 * which employer and which role, so that the application is on record here
 * and a reply from that employer is recognised as a reply to it.
 */
export function boardReceipt(m: AlertMessage): { board: string; company: string; title: string | null } | null {
  const from = String(m.from_addr ?? "").toLowerCase();
  const board = (from.match(BOARDS) ?? [])[1];
  if (!board) return null;
  const subject = String(m.subject ?? "").replace(/\s+/g, " ").trim();
  const body = String(m.body ?? "").replace(/\r/g, "");
  const first = body.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 12);
  const clean = (v: string | undefined | null) => tidy(String(v ?? "").replace(/[.!]+$/, ""));
  let company = "";
  let title: string | null = null;
  let hit: RegExpMatchArray | null;
  if ((hit = subject.match(/^you(?:'ve| have)? applied (?:to|for) (.+?) at (.+)$/i))) {
    title = clean(hit[1]);
    company = clean(hit[2]);
  } else if ((hit = subject.match(/^your application for (.+?) at (.+?)(?: (?:was|has been) (?:sent|submitted|received))?$/i))) {
    title = clean(hit[1]);
    company = clean(hit[2]);
  } else if ((hit = subject.match(/^your application (?:was|has been) (?:sent|submitted) to (.+)$/i)) || (hit = subject.match(/^your application to (.+?) (?:was|has been) (?:sent|submitted)/i))) {
    company = clean(hit[1]);
    // The role is the line above the employer's, where the receipt sets them out.
    const at = first.findIndex((l) => l.toLowerCase().startsWith(company.toLowerCase()));
    title = at > 0 ? clean(first[at - 1]) : null;
  } else if ((hit = subject.match(/^indeed application:\s*(.+)$/i))) {
    title = clean(hit[1]);
    company = clean((body.match(/(?:sent|submitted) to ([^\n.]{2,60})/i) ?? [])[1]);
  } else {
    return null;
  }
  if (!plausibleCompany(company)) return null;
  return { board, company, title: title && title.length <= 120 ? title : null };
}

/** Put on record the applications a board says were sent. Each once. */
export async function recordBoardApplications(supabase: any, messages: Array<AlertMessage & { message_id?: string | null; received_at?: string | null }>) {
  let recorded = 0;
  for (const m of messages) {
    const r = boardReceipt(m);
    if (!r || !m.message_id) continue;
    const { error } = await supabase.from("jobs").upsert(
      {
        // The receipt is the record; it has no posting address of its own.
        url: `https://www.${r.board}.com/#applied-${String(m.message_id).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40)}`,
        title: r.title ?? "an application made on the board",
        company: r.company,
        source: r.board,
        status: "applied",
        applied_at: m.received_at ?? new Date().toISOString(),
        confirm_state: "confirmed",
        confirmed_at: m.received_at ?? new Date().toISOString(),
        description: `Applied on ${r.board}; recorded from its receipt.`,
      },
      { onConflict: "url", ignoreDuplicates: true },
    );
    if (!error) recorded++;
  }
  return { recorded };
}

/** A first guess at where an employer's careers page lives. */
export function guessCareersUrl(company: string): string | null {
  const slug = company
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/\b(inc|llc|ltd|corp|corporation|co|company|group|holdings|plc|lp|the)\b\.?/g, " ")
    .replace(/[^a-z0-9]+/g, "");
  if (slug.length < 3 || slug.length > 30) return null;
  return `https://www.${slug}.com/careers`;
}

/**
 * Add the employers named in these alerts to the candidate list.
 *
 * Only ones the panel does not already know, by name. The address is a guess
 * — the company's own site — and the resolver treats it as one: it follows it
 * to whatever application system is really behind it, checks that system's
 * public feed, and adds nothing if the guess leads nowhere.
 */
export async function harvestAlerts(supabase: any, messages: AlertMessage[]) {
  const names = new Map<string, string>();
  let alerts = 0;
  for (const m of messages) {
    if (!isJobAlert(m)) continue;
    alerts++;
    for (const c of companiesFromAlert(m)) {
      const key = c.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (!names.has(key)) names.set(key, c);
    }
  }
  if (!names.size) return { alerts, named: 0, added: 0 };

  const flat = (v: unknown) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const [{ data: known }, { data: firms }] = await Promise.all([
    supabase.from("company_candidates").select("name").limit(5000),
    supabase.from("companies").select("name").limit(5000),
  ]);
  const have = new Set([...(known ?? []), ...(firms ?? [])].map((r: any) => flat(r.name)));

  const rows: Array<{ name: string; careers_url: string; status: string; note: string }> = [];
  for (const [key, name] of names) {
    if (have.has(key)) continue;
    const url = guessCareersUrl(name);
    if (!url) continue;
    rows.push({ name, careers_url: url, status: "pending", note: "named in a job-board alert" });
  }
  if (!rows.length) return { alerts, named: names.size, added: 0 };

  const { error, data } = await supabase
    .from("company_candidates")
    .upsert(rows.slice(0, 60), { onConflict: "careers_url", ignoreDuplicates: true })
    .select("id");
  return { alerts, named: names.size, added: error ? 0 : (data?.length ?? 0) };
}
