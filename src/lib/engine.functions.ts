import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** RUN DISCOVERY — pulls every enabled free feed into `jobs`. */
/**
 * The signed-in person's own client, for code that was written when there
 * was one person: every "only one" rule it asks for is asked per person.
 * The database already limits this client to the person's own rows.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function mine(context: { supabase: unknown; userId: string }): Promise<any> {
  const { forUser } = await import("@/lib/scope.server");
  return forUser(context.supabase, context.userId);
}

export const runDiscovery = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { runDiscover } = await import("@/lib/discover.server");
    return runDiscover(await mine(context));
  });

/** RUN SCORING — rates new jobs and tailors resumes for queued ones. */
export const runScoring = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { runScore } = await import("@/lib/score.server");
    return runScore(await mine(context));
  });

/**
 * ADD A COMPANY FROM ITS CAREERS URL.
 *
 * Large employers do not build their own application systems — they rent one
 * and brand it. So "apply through hundreds of company careers portals" is not
 * hundreds of scrapers: it is six APIs plus a URL parser. Paste the address
 * of any company's jobs page and this works out what is behind it, which
 * means no registry to maintain and nothing that silently rots when a company
 * changes its site id.
 */
export const addCompanyByUrl = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { url: string; name?: string }) => d)
  .handler(async ({ context, data }) => {
    const { parseCareersUrl, explainUnrecognized } = await import("@/lib/careers");

    const target = parseCareersUrl(data.url, data.name?.trim() || undefined);
    if (!target) {
      // explainUnrecognized gives a different, specific answer for a LinkedIn
      // link, a job board link and a company homepage. "Invalid URL" is
      // useless advice to someone who pasted target.com — the fix is to click
      // through to the listings page, which is where the portal name appears.
      return { ok: false as const, message: explainUnrecognized(data.url) };
    }

    const name =
      target.name || target.token.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

    const { error } = await context.supabase.from("companies").upsert(
      {
        ats: target.ats,
        token: target.token,
        name,
        enabled: true,
        pod: target.pod ?? null,
        site: target.site ?? null,
        careers_url: data.url.trim(),
        last_error: null,
      },
      { onConflict: "user_id,ats,token,site" },
    );

    if (error) return { ok: false as const, message: error.message };

    // Every source must also be switched on in search_config, or discovery
    // skips the company and the user is left looking at a row that does
    // nothing.
    const { data: cfg } = await context.supabase
      .from("search_config")
      .select("sources")
      .eq("id", 1)
      .single();
    const sources: string[] = cfg?.sources ?? [];
    if (!sources.includes(target.ats)) {
      await context.supabase
        .from("search_config")
        .update({ sources: [...sources, target.ats] })
        .eq("id", 1);
    }

    return {
      ok: true as const,
      message: `Added ${name} — ${target.ats}${target.site ? ` / ${target.site}` : ""}. Run discovery to pull its openings.`,
      company: target,
    };
  });

/**
 * VERIFY EMPLOYER CANDIDATES — resolve careers pages into fetchable sources.
 *
 * Works through the list a batch at a time rather than all at once: each
 * candidate is a real HTTP request that follows redirects, and several
 * hundred of those will outlast any request timeout. Call it repeatedly until
 * `pending` reaches zero.
 *
 * A candidate only becomes a company once its ATS has been identified. One
 * that cannot be resolved is marked with the reason and left in the list, so
 * the gaps are visible and fixable by pasting a better URL — rather than
 * disappearing, or worse, becoming a company row that returns nothing.
 */
export const verifyCandidates = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { limit?: number; retry?: boolean; retryBefore?: string } | undefined) => {
    if (d?.retryBefore && !Number.isFinite(Date.parse(d.retryBefore)))
      throw new Error("Invalid retry start time");
    return d ?? {};
  })
  .handler(async ({ context, data }) => {
    const { detectAts } = await import("@/lib/ats-detect.server");
    const { probeAts } = await import("@/lib/ats-probe.server");

    const db = context.supabase;

    // Smaller default batches than before. Each candidate that does not
    // resolve by reading its page now also gets probed against five job
    // boards, so a batch is a good deal more work than a single fetch each.
    const limit = Math.min(25, Math.max(1, Math.round(data.limit ?? 8)));

    // `retry` re-checks candidates that failed earlier. The probing below
    // reaches employers the page-reading pass could not, so the 335 already
    // marked failed deserve another look rather than a second hand-built list.
    // Freeze the pass boundary so a failure recorded in this pass is not picked
    // again forever. Pending rows are always eligible, including after resume.
    const retryBefore = data.retry ? new Date(data.retryBefore ?? Date.now()).toISOString() : null;
    let query = db.from("company_candidates").select("id, name, careers_url");
    query = retryBefore
      ? query.or(
          `status.eq.pending,and(status.eq.failed,or(checked_at.is.null,checked_at.lt.${retryBefore}))`,
        )
      : query.eq("status", "pending");
    const { data: batch, error: batchError } = await query.order("id").limit(limit);
    if (batchError) throw batchError;

    if (!batch?.length) {
      const { data: stats } = await db.from("v_candidate_stats").select("*").maybeSingle();
      return {
        ok: true as const,
        done: true as const,
        checked: 0,
        added: 0,
        failed: 0,
        stats,
        message: "Every employer in the list has been checked.",
      };
    }

    let added = 0;
    let failed = 0;

    for (const candidate of batch) {
      let found = await detectAts(candidate.careers_url, candidate.name);

      // Reading the page fails for most large employers: their careers sites
      // render with JavaScript, so the board link is never in the HTML, and
      // some refuse a plain fetch outright. Asking the boards directly
      // answers the same question without rendering anything.
      let how = found.ok ? `page ${found.via}` : "";
      let probeDetail = "";
      if (!found.ok) {
        const probed = await probeAts(candidate.name, candidate.careers_url);
        if (probed.ok) {
          found = {
            ok: true,
            target: probed.target,
            via: "markup",
            finalUrl: candidate.careers_url,
          };
          how = probed.how;
        } else {
          probeDetail = probed.detail;
        }
      }

      if (!found.ok) {
        failed++;
        await db
          .from("company_candidates")
          .update({
            status: "failed",
            // Keep both halves. "no supported ATS found on the page" alone
            // cannot tell a wrong board guess from a platform we do not
            // support, and those need opposite fixes.
            note: `${found.reason}${probeDetail ? ` | ${probeDetail}` : ""}`.slice(0, 400),
            resolved_url: found.finalUrl ?? null,
            checked_at: new Date().toISOString(),
          })
          .eq("id", candidate.id);
        continue;
      }

      const t = found.target;
      const { error } = await db.from("companies").upsert(
        {
          ats: t.ats,
          token: t.token,
          name: candidate.name,
          enabled: true,
          pod: t.pod ?? null,
          site: t.site ?? null,
          careers_url: candidate.careers_url,
          last_error: null,
        },
        { onConflict: "user_id,ats,token,site" },
      );

      if (error) {
        failed++;
        await db
          .from("company_candidates")
          .update({
            status: "failed",
            note: `could not save: ${error.message}`.slice(0, 300),
            checked_at: new Date().toISOString(),
          })
          .eq("id", candidate.id);
        continue;
      }

      added++;
      await db
        .from("company_candidates")
        .update({
          status: "ok",
          ats: t.ats,
          token: t.token,
          pod: t.pod ?? null,
          site: t.site ?? null,
          resolved_url: found.finalUrl,
          note: `found via ${how}`,
          checked_at: new Date().toISOString(),
        })
        .eq("id", candidate.id);
    }

    // Every source must also be enabled in search_config, or discovery skips
    // the company and the row sits there doing nothing.
    const { data: cfg } = await context.supabase
      .from("search_config")
      .select("sources")
      .eq("id", 1)
      .single();
    const sources: string[] = cfg?.sources ?? [];
    const all = new Set(sources);
    for (const a of ["workday", "greenhouse", "lever", "ashby", "workable", "smartrecruiters"]) {
      all.add(a);
    }
    if (all.size !== sources.length) {
      await db
        .from("search_config")
        .update({ sources: [...all] })
        .eq("id", 1);
    }

    const { data: stats } = await db.from("v_candidate_stats").select("*").maybeSingle();

    return {
      ok: true as const,
      done: false as const,
      checked: batch.length,
      added,
      failed,
      stats,
      message:
        `Checked ${batch.length}: ${added} added, ${failed} could not be resolved. ` +
        `${stats?.pending ?? 0} still to check.`,
    };
  });

/** Settings metadata only: credentials stay on the server. */
export const gmailStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { gmailConnectionState } = await import("@/lib/gmail-connection");
    const { data, error } = await context.supabase.from("google_tokens")
      .select("refresh_token,email,connected_at,last_sync_at,last_error").eq("id", 1).maybeSingle();
    if (error) throw error;
    // Read the address applications are actually sent from, so a mailbox
    // connected by mistake is reported rather than quietly finding nothing.
    const { data: profile } = await context.supabase
      .from("profile")
      .select("email")
      .maybeSingle();
    return gmailConnectionState(data, profile?.email ?? null);
  });

/** START CONNECTING GMAIL — returns the Google consent URL for the panel to open. */
export const gmailAuthUrl = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { buildAuthUrl, clientConfig, signState } = await import("@/lib/google.server");
    const { id, secret } = clientConfig();
    if (!id || !secret) {
      return {
        ok: false as const,
        message: "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set yet. Add them first.",
      };
    }
    // The state says whose mailbox this is, sealed so that nobody else can say it.
    return { ok: true as const, url: buildAuthUrl(await signState(context.userId)) };
  });

/** SYNC GMAIL — pull recent mail and run it through the existing classifier. */
export const gmailSync = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { query?: string; max?: number } | undefined) => d ?? {})
  .handler(async ({ context, data }) => {
    const { fetchMessages } = await import("@/lib/gmail.server");
    const { ingestMessages, recordSyncError } = await import("@/lib/email.server");

    try {
      // The routine sync reads three days, which is all that can be new. A
      // catch-up passes a wider window to find receipts for applications sent
      // before the mailbox was ever connected — the reason the confirmation
      // count read zero while the applications had in fact been answered.
      const max = Math.min(Math.max(Math.trunc(data.max ?? 50), 1), 200);
      const messages = await fetchMessages(
        await mine(context),
        data.query ?? "in:inbox newer_than:3d",
        max,
      );
      if (!messages.length) {
        return {
          ok: true as const,
          message:
            "Gmail is connected but returned nothing new. Either there is no recent mail, " +
            "or the mailbox has not been connected yet — check Settings → Email.",
          stored: 0,
        };
      }
      // Everything that decides what a message means already exists; this
      // only changes where the messages come from.
      // ingestMessages already reports ok; spreading it after another one
      // silently overwrote it.
      const stats = await ingestMessages(await mine(context), messages);
      return {
        ...stats,
        message: `Read ${messages.length}, kept ${stats.stored}, matched ${stats.matched} to applications.`,
      };
    } catch (e) {
      const why = String((e as Error)?.message ?? e);
      await recordSyncError(await mine(context), why).catch(() => {});
      return { ok: false as const, message: why.slice(0, 300) };
    }
  });

/** DISCONNECT GMAIL — forget the tokens. */
export const gmailDisconnect = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { error } = await context.supabase
      .from("google_tokens")
      .update({
        refresh_token: null,
        access_token: null,
        expires_at: null,
        email: null,
        last_error: null,
      })
      .eq("id", 1);
    if (error) throw error;
    return {
      ok: true as const,
      message:
        "Disconnected here. To revoke the grant on Google's side too, " +
        "remove ApplyPilot at myaccount.google.com/permissions.",
    };
  });

/** RUN APPLIER — starts the GitHub Actions cloud applier (needs GITHUB_TOKEN + GITHUB_REPO). */
export const runApplier = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { max_jobs?: number; dry_run?: boolean } | undefined) => d ?? {})
  .handler(async ({ context, data }) => {
    const token = process.env["GITHUB_TOKEN"];
    const repo = process.env["GITHUB_REPO"];
    if (!token || !repo) {
      return {
        ok: false as const,
        message: "Cloud applier not connected yet — GitHub token and repo still need to be added.",
      };
    }
    const maxJobs = Math.min(100, Math.max(1, Math.round(data.max_jobs ?? 25)));
    const dryRun = data.dry_run === true;
    const { count } = await context.supabase
      .from("jobs")
      .select("id", { count: "exact", head: true })
      .eq("status", "queued");
    if (!count)
      return { ok: false as const, message: "Queue is empty. Run discovery, then scoring." };
    const res = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "ApplyPilot",
      },
      body: JSON.stringify({
        event_type: "apply",
        // Sent as "submit", matching the workflow. A JSON false for dry_run
        // used to be indistinguishable from the field being absent, so this
        // button could never actually submit anything.
        client_payload: { max_jobs: maxJobs, submit: !dryRun },
      }),
    });
    if (res.status === 204) {
      await context.supabase.from("runs").insert({
        kind: "apply",
        status: "running",
        message: `cloud agent dispatched — up to ${maxJobs} job(s)${dryRun ? " (dry run)" : ""}`,
      });
      return {
        ok: true as const,
        message: `Cloud applier started on ${count} queued job(s). Boots in 1–2 min.`,
      };
    }
    const hint =
      res.status === 404
        ? "Repo not found or token can't see it."
        : res.status === 401 || res.status === 403
          ? "GitHub rejected the token."
          : "";
    return {
      ok: false as const,
      message: `GitHub ${res.status}. ${hint} ${(await res.text()).slice(0, 200)}`.trim(),
    };
  });

/**
 * RUN DISCOVERY / SCORING, somewhere the browser cannot cancel.
 *
 * These were server functions awaited straight from the dashboard, so the
 * browser held the request open for the whole run. Switching tabs, opening
 * Settings or locking the phone aborted the fetch and killed the run — and
 * this is used from a phone, where that is most of the time.
 *
 * The work still runs on this server, in /api/public/cron/sweep. All that
 * changes is who waits for it: a GitHub runner, which waits patiently.
 */
export const runSweep = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { only?: "both" | "discover" | "score" } | undefined) => d ?? {})
  .handler(async ({ context, data }) => {
    const token = process.env["GITHUB_TOKEN"];
    const repo = process.env["GITHUB_REPO"];
    if (!token || !repo) {
      return {
        ok: false as const,
        message: "Cloud runner not connected yet — GitHub token and repo still need to be added.",
      };
    }
    const only = data.only ?? "both";
    const res = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "ApplyPilot",
      },
      body: JSON.stringify({ event_type: "sweep", client_payload: { only } }),
    });

    if (res.status === 204) {
      await context.supabase.from("runs").insert({
        kind: only === "score" ? "score" : "discover",
        status: "running",
        message: `cloud runner dispatched — ${only}`,
      });
      return {
        ok: true as const,
        message:
          `Started ${only === "both" ? "discovery and scoring" : only} on the cloud runner. ` +
          `Boots in 1–2 min, and keeps going if you close this. Watch the run list below.`,
      };
    }
    const hint =
      res.status === 404
        ? "Repo not found, or the sweep workflow is not on the default branch yet."
        : res.status === 401 || res.status === 403
          ? "GitHub rejected the token."
          : "";
    return {
      ok: false as const,
      message: `GitHub ${res.status}. ${hint} ${(await res.text()).slice(0, 200)}`.trim(),
    };
  });

/**
 * The profile was saved: have every waiting question gone through with it.
 * Starts the small job on GitHub that answers what the profile now answers
 * and offers the stopped applications again. Quiet when it cannot: the same
 * is done at the start of every round anyway.
 */
export const syncAnswers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const token = process.env["GITHUB_TOKEN"];
    const repo = process.env["GITHUB_REPO"];
    if (!token || !repo) return { ok: false as const };
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
          "User-Agent": "ApplyPilot",
        },
        body: JSON.stringify({ event_type: "answers" }),
        signal: AbortSignal.timeout(15_000),
      });
      return { ok: res.status === 204 };
    } catch {
      return { ok: false as const };
    }
  });

/**
 * The first start. Every reader is started at once, so the last thirty days
 * of postings are gathered in one go; the hourly rounds after it only meet
 * what is new, because a posting already held is never taken twice.
 */
export const startBackfill = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const token = process.env["GITHUB_TOKEN"];
    const repo = process.env["GITHUB_REPO"];
    if (!token || !repo) return { ok: false as const };
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
          "User-Agent": "ApplyPilot",
        },
        body: JSON.stringify({ event_type: "backfill" }),
        signal: AbortSignal.timeout(15_000),
      });
      return { ok: res.status === 204 };
    } catch {
      return { ok: false as const };
    }
  });
