/* eslint-disable @typescript-eslint/no-explicit-any */
// ============================================================================
// ats-probe.server.ts — find an employer's job board by asking, not reading.
//
// Scraping the careers page resolved 67 of 402 large employers. 236 failed
// with "no supported ATS found on the page", which is the signature of a
// careers site rendered by JavaScript: the Workday link is not in the HTML
// the server sends, it is injected by scripts we never run. Another 29
// returned 403, because a plain fetch of a marketing page looks like a bot.
//
// Reading the page was the wrong primary strategy. Every one of these
// platforms has a public endpoint that answers a yes/no question directly:
//
//   greenhouse       boards-api.greenhouse.io/v1/boards/{token}/jobs
//   lever            api.lever.co/v0/postings/{token}?mode=json
//   ashby            api.ashbyhq.com/posting-api/job-board/{token}
//   smartrecruiters  api.smartrecruiters.com/v1/companies/{token}/postings
//   workday          the bare tenant host redirects to its default site
//
// So instead of parsing marketing HTML, this guesses the token and asks the
// board whether it exists. No rendering, no bot defences, and the answer is
// definitive rather than inferred.
//
// The best guess is usually not the company's name but its careers domain:
// careers.deere.com is "deere", jobs.tjx.com is "tjx". Marketing sites get
// renamed; the board token rarely does.
// ============================================================================

import type { AtsTarget } from "@/lib/careers";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const TIMEOUT_MS = 9000;

/** Pods in rough order of how many tenants sit on each. */
const PODS = ["wd1", "wd5", "wd3", "wd12", "wd103", "wd101"];

const CORP_WORDS =
  /\b(inc|llc|ltd|limited|corp|corporation|company|co|group|holdings|plc|the|and|of|international|global|worldwide|technologies|industries)\b/g;

/**
 * Candidate board tokens for an employer, best guess first.
 *
 * The careers hostname comes first on purpose. "careers.adm.com" gives "adm"
 * where the company name gives "archerdanielsmidland", and the board almost
 * always follows the domain.
 */
export function candidateTokens(name: string, careersUrl: string): string[] {
  const out: string[] = [];
  const add = (t: string | undefined | null) => {
    const v = (t ?? "").trim().toLowerCase();
    if (v.length >= 2 && v.length <= 40 && !out.includes(v)) out.push(v);
  };

  try {
    const host = new URL(careersUrl).hostname.toLowerCase();
    const labels = host.split(".").filter(Boolean);
    // Drop the public suffix and the usual careers prefixes, leaving the brand.
    const brand = labels
      .filter(
        (l) =>
          !/^(www|careers?|jobs|apply|talent|work|recruiting|corporate|about|my|search|hire|join)$/.test(
            l,
          ),
      )
      .filter((l) => !/^(com|org|net|io|co|us|jobs|careers|gov|edu)$/.test(l))
      .filter((l) => l.length > 1);
    if (brand.length) add(brand[0]);
  } catch {
    /* a malformed URL just means one fewer guess */
  }

  const slug = name
    .toLowerCase()
    .replace(CORP_WORDS, " ")
    .replace(/[^a-z0-9]+/g, "");
  add(slug);

  const hyphen = name
    .toLowerCase()
    .replace(CORP_WORDS, " ")
    .trim()
    .replace(/[^a-z0-9]+/g, "-");
  add(hyphen.replace(/^-+|-+$/g, ""));

  return out.slice(0, 3);
}

async function get(url: string, accept = "application/json"): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: accept,
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      signal: controller.signal,
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Does this board exist AND have postings? An empty board is not a find. */
async function boardHasJobs(ats: AtsTarget["ats"], token: string): Promise<boolean> {
  const urls: Record<string, string> = {
    greenhouse: `https://boards-api.greenhouse.io/v1/boards/${token}/jobs`,
    lever: `https://api.lever.co/v0/postings/${token}?mode=json&limit=1`,
    ashby: `https://api.ashbyhq.com/posting-api/job-board/${token}`,
    smartrecruiters: `https://api.smartrecruiters.com/v1/companies/${token}/postings?limit=1`,
  };
  const url = urls[ats];
  if (!url) return false;

  const res = await get(url);
  if (!res || !res.ok) return false;

  try {
    const data: any = await res.json();
    if (ats === "greenhouse") return Array.isArray(data?.jobs) && data.jobs.length > 0;
    if (ats === "lever") return Array.isArray(data) && data.length > 0;
    if (ats === "ashby") return Array.isArray(data?.jobs) && data.jobs.length > 0;
    if (ats === "smartrecruiters") return Number(data?.totalFound ?? 0) > 0;
  } catch {
    return false;
  }
  return false;
}

/**
 * Ask a Workday tenant where its job site lives.
 *
 * The bare tenant host redirects to its default site, so the landing URL
 * carries the site id — the one value that cannot be guessed and the reason
 * a hand-written tenant list is not worth writing.
 */
async function workdaySite(
  tenant: string,
  pod: string,
  trace?: string[],
): Promise<AtsTarget | null> {
  const res = await get(`https://${tenant}.${pod}.myworkdayjobs.com/`, "text/html");
  if (!res) {
    trace?.push(`${pod}:no-response`);
    return null;
  }
  // Record what actually came back. The first probing run added forty
  // employers across four board APIs and not one Workday tenant, which says
  // this request does not do what it was assumed to do — and without the
  // status and landing URL there is no way to tell whether the tenant is
  // wrong, the pod is wrong, or a bare host simply does not redirect.
  trace?.push(`${pod}:${res.status}${res.url ? ` -> ${res.url.slice(0, 90)}` : ""}`);
  if (!res.ok) return null;

  const match = res.url.match(
    /^https?:\/\/([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([A-Za-z0-9_-]+)/,
  );
  if (!match) return null;

  const [, foundTenant, foundPod, site] = match;
  if (!foundTenant || !foundPod || !site) return null;
  return { ats: "workday", token: foundTenant, pod: foundPod, site };
}

export type ProbeResult =
  { ok: true; target: AtsTarget; how: string } | { ok: false; tried: number; detail: string };

/**
 * Try to identify an employer's board without reading its careers page.
 *
 * Ordered cheapest and most likely first, and stops at the first hit, so a
 * Greenhouse employer costs one request while a miss costs the full set.
 */
export async function probeAts(name: string, careersUrl: string): Promise<ProbeResult> {
  // Two guesses, not three. A third rarely adds a hit and every extra guess
  // multiplies the cost of the far more common case: an employer on a
  // platform we cannot read at all.
  const tokens = candidateTokens(name, careersUrl).slice(0, 2);
  let tried = 0;
  const trace: string[] = [];

  // Workday first: it is what most large employers run, and one hit settles
  // tenant, pod and site together. All pods for a token go out at once —
  // sequentially this is six round-trips per guess, and at four hundred
  // employers that is the difference between minutes and hours.
  for (const token of tokens) {
    tried += PODS.length;
    const results = await Promise.all(
      PODS.map((pod) => workdaySite(token, pod, tokens[0] === token ? trace : undefined)),
    );
    const hit = results.find((r): r is AtsTarget => r !== null);
    if (hit) return { ok: true, target: { ...hit, name }, how: `workday ${hit.pod}` };
  }

  const BOARDS = ["greenhouse", "lever", "ashby", "smartrecruiters"] as const;
  for (const token of tokens) {
    tried += BOARDS.length;
    const results = await Promise.all(
      BOARDS.map(async (ats) => ((await boardHasJobs(ats, token)) ? ats : null)),
    );
    const hit = results.find((r): r is (typeof BOARDS)[number] => r !== null);
    if (hit) {
      return { ok: true, target: { ats: hit, token, name }, how: `${hit} board api` };
    }
  }

  return {
    ok: false,
    tried,
    detail: `tokens=[${tokens.join(",")}] workday[${trace.join(" ")}]`.slice(0, 400),
  };
}
