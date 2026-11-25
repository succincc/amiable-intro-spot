/* eslint-disable @typescript-eslint/no-explicit-any */
// Workday's search response is loosely typed JSON from an undocumented API.
// ============================================================================
// workday.ts — reaches the careers portals of most large employers.
//
// Target, BlackRock, Salesforce, Nvidia, Walmart, Dell and several thousand
// other large companies do not have bespoke careers sites: they run Workday
// under their own branding. Workday exposes the same JSON search API on every
// tenant, so one fetcher reaches all of them.
//
//   POST https://{tenant}.wd{N}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs
//   body { appliedFacets: {}, limit, offset, searchText }
//
// The hard part is not the API, it is knowing each employer's tenant and site
// id. Those are both in the URL of the company's careers page, so rather than
// maintaining a hand-written registry that silently rots when a company
// changes its site id, the user pastes the careers URL and parseWorkdayUrl
// extracts them.
// ============================================================================

export type WorkdayTarget = {
  tenant: string; // e.g. "target"
  pod: string; // e.g. "wd5"
  site: string; // e.g. "targetcareers"
  name?: string;
};

/**
 * Turn any Workday careers URL into the three values the API needs.
 *
 * Accepts the shapes a person actually copies out of the address bar:
 *   https://target.wd5.myworkdayjobs.com/en-US/targetcareers
 *   https://target.wd5.myworkdayjobs.com/targetcareers/job/Minneapolis/...
 *   target.wd5.myworkdayjobs.com/en-US/targetcareers/
 */
export function parseWorkdayUrl(input: string): WorkdayTarget | null {
  if (!input) return null;
  let url = input.trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  // {tenant}.wd{N}.myworkdayjobs.com — some tenants add a region prefix
  const host = parsed.hostname.toLowerCase();
  const hostMatch = host.match(/^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/);
  const tenant = hostMatch?.[1];
  const pod = hostMatch?.[2];
  if (!tenant || !pod) return null;

  // The site id is the first path segment that is not a locale.
  const segments = parsed.pathname.split("/").filter(Boolean);
  const site = segments.find((s) => !/^[a-z]{2}-[A-Z]{2}$/i.test(s));
  if (!site) return null;

  return { tenant, pod, site };
}

/** Build the public URL a human (and the applier) opens for one posting. */
function jobUrl(t: WorkdayTarget, externalPath: string): string {
  const path = externalPath.startsWith("/") ? externalPath : `/${externalPath}`;
  return `https://${t.tenant}.${t.pod}.myworkdayjobs.com/en-US/${t.site}${path}`;
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function searchPage(
  t: WorkdayTarget,
  searchText: string,
  offset: number,
  limit: number,
): Promise<{ total: number; postings: any[] }> {
  const endpoint = `https://${t.tenant}.${t.pod}.myworkdayjobs.com/wday/cxs/${t.tenant}/${t.site}/jobs`;

  const ctrl = new AbortController();
  // 20s was far too patient. Workday blocks datacentre ranges outright, and a
  // blocked request burns the whole timeout before failing — multiplied by
  // every search term, for every employer, that was a discovery run that
  // never came back.
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": UA,
        Origin: `https://${t.tenant}.${t.pod}.myworkdayjobs.com`,
        Referer: `https://${t.tenant}.${t.pod}.myworkdayjobs.com/en-US/${t.site}`,
      },
      body: JSON.stringify({ appliedFacets: {}, limit, offset, searchText }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return { total: data.total ?? 0, postings: data.jobPostings ?? [] };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch postings for one employer, for each search term.
 *
 * Workday paginates 20 at a time and large employers have thousands of
 * openings, so this caps pages per term. Searching by term rather than
 * pulling everything keeps the result relevant and the run short.
 */
export async function fetchWorkday(
  t: WorkdayTarget,
  searchTerms: string[],
  opts: { maxPagesPerTerm?: number; pageSize?: number } = {},
): Promise<any[]> {
  const pageSize = opts.pageSize ?? 20;
  const maxPages = opts.maxPagesPerTerm ?? 3; // 60 postings per term
  const seen = new Set<string>();
  const out: any[] = [];
  const failures: string[] = [];
  let unreachable = false;

  for (const term of searchTerms.length ? searchTerms : [""]) {
    if (unreachable) break;
    for (let page = 0; page < maxPages; page++) {
      let result;
      try {
        result = await searchPage(t, term, page * pageSize, pageSize);
      } catch (e) {
        // One term failing is survivable — try the next rather than abandoning
        // the employer. But remember why, because an employer that returns
        // nothing at all needs to say so: a wrong site id, a renamed tenant
        // and a genuinely empty careers page all look identical from the
        // outside otherwise, and "0 jobs" is the least useful of the three.
        failures.push(`${term || "(all)"}: ${(e as Error)?.message ?? String(e)}`);
        // The FIRST page of a term failing means the tenant is unreachable,
        // not that this search found nothing: a wrong site id, a renamed
        // tenant, or a host refusing this address. Every remaining term pays
        // the same timeout to learn the same thing, and with several titles
        // set that is most of what made a run take minutes. Stop on the
        // employer, not on the term.
        if (page === 0 && term === (searchTerms.length ? searchTerms[0] : "")) {
          unreachable = true;
        }
        break;
      }

      for (const p of result.postings) {
        const path = p.externalPath ?? "";
        if (!path || seen.has(path)) continue;
        seen.add(path);

        // bulletFields usually carries the requisition id; locationsText is
        // the human-readable location string shown on the card.
        out.push({
          url: jobUrl(t, path),
          apply_url: jobUrl(t, path),
          title: p.title,
          company: t.name ?? t.tenant,
          location: p.locationsText ?? null,
          remote: /remote|work from home|virtual/i.test(p.locationsText ?? ""),
          // Workday's search response has no description; the applier reads
          // the posting page itself, and the scorer works from the title and
          // location until then.
          description: null,
          source: "workday",
          ats: "workday",
          // "Posted 3 Days Ago", "Posted 30+ Days Ago", "Posted Today".
          // Recorded so the fourteen-day rule can be applied before a job is
          // ever queued, rather than only once the applier opens it.
          posted_at: (() => {
            const m = String(p.postedOn ?? "").toLowerCase().match(/(today|yesterday|(\d+)(\+)?\s+days?\s+ago)/);
            if (!m) return null;
            const days = m[1] === "today" ? 0 : m[1] === "yesterday" ? 1 : Number(m[2]) + (m[3] ? 1 : 0);
            return new Date(Date.now() - days * 86_400_000).toISOString();
          })(),
        });
      }

      if ((page + 1) * pageSize >= result.total) break;
      await new Promise((r) => setTimeout(r, 400)); // be polite
    }
  }

  // Nothing found AND every attempt errored is a broken target, not an empty
  // one. Throwing here is what puts the reason on the company row in the
  // panel instead of leaving a portal that silently contributes nothing.
  if (out.length === 0 && failures.length > 0) {
    throw new Error(
      `Workday ${t.tenant}/${t.site} returned no jobs — ${failures[0]}. ` +
        `Check the careers URL is the job listings page.`,
    );
  }

  return out;
}
