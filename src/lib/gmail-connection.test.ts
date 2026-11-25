import { describe, expect, it } from "vitest";
import { gmailConnectionState } from "./gmail-connection";

describe("Gmail connection state", () => {
  it("requires a refresh token, not just a saved address", () => {
    expect(gmailConnectionState(null).connected).toBe(false);
    expect(gmailConnectionState({ refresh_token: null, email: "owner@example.com", connected_at: null, last_sync_at: null, last_error: null }).connected).toBe(false);
  });
  it("returns connection metadata without exposing credentials", () => {
    const state = gmailConnectionState({ refresh_token: "test-secret", email: "owner@example.com", connected_at: "2026-11-23T02:00:00Z", last_sync_at: "2026-11-23T02:10:00Z", last_error: "Sync failed" });
    expect(state).toEqual({ connected: true, email: "owner@example.com", connected_at: "2026-11-23T02:00:00Z", last_sync_at: "2026-11-23T02:10:00Z", last_error: "Sync failed", mismatch: null });
    expect(JSON.stringify(state)).not.toContain("test-secret");
  });

  const row = (email: string) => ({
    refresh_token: "t", email, connected_at: null, last_sync_at: null, last_error: null,
  });

  it("warns when the connected mailbox is not the address that applies", () => {
    const state = gmailConnectionState(row("backup@example.com"), "owner@example.com");
    expect(state.mismatch).toContain("backup@example.com");
    expect(state.mismatch).toContain("owner@example.com");
  });

  it("stays quiet when the addresses agree, whatever the casing", () => {
    expect(gmailConnectionState(row("Owner@Example.com"), "owner@example.com").mismatch).toBeNull();
    expect(gmailConnectionState(row("owner@example.com"), " owner@example.com ").mismatch).toBeNull();
  });

  it("does not warn when there is nothing to compare", () => {
    expect(gmailConnectionState(row("backup@example.com"), null).mismatch).toBeNull();
    expect(gmailConnectionState(row("backup@example.com"), "").mismatch).toBeNull();
    // Not connected: the address on the row is stale, so a warning would be noise.
    expect(gmailConnectionState({ ...row("backup@example.com"), refresh_token: null }, "owner@example.com").mismatch).toBeNull();
  });
});