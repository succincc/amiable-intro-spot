// ============================================================================
// ats-detect.server.ts — work out which system is behind a careers page.
//
// A list of employers is only useful if each entry resolves to something we
// can actually pull jobs from, and that is the part nobody can get right by
// hand. "jobs.target.com" is a Workday tenant, "careers.ibm.com" is not, and
// which pod a tenant sits on (wd1, wd5, wd103) is not guessable at all.
//
// So the seed list holds the one thing that is easy to be right about — the
// company's own careers address — and this resolves the rest by following
// where that address actually goes. A redirect chain ending at
// "target.wd5.myworkdayjobs.com/targetcareers" answers tenant, pod and site
// at once; where there is no redirect, the ATS almost always appears in the
// page's own markup, because the listings are embedded or linked.
// ============================================================================

import { parseCareersUrl, type AtsTarget } from "@/lib/careers";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** ATS addresses as they appear in a careers page's markup. */
const PATTERNS: RegExp[] = [
  /https?:\/\/[a-z0-9-]+\.wd\d+\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?[A-Za-z0-9_-]+/g,
  /https?:\/\/(?:boards|job-boards)\.greenhouse\.io\/[A-Za-z0-9_-]+/g,
  /https?:\/\/jobs\.lever\.co\/[A-Za-z0-9_-]+/g,
  /https?:\/\/jobs\.ashbyhq\.com\/[A-Za-z0-9_-]+/g,
  /https?:\/\/(?:[a-z0-9-]+\.workable\.com|apply\.workable\.com\/[A-Za-z0-9_-]+)/g,
  /https?:\/\/careers\.smartrecruiters\.com\/[A-Za-z0-9_-]+/g,
];

export type Detection =
  | { ok: true; target: AtsTarget; via: "redirect" | "markup"; finalUrl: string }
  | { ok: false; reason: string; finalUrl?: string };

/**
 * Follow a careers URL and work out what it runs on.
 *
 * Deliberately gives up rather than guessing. A wrong tenant produces a
 * company row that silently returns nothing, which is worse than an entry the
 * list openly reports as unresolved — one can be fixed by pasting the right
 * URL, the other just quietly contributes zero jobs forever.
 */
export async function detectAts(careersUrl: string, name?: string): Promise<Detection> {
  // The address itself may already be an ATS.
  const direct = parseCareersUrl(careersUrl, name);
  if (direct) return { ok: true, target: direct, via: "redirect", finalUrl: careersUrl };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);

  try {
    const res = await fetch(careersUrl, {
      redirect: "follow",
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
      signal: controller.signal,
    });

    // Where it landed after redirects is the strongest signal there is.
    const landed = parseCareersUrl(res.url, name);
    if (landed) return { ok: true, target: landed, via: "redirect", finalUrl: res.url };

    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}`, finalUrl: res.url };

    // Otherwise read the page. Cap it: some careers pages are enormous, and
    // the ATS link is in the markup near the listings, not the footer of a
    // megabyte of inlined JSON.
    const html = (await res.text()).slice(0, 400_000);

    for (const pattern of PATTERNS) {
      const matches = html.match(pattern);
      if (!matches) continue;
      for (const hit of matches) {
        const parsed = parseCareersUrl(hit, name);
        if (parsed) return { ok: true, target: parsed, via: "markup", finalUrl: res.url };
      }
    }

    return { ok: false, reason: "no supported ATS found on the page", finalUrl: res.url };
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    return { ok: false, reason: msg === "The operation was aborted." ? "timed out" : msg };
  } finally {
    clearTimeout(timer);
  }
}
