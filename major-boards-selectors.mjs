// major-boards-selectors.mjs — Selectors, URL helpers, stealth, humanizer,
// rate-limiter, and verification detectors for LinkedIn, Indeed, and ZipRecruiter.
//
// Portions of selector registries, stealth scripts, humanizer pacing, fuzzy
// option matching, and circuit-breaker rate limiting are adapted from
// billmal071/job-agent (Copyright (c) 2025 Malachy Williams, MIT License).

export const BOARD_PLATFORMS = ["linkedin", "indeed", "ziprecruiter"];

export const BOARD_HOSTS = {
  linkedin: "linkedin.com",
  indeed: "indeed.com",
  ziprecruiter: "ziprecruiter.com",
};

export const BOARD_SELECTORS = {
  linkedin: {
    homepageUrl: "https://www.linkedin.com/feed/",
    loginUrl: "https://www.linkedin.com/login",
    searchUrl: "https://www.linkedin.com/jobs/search/",
    usernameField: "#username",
    passwordField: "#password",
    loginSubmit: 'button[type="submit"]',
    loggedInCheck: '.global-nav__me, nav[aria-label="Primary"], .feed-identity-module, img.global-nav__me-photo',
    loggedOutCheck: 'a.nav__button-secondary:has-text("Sign in"), a[href*="/login"], button:has-text("Sign in")',
    loginPopup: '[data-test-modal-id="join-now-modal"], .join-now-modal, [role="dialog"]:has-text("Sign in"), [role="dialog"]:has-text("Join LinkedIn")',
    loginPopupClose: 'button[aria-label="Dismiss"], button.contextual-sign-in-modal__modal-dismiss, button.modal__dismiss, .artdeco-modal__dismiss',
    jobCard: ".scaffold-layout__list-item, .jobs-search-results-list__list-item, .jobs-search-results__list-item, .job-card-container, div.base-search-card.job-search-card",
    jobTitle: ".job-card-list__title, .job-card-container__link, .artdeco-entity-lockup__title, h3.base-search-card__title",
    jobCompany: ".job-card-container__primary-description, .job-card-container__company-name, .artdeco-entity-lockup__subtitle, h4.base-search-card__subtitle",
    jobLocation: ".job-card-container__metadata-item, .job-card-container__metadata-wrapper, .artdeco-entity-lockup__caption, .job-search-card__location",
    jobUrl: "a[href*='/jobs/view/'], a.base-card__full-link",
    jobSalary: ".job-card-container__salary-info, .artdeco-entity-lockup__metadata",
    easyApplyBadge: ".job-card-container__apply-method, [data-is-easy-apply-button], .jobs-apply-button--top-card, li-icon[type='linkedin-bug']",
    paginationNext: 'button[aria-label="Next"], button.artdeco-pagination__button--next, button[aria-label="View next page"]',
    detailDescription: ".jobs-description__content, .jobs-box__html-content, .jobs-description-content__text, #job-details, .description__text",
    applyButton: '[aria-label*="Easy Apply"], .jobs-apply-button, button:has-text("Easy Apply"), a:has-text("Easy Apply")',
    externalApplyLink: 'a[href*="/applyredirect"], a:has-text("Apply"):not(:has-text("Easy Apply")), button.jobs-apply-button:not(:has-text("Easy Apply"))',
    easyApplyModal: '.jobs-easy-apply-modal, [data-test-modal-id="easy-apply-modal"], [role="dialog"]',
    nextStepButton: '[aria-label="Continue to next step"], [aria-label="Next"], button:has-text("Next"), button:has-text("Continue")',
    reviewButton: '[aria-label="Review your application"], button:has-text("Review")',
    submitButton: '[aria-label="Submit application"], button:has-text("Submit application"), button:has-text("Submit")',
    appliedBadge: '.jobs-apply-button--applied, [aria-label*="Applied"], .artdeco-inline-feedback--success',
    successConfirmation: ':text("Application sent"), :text("Your application was sent"), .artdeco-inline-feedback--success, [data-test-modal-id="post-apply-modal"]',
    formErrors: ".artdeco-inline-feedback--error, .fb-dash-form-element__error-field, [data-test-form-element-error], .jobs-easy-apply-form-element__error",
    discardDialog: '[data-test-modal-id="data-test-easy-apply-discard-confirmation"], [role="alertdialog"], [role="dialog"]:has-text("Discard")',
    discardButton: 'button:has-text("Discard"), button[data-test-dialog-primary-btn]',
    resumeUploaded: ".jobs-document-upload-redesign-card__file-name, .jobs-document-upload__file-name, .jobs-resume-upload__file-name",
    questionGroups: ".jobs-easy-apply-form-section__grouping, .jobs-easy-apply-form-element, .fb-dash-form-element",
    questionLabel: "label, legend, span.t-14",
  },
  indeed: {
    homepageUrl: "https://www.indeed.com/",
    loginUrl: "https://secure.indeed.com/auth",
    searchUrl: "https://www.indeed.com/jobs",
    usernameField: 'input[type="email"], input[name="__email"]',
    emailSubmit: '[data-tn-element="auth-page-email-submit"], button[type="submit"]',
    passwordField: 'input[type="password"], input[name="__password"]',
    loginSubmit: 'button[type="submit"]',
    loggedInCheck: '[data-gnav-element-name="Profile"], [aria-label*="Profile"], a[href*="/myjobs"], #AccountMenu',
    jobCard: ".job_seen_beacon, .resultContent",
    jobTitle: "h2.jobTitle a, .jobTitle > a",
    jobCompany: '[data-testid="company-name"], .companyName',
    jobLocation: '[data-testid="text-location"], .companyLocation',
    jobUrl: "h2.jobTitle a, .jobTitle > a",
    jobSalary: ".salary-snippet-container, .metadata.salary-snippet-container",
    easyApplyBadge: ".iaLabel, .indeed-apply-badge, [data-indeed-apply-button]",
    paginationNext: 'a[data-testid="pagination-page-next"], a[aria-label="Next Page"]',
    detailDescription: "#jobDescriptionText, .jobsearch-jobDescriptionText",
    applyButton: '#indeedApplyButton, button[id*="apply"], button:has-text("Apply now")',
    externalApplyLink: 'a:has-text("Apply on company site"), a.jobsearch-IndeedApplyButton-newDesign, button:has-text("Apply on company site"), a[href*="applystart"]',
    continueButton: 'button[id*="continue"], button:has-text("Continue"), button:has-text("Review your application"), button:has-text("Submit your application"), button:has-text("Submit"), button:has-text("Apply")',
    submitButton: 'button:has-text("Submit your application"), button:has-text("Submit application"), button:has-text("Submit")',
    successConfirmation: ':text("Your application has been submitted"), :text("Application submitted"), :text("You\'ve applied"), [data-testid="post-apply-confirmation"]',
    formErrors: '.ia-Questions-errorMessage, [role="alert"], .css-1s1r2hr',
    questionGroups: '.ia-Questions-item, .ia-BasePage-field, fieldset, [data-testid="questionItem"]',
    questionLabel: "label, legend, .ia-Questions-title",
  },
  ziprecruiter: {
    homepageUrl: "https://www.ziprecruiter.com/",
    loginUrl: "https://www.ziprecruiter.com/authn/login",
    searchUrl: "https://www.ziprecruiter.com/jobs-search",
    usernameField: 'input[type="email"], input[name="email"]',
    passwordField: 'input[type="password"], input[name="password"]',
    loginSubmit: 'button[type="submit"]',
    loggedInCheck: 'a[href*="/candidate/"], [data-testid="user-menu"], button[aria-label*="Account"]',
    jobCard: ".job_result_item, article.job_result, .job-listing, article[data-testid='job-card']",
    jobTitle: ".job_title a, h2.job_title, [data-testid='job-title'] a, h2 a",
    jobCompany: ".company_name, a.company-name, [data-testid='company-name']",
    jobLocation: ".job_location, .location, [data-testid='job-location']",
    jobUrl: ".job_title a, h2.job_title a, [data-testid='job-title'] a, a[href*='/jobs/']",
    jobSalary: ".salary, .compensation, [data-testid='salary']",
    easyApplyBadge: ".one_click_apply, .quick-apply-badge, button:has-text('1-Click Apply'), button:has-text('Quick Apply')",
    paginationNext: 'a[aria-label="Next"], a.next-page, [data-testid="pagination-next"]',
    detailDescription: ".job-description, [data-testid='job-description'], .jobDescriptionSection",
    applyButton: 'button:has-text("1-Click Apply"), button:has-text("Quick Apply"), button:has-text("Apply"), a:has-text("Apply Now"), [data-testid="apply-button"]',
    externalApplyLink: 'a:has-text("Apply on Company Site"), a:has-text("Apply on company"), a[target="_blank"]:has-text("Apply")',
    submitButton: 'button:has-text("Submit Application"), button:has-text("Submit"), button:has-text("Continue"), button[type="submit"]',
    successConfirmation: ':text("Application Submitted"), :text("You applied"), :text("Applied!"), :text("Your application has been sent")',
    formErrors: '[role="alert"], .error-message, .field-error',
    questionGroups: "fieldset, .question-container, .form-group, [data-testid='question']",
    questionLabel: "label, legend",
  },
};

/** Detect which major job board a URL belongs to, or null. */
export function detectBoardPlatform(url) {
  try {
    const host = new URL(String(url ?? "")).hostname.toLowerCase();
    if (host === "linkedin.com" || host.endsWith(".linkedin.com")) return "linkedin";
    if (host === "indeed.com" || host.endsWith(".indeed.com")) return "indeed";
    if (host === "ziprecruiter.com" || host.endsWith(".ziprecruiter.com")) return "ziprecruiter";
  } catch {
    /* invalid url */
  }
  return null;
}

/** Check whether a URL's hostname equals or is a subdomain of `domain`. */
export function isOnDomain(url, domain) {
  try {
    const host = new URL(String(url ?? "")).hostname.replace(/\.+$/, "").toLowerCase();
    const d = String(domain ?? "").replace(/\.+$/, "").toLowerCase();
    return host === d || host.endsWith(`.${d}`);
  } catch {
    return false;
  }
}

/** Extract a stable platform job ID from a job URL. */
export function extractBoardJobId(platform, url) {
  const s = String(url ?? "");
  if (platform === "linkedin") {
    // Require 7+ digits to skip small numbers inside URL slugs (e.g. k8s-0-downtime-4384228814)
    const m = s.match(/\/jobs\/view\/.*?(\d{7,})/) || s.match(/currentJobId=(\d{7,})/) || s.match(/jobPosting:(\d{7,})/);
    return m ? m[1] : "";
  }
  if (platform === "indeed") {
    const m = s.match(/[?&](?:jk|vjk)=([a-f0-9]{8,})/i);
    return m ? m[1] : "";
  }
  if (platform === "ziprecruiter") {
    const m = s.match(/\/jobs\/[^/?#]+\/([a-f0-9-]{6,})/i) || s.match(/[?&](?:jid|lvk)=([a-zA-Z0-9_-]{6,})/);
    if (m) return m[1];
    try {
      const segs = new URL(s).pathname.replace(/\/+$/, "").split("/").filter(Boolean);
      return segs.length ? segs[segs.length - 1] : "";
    } catch {
      return "";
    }
  }
  return "";
}

/** Canonicalize a board job URL so deduplication and navigation are deterministic. */
export function normalizeBoardUrl(platform, url, externalId = "") {
  const id = externalId || extractBoardJobId(platform, url);
  if (platform === "linkedin" && id) return `https://www.linkedin.com/jobs/view/${id}/`;
  if (platform === "indeed" && id) return `https://www.indeed.com/viewjob?jk=${id}`;
  if (platform === "ziprecruiter") {
    try {
      const u = new URL(String(url ?? ""));
      u.hash = "";
      for (const k of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"]) u.searchParams.delete(k);
      return u.toString();
    } catch {
      return String(url ?? "");
    }
  }
  return String(url ?? "");
}

/**
 * 3-tier fuzzy option matcher: exact (case-insensitive) -> substring -> word overlap.
 * Adapted from billmal071/job-agent BaseApplicator._fuzzy_match_option.
 */
export function fuzzyMatchOption(answer, options) {
  const want = String(answer ?? "").trim().toLowerCase();
  if (!want || !Array.isArray(options) || !options.length) return null;

  for (const opt of options) {
    if (String(opt ?? "").trim().toLowerCase() === want) return opt;
  }
  for (const opt of options) {
    const o = String(opt ?? "").trim().toLowerCase();
    if (o && (want.includes(o) || o.includes(want))) return opt;
  }
  const wantWords = new Set(want.split(/[^a-z0-9]+/).filter(Boolean));
  let best = null;
  let bestScore = 0;
  for (const opt of options) {
    const words = String(opt ?? "").trim().toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    let overlap = 0;
    for (const w of words) if (wantWords.has(w)) overlap++;
    if (overlap > bestScore) {
      bestScore = overlap;
      best = opt;
    }
  }
  return bestScore > 0 ? best : null;
}

/**
 * Detect human-verification, CAPTCHA, Cloudflare, or security checkpoint walls.
 * Pure function so it can be unit-tested without a browser.
 */
export function detectHumanVerification(platform, url, title, bodyText, hasChallengeFrame = false) {
  const u = String(url ?? "").toLowerCase();
  const t = String(title ?? "").toLowerCase();
  const b = String(bodyText ?? "").toLowerCase();

  if (hasChallengeFrame || /challenges\.cloudflare/.test(u) || /just a moment/.test(t)) {
    return {
      blocked: true,
      help_reason: "captcha",
      note: `${platform}: Cloudflare / human verification challenge appeared. Solve it in your browser, sync your session in the extension or Settings, then click done to resume.`,
    };
  }
  if (platform === "linkedin" && (/\/checkpoint\//.test(u) || /security verification|quick verification|let's do a quick security check/.test(b))) {
    return {
      blocked: true,
      help_reason: "verification_required",
      note: "LinkedIn requested a security checkpoint / 2FA verification. Complete it in Chrome, click Sync Board Sessions in the extension (or update Settings), then click done to resume.",
    };
  }
  if (/additional verification required|verify you are human|are you a robot|please verify you are a human|unusual traffic|access denied|hcaptcha|recaptcha/.test(b)) {
    return {
      blocked: true,
      help_reason: "captcha",
      note: `${platform}: human verification / CAPTCHA wall detected. Complete verification in Chrome, sync your session, then click done to resume.`,
    };
  }
  return { blocked: false, help_reason: null, note: null };
}

/**
 * Adaptive rate limiter with exponential backoff and a circuit breaker.
 * Adapted from billmal071/job-agent RateLimiter.
 */
export class CircuitBreakerRateLimiter {
  constructor({ minDelayMs = 1500, maxDelayMs = 4000, maxFailures = 4, cooldownMs = 60_000 } = {}) {
    this.minDelayMs = minDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.maxFailures = maxFailures;
    this.cooldownMs = cooldownMs;
    this.failures = 0;
    this.openedAt = 0;
  }

  isOpen(now = Date.now()) {
    if (this.failures < this.maxFailures) return false;
    if (now - this.openedAt >= this.cooldownMs) {
      this.failures = 0;
      this.openedAt = 0;
      return false;
    }
    return true;
  }

  nextDelayMs() {
    const base = this.minDelayMs + Math.random() * Math.max(0, this.maxDelayMs - this.minDelayMs);
    const factor = Math.pow(2, Math.min(this.failures, 4));
    return Math.round(base * factor);
  }

  async wait() {
    if (this.isOpen()) return false;
    await new Promise((r) => setTimeout(r, this.nextDelayMs()));
    return true;
  }

  success() {
    this.failures = 0;
    this.openedAt = 0;
  }

  failure(now = Date.now()) {
    this.failures += 1;
    if (this.failures >= this.maxFailures) this.openedAt = now;
  }
}

/** Stealth init scripts (adapted from billmal071/job-agent browser/stealth.py). */
export const STEALTH_INIT_SCRIPT = `
(() => {
  try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch {}
  try {
    if (!window.chrome) window.chrome = { runtime: {}, loadTimes() {}, csi() {}, app: {} };
  } catch {}
  try {
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  } catch {}
  try {
    const orig = WebGLRenderingContext && WebGLRenderingContext.prototype.getParameter;
    if (orig) {
      WebGLRenderingContext.prototype.getParameter = function(p) {
        if (p === 37445) return 'Intel Inc.';
        if (p === 37446) return 'Intel Iris OpenGL Engine';
        return orig.call(this, p);
      };
    }
  } catch {}
})();
`;

export async function applyStealth(context) {
  await context.addInitScript(STEALTH_INIT_SCRIPT).catch(() => {});
}

export function humanDelay(minMs = 600, maxMs = 1800) {
  const ms = Math.round(minMs + Math.random() * Math.max(0, maxMs - minMs));
  return new Promise((r) => setTimeout(r, ms));
}

export async function humanScroll(page, amount = 400) {
  let left = amount;
  while (left > 0) {
    const step = Math.min(left, 80 + Math.floor(Math.random() * 90));
    await page.mouse.wheel(0, step).catch(() => {});
    left -= step;
    await humanDelay(60, 140);
  }
}

export async function humanType(locator, text) {
  await locator.click({ timeout: 5000 }).catch(() => {});
  await locator.fill("").catch(() => {});
  for (const ch of String(text ?? "")) {
    await locator.pressSequentially(ch, { delay: 40 + Math.floor(Math.random() * 80) }).catch(() => {});
  }
}