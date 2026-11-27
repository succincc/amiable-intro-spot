import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../drizzle/migrations/0040_secure_workspace_reset.sql", import.meta.url),
  "utf8",
);
const body = migration.split("AS $$")[1]?.split("END $$;")[0];

describe("workspace reset security", () => {
  it("never executes assembled commands with elevated privileges", () => {
    expect(body).toBeDefined();
    expect(body).not.toMatch(/\bEXECUTE\b/i);
  });

  it("checks owner access and protects the owner before deleting anything", () => {
    expect(body).toBeDefined();
    const firstDelete = body?.indexOf("DELETE FROM") ?? -1;
    const ownerGuard = body?.indexOf("IF NOT public.is_app_owner()") ?? -1;
    const targetGuard = body?.indexOf("FROM public.app_owner WHERE user_id = p_user") ?? -1;
    expect(ownerGuard).toBeGreaterThanOrEqual(0);
    expect(targetGuard).toBeGreaterThan(ownerGuard);
    expect(firstDelete).toBeGreaterThan(targetGuard);
    expect(body).toContain("p_user IS NULL");
    expect(body).toContain("NOT EXISTS (SELECT 1 FROM public.members WHERE user_id = p_user)");
  });

  it("scopes every reset deletion to the selected person's workspace", () => {
    const deletions = body?.match(/DELETE FROM[^;]+;/g) ?? [];
    expect(deletions).toHaveLength(16);
    for (const deletion of deletions) {
      expect(deletion).toMatch(/^DELETE FROM public\.\w+ WHERE user_id = p_user;$/);
    }
  });
});