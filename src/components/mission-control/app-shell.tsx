import type { ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";

import { supabase } from "@/integrations/supabase/client";
import { agentOnline, useAgent, useAnswersNeedingCount, useEmailStats } from "@/hooks/use-mission-control";

const NAV = [
  { to: "/dashboard", label: "dashboard" },
  { to: "/jobs", label: "jobs" },
  { to: "/review", label: "review" },
  { to: "/answers", label: "answers" },
  { to: "/inbox", label: "inbox" },
  { to: "/practice", label: "practice" },
  { to: "/settings", label: "settings" },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { data: agent } = useAgent();
  const { data: needAnswers = 0 } = useAnswersNeedingCount();
  const { data: emailStats } = useEmailStats();
  const unread = emailStats?.unread ?? 0;
  const online = agentOnline(agent);

  async function signOut() {
    await supabase.auth.signOut();
    void navigate({ to: "/", replace: true });
  }

  const item = (n: (typeof NAV)[number], mobile = false) => (
    <Link
      key={n.to}
      to={n.to}
      className={mobile ? "flex-1 py-3 text-center text-[11px] text-muted-foreground" : "block px-4 py-1.5 text-sm text-muted-foreground hover:text-foreground"}
      activeProps={{ className: mobile ? "flex-1 py-3 text-center text-[11px] text-primary" : "block px-4 py-1.5 text-sm text-primary" }}
    >
      {n.label}
      {n.to === "/answers" && needAnswers > 0 ? <span className="ml-1 text-warning">{needAnswers}</span> : null}
      {n.to === "/inbox" && unread > 0 ? <span className="ml-1 text-warning">{unread}</span> : null}
    </Link>
  );

  return (
    <div className="min-h-screen bg-background text-foreground">
      <aside className="fixed inset-y-0 left-0 hidden w-[180px] flex-col border-r border-border bg-card md:flex">
        <div className="px-4 py-4 text-sm">
          <span className="text-primary">$</span> applypilot
        </div>
        <nav className="flex-1">{NAV.map((n) => item(n))}</nav>
        <div className="space-y-2 border-t border-border px-4 py-3 text-xs">
          <div className={online ? "text-success" : "text-muted-foreground"}>
            {online ? "●" : "○"} agent {online ? agent?.state ?? "idle" : "offline"}
          </div>
          <button onClick={signOut} className="text-muted-foreground hover:text-foreground">sign out</button>
        </div>
      </aside>

      <header className="sticky top-0 z-20 flex items-center justify-between border-b border-border bg-card px-3 py-2 text-xs md:hidden">
        <span><span className="text-primary">$</span> applypilot</span>
        <span className={online ? "text-success" : "text-muted-foreground"}>{online ? "●" : "○"} agent</span>
        <button onClick={signOut} className="text-muted-foreground">exit</button>
      </header>

      <main className="px-3 pb-24 pt-4 md:ml-[180px] md:px-6 md:pb-8">
        <div className="mx-auto max-w-5xl">{children}</div>
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-20 flex border-t border-border bg-card md:hidden">
        {NAV.map((n) => item(n, true))}
      </nav>
    </div>
  );
}
