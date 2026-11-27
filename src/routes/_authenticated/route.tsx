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
    return { user: data.user, access };
  },
  component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
  const { access } = Route.useRouteContext();
  // An approved member has a login and, for now, nothing behind it: each
  // person's own workspace is the next thing being built. The owner's data
  // is the owner's alone and is not shown to anyone else.
  if (access !== "owner") {
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
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

