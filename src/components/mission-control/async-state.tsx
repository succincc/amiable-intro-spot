import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export function Cursor({ label = "loading" }: { label?: string }) {
  return (
    <div className="py-6 text-sm text-muted-foreground" aria-busy="true">
      {label}
      <span className="ap-cursor ml-1 inline-block h-4 w-2 translate-y-0.5 bg-primary" />
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="border border-dashed border-border px-3 py-6 text-sm text-muted-foreground">{children}</div>;
}

export function ErrorLine({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const msg = error instanceof Error ? error.message : String((error as { message?: string })?.message ?? error);
  return (
    <div className="border border-destructive/50 px-3 py-2 text-sm text-destructive">
      error: {msg}
      {onRetry ? (
        <button onClick={onRetry} className="ml-3 underline">retry</button>
      ) : null}
    </div>
  );
}

export function Section({ title, children, right, className }: { title: string; children: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <section className={cn("space-y-2", className)}>
      <div className="flex items-center justify-between">
        <h2 className="text-xs text-muted-foreground">[ {title} ]</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

export function Btn({
  children, onClick, disabled, variant = "default", className, type = "button",
}: {
  children: ReactNode; onClick?: () => void; disabled?: boolean;
  variant?: "default" | "primary" | "danger" | "ghost"; className?: string; type?: "button" | "submit";
}) {
  const v = {
    default: "border-border text-foreground hover:bg-accent",
    primary: "border-primary text-primary hover:bg-primary/10",
    danger: "border-destructive/60 text-destructive hover:bg-destructive/10",
    ghost: "border-transparent text-muted-foreground hover:text-foreground",
  }[variant];
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={cn("min-h-9 border px-3 text-xs uppercase tracking-widest disabled:opacity-40", v, className)}
    >
      {children}
    </button>
  );
}

export const inputCls =
  "w-full min-h-9 border border-border bg-background px-2 text-sm text-foreground outline-none focus:border-primary";
