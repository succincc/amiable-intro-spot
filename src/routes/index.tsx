import { useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Loader2, Radar } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { signupProblem, standing, standingMessage } from "@/lib/access";

export const Route = createFileRoute("/")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Sign in · ApplyPilot Mission Control" },
      {
        name: "description",
        content: "Sign in to the private ApplyPilot Mission Control panel.",
      },
      { property: "og:title", content: "Sign in · ApplyPilot Mission Control" },
      {
        property: "og:description",
        content: "Sign in to the private ApplyPilot Mission Control panel.",
      },
      { name: "robots", content: "noindex" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(true);
  const [mode, setMode] = useState<"in" | "up">("in");
  const [fullName, setFullName] = useState("");
  const [confirm, setConfirm] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  // A login is let through only as the owner or once approved; anyone else
  // is signed back out and told where their request stands.
  async function enter(name = "") {
    const s = await standing(name);
    if (s === "owner" || s === "approved") {
      void navigate({ to: "/dashboard", replace: true });
      return;
    }
    await supabase.auth.signOut();
    setNotice(standingMessage(s));
    setChecking(false);
  }

  useEffect(() => {
    let active = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      if (data.session) {
        void enter();
      } else {
        setChecking(false);
      }
    });
    return () => {
      active = false;
    };
  }, [navigate]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    if (mode === "up") {
      const problem = signupProblem({ fullName, email, password, confirm });
      if (problem) {
        setBusy(false);
        toast.error(problem);
        return;
      }
      // The request is made by the panel's server: signing up on one's own
      // is switched off, so a login only ever exists as a request the owner
      // has yet to answer.
      let answer: { ok?: boolean; message?: string } = {};
      try {
        const res = await fetch("/api/public/access/request", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ full_name: fullName.trim(), email: email.trim(), password }),
        });
        answer = ((await res.json()) as typeof answer) ?? {};
      } catch {
        answer = { ok: false, message: "The request could not be sent. Check your connection and try again." };
      }
      if (!answer.ok) {
        setBusy(false);
        toast.error(answer.message ?? "The request could not be made.");
        return;
      }
      setNotice("Sign-up request sent. Approval is decided by the owner.");
      setBusy(false);
      setMode("in");
      setPassword("");
      setConfirm("");
      return;
    }
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setBusy(false);
      toast.error(error.message);
      return;
    }
    await enter();
    setBusy(false);
  }

  if (checking) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/15 text-primary">
            <Radar className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-lg font-semibold leading-tight">Mission Control</h1>
            <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
              ApplyPilot · private
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 rounded-lg border border-border bg-card p-5">
          {notice ? <p className="rounded-md border border-border bg-background p-3 text-sm">{notice}</p> : null}
          {mode === "up" ? (
            <div className="space-y-2">
              <Label htmlFor="fullName">Full name</Label>
              <Input id="fullName" autoComplete="name" required value={fullName} onChange={(event) => setFullName(event.target.value)} />
            </div>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete={mode === "up" ? "new-password" : "current-password"}
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
          {mode === "up" ? (
            <div className="space-y-2">
              <Label htmlFor="confirm">Confirm password</Label>
              <Input id="confirm" type="password" autoComplete="new-password" required value={confirm} onChange={(event) => setConfirm(event.target.value)} />
            </div>
          ) : null}
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : mode === "up" ? "Request access" : "Sign in"}
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            {mode === "up" ? "Already approved? " : "No account? "}
            <button type="button" className="underline" onClick={() => { setMode(mode === "up" ? "in" : "up"); setNotice(null); }}>
              {mode === "up" ? "Sign in" : "Request access"}
            </button>
            {mode === "up" ? " Access is by the owner's approval." : ""}
          </p>
        </form>
      </div>
    </main>
  );
}
