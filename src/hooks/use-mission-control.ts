import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";

export type Job = Tables<"jobs">;
export type Agent = Tables<"agent">;
export type Run = Tables<"runs">;
export type Answer = Tables<"answers">;
export type Email = Tables<"emails">;
export type Profile = Tables<"profile">;
export type SearchConfig = Tables<"search_config">;
export type Company = Tables<"companies">;

/** Re-renders on an interval so time-derived UI stays honest. */
export function useTicker(intervalMs = 15_000) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
}

export function useRealtimeInvalidate(table: string, keys: string[][]) {
  const queryClient = useQueryClient();
  useEffect(() => {
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    const invalidate = () => {
      for (const key of keys) void queryClient.invalidateQueries({ queryKey: key });
    };
    function connect() {
      if (disposed) return;
      channel = supabase
        .channel(`ap-${table}-${Math.random().toString(36).slice(2)}`)
        .on("postgres_changes", { event: "*", schema: "public", table }, invalidate)
        .subscribe((status) => {
          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
            if (disposed || retry) return;
            retry = setTimeout(() => {
              retry = null;
              if (channel) void supabase.removeChannel(channel);
              channel = null;
              connect();
            }, 3000);
          } else if (status === "SUBSCRIBED") invalidate();
        });
    }
    function onBackOnline() {
      if (disposed) return;
      if (channel) void supabase.removeChannel(channel);
      channel = null;
      connect();
    }
    connect();
    window.addEventListener("online", onBackOnline);
    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      window.removeEventListener("online", onBackOnline);
      if (channel) void supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table, queryClient]);
}

export function useAgent() {
  useRealtimeInvalidate("agent", [["agent"]]);
  useTicker(15_000);
  return useQuery({
    queryKey: ["agent"],
    refetchInterval: 30_000,
    queryFn: async (): Promise<Agent | null> => {
      const { data, error } = await supabase.from("agent").select("*").eq("id", 1).maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

export function agentOnline(agent: Agent | null | undefined) {
  if (!agent?.last_seen) return false;
  return Date.now() - new Date(agent.last_seen).getTime() < 120_000;
}

export type Stats = {
  total: number; new: number; review: number; queued: number; applied: number;
  needs_help: number; interviews: number; offers: number; rejected: number;
  applied_today: number; confirmed: number; within_25mi: number; within_40mi: number;
};

export function useStats() {
  useRealtimeInvalidate("jobs", [["jobs"], ["stats"], ["autopilot"]]);
  return useQuery({
    queryKey: ["stats"],
    queryFn: async (): Promise<Stats> => {
      const { data, error } = await supabase.from("v_stats").select("*").maybeSingle();
      if (error) throw error;
      const d = (data ?? {}) as Record<string, number | null>;
      const n = (k: string) => Number(d[k] ?? 0);
      return {
        total: n("total"), new: n("new"), review: n("review"), queued: n("queued"),
        applied: n("applied"), needs_help: n("needs_help"), interviews: n("interviews"),
        offers: n("offers"), rejected: n("rejected"), applied_today: n("applied_today"),
        confirmed: n("confirmed"), within_25mi: n("within_25mi"), within_40mi: n("within_40mi"),
      };
    },
  });
}

export function useRuns(limit = 10) {
  useRealtimeInvalidate("runs", [["runs"]]);
  return useQuery({
    queryKey: ["runs", limit],
    queryFn: async (): Promise<Run[]> => {
      const { data, error } = await supabase
        .from("runs").select("*").order("started_at", { ascending: false }).limit(limit);
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useJobsByStatus(status: string, limit = 200) {
  return useQuery({
    queryKey: ["jobs", "status", status, limit],
    queryFn: async (): Promise<Job[]> => {
      const { data, error } = await supabase
        .from("jobs").select("*").eq("status", status)
        .order("score", { ascending: false, nullsFirst: false })
        .order("found_at", { ascending: false }).limit(limit);
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useAnswersNeedingCount() {
  useRealtimeInvalidate("answers", [["answers"]]);
  return useQuery({
    queryKey: ["answers", "count"],
    refetchInterval: 60_000,
    queryFn: async () => {
      const { count, error } = await supabase
        .from("answers").select("id", { count: "exact", head: true }).eq("confirmed", false);
      if (error) throw error;
      return count ?? 0;
    },
  });
}

export async function setJobStatus(id: string, status: string, extra: Partial<Job> = {}) {
  const { error } = await supabase.from("jobs").update({ status, ...extra }).eq("id", id);
  if (error) throw error;
}

export function relTime(iso: string | null | undefined) {
  if (!iso) return "—";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// Times are shown in New Jersey's clock, in the form a person reads them.
//
// "America/New_York" rather than a fixed EST on purpose: half the year the
// state is on EDT, and a hard-coded offset would be quietly an hour wrong
// from March to November — on a panel whose whole job is telling you when
// something ran.
const ZONE = "America/New_York";

/** "11:13 PM" */
export function clockTime(iso: string | null | undefined) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("en-US", {
    timeZone: ZONE,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/** "Nov 23, 11:13 PM" */
export function stamp(iso: string | null | undefined) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    timeZone: ZONE,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

export function scoreClass(score: number | null | undefined) {
  if (score == null) return "text-muted-foreground";
  if (score >= 8) return "text-success";
  if (score >= 6) return "text-cyan";
  if (score >= 4) return "text-warning";
  return "text-muted-foreground";
}

export type EmailStats = {
  unread: number; interviews: number; offers: number; drafts_waiting: number;
  replies_failed: number; applications_sent: number; applications_confirmed: number;
};

export function useEmailStats() {
  useRealtimeInvalidate("emails", [["emails"], ["email-stats"]]);
  return useQuery({
    queryKey: ["email-stats"],
    refetchInterval: 60_000,
    queryFn: async (): Promise<EmailStats> => {
      const { data, error } = await supabase.from("v_email_stats").select("*").maybeSingle();
      if (error) throw error;
      const d = (data ?? {}) as Record<string, number | null>;
      const n = (k: string) => Number(d[k] ?? 0);
      return {
        unread: n("unread"), interviews: n("interviews"), offers: n("offers"),
        drafts_waiting: n("drafts_waiting"), replies_failed: n("replies_failed"),
        applications_sent: n("applications_sent"), applications_confirmed: n("applications_confirmed"),
      };
    },
  });
}

/** Share of claimed applications backed by an employer receipt; below this, warn. */
export const CONFIRM_WARN_RATIO = 0.7;
export function confirmationGap(sent: number, confirmed: number) {
  const warn = sent > 0 && confirmed < sent * CONFIRM_WARN_RATIO;
  return { warn, missing: Math.max(0, sent - confirmed) };
}

/** "18 mi", "Remote", or "—". */
export function distanceLabel(j: { remote: boolean | null; distance_miles: number | null }) {
  if (j.remote) return "Remote";
  if (j.distance_miles == null) return "—";
  return `${j.distance_miles} mi`;
}

export type AutopilotState = {
  autopilot: boolean;
  daily_cap: number;
  applications_today: number;
};

export function useAutopilot() {
  return useQuery({
    queryKey: ["autopilot"],
    refetchInterval: 30_000,
    queryFn: async (): Promise<AutopilotState> => {
      const [p, s, c] = await Promise.all([
        supabase.from("profile").select("autopilot").eq("id", 1).single(),
        supabase.from("search_config").select("daily_cap").eq("id", 1).single(),
        supabase.rpc("applications_today"),
      ]);
      if (p.error) throw p.error;
      if (s.error) throw s.error;
      if (c.error) throw c.error;
      return {
        autopilot: Boolean(p.data.autopilot),
        daily_cap: Number(s.data.daily_cap ?? 50),
        applications_today: Number(c.data ?? 0),
      };
    },
  });
}

/** Convert 1–10 score to 10%–100% match display. */
export function scoreToPercent(score: number | null | undefined, fallback = 5) {
  const s = Math.min(10, Math.max(1, Math.round(score ?? fallback)));
  return s * 10;
}

/** Convert 10%–100% slider value back to 1–10 score. */
export function percentToScore(percent: number) {
  return Math.min(10, Math.max(1, Math.round(percent / 10)));
}

/** Validate daily_cap integer within 1–1000, or null if invalid. */
export function parseDailyCap(value: string | number | null | undefined): number | null {
  if (value === "" || value == null) return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isInteger(n) || n < 1 || n > 1000) return null;
  return n;
}
