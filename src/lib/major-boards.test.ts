import { describe, expect, it } from "vitest";

// @ts-expect-error — untyped root automation ESM module
const selectors = await import("../../major-boards-selectors.mjs");
// @ts-expect-error — untyped root automation ESM module
const engine = await import("../../major-boards-engine.mjs");

const { CircuitBreakerRateLimiter, detectBoardPlatform, detectHumanVerification, extractBoardJobId, fuzzyMatchOption, isOnDomain, normalizeBoardUrl } = selectors;
const { normalizeSessionCookies } = engine;

process.env["MAJOR_BOARDS_IMPORT_ONLY"] = "1";
// @ts-expect-error — untyped root automation ESM module
const { buildBoardSearchUrl, filterBoardPostings } = await import("../../major-boards.mjs");

describe("major job boards (LinkedIn, Indeed, ZipRecruiter)", () => {
  it("detects platform and canonicalizes URLs without grabbing small slug numbers", () => {
    expect(detectBoardPlatform("https://www.linkedin.com/jobs/view/devops-k8s-0-downtime-4384228814/?ref=1")).toBe("linkedin");
    expect(extractBoardJobId("linkedin", "https://www.linkedin.com/jobs/view/devops-k8s-0-downtime-4384228814/")).toBe("4384228814");
    expect(normalizeBoardUrl("linkedin", "https://www.linkedin.com/jobs/view/devops-k8s-0-downtime-4384228814/?trk=abc")).toBe(
      "https://www.linkedin.com/jobs/view/4384228814/",
    );

    expect(detectBoardPlatform("https://www.indeed.com/rc/clk?jk=a1b2c3d4e5f6&from=serp")).toBe("indeed");
    expect(normalizeBoardUrl("indeed", "https://www.indeed.com/rc/clk?jk=a1b2c3d4e5f6&from=serp")).toBe(
      "https://www.indeed.com/viewjob?jk=a1b2c3d4e5f6",
    );

    expect(detectBoardPlatform("https://www.ziprecruiter.com/jobs/acme-co/9f8e7d6c?utm_source=test")).toBe("ziprecruiter");
    expect(extractBoardJobId("ziprecruiter", "https://www.ziprecruiter.com/jobs/acme-co/9f8e7d6c")).toBe("9f8e7d6c");
    expect(normalizeBoardUrl("ziprecruiter", "https://www.ziprecruiter.com/jobs/acme-co/9f8e7d6c?utm_source=test")).toBe(
      "https://www.ziprecruiter.com/jobs/acme-co/9f8e7d6c",
    );

    expect(detectBoardPlatform("https://boards.greenhouse.io/acme/jobs/123")).toBeNull();
  });

  it("checks domain ownership accurately for external ATS delegation", () => {
    expect(isOnDomain("https://www.linkedin.com/jobs/view/1234567/", "linkedin.com")).toBe(true);
    expect(isOnDomain("https://boards.greenhouse.io/acme/jobs/1", "linkedin.com")).toBe(false);
    expect(isOnDomain("https://notindeed.com/jobs", "indeed.com")).toBe(false);
  });

  it("matches select/radio options with 3-tier fuzzy matching", () => {
    const opts = ["United States", "Canada", "Bachelor's Degree", "5+ years"];
    expect(fuzzyMatchOption("canada", opts)).toBe("Canada");
    expect(fuzzyMatchOption("Bachelor", opts)).toBe("Bachelor's Degree");
    expect(fuzzyMatchOption("I have a Bachelor's degree in CS", opts)).toBe("Bachelor's Degree");
    expect(fuzzyMatchOption("Unrelated option", opts)).toBeNull();
  });

  it("detects Cloudflare, CAPTCHA, and LinkedIn security checkpoints for pause-and-resume", () => {
    const cf = detectHumanVerification("indeed", "https://www.indeed.com/jobs", "Just a moment...", "", false);
    expect(cf.blocked).toBe(true);
    expect(cf.help_reason).toBe("captcha");

    const li = detectHumanVerification("linkedin", "https://www.linkedin.com/checkpoint/challenge/123", "Security Verification", "Let's do a quick security check", false);
    expect(li.blocked).toBe(true);
    expect(li.help_reason).toBe("verification_required");

    const ok = detectHumanVerification("ziprecruiter", "https://www.ziprecruiter.com/jobs-search", "Jobs", "Software Engineer at Acme", false);
    expect(ok.blocked).toBe(false);
  });

  it("normalizes Chrome extension and Playwright cookies scoped to the target board", () => {
    const cookies = normalizeSessionCookies(
      {
        cookies: [
          { name: "li_at", value: "tok", domain: ".linkedin.com", path: "/", sameSite: "no_restriction", expirationDate: 1999999999.5 },
          { name: "other", value: "x", domain: ".indeed.com", path: "/" },
        ],
      },
      "linkedin",
    );
    expect(cookies).toHaveLength(1);
    expect(cookies[0]?.name).toBe("li_at");
    expect(cookies[0]?.sameSite).toBe("None");
    expect(cookies[0]?.secure).toBe(true);
    expect(cookies[0]?.expires).toBe(1999999999);
  });

  it("opens and resets circuit-breaker rate limiter on consecutive failures", () => {
    const rl = new CircuitBreakerRateLimiter({ minDelayMs: 100, maxDelayMs: 100, maxFailures: 2, cooldownMs: 5000 });
    expect(rl.isOpen(1000)).toBe(false);
    rl.failure(1000);
    expect(rl.isOpen(1000)).toBe(false);
    rl.failure(1000);
    expect(rl.isOpen(2000)).toBe(true);
    expect(rl.isOpen(7000)).toBe(false);
    rl.success();
    expect(rl.failures).toBe(0);
  });

  it("builds board search URLs and filters discovered postings by titles, exclusions, remote, and dedup", () => {
    expect(buildBoardSearchUrl("linkedin", { query: "Account Manager", location: "New Jersey", remote: true })).toContain("f_WT=2");
    expect(buildBoardSearchUrl("indeed", { query: "Account Manager", location: "New Jersey" })).toContain("fromage=7");
    expect(buildBoardSearchUrl("ziprecruiter", { query: "Account Manager", location: "New Jersey", remote: true })).toContain("remote=1");

    const filtered = filterBoardPostings(
      [
        { title: "Account Manager", company: "Acme", url: "https://www.linkedin.com/jobs/view/1111111/", remote: false },
        { title: "Account Manager", company: "Acme", url: "https://www.linkedin.com/jobs/view/1111111/", remote: false },
        { title: "Senior Account Manager", company: "Acme", url: "https://www.linkedin.com/jobs/view/2222222/", remote: false },
        { title: "Account Manager", company: "BlockedCo", url: "https://www.linkedin.com/jobs/view/3333333/", remote: false },
        { title: "Account Manager", company: "RemoteCo", url: "https://www.linkedin.com/jobs/view/4444444/", remote: true },
      ],
      {
        titles: ["Account Manager"],
        exclude_titles: ["senior"],
        exclude_companies: ["blockedco"],
        include_remote: false,
      },
    );
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.url).toBe("https://www.linkedin.com/jobs/view/1111111/");
  });
});