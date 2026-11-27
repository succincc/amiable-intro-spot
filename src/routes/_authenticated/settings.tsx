import { CallingExtra } from "@/components/mission-control/calling-extra";
import { useEffect, useState, type ReactNode } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { Btn, Cursor, Empty, ErrorLine, inputCls } from "@/components/mission-control/async-state";
import { supabase } from "@/integrations/supabase/client";
import {
  agentOnline, parseDailyCap, percentToScore, relTime, scoreToPercent, useAgent, useStats,
  type Company, type Profile, type SearchConfig,
} from "@/hooks/use-mission-control";
import { addCompanyByUrl } from "@/lib/engine.functions";
import { LargeEmployerImport } from "@/components/mission-control/large-employer-import";
import { GmailSettings } from "@/components/mission-control/gmail-settings";
import { InterviewCalendar } from "@/components/mission-control/interview-calendar";
import { extractResumeText, looksScanned } from "@/lib/resume-parse";
import bridgeCode from "../../../gmail-bridge/Code.gs?raw";

export const Route = createFileRoute("/_authenticated/settings")({
  validateSearch: (search: Record<string, unknown>) => ({
    ...(typeof search["gmail"] === "string" ? { gmail: search["gmail"] } : {}),
    ...(typeof search["detail"] === "string" ? { detail: search["detail"] } : {}),
  }),
  head: () => ({
    meta: [
      { title: "Settings · ApplyPilot" },
      { name: "description", content: "Profile, resume, search rules, companies and the Chrome agent." },
      { property: "og:title", content: "Settings · ApplyPilot" },
      { property: "og:description", content: "Profile, resume, search rules, companies and the Chrome agent." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Settings,
});

function Block({ title, children, open }: { title: string; children: ReactNode; open?: boolean }) {
  return (
    <details open={open} className="border border-border bg-card">
      <summary className="cursor-pointer px-3 py-2 text-xs text-muted-foreground">[ {title} ]</summary>
      <div className="space-y-3 border-t border-border p-3">{children}</div>
    </details>
  );
}

function Field({ label, children, note }: { label: string; children: ReactNode; note?: string }) {
  return (
    <label className="block space-y-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      {children}
      {note ? <span className="block text-muted-foreground">{note}</span> : null}
    </label>
  );
}

function SaveLine({ onSave }: { onSave: () => Promise<void> }) {
  const [state, setState] = useState<{ k: "ok" | "err" | "busy"; t: string } | null>(null);
  return (
    <div className="flex items-center gap-3">
      <Btn variant="primary" disabled={state?.k === "busy"} onClick={async () => {
        setState({ k: "busy", t: "saving…" });
        try { await onSave(); setState({ k: "ok", t: "saved" }); } catch (e) { setState({ k: "err", t: (e as Error).message }); }
      }}>save</Btn>
      {state ? <span className={`text-xs ${state.k === "ok" ? "text-success" : state.k === "err" ? "text-destructive" : "text-muted-foreground"}`}>{state.t}</span> : null}
    </div>
  );
}

function Settings() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const [gmailBanner, setGmailBanner] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    if (search.gmail === undefined && search.detail === undefined) return;
    if (search.gmail === "connected" || search.gmail === "failed") {
      setGmailBanner({ ok: search.gmail === "connected", text: search.detail ?? (search.gmail === "connected" ? "Gmail connected." : "Gmail connection failed.") });
    }
    void navigate({ search: (prev) => {
      const { gmail: _gmail, detail: _detail, ...rest } = prev;
      return rest;
    }, replace: true });
  }, [search.gmail, search.detail, navigate]);
  const q = useQuery({
    queryKey: ["settings"],
    queryFn: async () => {
      const [p, s] = await Promise.all([
        supabase.from("profile").select("*").eq("id", 1).single(),
        supabase.from("search_config").select("*").eq("id", 1).single(),
      ]);
      if (p.error) throw p.error;
      if (s.error) throw s.error;
      return { profile: p.data, search: s.data };
    },
  });
  if (q.isLoading) return <Cursor />;
  if (q.error || !q.data) return <ErrorLine error={q.error} onRetry={() => q.refetch()} />;
  return (
    <div className="space-y-3">
      {gmailBanner ? <div role="status" className={`break-words border p-3 text-sm ${gmailBanner.ok ? "border-success text-success" : "border-warning text-warning"}`}>{gmailBanner.text}</div> : null}
      <AgentBlock />
      <ApplyingBlock initial={q.data.profile} />
      <ProfileBlock initial={q.data.profile} />
      <ResumeBlock initial={q.data.profile} />
      <ExperienceBlock />
      <SearchBlock initial={q.data.search} profile={q.data.profile} />
      <CompaniesBlock />
      <EmailBlock initial={q.data.profile} open={gmailBanner !== null} />
      <Block title="calling (optional extra)">
        <CallingExtra initial={q.data.profile as unknown as Record<string, unknown>} />
      </Block>
    </div>
  );
}

/* ------------------------------- profile -------------------------------- */
const TEXT_FIELDS: Array<[keyof Profile, string]> = [
  ["full_name", "full name"], ["preferred_name", "preferred name"], ["email", "email"], ["phone", "phone"],
  ["address", "address"], ["city", "city"], ["state", "state"], ["postal_code", "postal code"], ["country", "country"],
  ["linkedin_url", "linkedin url"], ["github_url", "github url"], ["portfolio_url", "portfolio url"],
  ["target_role", "target role"], ["years_experience", "years experience"], ["education_level", "education level"],
  ["earliest_start", "earliest start"],
  // Used only to work out an age for "are you over 18". Never typed into a form.
  ["date_of_birth", "date of birth (MM/DD/YYYY)"],
];
const SELECTS: Array<[keyof Profile, string, string[]]> = [
  ["work_authorized", "work authorized", ["Yes", "No"]],
  ["needs_sponsorship", "needs sponsorship", ["No", "Yes"]],
  ["over_18", "over 18", ["Yes", "No"]],
  // "Which, if any, of these countries are you a citizen of" can only be
  // answered "none" by someone with the one citizenship.
  ["citizenship", "citizenship", ["United States only", "United States and another country", "Another country"]],
  ["can_background_check", "can pass background check", ["Yes", "No"]],
  ["willing_to_relocate", "willing to relocate", ["No", "Yes"]],
  ["veteran_status", "veteran status", ["I am not a protected veteran", "I am a protected veteran", "I do not wish to answer"]],
  // Worded as the federal form words it, so what is chosen here is what is
  // ticked there.
  ["disability_status", "disability status", [
    "I do not want to answer",
    "No, I do not have a disability and have not had one in the past",
    "Yes, I have a disability, or have had one in the past",
  ]],
  ["gender", "gender", ["Decline to self-identify", "Male", "Female", "Non-binary"]],
  ["hispanic_latino", "hispanic or latino", ["No", "Yes", "Decline to self-identify"]],
  ["race_ethnicity", "race / ethnicity", ["Decline to self-identify", "American Indian or Alaska Native", "Asian", "Black or African American", "Hispanic or Latino", "Native Hawaiian or Other Pacific Islander", "White", "Two or More Races"]],
];

function ProfileBlock({ initial }: { initial: Profile }) {
  const [p, setP] = useState<Profile>(initial);
  const set = (k: keyof Profile, v: string | number | null) => setP((x) => ({ ...x, [k]: v }));
  return (
    <Block title="profile">
      <div className="grid gap-3 sm:grid-cols-2">
        {TEXT_FIELDS.map(([k, label]) => (
          <Field key={k} label={label}><input className={inputCls} value={(p[k] as string) ?? ""} onChange={(e) => set(k, e.target.value)} /></Field>
        ))}
        <Field label="salary expectation"><input type="number" className={inputCls} value={p.salary_expectation ?? ""} onChange={(e) => set("salary_expectation", e.target.value ? Number(e.target.value) : null)} /></Field>
        {SELECTS.map(([k, label, opts]) => (
          <Field key={k} label={label}>
            <select className={inputCls} value={(p[k] as string) ?? opts[0]} onChange={(e) => set(k, e.target.value)}>
              {opts.map((o) => <option key={o}>{o}</option>)}
            </select>
          </Field>
        ))}
      </div>
      <SaveLine onSave={async () => {
        // Fields owned by other sections are left out so a stale copy here never overwrites them.
        const { id: _id, updated_at: _u, resume_text: _r, home_city: _hc, home_lat: _hl, home_lon: _ho, home_state: _hs, auto_reply: _ar, autopilot: _ap, follow_up: _fu, daily_summary: _ds, availability: _av, availability_slots: _as, interview_holds: _ih, notify_moments: _nm, health_state: _hst, health_notified_at: _hn, calls_enabled: _ce, calls_min_score: _cm, calls_targets_only: _ct,
          resume_file_path: _fp, resume_file_name: _fn, resume_word_count: _wc, resume_error: _re, ...rest } = p;
        const { error } = await supabase.from("profile").update(rest).eq("id", 1);
        if (error) throw error;
      }} />
    </Block>
  );
}

function ResumeBlock({ initial }: { initial: Profile }) {
  const [text, setText] = useState(initial.resume_text ?? "");
  const [file, setFile] = useState<{ k: "ok" | "err" | "busy"; t: string } | null>(
    initial.resume_file_name ? { k: "ok", t: `on file: ${initial.resume_file_name}` } : null,
  );
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;

  async function upload(f: File) {
    setFile({ k: "busy", t: `reading ${f.name}…` });
    try {
      const extracted = await extractResumeText(f);
      if (looksScanned(extracted)) {
        setFile({ k: "err", t: "Almost no text came out of this file — it is probably a scan. Export a text PDF from Word or Google Docs, or upload a .docx." });
        return;
      }
      const path = `resume/${Date.now()}-${f.name.replace(/[^\w.-]+/g, "_")}`;
      const up = await supabase.storage.from("artifacts").upload(path, f, f.type ? { upsert: true, contentType: f.type } : { upsert: true });
      if (up.error) throw up.error;
      const wc = extracted.split(/\s+/).filter(Boolean).length;
      const { error } = await supabase.from("profile").update({
        resume_text: extracted, resume_word_count: wc, resume_file_path: path, resume_file_name: f.name, resume_error: null,
      }).eq("id", 1);
      if (error) throw error;
      setText(extracted);
      setFile({ k: "ok", t: `saved ${f.name} · ${wc} words` });
    } catch (e) {
      setFile({ k: "err", t: (e as Error).message });
    }
  }

  return (
    <Block title="resume">
      <label className="block space-y-1 text-xs">
        <span className="text-muted-foreground">upload your resume (.pdf, .docx or .txt)</span>
        <input type="file" accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
          className="block text-xs" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ""; }} />
      </label>
      {file ? <div className={`text-xs ${file.k === "ok" ? "text-success" : file.k === "err" ? "text-destructive" : "text-muted-foreground"}`}>{file.t}</div> : null}
      <textarea
        rows={20}
        className={`${inputCls} font-mono`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const f = e.dataTransfer.files[0];
          if (f) void upload(f);
        }}
        placeholder="paste your full resume, or drop a .pdf / .docx / .txt file here"
      />
      <div className="text-xs text-muted-foreground">{words} words · this exact text is what gets rewritten for each job. paste your full resume.</div>
      {!text.trim() ? <div className="text-xs text-warning">no resume — scoring and tailoring will not run.</div> : null}
      <SaveLine onSave={async () => {
        const { error } = await supabase.from("profile").update({ resume_text: text, resume_word_count: words }).eq("id", 1);
        if (error) throw error;
      }} />
    </Block>
  );
}

/* -------------------------------- search -------------------------------- */
/* ------------------------------ experience ------------------------------ */
type Role = {
  id: string; company: string; title: string; location: string | null;
  start_date: string | null; end_date: string | null; details: string | null;
};
const BLANK_ROLE = { company: "", title: "", location: "", start_date: "", end_date: "", details: "" };

function ExperienceBlock() {
  const qc = useQueryClient();
  // The table is newer than the generated types.
  const db = supabase as any;
  const q = useQuery({
    queryKey: ["experience"],
    queryFn: async (): Promise<Role[]> => {
      const { data, error } = await db.from("experience").select("*").order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
  const [draft, setDraft] = useState<typeof BLANK_ROLE & { id?: string }>(BLANK_ROLE);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["experience"] });
  const set = (k: keyof typeof BLANK_ROLE, v: string) => setDraft((d) => ({ ...d, [k]: v }));

  const save = async () => {
    if (!draft.company.trim() || !draft.title.trim()) { setErr("company and title are needed"); return; }
    setBusy(true); setErr(null);
    const row = {
      company: draft.company.trim(), title: draft.title.trim(), location: draft.location.trim() || null,
      start_date: draft.start_date.trim() || null, end_date: draft.end_date.trim() || null,
      details: draft.details.trim() || null, updated_at: new Date().toISOString(),
    };
    const { error } = draft.id
      ? await db.from("experience").update(row).eq("id", draft.id)
      : await db.from("experience").insert(row);
    setBusy(false);
    if (error) { setErr(error.message); return; }
    setDraft(BLANK_ROLE); refresh();
  };

  return (
    <Block title={`experience (${q.data?.length ?? 0})`}>
      <p className="text-xs text-muted-foreground">every job you have held, not only the ones on your resume. for each application the roles that suit that posting are chosen from here and written onto a one-page resume; the rest are left off. company, title and dates go on the page exactly as you enter them.</p>
      {q.isLoading ? <Cursor /> : q.error ? <ErrorLine error={q.error} onRetry={() => q.refetch()} /> : (
        <div className="space-y-1">
          {(q.data ?? []).length === 0 ? <Empty>no roles yet. until you add some, resumes are written from the resume above alone.</Empty> : null}
          {(q.data ?? []).map((r) => (
            <div key={r.id} className="flex items-start justify-between gap-2 border border-border p-2 text-xs">
              <div className="min-w-0">
                <div className="truncate">{r.title} · {r.company}</div>
                <div className="text-muted-foreground">{r.start_date || "?"} – {r.end_date || "present"}{r.location ? ` · ${r.location}` : ""}{r.details ? ` · ${r.details.trim().split(/\s+/).length} words of detail` : " · no detail yet"}</div>
              </div>
              <div className="flex shrink-0 gap-1">
                <Btn onClick={() => setDraft({ id: r.id, company: r.company, title: r.title, location: r.location ?? "", start_date: r.start_date ?? "", end_date: r.end_date ?? "", details: r.details ?? "" })}>edit</Btn>
                <Btn onClick={async () => {
                  if (!window.confirm(`remove ${r.title} at ${r.company}?`)) return;
                  const { error } = await db.from("experience").delete().eq("id", r.id);
                  if (error) setErr(error.message); else { if (draft.id === r.id) setDraft(BLANK_ROLE); refresh(); }
                }}>remove</Btn>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="space-y-2 border border-border p-2">
        <div className="text-xs text-muted-foreground">{draft.id ? "edit role" : "add a role"}</div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Field label="job title"><input className={inputCls} value={draft.title} onChange={(e) => set("title", e.target.value)} /></Field>
          <Field label="company"><input className={inputCls} value={draft.company} onChange={(e) => set("company", e.target.value)} /></Field>
          <Field label="started" note="as it should read: Jul 2024"><input className={inputCls} value={draft.start_date} onChange={(e) => set("start_date", e.target.value)} /></Field>
          <Field label="ended" note="leave empty if you still work there"><input className={inputCls} value={draft.end_date} onChange={(e) => set("end_date", e.target.value)} /></Field>
          <Field label="location"><input className={inputCls} value={draft.location} onChange={(e) => set("location", e.target.value)} /></Field>
        </div>
        <Field label="what you did there" note="everything worth knowing, in your own words: responsibilities, results, numbers, tools, team size. more is better — only what suits a posting is used.">
          <textarea className={`${inputCls} min-h-28`} value={draft.details} onChange={(e) => set("details", e.target.value)} />
        </Field>
        {err ? <ErrorLine error={err} /> : null}
        <div className="flex gap-2">
          <Btn onClick={save}>{busy ? "saving…" : draft.id ? "save changes" : "add role"}</Btn>
          {draft.id ? <Btn onClick={() => { setDraft(BLANK_ROLE); setErr(null); }}>cancel</Btn> : null}
        </div>
      </div>
    </Block>
  );
}

function Tags({ value, onChange, placeholder }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const parts = draft.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length) onChange([...new Set([...value, ...parts])]);
    setDraft("");
  };
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-1">
        {value.map((t) => (
          <button type="button" key={t} onClick={() => onChange(value.filter((x) => x !== t))} className="border border-border px-1.5 py-0.5 text-xs hover:border-destructive">
            {t} <span className="text-muted-foreground">x</span>
          </button>
        ))}
      </div>
      <input className={inputCls} value={draft} placeholder={placeholder ?? "type and press enter"} onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} onBlur={add} />
    </div>
  );
}

// arbeitnow was removed: a German job board has nothing to offer a search
// measured in miles from New Jersey.
const SOURCES = ["greenhouse", "lever", "ashby", "workday", "smartrecruiters", "remotive", "remoteok", "workable", "usajobs"];

function SearchBlock({ initial, profile }: { initial: SearchConfig; profile: Profile }) {
  const qc = useQueryClient();
  const [s, setS] = useState<SearchConfig>(initial);
  const [homeCity, setHomeCity] = useState(profile.home_city ?? "");
  const stats = useStats();
  const radius = s.radius_miles ?? 40;
  const set = <K extends keyof SearchConfig>(k: K, v: SearchConfig[K]) => setS((x) => ({ ...x, [k]: v }));
  const titles = s.titles ?? [];
  const locs = s.locations ?? [];
  const homeState = profile.home_state ?? profile.state ?? "home state";
  const autoPct = scoreToPercent(s.auto_apply_score, 6);
  const reviewPct = scoreToPercent(s.review_score, 4);
  return (
    <Block title="search">
      <Field label="job titles to search" note="leave empty to let scoring judge everything — it costs more AI quota.">
        <Tags value={titles} onChange={(v) => set("titles", v)} placeholder="e.g. customer success, account manager" />
      </Field>
      <Field label="home city"><input className={inputCls} placeholder="e.g. Princeton, NJ" value={homeCity} onChange={(e) => setHomeCity(e.target.value)} /></Field>
      <Field label={`search radius: ${radius === 0 ? "no limit" : `${radius} mi`}`} note={`${stats.data?.within_25mi ?? 0} jobs within 25 mi · ${stats.data?.within_40mi ?? 0} within 40 mi · 0 means no distance limit`}>
        <input type="range" min={0} max={100} className="w-full accent-primary" value={radius} onChange={(e) => set("radius_miles", Number(e.target.value))} />
      </Field>
      <div className="space-y-1">
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={s.same_state_only ?? false} onChange={(e) => set("same_state_only", e.target.checked)} />
          same state only{homeState ? ` (${homeState})` : ""}
        </label>
        <p className="text-xs text-muted-foreground">a radius is a circle and crosses state lines. this keeps on-site jobs to your home state, whichever state your home city is in. remote jobs are not held to it.</p>
      </div>
      <div className="space-y-1">
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={s.same_country_only ?? true} onChange={(e) => set("same_country_only", e.target.checked)} />
          only jobs in my country
        </label>
        <p className="text-xs text-muted-foreground">on unless you turn it off. remote jobs are held to it too: a remote role advertised abroad usually cannot be worked from here. built for the united states.</p>
      </div>
      <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={s.include_remote ?? true} onChange={(e) => set("include_remote", e.target.checked)} /> always include remote jobs</label>
      <div className="space-y-1">
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={s.include_unknown_location ?? true} onChange={(e) => set("include_unknown_location", e.target.checked)} /> keep jobs whose location can't be determined</label>
        <p className="text-xs text-muted-foreground">many postings say 'Multiple Locations' or nothing at all. Turning this off discards them.</p>
      </div>
      <Field label="locations"><Tags value={locs} onChange={(v) => set("locations", v)} placeholder="e.g. Princeton, NJ · Remote" /></Field>
      <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={s.remote_ok ?? true} onChange={(e) => set("remote_ok", e.target.checked)} /> remote ok</label>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={`salary floor${Number(s.salary_floor) > 0 ? ` (about $${(Number(s.salary_floor) / 2080).toFixed(2)} an hour)` : ""}`}><input type="number" className={inputCls} value={s.salary_floor ?? 0} onChange={(e) => set("salary_floor", Number(e.target.value))} /></Field>
        <Field label="daily cap"><input type="number" min={1} max={1000} className={inputCls} value={s.daily_cap ?? 50} onChange={(e) => set("daily_cap", Number(e.target.value))} /></Field>
        <Field label={`apply automatically at this match or better: ${autoPct}% match`}>
          <input type="range" min={10} max={100} step={10} className="w-full accent-primary" value={autoPct} onChange={(e) => set("auto_apply_score", percentToScore(Number(e.target.value)))} />
        </Field>
        <Field label={`show me for review at this match or better: ${reviewPct}% match`}>
          <input type="range" min={10} max={100} step={10} className="w-full accent-primary" value={reviewPct} onChange={(e) => set("review_score", percentToScore(Number(e.target.value)))} />
        </Field>
      </div>
      <Field label="exclude titles"><Tags value={s.exclude_titles ?? []} onChange={(v) => set("exclude_titles", v)} /></Field>
      <Field label="exclude companies"><Tags value={s.exclude_companies ?? []} onChange={(v) => set("exclude_companies", v)} /></Field>
      <Field label="no-go patterns"><Tags value={s.no_go_patterns ?? []} onChange={(v) => set("no_go_patterns", v)} /></Field>
      <Field label="sources">
        <div className="flex flex-wrap gap-3">
          {SOURCES.map((src) => (
            <label key={src} className="flex items-center gap-1">
              <input type="checkbox" checked={(s.sources ?? []).includes(src)}
                onChange={(e) => set("sources", e.target.checked ? [...(s.sources ?? []), src] : (s.sources ?? []).filter((x) => x !== src))} />
              {src}
            </label>
          ))}
        </div>
      </Field>
      <SaveLine onSave={async () => {
        if (!locs.length) throw new Error("add at least one location");
        const cap = parseDailyCap(s.daily_cap);
        if (cap == null) throw new Error("daily cap must be between 1 and 1000");
        const { id: _id, updated_at: _u, ...rest } = s;
        const { error } = await supabase.from("search_config").update({ ...rest, daily_cap: cap }).eq("id", 1);
        if (error) throw error;
        const hc = homeCity.trim() || null;
        if (hc !== (profile.home_city ?? null)) {
          // Clear the cached coordinates so the next discovery run geocodes the new home.
          const { error: pe } = await supabase.from("profile").update({ home_city: hc, home_lat: null, home_lon: null }).eq("id", 1);
          if (pe) throw pe;
        }
        void qc.invalidateQueries({ queryKey: ["autopilot"] });
        void qc.invalidateQueries({ queryKey: ["settings"] });
      }} />
    </Block>
  );
}

/* ------------------------------- companies ------------------------------ */
const ATS_URL: Record<string, (t: string) => string> = {
  greenhouse: (t) => `job-boards.greenhouse.io/${t}`,
  lever: (t) => `jobs.lever.co/${t}`,
  ashby: (t) => `jobs.ashbyhq.com/${t}`,
  workable: (t) => `apply.workable.com/${t}`,
};

function CompaniesBlock() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["companies"],
    queryFn: async (): Promise<Company[]> => {
      const { data, error } = await supabase.from("companies").select("*").order("name");
      if (error) throw error;
      return data ?? [];
    },
  });
  const addByUrl = useServerFn(addCompanyByUrl);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["companies"] });

  return (
    <Block title={`companies (${q.data?.length ?? 0})`}>
      <LargeEmployerImport />
      {err ? <ErrorLine error={err} /> : null}
      {q.isLoading ? <Cursor /> : q.error ? <ErrorLine error={q.error} /> : (
        <div className="divide-y divide-border border border-border text-xs">
          <div className="flex items-center gap-2 px-2 py-1 text-muted-foreground">
            <span className="w-3" /><span className="flex-1">company</span><span>portal</span>
            <span className="w-10 text-right">jobs</span><span className="w-8 text-right">pulled</span><span className="w-3" />
          </div>
          {q.data?.map((c) => (
            <div key={c.id} className="flex items-center gap-2 px-2 py-1.5">
              <input type="checkbox" checked={c.enabled ?? true} onChange={async (e) => {
                await supabase.from("companies").update({ enabled: e.target.checked }).eq("id", c.id); refresh();
              }} />
              <span className="min-w-0 flex-1 truncate">{c.name}{c.last_error ? <span className="block truncate text-destructive">{c.last_error}</span> : null}</span>
              <span className="text-cyan">{c.ats}</span>
              <span className="hidden max-w-48 truncate text-muted-foreground sm:block">{c.careers_url ?? ATS_URL[c.ats]?.(c.token) ?? c.token}</span>
              <span className="w-10 text-right text-muted-foreground">{c.job_count ?? 0}</span>
              <span className="w-8 text-right text-muted-foreground" title="last pulled">{relTime(c.last_pulled)}</span>
              <button className="text-destructive" onClick={async () => {
                if (!confirm(`Remove ${c.name}?`)) return;
                await supabase.from("companies").delete().eq("id", c.id); refresh();
              }}>x</button>
            </div>
          ))}
        </div>
      )}
      <form className="space-y-2" onSubmit={async (e) => {
        e.preventDefault();
        if (!url.trim()) return;
        setBusy(true); setMsg(null);
        try {
          const res = await addByUrl({ data: name.trim() ? { url: url.trim(), name: name.trim() } : { url: url.trim() } });
          setMsg({ ok: res.ok, t: res.message });
          if (res.ok) { setUrl(""); setName(""); refresh(); }
        } catch (ex) { setMsg({ ok: false, t: (ex as Error).message }); }
        finally { setBusy(false); }
      }}>
        <div className="grid gap-2 sm:grid-cols-[1fr_180px_auto]">
          <Field label="paste a company's careers page URL">
            <input className={inputCls} inputMode="url" placeholder="https://company.wd5.myworkdayjobs.com/External" value={url} onChange={(e) => setUrl(e.target.value)} />
          </Field>
          <Field label="company name (optional)">
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <div className="flex items-end"><Btn variant="primary" type="submit" disabled={busy || !url.trim()}>{busy ? "adding…" : "add"}</Btn></div>
        </div>
        {msg ? <div className={`text-xs ${msg.ok ? "text-success" : "text-destructive"}`}>{msg.t}</div> : null}
        <p className="text-xs text-muted-foreground">
          find a company you want to work for, open its jobs page, and paste the address. works with Workday, Greenhouse, Lever, Ashby, Workable and SmartRecruiters — which covers most large employers.
        </p>
      </form>
    </Block>
  );
}

/* --------------------------------- agent -------------------------------- */
/**
 * Whether the applier may register on an employer's portal, and what it
 * created when it did.
 *
 * The column and the gate behind it were built together; this switch was not,
 * so the setting defaulted to false and could not be changed from anywhere —
 * while the applier's own error message told you to change it in Settings.
 */
function ApplyingBlock({ initial }: { initial: Profile }) {
  const qc = useQueryClient();
  const [createAccounts, setCreateAccounts] = useState(initial.create_accounts ?? false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  // An account made by hand, recorded here so the applier can use it.
  //
  // Some portals will not let a script register — and sometimes it is simply
  // faster to do it yourself. Either way the applier then cannot get in,
  // because the password it has is one it generated for an account that was
  // never created. Thirty seconds of typing beats any amount of guessing at
  // a registration form from the outside.
  const [host, setHost] = useState("");
  const [acctEmail, setAcctEmail] = useState(initial.email ?? "");
  const [acctPassword, setAcctPassword] = useState("");
  const [acctBusy, setAcctBusy] = useState(false);
  const [acctMsg, setAcctMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function saveAccount() {
    // Paste a whole job URL if you like; only the host matters, and typing
    // one out on a phone invites a typo that fails silently later.
    let cleanHost = host.trim().replace(/^https?:\/\//i, "").split("/")[0] ?? "";
    cleanHost = cleanHost.toLowerCase();
    if (!cleanHost || !acctEmail.trim() || !acctPassword) {
      setAcctMsg({ ok: false, text: "Host, email and password are all needed." });
      return;
    }
    setAcctBusy(true);
    setAcctMsg(null);
    const { error } = await supabase.from("site_accounts").upsert(
      {
        host: cleanHost,
        email: acctEmail.trim(),
        password: acctPassword,
        status: "active",
        note: "added by hand",
        last_used_at: null,
      },
      { onConflict: "host" },
    );
    setAcctBusy(false);
    if (error) {
      setAcctMsg({ ok: false, text: error.message });
      return;
    }
    setAcctPassword("");
    setHost("");
    setAcctMsg({ ok: true, text: `Saved for ${cleanHost}. The applier will sign in with it.` });
    void qc.invalidateQueries({ queryKey: ["site-accounts"] });
  }

  const accounts = useQuery({
    queryKey: ["site-accounts"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("site_accounts")
        .select("host,email,password,status,note,created_at")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  return (
    <Block title="applying" open={!createAccounts}>
      <div className="space-y-1">
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={createAccounts}
            onChange={async (e) => {
              const v = e.target.checked;
              setCreateAccounts(v);
              setSaveErr(null);
              const { error } = await supabase.from("profile").update({ create_accounts: v }).eq("id", 1);
              if (error) {
                setCreateAccounts(!v);
                setSaveErr(error.message);
              } else {
                void qc.invalidateQueries({ queryKey: ["settings"] });
              }
            }}
          />
          register an account when a portal demands one
        </label>
        <p className="text-xs text-muted-foreground">
          off: a posting behind a sign-in is parked for you to do by hand. on: the applier registers
          with your email and a password generated for that one employer — never the password you use
          here, so a portal being breached costs exactly that portal. Workday requires an account
          before it will show a form, and Workday is most of the Fortune 500.
        </p>
        {saveErr ? <ErrorLine error={saveErr} /> : null}
      </div>

      <div className="space-y-1 border border-border p-2 text-xs">
        <div className="text-muted-foreground">accounts created ({accounts.data?.length ?? 0})</div>
        {accounts.isLoading ? (
          <Cursor />
        ) : accounts.error ? (
          <ErrorLine error={accounts.error} onRetry={() => void accounts.refetch()} />
        ) : !accounts.data?.length ? (
          <Empty>none yet</Empty>
        ) : (
          <div className="space-y-2">
            {accounts.data.map((a) => (
              <div key={a.host} className="border-b border-border pb-1 last:border-0">
                <div className="break-all">{a.host}</div>
                <div className="text-muted-foreground">
                  {a.email} · <span className="select-all break-all">{a.password}</span>
                </div>
                <div
                  className={
                    a.status === "active"
                      ? "text-success"
                      : a.status === "pending_verification"
                        ? "text-warning"
                        : "text-destructive"
                  }
                >
                  {a.status}
                  {a.note ? ` — ${a.note}` : ""}
                </div>
              </div>
            ))}
          </div>
        )}
        <p className="text-muted-foreground">
          Passwords are shown so you can sign in yourself. Anyone who can read this page can already
          read your resume and inbox, so hiding them here would protect nothing.
        </p>
      </div>

      <div className="space-y-2 border border-border p-2 text-xs">
        <div className="text-muted-foreground">
          add an account you made yourself
        </div>
        <p className="text-muted-foreground">
          Registered on a portal by hand? Put it here and the applier signs in with it instead of
          trying to register. Paste the job URL or just the host — only the host is kept.
        </p>
        <input
          className={inputCls}
          placeholder="att.wd1.myworkdayjobs.com"
          value={host}
          onChange={(e) => setHost(e.target.value)}
          autoCapitalize="off"
          autoCorrect="off"
        />
        <input
          className={inputCls}
          placeholder="email you registered with"
          value={acctEmail}
          onChange={(e) => setAcctEmail(e.target.value)}
          autoCapitalize="off"
          autoCorrect="off"
        />
        <input
          className={inputCls}
          type="password"
          placeholder="password you set"
          value={acctPassword}
          onChange={(e) => setAcctPassword(e.target.value)}
        />
        <Btn variant="primary" disabled={acctBusy} onClick={() => void saveAccount()}>
          {acctBusy ? "saving…" : "SAVE ACCOUNT"}
        </Btn>
        {acctMsg ? (
          <p className={`break-words ${acctMsg.ok ? "text-success" : "text-warning"}`}>
            {acctMsg.text}
          </p>
        ) : null}
      </div>
    </Block>
  );
}

function AgentBlock() {
  const { data: agent } = useAgent();
  const online = agentOnline(agent);
  const [dl, setDl] = useState<string | null>(null);
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);

  async function download() {
    setDl(null);
    try {
      const res = await fetch("/applypilot-extension.zip");
      if (!res.ok) throw new Error(`download failed: ${res.status}`);
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "applypilot-extension.zip";
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      setDl((e as Error).message);
    }
  }

  return (
    <Block title="agent" open={!online}>
      <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
        <div><div className="text-muted-foreground">status</div><div className={online ? "text-success" : "text-muted-foreground"}>{online ? "● online" : "○ offline"}</div></div>
        <div><div className="text-muted-foreground">state</div>{agent?.state ?? "idle"}</div>
        <div><div className="text-muted-foreground">last seen</div>{relTime(agent?.last_seen)}</div>
        <div><div className="text-muted-foreground">applied today</div>{agent?.applied_today ?? 0}</div>
        <div><div className="text-muted-foreground">version</div>{agent?.version ?? "—"}</div>
      </div>
      <Btn variant="primary" onClick={download}>download chrome extension</Btn>
      {dl ? <ErrorLine error={dl} /> : null}
      <pre className="whitespace-pre-wrap border border-border p-2 text-xs">{`1. unzip applypilot-extension.zip
2. open chrome://extensions
3. turn on "Developer mode" (top right)
4. click "Load unpacked" → pick the unzipped folder
5. pin the ApplyPilot icon, click it
6. sign in with the same email + password you use here
   (the database address is already filled in${origin ? `; panel: ${origin}` : ""})
7. tick "dry run" → START APPLYING to watch it fill forms safely
8. untick dry run → START APPLYING to submit for real`}</pre>
    </Block>
  );
}

/* --------------------------------- email -------------------------------- */
const BRIDGE_SETUP = (bridgeCode.match(/SETUP[\s\S]*?Executions, in the left sidebar\./)?.[0] ?? "")
  .split("\n").map((l) => l.replace(/^\s*\*\s?/, "")).join("\n");

function EmailBlock({ initial, open }: { initial: Profile; open: boolean }) {
  const qc = useQueryClient();
  const [autoReply, setAutoReply] = useState(initial.auto_reply ?? false);
  const [followUp, setFollowUp] = useState(initial.follow_up ?? false);
  const [dailySummary, setDailySummary] = useState(initial.daily_summary ?? false);
  const [notify, setNotify] = useState((initial as Profile & { notify_moments?: boolean | null }).notify_moments !== false);
  const [availability, setAvailability] = useState(initial.availability ?? "");
  const [availabilitySaved, setAvailabilitySaved] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const sync = useQuery({
    queryKey: ["email-sync"],
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.from("email_sync").select("*").eq("id", 1).maybeSingle();
      if (error) throw error;
      return data;
    },
  });
  const last = sync.data?.last_run_at;
  // The mailbox is read once an hour.
  const fresh = !!last && Date.now() - new Date(last).getTime() < 100 * 60_000;

  return (
    <Block title="email" open={open}>
      <GmailSettings />
      <div className="space-y-1">
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={autoReply} onChange={async (e) => {
            const v = e.target.checked;
            setAutoReply(v); setSaveErr(null);
            const { error } = await supabase.from("profile").update({ auto_reply: v }).eq("id", 1);
            if (error) { setAutoReply(!v); setSaveErr(error.message); } else void qc.invalidateQueries({ queryKey: ["settings"] });
          }} />
          send replies to interview requests without showing me first
        </label>
        <p className="text-xs text-muted-foreground">off: drafts wait here. on: a reply to a scheduling request goes out within five minutes. offers and assessments always wait, whatever this is set to.</p>
        {saveErr ? <ErrorLine error={saveErr} /> : null}
      </div>

      <div className="space-y-1">
        <div className="text-xs">interview calendar</div>
        <InterviewCalendar
          initialSlots={(initial as Profile & { availability_slots?: unknown }).availability_slots}
          initialHolds={(initial as Profile & { interview_holds?: unknown }).interview_holds}
          zone={String((initial as Profile & { timezone?: string | null }).timezone ?? "") || "America/New_York"}
        />
      </div>

      <div className="space-y-1">
        <label className="block text-xs" htmlFor="availability">when i can interview, in words</label>
        <input
          id="availability"
          className="w-full border border-border bg-background px-2 py-1 text-xs"
          placeholder="weekdays between 9am and 5pm Eastern, with a day's notice"
          maxLength={300}
          value={availability}
          onChange={(e) => { setAvailability(e.target.value); setAvailabilitySaved(false); }}
          onBlur={async () => {
            setSaveErr(null);
            const { error } = await supabase.from("profile").update({ availability: availability.trim() || null }).eq("id", 1);
            if (error) setSaveErr(error.message); else { setAvailabilitySaved(true); void qc.invalidateQueries({ queryKey: ["settings"] }); }
          }}
        />
        <p className="text-xs text-muted-foreground">written once, in your own words. if google calendar access was granted when gmail was connected, replies offer specific free hours inside these times — it sees only when you are busy, never what an event is. otherwise this is offered as it stands. left empty, replies say your schedule is flexible and ask them to name a time.{availabilitySaved ? " saved." : ""}</p>
      </div>

      <div className="space-y-1">
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={followUp} onChange={async (e) => {
            const v = e.target.checked;
            setFollowUp(v); setSaveErr(null);
            const { error } = await supabase.from("profile").update({ follow_up: v }).eq("id", 1);
            if (error) { setFollowUp(!v); setSaveErr(error.message); } else void qc.invalidateQueries({ queryKey: ["settings"] });
          }} />
          email the employer after each application, with my resume attached
        </label>
        <p className="text-xs text-muted-foreground">off: nothing is sent. on: after an application goes in, a short note written for that role is sent from your gmail to the contact address the employer publishes on its own site. one per employer a month, at most 25 a day, and none where no address is published.</p>
      </div>

      <div className="space-y-1">
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={dailySummary} onChange={async (e) => {
            const v = e.target.checked;
            setDailySummary(v); setSaveErr(null);
            const { error } = await supabase.from("profile").update({ daily_summary: v }).eq("id", 1);
            if (error) { setDailySummary(!v); setSaveErr(error.message); } else void qc.invalidateQueries({ queryKey: ["settings"] });
          }} />
          email me a summary of each day
        </label>
        <p className="text-xs text-muted-foreground">off: nothing is sent. on: one email each morning to your own gmail — what was applied to in the last 24 hours, which replies are worth reading, what is stuck and why, and how much is waiting.</p>
      </div>

      <div className="space-y-1">
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={notify} onChange={async (e) => {
            const v = e.target.checked;
            setNotify(v); setSaveErr(null);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const { error } = await (supabase.from("profile") as any).update({ notify_moments: v }).eq("id", 1);
            if (error) { setNotify(!v); setSaveErr(error.message); } else void qc.invalidateQueries({ queryKey: ["settings"] });
          }} />
          email me when an interview is booked, an assessment arrives, or an offer comes
        </label>
        <p className="text-xs text-muted-foreground">on: one email to your own gmail for each. an interview comes with its time, how to join, a calendar file, and what the posting asks for beside your resume; a link to pick a time, an assessment and an offer are passed on as they are. also one if the system itself stops working. off: interviews are still marked on your calendar of windows, quietly.</p>
      </div>

      <div className="space-y-1 border border-border p-2 text-xs">
        <div className="text-muted-foreground">gmail bridge</div>
        {sync.isLoading ? <Cursor /> : sync.error ? <ErrorLine error={sync.error} onRetry={() => sync.refetch()} /> : (
          <>
            <div className={fresh ? "text-success" : "text-destructive"}>
              {fresh ? "●" : "○"} last sync: {last ? `${relTime(last)} ago` : "never"}
            </div>
            {sync.data?.last_status ? <div>status: {sync.data.last_status}</div> : null}
            {sync.data?.last_error ? <div className="text-destructive">error: {sync.data.last_error}</div> : null}
            {!fresh ? <div className="text-muted-foreground">a bridge that has stopped looks exactly like an empty inbox. if this is red, check Executions in Apps Script.</div> : null}
          </>
        )}
      </div>

      <pre className="whitespace-pre-wrap border border-border p-2 text-xs">{BRIDGE_SETUP}</pre>
      <div className="flex items-center gap-2">
        <Btn onClick={async () => { await navigator.clipboard.writeText(bridgeCode); setCopied(true); setTimeout(() => setCopied(false), 2000); }}>
          {copied ? "copied" : "copy"}
        </Btn>
        <span className="text-xs text-muted-foreground">gmail-bridge/Code.gs · uses the existing ENGINE_API_KEY</span>
      </div>
      <pre className="max-h-80 overflow-auto border border-border p-2 text-[11px] leading-4">{bridgeCode}</pre>
    </Block>
  );
}
