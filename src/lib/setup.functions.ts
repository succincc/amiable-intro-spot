import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { rolesFrom } from "@/lib/roles";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

async function mine(context: { supabase: unknown; userId: string }): Promise<Any> {
  const { forUser } = await import("@/lib/scope.server");
  return forUser(context.supabase, context.userId);
}

const sameTitle = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * A resume has just been saved: read off it what a person should not have
 * to type again. The job titles to search for, where none are set, and the
 * jobs they have held, where the experience bank is empty. What is already
 * there is never overwritten.
 */
export const afterResume = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const sb = await mine(context);
    const out = { titles: 0, roles: 0 };
    const { data: profile } = await sb.from("profile").select("resume_text,target_role").eq("id", 1).maybeSingle();
    const resume = String(profile?.resume_text ?? "");
    if (resume.trim().length < 200) return out;

    const { data: cfg } = await sb.from("search_config").select("titles,exclude_titles,no_go_patterns").eq("id", 1).maybeSingle();
    if (cfg && !(cfg.titles ?? []).length) {
      const { suggestTitles } = await import("@/lib/titles.server");
      const titles = suggestTitles({ resume, profile, exclude: [...(cfg.exclude_titles ?? []), ...(cfg.no_go_patterns ?? [])], limit: 75 });
      if (titles.length) {
        const { error } = await sb.from("search_config").update({ titles, updated_at: new Date().toISOString() }).eq("id", 1);
        if (!error) out.titles = titles.length;
      }
    }

    const { count } = await sb.from("experience").select("id", { count: "exact", head: true });
    if (!count) {
      const roles = rolesFrom(resume);
      if (roles.length) {
        const { error } = await sb.from("experience").insert(roles.map((r) => ({ company: r.company, title: r.title, location: r.location, start_date: r.start_date, end_date: r.end_date, details: r.details })));
        if (!error) out.roles = roles.length;
      }
    }
    return out;
  });

/**
 * "Add eligible roles": every title the resume shows this person could be
 * hired for, added to the ones they already search for. Nothing is removed,
 * and a title they have excluded is not put back.
 */
export const addEligibleTitles = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const sb = await mine(context);
    const { data: profile } = await sb.from("profile").select("resume_text,target_role").eq("id", 1).maybeSingle();
    const resume = String(profile?.resume_text ?? "");
    if (resume.trim().length < 200) return { ok: false as const, message: "Add your resume first; the roles are read from it." };
    const { data: cfg } = await sb.from("search_config").select("titles,exclude_titles,no_go_patterns").eq("id", 1).maybeSingle();
    const have: string[] = cfg?.titles ?? [];
    const { suggestTitles } = await import("@/lib/titles.server");
    const found = suggestTitles({ resume, profile, exclude: [...(cfg?.exclude_titles ?? []), ...(cfg?.no_go_patterns ?? [])], limit: 160, ladder: true });
    const seen = new Set(have.map(sameTitle));
    const fresh = found.filter((t) => !seen.has(sameTitle(t)) && seen.add(sameTitle(t)));
    if (!fresh.length) return { ok: true as const, added: 0, titles: have };
    const titles = [...have, ...fresh];
    const { error } = await sb.from("search_config").update({ titles, updated_at: new Date().toISOString() }).eq("id", 1);
    return error ? { ok: false as const, message: error.message } : { ok: true as const, added: fresh.length, titles };
  });
