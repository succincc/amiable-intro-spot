// ============================================================================
// access.ts — who may come in.
//
// A login is not an invitation. Signing up files a request; the owner says
// yes or no. Until then, and after a no, the panel shows nothing — and the
// database would give nothing if it did: every table is the owner's alone.
// ============================================================================

import { supabase } from "@/integrations/supabase/client";

export type Standing = "owner" | "approved" | "pending" | "denied" | "unknown";

/** Where the signed-in person stands. Files their request the first time it is asked. */
export async function standing(fullName = ""): Promise<Standing> {
  // request_access is newer than the generated types.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc("request_access", { p_full_name: fullName });
  if (error) return "unknown";
  return data === "owner" || data === "approved" || data === "pending" || data === "denied" ? data : "unknown";
}

/** What a sign-up form has to hold before it is sent. Null when it is in order. */
export function signupProblem(f: { fullName: string; email: string; password: string; confirm: string }): string | null {
  if (f.fullName.trim().split(/\s+/).filter(Boolean).length < 2) return "Enter your first and last name.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(f.email.trim())) return "Enter a valid email address.";
  if (f.password.length < 8) return "Use a password of at least 8 characters.";
  if (f.password !== f.confirm) return "The two passwords do not match.";
  return null;
}

/** What to tell someone who signed in but may not come in. */
export function standingMessage(s: Standing): string {
  if (s === "pending") return "Sign-up request sent. Approval is decided by the owner.";
  if (s === "denied") return "This sign-up request was not approved.";
  return "Access could not be checked. Try again in a minute.";
}
