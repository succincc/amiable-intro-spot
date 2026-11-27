/* eslint-disable @typescript-eslint/no-explicit-any */
// @ts-nocheck — ported verbatim from the user's Deno function; loosely typed JSON feeds.
// Ported from the user's `discover` function. Free public job feeds, no keys.

import { cleanLocation, coarsePlace, greenhousePlace, milesBetween } from "@/lib/careers";
import { cachedGeocode, geocode } from "@/lib/geo.server";
import { suggestTitles } from "@/lib/titles.server";
import { fetchWorkday } from "@/lib/workday.server";

/** How old a posting may be and still be wanted. The same number as fresh.mjs. */
const FRESH_DAYS = 30;

const UA = "ApplyPilot/1.0 (job search automation; contact via app)";
const TIMEOUT_MS = 15_000;

type Job = {
  url: string;
  apply_url?: string;
  title: string;
  company?: string;
  location?: string;
  remote?: boolean;
  salary_text?: string;
  description?: string;
  source: string;
  ats?: string;
  posted_at?: string;
};

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------

async function getJSON(url: string, headers: Record<string, string> = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json", ...headers },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Strip HTML to readable text. Job descriptions arrive as HTML from most ATS. */
function clean(html?: string | null): string {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Parse "$95,000-$120,000", "95k-120k", "$50/hr" into annual min/max. */
function parseSalary(text?: string | null): { min?: number; max?: number } {
  if (!text) return {};
  const t = String(text).toLowerCase();
  const hourly = /hour|hr|hourly/.test(t);
  const nums: number[] = [];
  for (const m of t.matchAll(/(\d[\d,]*\.?\d*)\s*(k)?/g)) {
    let v = parseFloat(m[1].replace(/,/g, ""));
    if (isNaN(v)) continue;
    if (m[2]) v *= 1000;
    if (hourly && v >= 5 && v <= 500) v *= 2080;
    else if (v < 1000) continue;
    if (v >= 1000 && v <= 10_000_000) nums.push(Math.round(v));
  }
  if (!nums.length) return {};
  return { min: Math.min(...nums), max: Math.max(...nums) };
}

const REMOTE_RE = /\b(remote|anywhere|work from home|wfh|distributed|telecommute)\b/i;

// --------------------------------------------------------------------------
// per-company ATS sources
// --------------------------------------------------------------------------

async function greenhouse(token: string, name: string): Promise<Job[]> {
  const data = await getJSON(
    `https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`,
  );
  return (data.jobs ?? []).map((j: any) => ({
    url: j.absolute_url,
    apply_url: j.absolute_url,
    title: j.title,
    company: name,
    location: greenhousePlace(j),
    remote: REMOTE_RE.test(j.location?.name ?? ""),
    // Tidied when it is first read, not before. A board sends the whole
    // text of every opening, most openings are turned away on their title
    // alone, and tidying nine thousand descriptions nobody would read was
    // most of the work in a round of nothing but boards like this one — a
    // new person's rounds, which the host ended for it.
    get description() {
      const tidy = clean(j.content);
      Object.defineProperty(this, "description", { value: tidy, writable: true, enumerable: true, configurable: true });
      return tidy;
    },
    source: "greenhouse",
    ats: "greenhouse",
    // When it first went up, where the board says. updated_at moves every
    // time a recruiter touches the posting, which made months-old openings
    // look new.
    posted_at: j.first_published ?? j.updated_at,
  }));
}

async function lever(token: string, name: string): Promise<Job[]> {
  const data = await getJSON(`https://api.lever.co/v0/postings/${token}?mode=json`);
  return (data ?? []).map((j: any) => ({
    url: j.hostedUrl,
    apply_url: j.applyUrl ?? j.hostedUrl,
    title: j.text,
    company: name,
    location: j.categories?.location,
    remote: REMOTE_RE.test(j.categories?.location ?? "") || REMOTE_RE.test(j.workplaceType ?? ""),
    salary_text: j.salaryRange
      ? `${j.salaryRange.min}-${j.salaryRange.max} ${j.salaryRange.currency ?? ""}`
      : undefined,
    // Tidied when first read, as a Greenhouse description is.
    get description() {
      const tidy = clean(j.descriptionPlain ?? j.description);
      Object.defineProperty(this, "description", { value: tidy, writable: true, enumerable: true, configurable: true });
      return tidy;
    },
    source: "lever",
    ats: "lever",
    posted_at: j.createdAt ? new Date(j.createdAt).toISOString() : undefined,
  }));
}

async function ashby(token: string, name: string): Promise<Job[]> {
  const data = await getJSON(
    `https://api.ashbyhq.com/posting-api/job-board/${token}?includeCompensation=true`,
  );
  return (data.jobs ?? []).map((j: any) => ({
    url: j.jobUrl,
    apply_url: j.applyUrl ?? j.jobUrl,
    title: j.title,
    company: name,
    location: j.location,
    remote: !!j.isRemote || REMOTE_RE.test(j.location ?? ""),
    salary_text: j.compensation?.compensationTierSummary,
    // Tidied when first read, as a Greenhouse description is.
    get description() {
      const tidy = clean(j.descriptionPlain ?? j.descriptionHtml);
      Object.defineProperty(this, "description", { value: tidy, writable: true, enumerable: true, configurable: true });
      return tidy;
    },
    source: "ashby",
    ats: "ashby",
    posted_at: j.publishedAt,
  }));
}

async function workable(token: string, name: string): Promise<Job[]> {
  const data = await getJSON(
    `https://apply.workable.com/api/v1/widget/accounts/${token}?details=true`,
  );
  return (data.jobs ?? []).map((j: any) => ({
    url: j.url ?? j.application_url,
    apply_url: j.application_url ?? j.url,
    title: j.title,
    company: name,
    location: [j.city, j.state, j.country].filter(Boolean).join(", "),
    remote: !!j.telecommuting,
    description: clean(j.description),
    source: "workable",
    ats: "workable",
    posted_at: j.published_on,
  }));
}

// --------------------------------------------------------------------------
// global feeds
// --------------------------------------------------------------------------

async function remotive(q?: string): Promise<Job[]> {
  const url = new URL("https://remotive.com/api/remote-jobs");
  url.searchParams.set("limit", "200");
  if (q) url.searchParams.set("search", q);
  const data = await getJSON(url.toString());
  return (data.jobs ?? []).map((j: any) => ({
    url: j.url,
    apply_url: j.url,
    title: j.title,
    company: j.company_name,
    location: j.candidate_required_location || "Remote",
    remote: true,
    salary_text: j.salary || undefined,
    description: clean(j.description),
    source: "remotive",
    posted_at: j.publication_date,
  }));
}

async function remoteok(): Promise<Job[]> {
  const data = await getJSON("https://remoteok.com/api");
  return (data ?? [])
    .filter((j: any) => j && typeof j === "object" && j.position)
    .map((j: any) => ({
      url: j.url ?? j.apply_url,
      apply_url: j.apply_url ?? j.url,
      title: j.position,
      company: j.company,
      location: j.location || "Remote",
      remote: true,
      salary_text: j.salary_min ? `$${j.salary_min}-$${j.salary_max ?? j.salary_min}` : undefined,
      description: clean(j.description),
      source: "remoteok",
      posted_at: j.date,
    }));
}

async function usajobs(q: string, loc?: string): Promise<Job[]> {
  const key = process.env["USAJOBS_API_KEY"];
  const email = process.env["USAJOBS_EMAIL"];
  if (!key || !email) return [];

  const url = new URL("https://data.usajobs.gov/api/search");
  url.searchParams.set("Keyword", q);
  url.searchParams.set("ResultsPerPage", "100");
  if (loc && !REMOTE_RE.test(loc)) url.searchParams.set("LocationName", loc);

  const data = await getJSON(url.toString(), {
    Host: "data.usajobs.gov",
    "User-Agent": email,
    "Authorization-Key": key,
  });

  return (data.SearchResult?.SearchResultItems ?? []).map((item: any) => {
    const d = item.MatchedObjectDescriptor ?? {};
    const pay = (d.PositionRemuneration ?? [])[0] ?? {};
    const salary = pay.MinimumRange
      ? `$${Math.round(+pay.MinimumRange).toLocaleString()}-$${Math.round(+(pay.MaximumRange ?? pay.MinimumRange)).toLocaleString()}`
      : undefined;
    return {
      url: d.PositionURI,
      apply_url: (d.ApplyURI ?? [])[0] ?? d.PositionURI,
      title: d.PositionTitle,
      company: d.OrganizationName,
      location: (d.PositionLocation ?? [])[0]?.LocationName,
      remote: false,
      salary_text: salary,
      description: clean(d.UserArea?.Details?.JobSummary ?? d.QualificationSummary),
      source: "usajobs",
      ats: "usajobs",
      posted_at: d.PublicationStartDate,
    };
  });
}

// --------------------------------------------------------------------------
// filtering — free, runs before anything costs a token
// --------------------------------------------------------------------------

// One pattern per word, made once. A round reads three thousand postings
// against every excluded title, and building the same pattern afresh for
// each pairing was most of what a round spent its time on — enough that
// some rounds were ended by the host before they could answer.
const WORD_PATTERNS = new Map<string, RegExp>();
function wordHit(haystack: string, needle: string): boolean {
  let re = WORD_PATTERNS.get(needle);
  if (!re) {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    re = new RegExp(`(?<!\\w)${escaped}(?!\\w)`, "i");
    if (WORD_PATTERNS.size < 5000) WORD_PATTERNS.set(needle, re);
  }
  return re.test(haystack);
}

function keep(job: Job, cfg: any): { ok: boolean; why?: string } {
  const title = (job.title ?? "").toLowerCase();

  if (!job.url || !job.title) return { ok: false, why: "missing url or title" };

  for (const bad of cfg.exclude_titles ?? []) {
    if (bad && wordHit(title, bad.toLowerCase())) {
      return { ok: false, why: `excluded title: ${bad}` };
    }
  }
  for (const bad of cfg.exclude_companies ?? []) {
    if (bad && (job.company ?? "").toLowerCase().includes(bad.toLowerCase())) {
      return { ok: false, why: `blocked company: ${job.company}` };
    }
  }

  // Title relevance: at least one target title word must appear. Without this
  // the global feeds flood the queue with thousands of unrelated postings.
  const titles: string[] = cfg.titles ?? [];
  if (titles.length) {
    const hit = titles.some((t: string) => {
      const words = t
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 2);
      if (!words.length) return false;
      const matched = words.filter((w) => title.includes(w)).length;
      return matched / words.length >= 0.5; // half the words of any target title
    });
    if (!hit) return { ok: false, why: "title not relevant to targets" };
  }

  // Words the owner will not have in a posting. Looked for after the title
  // has been judged, because this is the first thing that opens the
  // description, and most postings never need theirs opened.
  const noGo: string[] = (cfg.no_go_patterns ?? []).filter(Boolean);
  if (noGo.length) {
    const blob = `${title}\n${(job.description ?? "").slice(0, 4000)}`.toLowerCase();
    for (const pat of noGo) {
      if (blob.includes(pat.toLowerCase())) return { ok: false, why: `no-go pattern: ${pat}` };
    }
  }

  // Salary floor — jobs with no stated salary always pass, because most
  // postings omit it and filtering them would delete the majority of the market.
  const { min, max } = parseSalary(job.salary_text);
  const floor = cfg.salary_floor ?? 0;
  if (floor > 0 && min != null) {
    if ((max ?? min) < floor) return { ok: false, why: `below salary floor` };
  }

  // Location
  //
  // When a radius is set, distance decides and this string match must not
  // run. Two location filters in series is not twice as safe, it is just the
  // stricter one winning silently — and the stricter one here is the string
  // match, which is exactly what the radius was added to replace. With
  // locations = ["Princeton, NJ"] it rejects a job 20 miles away in Edison
  // because "edison" does not contain "princeton", before anything has
  // measured how far away Edison actually is. It also rejected all 107
  // Target postings on the first live run, which is how this was found.
  const radiusSet = Number(cfg.radius_miles ?? 0) > 0;

  const locs: string[] = radiusSet ? [] : (cfg.locations ?? []);
  if (locs.length && job.location) {
    const loc = job.location.toLowerCase();
    const remoteOk = cfg.remote_ok !== false;
    const isRemote = job.remote || REMOTE_RE.test(loc);

    if (!(isRemote && remoteOk)) {
      // Compare only against real places. A "Remote" entry in the config
      // describes remote jobs, not a city — matching it against an on-site
      // job let every location through, which silently defeated the filter.
      const cities = locs
        .filter((l) => !REMOTE_RE.test(l))
        .map((l) => l.toLowerCase().split(",")[0].trim())
        .filter(Boolean);

      if (cities.length === 0) {
        // Config is remote-only and this job is not remote.
        return { ok: false, why: `not remote: ${job.location}` };
      }
      if (!cities.some((city) => loc.includes(city))) {
        return { ok: false, why: `location: ${job.location}` };
      }
    }
  }

  return { ok: true };
}

// --------------------------------------------------------------------------
// runner (ported from the discover edge function; runs on this site's server)
// --------------------------------------------------------------------------
export async function runDiscover(supabase: any, opts: { since?: string | undefined } = {}) {
  const { data: run } = await supabase.from("runs").insert({ kind: "discover" }).select().single();
  const stats = {
    found: 0,
    kept: 0,
    inserted: 0,
    filtered: 0,
    errors: 0,
    backfilled: 0,
    pruned: 0,
  };
  const bySource: Record<string, number> = {};
  // Filtered jobs are not stored, so without a tally of the reasons a run can
  // report that it dropped 2,662 postings and nothing about why.
  const byReason: Record<string, number> = {};
  const bump = (why: string) => {
    byReason[why] = (byReason[why] ?? 0) + 1;
  };

  // A state centroid can sit a few hundred miles from a city in the same
  // state, so a coarse estimate only rejects well outside that error. It is
  // there to discard Bangalore and Minneapolis, not to make fine calls.
  const STATE_SLACK_MI = 400;
  const problems: string[] = [];
  try {
    const { data: cfg } = await supabase.from("search_config").select("*").eq("id", 1).single();
    if (!cfg) throw new Error("search_config row missing");
    // Titles are optional. With none set, the title filter does not run and
    // scoring decides everything — which is the point of the match threshold.
    // The warning stays, because the global feeds really do return thousands
    // of unrelated postings and the scorer then spends quota reading them.
    if (!cfg.titles?.length) {
      // Read them off the resume rather than asking for them.
      //
      // A new account uploads a resume and has no target titles, so either
      // every posting on earth gets scored or nothing matches — and the
      // first run is the one thing that has to work without anyone being
      // told. The resume already says what this person can be hired for:
      // someone who has run a business has done hiring, budgeting and vendor
      // management; a cashier has done escalation and inventory. None of
      // that is visible from their job titles, which is exactly why asking
      // someone to list their own targets undershoots.
      const { data: p0 } = await supabase
        .from("profile")
        .select("resume_text,target_role,current_company")
        .eq("id", 1)
        .single();

      const generated = p0?.resume_text
        ? suggestTitles({
            resume: p0.resume_text,
            profile: p0,
            exclude: [...(cfg.exclude_titles ?? []), ...(cfg.no_go_patterns ?? [])],
            limit: 75,
          })
        : [];

      if (generated.length) {
        await supabase
          .from("search_config")
          .update({ titles: generated, updated_at: new Date().toISOString() })
          .eq("id", 1);
        cfg.titles = generated;
        problems.push(
          `No job titles were set, so ${generated.length} were read from the resume. ` +
            `Edit them in Settings; this only happens while the list is empty.`,
        );
      } else {
        // Nothing to look for, and nothing to apply with. Taking in every
        // posting from every employer was allowed here once; for a workspace
        // that has only just been made it is tens of thousands of rows, more
        // than one request can hold, and it took the whole request down with
        // it. A new workspace waits for a resume or a list of titles.
        const message = "Nothing to look for yet: add a resume or job titles in Settings, and the next round starts finding postings.";
        await supabase
          .from("runs")
          .update({ status: "done", message, ended_at: new Date().toISOString() })
          .eq("id", run!.id);
        return { ok: true as const, ...stats, by_source: {}, message, employers: 0, unreached: 0, stale: 0 };
      }
    }
    const enabled: string[] = cfg.sources ?? [];
    const all: Job[] = [];

    // A run has to come back. Each request below is bounded on its own, but
    // employers x search terms x pages is not, and against a host that
    // refuses this address every one of those pays its full timeout before
    // failing. That is a panel reading "running" for ten minutes.
    // Thirty-two seconds, not forty: with the measuring that follows, rounds
    // were coming back at fifty and the host ends a request not long after.
    // Twenty-four, where it was thirty-two: with a wider search there is more
    // to measure and save after the reading, rounds were coming back at
    // seventy seconds, and the host was ending some. A round reads fewer
    // employers and the sweep asks for more rounds.
    const runDeadline = Date.now() + 24_000;

    // Which search terms this run uses.
    //
    // Three terms per run is a real budget: Workday asks once per term, three
    // pages deep, so one employer is nine requests and a batch of eight is
    // what pushed a run past the host's limit. The cap is right. Taking the
    // same three every time is not — the resume generates 75 titles and 72 of
    // them had never been searched once, so the whole point of reading target
    // roles off a resume was lost one line after it was built.
    //
    // The window walks the list instead, on the clock rather than on a stored
    // cursor: a column would need a migration, and discovery has to keep
    // rotating unattended, which the clock does by itself. Six hours advances
    // between the two daily sweeps and over a few days covers every title.
    // Two manual runs minutes apart do search the same terms, which is
    // harmless — nothing new has been posted in between either.
    const allTitles: string[] = cfg.titles ?? [];
    const TERMS_PER_RUN = 3;
    const searchTerms = (() => {
      if (allTitles.length <= TERMS_PER_RUN) return allTitles;
      const window = Math.floor(Date.now() / 21_600_000) * TERMS_PER_RUN;
      return Array.from(
        { length: TERMS_PER_RUN },
        (_, i) => allTitles[(window + i) % allTitles.length],
      );
    })();
    if (allTitles.length > TERMS_PER_RUN) {
      console.log(
        `discover: searching ${searchTerms.length} of ${allTitles.length} titles this run — ` +
          JSON.stringify(searchTerms),
      );
    }

    // Least recently pulled first, so a run that stops early still makes
    // progress rather than re-pulling the same employers and never reaching
    // the rest.
    const { data: companies } = await supabase
      .from("companies")
      .select("*")
      .eq("enabled", true)
      .order("last_pulled", { ascending: true, nullsFirst: true });
    const fetchers: Record<string, (t: string, n: string) => Promise<Job[]>> = {
      greenhouse,
      lever,
      ashby,
      workable,
    };

    // Workday needs the tenant, the pod and the site id rather than a single
    // board token, so it is dispatched from the company row itself. This one
    // fetcher reaches the careers portals of most large employers — Target,
    // BlackRock, Walmart and several thousand others run Workday under their
    // own branding rather than building anything of their own.
    const pullOne = (c: any): Promise<Job[]> => {
      if (c.ats === "workday") {
        if (!c.site) {
          return Promise.reject(
            new Error("missing Workday site id — re-add this company from its careers URL"),
          );
        }
        return fetchWorkday(
          { tenant: c.token, pod: c.pod ?? "wd1", site: c.site, name: c.name },
          // Three titles, as remotive and usajobs already do. Workday asks
          // once per term, three pages deep — so ten titles is thirty requests
          // for one employer, and eight of those in a batch is what pushed a
          // run past the host's limit.
          searchTerms,
        );
      }
      return fetchers[c.ats]?.(c.token, c.name) ?? Promise.resolve([]);
    };

    // A deadline checked between batches does not bound a batch already in
    // flight, and one slow employer held eight others with it. The host kills
    // a request that runs too long — Cloudflare 1102, which arrives as a 503
    // with nothing in it — so every employer gets its own ceiling.
    const PER_COMPANY_MS = 20_000;
    const pull = (c: any): Promise<Job[]> =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`took longer than ${PER_COMPANY_MS / 1000}s`)),
          PER_COMPANY_MS,
        );
        pullOne(c).then(
          (jobs) => {
            clearTimeout(timer);
            resolve(jobs);
          },
          (e) => {
            clearTimeout(timer);
            reject(e);
          },
        );
      });

    // Postings are judged as they arrive, employer by employer, and only the
    // ones that pass are held. A round used to hold every posting it read —
    // nine thousand, each with its whole description — until all the reading
    // was done, and a new person's rounds were ended by the host partway
    // through the reading. What is turned away is counted and let go at once.
    let foundSoFar = 0;
    const judged = new Set<string>();
    const take = (jobs: Job[]) => {
      foundSoFar += jobs.length;
      for (const j of jobs) {
        if (!j.url || judged.has(j.url)) continue;
        const verdict = keep(j, cfg);
        if (!verdict.ok) {
          judged.add(j.url);
          stats.filtered++;
          bump((verdict.why ?? "filtered").replace(/:.*$/, "").trim());
          continue;
        }
        if (j.posted_at) {
          const up = new Date(j.posted_at).getTime();
          if (Number.isFinite(up) && up < Date.now() - FRESH_DAYS * 86_400_000) {
            judged.add(j.url);
            stats.filtered++;
            bump(`posted more than ${FRESH_DAYS} days ago`);
            continue;
          }
        }
        all.push(j);
      }
    };

    const list = (companies ?? []).filter((c: any) => enabled.includes(c.ats));
    const BATCH = 8;
    // How many employers this run did not get to. Reported, so whoever called
    // can simply call again: with a few hundred employers one bounded request
    // reads a fraction of them, and at two requests a day the rest waited
    // days for their turn while their postings aged out.
    let unreached = 0;
    for (let i = 0; i < list.length; i += BATCH) {
      if (Date.now() > runDeadline) {
        unreached = list.length - i;
        problems.push(
          `Stopped after ${i} of ${list.length} employers to keep this run bounded. ` +
            `The rest are pulled first on the next run — they are ordered by how ` +
            `long it has been since each was last read.`,
        );
        break;
      }
      const slice = list.slice(i, i + BATCH);
      // Where this round has got to, written down before each step of it: a
      // round the host ends leaves no error behind, only this.
      await supabase
        .from("runs")
        .update({ message: `reading ${slice.map((c: any) => `${c.ats}#${c.id}`).join(" ")} (after ${i}, holding ${all.length})` })
        .eq("id", run!.id);
      const results = await Promise.allSettled(slice.map(pull));
      for (let idx = 0; idx < results.length; idx++) {
        const r = results[idx];
        const c = slice[idx];
        if (r.status === "fulfilled") {
          take(r.value);
          bySource[c.ats] = (bySource[c.ats] ?? 0) + r.value.length;
          await supabase
            .from("companies")
            .update({
              last_pulled: new Date().toISOString(),
              job_count: r.value.length,
              last_error: null,
            })
            .eq("id", c.id);
        } else {
          stats.errors++;
          const why = (r.reason as Error)?.message ?? String(r.reason);
          problems.push(`${c.ats}:${c.token} — ${why}`);
          // Surface it on the company row too. A portal that has stopped
          // returning jobs is otherwise indistinguishable from one that has
          // no openings.
          await supabase
            .from("companies")
            .update({ last_error: why.slice(0, 300), last_pulled: new Date().toISOString() })
            .eq("id", c.id);
        }
      }
    }
    const globals: Array<[string, () => Promise<Job[]>]> = [];
    if (enabled.includes("remotive"))
      for (const t of searchTerms) globals.push(["remotive", () => remotive(t)]);
    if (enabled.includes("remoteok")) globals.push(["remoteok", remoteok]);
    // arbeitnow is deliberately gone: it is a German job board, and every
    // posting it returned was in the wrong country for a search measured in
    // miles from New Jersey. A stored preference naming it is simply ignored.
    if (enabled.includes("usajobs"))
      for (const t of searchTerms)
        globals.push(["usajobs", () => usajobs(t, (cfg.locations ?? [])[0])]);
    const gres = await Promise.allSettled(globals.map(([, fn]) => fn()));
    gres.forEach((r, i) => {
      const name = globals[i][0];
      if (r.status === "fulfilled") {
        take(r.value);
        bySource[name] = (bySource[name] ?? 0) + r.value.length;
      } else {
        stats.errors++;
        problems.push(`${name} — ${(r.reason as Error)?.message ?? r.reason}`);
      }
    });
    stats.found = foundSoFar;
    await supabase.from("runs").update({ message: `judging ${all.length} of ${foundSoFar}` }).eq("id", run!.id);
    const seen = new Set<string>();
    const rows: any[] = [];
    for (const j of all) {
      if (!j.url || seen.has(j.url)) continue;
      seen.add(j.url);
      const verdict = keep(j, cfg);
      if (!verdict.ok) {
        stats.filtered++;
        // Group to the kind of reason, not the specific value, or the tally
        // is one entry per job and tells you nothing.
        bump((verdict.why ?? "filtered").replace(/:.*$/, "").trim());
        continue;
      }
      // Fresh postings only: up within the last thirty days (it was
      // fourteen; the owner raised it, and fresh.mjs says why). Built in, not
      // a setting. A posting that gives no date is kept and judged by the
      // applier, which can read the date off the posting page itself.
      if (j.posted_at) {
        const up = new Date(j.posted_at).getTime();
        if (Number.isFinite(up) && up < Date.now() - FRESH_DAYS * 86_400_000) {
          stats.filtered++;
          bump(`posted more than ${FRESH_DAYS} days ago`);
          continue;
        }
      }
      const { min, max } = parseSalary(j.salary_text);
      rows.push({
        url: j.url,
        apply_url: j.apply_url ?? j.url,
        title: j.title,
        company: j.company,
        location: j.location,
        remote: !!j.remote,
        salary_text: j.salary_text,
        salary_min: min,
        salary_max: max,
        // Read when the row is saved, not here: most rows are turned away
        // on where the job is, and never needed their description opened.
        get description() {
          const text = (j.description ?? "").slice(0, 20000);
          Object.defineProperty(this, "description", { value: text, writable: true, enumerable: true, configurable: true });
          return text;
        },
        source: j.source,
        ats: j.ats ?? null,
        posted_at: j.posted_at ?? null,
        status: "new",
      });
    }
    // A round carries only so much. A new person's search has broad titles
    // and no exclusions yet, so thousands of postings pass the tests above
    // where the owner's pass a few dozen — each with its whole description —
    // and the host ended those rounds before they could answer. The newest
    // are carried; the rest belong to employers that are read again.
    //
    // Four hundred was far too few, and in the wrong place: this is counted
    // before a posting's place has been looked at, where the owner's own
    // search has a thousand or more each round — and the cut threw away all
    // but the newest of them, so a day's sweep kept seven where it had kept
    // fifty-four. Descriptions are no longer opened here at all, which was
    // the cost this guarded against; the limit stays only as a ceiling no
    // ordinary round reaches.
    const ROUND_CARRIES = 6000;
    if (rows.length > ROUND_CARRIES) {
      rows.sort((a, b) => String(b.posted_at ?? "").localeCompare(String(a.posted_at ?? "")));
      const over = rows.length - ROUND_CARRIES;
      rows.length = ROUND_CARRIES;
      stats.filtered += over;
      byReason["more than one round carries"] = (byReason["more than one round carries"] ?? 0) + over;
    }
    // The postings themselves are no longer needed, and they are the bulk
    // of what a round holds in memory.
    all.length = 0;
    // ----------------------------------------------------------------------
    // Distance
    // ----------------------------------------------------------------------
    // Matching locations as strings let a "New York" filter admit a job 90
    // miles upstate while rejecting one 14 miles away in Red Bank. Real miles
    // from a real home address is the only version of this that works.
    //
    // Geocoding is rate limited to roughly one call a second, so it runs
    // last — only on postings that already survived every other filter — and
    // every result is cached forever.
    const radius = Number(cfg.radius_miles ?? 0);
    // What is already in the list needs nothing more done to it here: it was
    // measured when it came in, and the pass further down looks over the
    // list itself. A round was found stopped at "measuring 5177" — a new
    // person's search, wide and with no state limit — where each of those
    // was a question put to the database one at a time, nearly all of them
    // about postings saved by an earlier round. Those are taken out first,
    // a hundred addresses to a question, and only what is new goes on.
    let knownAlready = 0;
    const NEW_PER_ROUND = 600;
    let capOff = false;
    let lookedUp = 0;
    if (rows.length) {
      const have = new Set<string>();
      const urls = rows.map((r) => String(r.url));
      const chunks: string[][] = [];
      // Twenty addresses to a question. A hundred made a question too long
      // to be asked at all: it was refused, nothing was found to be known,
      // and the newest six hundred — every one already in the list — were
      // carried while what was really new was left behind. A question that
      // fails is now counted, and where any did, nothing is left behind on
      // the strength of an answer that never came.
      for (let i = 0; i < urls.length; i += 20) chunks.push(urls.slice(i, i + 20));
      let unanswered = 0;
      for (let i = 0; i < chunks.length; i += 10) {
        await Promise.all(
          chunks.slice(i, i + 10).map(async (c) => {
            const { data, error } = await supabase.from("jobs").select("url").in("url", c);
            if (error || !data) {
              unanswered++;
              return;
            }
            for (const d of data) have.add(String(d.url));
          }),
        );
      }
      if (unanswered) byReason["questions about the list that went unanswered"] = unanswered;
      if (unanswered) problems.push(`${unanswered} of ${chunks.length} questions about what is already in the list went unanswered`);
      if (have.size) {
        const fresh = rows.filter((r) => !have.has(String(r.url)));
        knownAlready = rows.length - fresh.length;
        rows.length = 0;
        rows.push(...fresh);
      }
      // And of what is new, only so much is carried by one round: the
      // newest, with the rest left for the next round to find still new.
      //
      // The limit is on what has to be looked up, and is kept further down,
      // where the looking up is. Kept here, on everything new, it was filled
      // round after round by the same postings: remote ones for a person who
      // takes none, and ones in other states — turned away below for
      // nothing, never saved, and so new again next round and first in the
      // line again. Thirteen rounds in a row saved nothing while a thousand
      // new postings waited behind them.
      if (rows.length > NEW_PER_ROUND) {
        rows.sort((a, b) => String(b.posted_at ?? "").localeCompare(String(a.posted_at ?? "")));
      }
      capOff = unanswered > 0;
    }
    await supabase.from("runs").update({ message: `measuring ${rows.length} new (${knownAlready} already in the list)` }).eq("id", run!.id);
    if (radius > 0) {
      const { data: profile } = await supabase
        .from("profile")
        .select("id, home_city, home_lat, home_lon, city, state")
        .limit(1)
        .maybeSingle();

      let home =
        profile?.home_lat != null && profile?.home_lon != null
          ? { lat: profile.home_lat, lon: profile.home_lon }
          : null;

      // Resolve home once, then remember it.
      if (!home && profile) {
        const where = profile.home_city || [profile.city, profile.state].filter(Boolean).join(", ");
        if (where) {
          home = await geocode(supabase, where);
          if (home) {
            await supabase
              .from("profile")
              .update({
                home_lat: home.lat,
                home_lon: home.lon,
                home_city: profile.home_city ?? where,
              })
              .eq("id", profile.id);
          }
        }
      }

      // Prefer the stored state; fall back to the profile's own.
      // The home CITY decides the home state, not profile.state. Someone who
      // lives in California and searches around Las Vegas wants Nevada, and
      // "same state" has to mean the state they are searching from.
      const fromCity = String(profile?.home_city ?? "").match(/[,\s]([A-Za-z]{2})\s*$/)?.[1];
      const homeState =
        (fromCity || profile?.home_state || profile?.state || "")
          .trim()
          .toUpperCase()
          .slice(0, 2) || null;
      // Keep the stored value in step, so the panel's label follows the city.
      if (homeState && profile?.home_state !== homeState && profile?.id) {
        await supabase.from("profile").update({ home_state: homeState }).eq("id", profile.id);
      }

      if (!home) {
        problems.push(
          "Distance filter skipped: no home address set. Add your city in Settings → Search.",
        );
      } else {
        // Nominatim allows about one request a second, so a run cannot look up
        // every unseen place. Cached places are free, which after a few runs
        // is nearly all of them, so the budget only limits genuinely new ones
        // and the backlog clears over successive runs instead of timing out
        // one of them.
        let netLookups = 0;
        const MAX_NET_LOOKUPS = 60;
        // A count is not a bound on time. Nominatim's own rule is one request
        // a second, which this honours with a 1.1s pause after each — so
        // sixty lookups cost at least a minute of sleeping before any of them
        // has answered, and a few slow replies on top turned a discovery run
        // into ten minutes of "running" with nothing to show.
        //
        // The budget is wall-clock, and running out is not a failure: an
        // unmeasured place comes back "deferred" and is measured on a later
        // run, which is what that status already exists for.
        const geocodeDeadline = Date.now() + 10_000;
        // Three outcomes, not two. "Could not resolve this place" and "ran out
        // of budget before trying" both used to come back as null, so a
        // genuinely unresolvable location was treated as merely unmeasured
        // and survived strict mode — which is how a Stripe job listed as
        // "Seattle or San Francisco" stayed in a 25-mile list.
        type Located =
          | { status: "found"; point: { lat: number; lon: number } }
          | { status: "miss" }
          | { status: "deferred" };

        const asked = new Map<string, Promise<Located>>();
        const locate = (place: string): Promise<Located> => {
          const key = place.trim().toLowerCase();
          let answer = asked.get(key);
          if (!answer) {
            answer = locateOnce(place);
            asked.set(key, answer);
          }
          return answer;
        };
        const locateOnce = async (place: string): Promise<Located> => {
          const cached = await cachedGeocode(supabase, place);
          if (cached) return { status: "found", point: cached };
          if (cached === null) return { status: "miss" }; // looked up before, no result
          if (netLookups >= MAX_NET_LOOKUPS || Date.now() > geocodeDeadline) {
            return { status: "deferred" };
          }
          netLookups++;
          const fresh = await geocode(supabase, place);
          return fresh ? { status: "found", point: fresh } : { status: "miss" };
        };

        const keptRows: any[] = [];
        for (const row of rows) {
          // Settle the obvious cases offline, before spending a lookup.
          // Bangalore and Minneapolis are not within 25 miles of New Jersey
          // and never needed a network call to prove it. Without this, the
          // rate limit meant most postings were never measured at all — and
          // unmeasured ones are kept, so a 25-mile search returned India.
          //
          // Read before the remote branch, not after: remote postings need
          // the country from it too.
          const coarse = coarsePlace(row.location, home.lat, home.lon);

          const isRemote = !!row.remote || REMOTE_RE.test(row.location ?? "");
          if (isRemote) {
            // A remote job has no distance to measure. Whether to keep it is
            // a separate choice from how far you will travel.
            if (cfg.include_remote === false) {
              stats.filtered++;
              bump("remote, and remote work is switched off");
              continue;
            }
            // Remote is not the same as anywhere. A remote role advertised in
            // Germany cannot be worked from New Jersey, and this branch used
            // to return before any country check ran at all — which is how
            // German postings survived a 25-mile search.
            if (coarse.basis === "non-us" && cfg.same_country_only !== false) {
              row.skip_reason = `outside the US: ${row.location}`;
              stats.filtered++;
              bump("outside the US");
              continue;
            }
            keptRows.push(row);
            continue;
          }

          // Same-state is a stricter cut than the radius and costs nothing:
          // the state is already read off the string, so this needs no
          // geocoder call at all.
          if (homeState && cfg.same_state_only === true) {
            if (coarse.basis === "non-us" || (coarse.state && coarse.state !== homeState)) {
              row.skip_reason = `outside ${homeState}: ${row.location}`;
              stats.filtered++;
              bump(`outside ${homeState}`);
              continue;
            }
            // A posting with no state at all cannot be shown to be in it.
            if (!coarse.state && cfg.include_unknown_location === false) {
              stats.filtered++;
              bump("no state given");
              continue;
            }
          }

          if (coarse.basis !== "unknown" && coarse.miles > radius + STATE_SLACK_MI && !(coarse.basis === "non-us" && cfg.same_country_only === false)) {
            row.skip_reason =
              coarse.basis === "non-us"
                ? `outside the US: ${row.location}`
                : `${coarse.state} is far beyond ${radius} mi`;
            stats.filtered++;
            bump(coarse.basis === "non-us" ? "outside the US" : "wrong state");
            continue;
          }

          // Only so many are looked up in one round, the newest first; the
          // rest are new again next round, when these have been saved.
          if (!capOff && lookedUp >= NEW_PER_ROUND) {
            stats.filtered++;
            bump("new, and left for the next round");
            continue;
          }
          lookedUp++;
          const place = cleanLocation(row.location);
          const found = place ? await locate(place) : ({ status: "miss" } as const);

          if (found.status !== "found") {
            // A deferred lookup is not the same as an unmeasurable one. Keep
            // it either way here — it is a new posting, and the reconcile pass
            // measures it on a later run rather than discarding it unseen.
            if (found.status === "miss" && cfg.include_unknown_location === false) {
              stats.filtered++;
              bump("location unknown");
              continue;
            }
            keptRows.push(row);
            continue;
          }
          const point = found.point;

          const miles = Math.round(milesBetween(home.lat, home.lon, point.lat, point.lon));
          row.lat = point.lat;
          row.lon = point.lon;
          row.distance_miles = miles;

          // Three miles of give: a posting a mile past the line is not a
          // different commute.
          if (miles > radius + 3) {
            stats.filtered++;
            bump(`over ${radius} mi`);
            continue;
          }
          keptRows.push(row);
        }
        rows.length = 0;
        rows.push(...keptRows);

        // Reconcile the jobs already in the list.
        //
        // New rows are inserted with ignoreDuplicates, so nothing already
        // stored is ever rewritten. That left the list holding jobs from
        // before the radius existed — the live run reported a maximum
        // distance of 8,570 miles under a 25-mile setting, because the filter
        // only ever judged new postings.
        //
        // A radius that applies to new jobs but not the list is not a radius.
        // So each run also measures what is already there and takes anything
        // beyond the limit out of the queue.
        //
        // Only jobs not yet acted on are touched. An application already sent
        // is history and stays exactly as it is, whatever its distance.
        // needs_help belongs here too. A posting the applier got stuck on is
        // still a live candidate, and it stays in the set the inbox matcher
        // searches — so a German listing parked there went on matching mail
        // long after it should have been cut.
        const LIVE = ["new", "review", "queued", "needs_help"];

        const { data: stale } = await supabase
          .from("jobs")
          .select("id, location, distance_miles")
          .in("status", LIVE)
          // not(is true) rather than eq(false), so a row whose remote flag was
          // never written is still measured.
          .not("remote", "is", true)
          .limit(3000);

        // Remote rows are excluded above because there is no distance to
        // measure — which left them never re-examined at all. A remote job
        // still has one measurable thing, and it is the one that matters:
        // which country it is in. Copenhagen is not commutable from New
        // Jersey and is not legally workable from it either.
        const { data: remoteStale } = await supabase
          .from("jobs")
          .select("id, location")
          .in("status", LIVE)
          .is("remote", true)
          .limit(3000);

        // Group by location string. Thousands of postings share a few hundred
        // towns, so this costs a few hundred lookups and one UPDATE per town
        // rather than one of each per job.
        const byPlace = new Map<string, string[]>();
        const unmeasurable: string[] = [];
        const tooFarOffline: Array<{ id: string; why: string }> = [];

        for (const job of stale ?? []) {
          const coarse = coarsePlace(job.location, home.lat, home.lon);

          if (homeState && cfg.same_state_only === true) {
            // A job in Germany has no state at all, so a check that requires
            // one to be set lets every foreign posting through. That is why
            // German listings survived "only jobs in NJ".
            if (coarse.basis === "non-us" && cfg.same_country_only !== false) {
              tooFarOffline.push({ id: job.id, why: `outside the US: ${job.location}` });
              continue;
            }
            if (coarse.state && coarse.state !== homeState) {
              tooFarOffline.push({ id: job.id, why: `outside ${homeState}: ${job.location}` });
              continue;
            }
            if (!coarse.state && cfg.include_unknown_location === false) {
              tooFarOffline.push({ id: job.id, why: `no state given: ${job.location}` });
              continue;
            }
          }

          if (coarse.basis !== "unknown" && coarse.miles > radius + STATE_SLACK_MI) {
            tooFarOffline.push({
              id: job.id,
              why:
                coarse.basis === "non-us"
                  ? `outside the US: ${job.location}`
                  : `${coarse.state} is far beyond ${radius} mi`,
            });
            continue;
          }
          const place = cleanLocation(job.location);
          if (!place) {
            // Includes rows that were given a bogus distance earlier, when
            // "In-Office" and "N/A" were still being sent to the geocoder.
            unmeasurable.push(job.id);
            continue;
          }
          const ids = byPlace.get(place) ?? [];
          ids.push(job.id);
          byPlace.set(place, ids);
        }

        const park = async (ids: string[], why: string) => {
          for (let i = 0; i < ids.length; i += 200) {
            await supabase
              .from("jobs")
              .update({ status: "skipped", skip_reason: why })
              .in("id", ids.slice(i, i + 200))
              .in("status", LIVE);
          }
          stats.pruned += ids.length;
        };

        for (const job of remoteStale ?? []) {
          if (coarsePlace(job.location, home.lat, home.lon).basis === "non-us") {
            tooFarOffline.push({ id: job.id, why: `outside the US: ${job.location}` });
          }
        }

        const farByReason = new Map<string, string[]>();
        for (const item of tooFarOffline) {
          const ids = farByReason.get(item.why) ?? [];
          ids.push(item.id);
          farByReason.set(item.why, ids);
        }
        for (const [why, ids] of farByReason) await park(ids, why);

        if (unmeasurable.length) {
          // Clear any distance these were wrongly given before parking them.
          for (let i = 0; i < unmeasurable.length; i += 200) {
            await supabase
              .from("jobs")
              .update({ lat: null, lon: null, distance_miles: null })
              .in("id", unmeasurable.slice(i, i + 200));
          }
          if (cfg.include_unknown_location === false) {
            await park(unmeasurable, "no usable location");
          }
        }

        for (const [place, ids] of byPlace) {
          const found = await locate(place);

          if (found.status === "deferred") {
            // Budget ran out before reaching this town. Leave it for the next
            // run rather than parking a job that may well be nearby.
            continue;
          }
          if (found.status === "miss") {
            // The geocoder has seen this string and cannot place it. That is
            // settled, not pending, so strict mode acts on it.
            //
            // It is no longer set aside here, though. This looks a place up
            // once, as it is written; the runner's measuring (measure.mjs)
            // takes a location apart — several places in one line, a town
            // without its building or its street — and finds many that this
            // cannot. One morning 177 postings were set aside here as
            // unplaceable before that had been tried. Left unmeasured, they
            // go to the runner, which sets aside what it cannot place either.
            continue;
          }

          const point = found.point;
          const miles = Math.round(milesBetween(home.lat, home.lon, point.lat, point.lon));
          for (let i = 0; i < ids.length; i += 200) {
            await supabase
              .from("jobs")
              .update({ lat: point.lat, lon: point.lon, distance_miles: miles })
              .in("id", ids.slice(i, i + 200));
          }
          stats.backfilled += ids.length;
          if (miles > radius + 3) await park(ids, `${miles} mi away (limit ${radius})`);
        }

        if (netLookups >= MAX_NET_LOOKUPS || Date.now() > geocodeDeadline) {
          problems.push(
            netLookups >= MAX_NET_LOOKUPS
              ? `Geocoder budget reached (${MAX_NET_LOOKUPS} new places this run). ` +
                `Remaining locations resolve on the next run.`
              : `Geocoder ran out of time after ${netLookups} new place(s). The service ` +
                `allows one lookup a second, so a long backlog takes several runs. ` +
                `Remaining locations resolve on the next run.`,
          );
        }
      }
    }

    stats.kept = rows.length + knownAlready;
    await supabase.from("runs").update({ message: `saving ${rows.length}` }).eq("id", run!.id);
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const { data, error } = await supabase
        .from("jobs")
        .upsert(chunk, { onConflict: "url", ignoreDuplicates: true })
        .select("id");
      if (error) {
        stats.errors++;
        problems.push(`insert: ${error.message}`);
      } else stats.inserted += data?.length ?? 0;
    }
    const message =
      stats.inserted > 0
        ? `${stats.inserted} new jobs from ${Object.keys(bySource).length} sources`
        : stats.found === 0
          ? "No sources returned any jobs. Check Settings → Companies has entries, and that your enabled sources are correct."
          : stats.kept > 0
            ? `Found ${stats.found} postings, kept ${stats.kept}, all already in your list — nothing new.`
            : `Found ${stats.found} postings but kept 0 — every one was filtered out. Most likely your job titles are too specific, or your exclude list is too broad.`;
    await supabase
      .from("runs")
      .update({
        status: "done",
        found: stats.found,
        processed: stats.inserted,
        errors: stats.errors,
        detail: {
          by_source: bySource,
          kept: stats.kept,
          filtered: stats.filtered,
          filtered_by: byReason,
          backfilled: stats.backfilled,
          pruned: stats.pruned,
          radius_miles: radius,
          problems: problems.slice(0, 20),
        },
        message,
        ended_at: new Date().toISOString(),
      })
      .eq("id", run!.id);
    // Of the employers this request did not get to, how many have not been
    // read since the caller started asking. Each request begins again at the
    // least recently read, so "not reached this time" never falls to zero on
    // its own; "not read since you began" does, and is when to stop.
    const sinceMs = opts.since ? Date.parse(opts.since) : NaN;
    const stale = Number.isFinite(sinceMs)
      ? list
          .slice(list.length - unreached)
          .filter((c: any) => !c.last_pulled || Date.parse(c.last_pulled) < sinceMs).length
      : unreached;
    return {
      ok: true as const,
      ...stats,
      by_source: bySource,
      filtered_by: byReason,
      message,
      employers: list.length,
      unreached,
      stale,
    };
  } catch (e) {
    const message = String((e as Error)?.message ?? e);
    await supabase
      .from("runs")
      .update({
        status: "error",
        message,
        errors: stats.errors + 1,
        ended_at: new Date().toISOString(),
      })
      .eq("id", run!.id);
    return { ok: false as const, error: message, message };
  }
}
