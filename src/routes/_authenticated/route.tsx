import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

import { AppShell } from "@/components/mission-control/app-shell";
import { supabase } from "@/integrations/supabase/client";
import { standing } from "@/lib/access";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/" });
    // Typing a page's address is not a way in: a login that is not the
    // owner's, or not yet approved, is signed out and sent to the door.
    const access = await standing();
    if (access !== "owner" && access !== "approved") {
      await supabase.auth.signOut();
      throw redirect({ to: "/" });
    }
    // The rows a person's panel expects to find are made the first time
    // they come in. Until the database can do that, an approved person has
    // a login and nothing behind it, and is told so.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const made = await (supabase as any).rpc("ensure_workspace");
    const ready = !made.error && made.data === "ready";
    return { user: data.user, access, ready };
  },
  component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
  const { access, ready } = Route.useRouteContext();
  // Each person has a workspace of their own, and sees nothing of anyone
  // else's. Where one could not be made yet, the person is told, rather
  // than shown an empty panel that looks broken.
  if (access !== "owner" && !ready) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="max-w-md space-y-3 rounded-lg border border-border bg-card p-6 text-sm">
          <h1 className="text-base font-semibold">You are approved</h1>
          <p className="text-muted-foreground">Your own workspace is being set up and is not open yet. You will be able to sign in here as soon as it is.</p>
          <button className="underline" onClick={() => void supabase.auth.signOut().then(() => window.location.assign("/"))}>Sign out</button>
        </div>
      </main>
    );
  }
  return (
    <AppShell isOwner={access === "owner"}>
      <Outlet />
    </AppShell>
  );
}

