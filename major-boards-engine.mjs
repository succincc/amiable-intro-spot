// major-boards-engine.mjs — Session management, authentication, workflow
// detection, direct employer routing, and native application flows for
// LinkedIn, Indeed, and ZipRecruiter.
//
// Adapted from billmal071/job-agent (Copyright (c) 2025 Malachy Williams, MIT License),
// integrated with ApplyNow.lol's truthful profile/answer/resume/verification pipeline.

import { existsSync } from "node:fs";
import {
  BOARD_HOSTS,
  BOARD_SELECTORS,
  detectHumanVerification,
  fuzzyMatchOption,
  humanDelay,
  humanType,
  isOnDomain,
  normalizeBoardUrl,
} from "./major-boards-selectors.mjs";

const BLANK_URLS = new Set(["", "about:blank"]);
const CLOSED_RE =
  /no longer accepting|no longer available|has been removed|been taken down|position (has been )?filled|posting (is )?closed|job (has )?expired|job not found/i;

/** Normalize Playwright storageState or Chrome extension cookies for context.addCookies(). */
export function normalizeSessionCookies(sessionState, platform) {
  if (!sessionState) return [];
  let parsed = sessionState;
  if (typeof sessionState === "string") {
    try { parsed = JSON.parse(sessionState); } catch { return []; }
  }
  const raw = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.cookies) ? parsed.cookies : [];
  const host = BOARD_HOSTS[platform] || "";
  const out = [];
  for (const c of raw) {
    if (!c || !c.name || c.value === undefined || !c.domain) continue;
    const domain = String(c.domain);
    if (host && !domain.toLowerCase().includes(host)) continue;
    const sameSiteRaw = String(c.sameSite ?? "").toLowerCase();
    const sameSite =
      sameSiteRaw === "strict" ? "Strict" : sameSiteRaw === "none" || sameSiteRaw === "no_restriction" ? "None" : "Lax";
    const exp = Number(c.expires ?? c.expirationDate ?? -1);
    const cookie = {
      name: String(c.name),
      value: String(c.value),
      domain,
      path: String(c.path || "/"),
      httpOnly: Boolean(c.httpOnly),
      secure: sameSite === "None" ? true : Boolean(c.secure),
      sameSite,
    };
    if (Number.isFinite(exp) && exp > 0) cookie.expires = Math.floor(exp);
    out.push(cookie);
  }
  return out;
}

/** Restore saved cookies into a Playwright BrowserContext. Returns count loaded. */
export async function restoreBoardSession(context, sessionState, platform) {
  const cookies = normalizeSessionCookies(sessionState, platform);
  if (!cookies.length) return 0;
  await context.addCookies(cookies).catch(() => {});
  return cookies.length;
}

/** Capture current cookies for `platform` from a BrowserContext as a storageState object. */
export async function captureBoardSession(context, platform) {
  const host = BOARD_HOSTS[platform];
  if (!host) return null;
  const all = await context.cookies().catch(() => []);
  const cookies = all.filter((c) => String(c.domain || "").toLowerCase().includes(host));
  if (!cookies.length) return null;
  return { cookies, captured_at: new Date().toISOString() };
}

/** Inspect the live page for CAPTCHA / Cloudflare / LinkedIn checkpoint walls. */
export async function checkVerificationWall(page, platform) {
  const url = page.url();
  const title = await page.title().catch(() => "");
  const body = ((await page.innerText("body").catch(() => "")) || "").slice(0, 6000);
  const hasChallengeFrame =
    (await page.locator('iframe[src*="challenges.cloudflare"], iframe[src*="hcaptcha"], iframe[src*="recaptcha/api2/bframe"]').count().catch(() => 0)) > 0;
  return detectHumanVerification(platform, url, title, body, hasChallengeFrame);
}

async function isLoggedIn(page, platform) {
  const sel = BOARD_SELECTORS[platform];
  if (!sel) return false;
  if ((await page.locator(sel.loggedInCheck).count().catch(() => 0)) > 0) return true;
  if (platform === "linkedin") {
    const u = page.url().toLowerCase();
    if (u.includes("/login") || u.includes("/checkpoint")) return false;
    if ((await page.locator(sel.loggedOutCheck).count().catch(() => 0)) > 0) return false;
  }
  return false;
}

async function dismissLinkedInLoginPopup(page) {
  const sel = BOARD_SELECTORS.linkedin;
  const modal = page.locator(sel.loginPopup);
  if ((await modal.count().catch(() => 0)) === 0) return;
  await page.keyboard.press("Escape").catch(() => {});
  await humanDelay(300, 600);
  const closeBtn = page.locator(sel.loginPopupClose);
  const n = await closeBtn.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    if (await closeBtn.nth(i).isVisible().catch(() => false)) {
      await closeBtn.nth(i).click({ timeout: 3000 }).catch(() => {});
      await humanDelay(300, 600);
      break;
    }
  }
}

/**
 * Ensure the browser context has a usable session on `platform`.
 * Uses restored cookies first, then falls back to stored `site_accounts` credentials
 * if provided. Never bypasses CAPTCHA/2FA — parks cleanly for human pause-and-resume.
 */
export async function ensureBoardAuth(page, platform, account, opts = {}) {
  const sel = BOARD_SELECTORS[platform];
  if (!sel) return { ok: false, authenticated: false, help_reason: "unsupported_board", note: `Unsupported board: ${platform}` };

  if (await isLoggedIn(page, platform)) return { ok: true, authenticated: true };
  if (platform === "linkedin") await dismissLinkedInLoginPopup(page);
  if (await isLoggedIn(page, platform)) return { ok: true, authenticated: true };

  const wall = await checkVerificationWall(page, platform);
  if (wall.blocked) return { ok: false, authenticated: false, help_reason: wall.help_reason, note: wall.note };

  if (!account?.email || !account?.password) {
    return {
      ok: false,
      authenticated: false,
      help_reason: "session_expired",
      note: `Not signed in to ${platform}. Sign in to ${BOARD_HOSTS[platform]} in Chrome and click Sync Board Sessions in the extension (or add your session/account in Settings), then click done.`,
    };
  }

  await page.goto(sel.loginUrl, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
  await humanDelay(1200, 2200);

  const loginWall = await checkVerificationWall(page, platform);
  if (loginWall.blocked) return { ok: false, authenticated: false, help_reason: loginWall.help_reason, note: loginWall.note };

  const userBox = page.locator(sel.usernameField).first();
  if ((await userBox.count().catch(() => 0)) > 0 && (await userBox.isVisible().catch(() => false))) {
    await humanType(userBox, account.email);
    if (platform === "indeed" && sel.emailSubmit) {
      const emailNext = page.locator(sel.emailSubmit).first();
      if ((await emailNext.count().catch(() => 0)) > 0) {
        await emailNext.click({ timeout: 6000 }).catch(() => {});
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        await humanDelay(1200, 2200);
      }
    }
    const passBox = page.locator(sel.passwordField).first();
    if ((await passBox.count().catch(() => 0)) > 0 && (await passBox.isVisible().catch(() => false))) {
      await humanType(passBox, account.password);
      await humanDelay(400, 900);
      const submit = page.locator(sel.loginSubmit).first();
      if ((await submit.count().catch(() => 0)) > 0) {
        await submit.click({ timeout: 8000 }).catch(() => {});
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        await humanDelay(2000, 3500);
      }
    }
  }

  // If emailed OTP/code input appears and caller provided waitForCode, try filling it once.
  const otpBox = page.locator('input[name="pin"], input[autocomplete="one-time-code"], input[id*="verification" i]').first();
  if ((await otpBox.count().catch(() => 0)) > 0 && (await otpBox.isVisible().catch(() => false)) && typeof opts.waitForCode === "function") {
    const code = await opts.waitForCode(BOARD_HOSTS[platform], platform).catch(() => null);
    if (code) {
      await humanType(otpBox, code);
      const submit = page.locator('button[type="submit"], button:has-text("Submit"), button:has-text("Verify")').first();
      if ((await submit.count().catch(() => 0)) > 0) {
        await submit.click({ timeout: 8000 }).catch(() => {});
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        await humanDelay(2000, 3500);
      }
    }
  }

  const postWall = await checkVerificationWall(page, platform);
  if (postWall.blocked) return { ok: false, authenticated: false, help_reason: postWall.help_reason, note: postWall.note };

  if (await isLoggedIn(page, platform)) {
    if (typeof opts.onSessionUpdated === "function") {
      const fresh = await captureBoardSession(page.context(), platform);
      if (fresh) await opts.onSessionUpdated(fresh).catch(() => {});
    }
    return { ok: true, authenticated: true };
  }

  return {
    ok: false,
    authenticated: false,
    help_reason: "session_expired",
    note: `${platform} sign-in did not complete automatically (likely OAuth or verification required). Sign in to ${BOARD_HOSTS[platform]} in Chrome and sync your session in the extension or Settings.`,
  };
}

/** Click a button while listening for a new popup tab before the click fires. */
export async function clickAndWaitForPopup(page, locator, timeoutMs = 5000) {
  const popupPromise = page.context().waitForEvent("page", { timeout: timeoutMs }).catch(() => null);
  await locator.click({ timeout: 8000, noWaitAfter: true });
  const popup = await popupPromise;
  return popup;
}

/** Wait for a newly opened page to navigate away from about:blank. */
export async function waitForNonBlankUrl(page, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let url = page.url();
  while (BLANK_URLS.has(url) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    url = page.url();
  }
  return url;
}

/**
 * Detect whether clicking Apply opened or redirected to an external employer ATS.
 * Ignores tabs that already existed in `pagesBefore` so stale tabs are never reused.
 */
export async function findExternalRedirect(page, platformDomain, pagesBefore = []) {
  const allPages = page.context().pages();
  for (let i = allPages.length - 1; i >= 0; i--) {
    const cand = allPages[i];
    if (cand === page || pagesBefore.includes(cand)) continue;
    const url = await waitForNonBlankUrl(cand, 10_000);
    if (BLANK_URLS.has(url)) continue;
    if (!isOnDomain(url, platformDomain)) return cand;
  }
  if (!isOnDomain(page.url(), platformDomain)) return page;
  return null;
}

async function uploadFileIfPresent(scope, filePath, alreadyUploadedSelector = null) {
  if (!filePath || !existsSync(filePath)) return false;
  const input = scope.locator('input[type="file"]').first();
  if ((await input.count().catch(() => 0)) === 0) return false;
  if (alreadyUploadedSelector) {
    const existing = await scope.locator(alreadyUploadedSelector).count().catch(() => 0);
    if (existing > 0) return false;
  }
  await input.setInputFiles(filePath).catch(() => {});
  await humanDelay(600, 1200);
  return true;
}

async function fillBoardQuestionGroups(scope, platform, resolveAnswer) {
  const sel = BOARD_SELECTORS[platform];
  const groups = await scope.locator(sel.questionGroups).all().catch(() => []);
  let filled = 0;
  const unknown = [];

  for (const group of groups) {
    const labelEl = group.locator(sel.questionLabel).first();
    if ((await labelEl.count().catch(() => 0)) === 0) continue;
    const label = ((await labelEl.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
    if (!label) continue;

    // 1. Select dropdown
    const select = group.locator("select").first();
    if ((await select.count().catch(() => 0)) > 0) {
      const cur = await select.inputValue().catch(() => "");
      if (cur && cur !== "" && !/^select/i.test(cur)) continue;
      const options = [];
      for (const opt of await group.locator("select option").all().catch(() => [])) {
        const txt = ((await opt.innerText().catch(() => "")) || "").trim();
        const val = (await opt.getAttribute("value").catch(() => "")) ?? "";
        if (txt && val && !/^select\b/i.test(txt)) options.push(txt);
      }
      const ans = await resolveAnswer(label, "select", options);
      const picked = ans ? fuzzyMatchOption(ans, options) : null;
      if (picked) {
        await select.selectOption({ label: picked }).catch(() => {});
        filled++;
      } else {
        unknown.push({ question: label, field_type: "select", options });
      }
      continue;
    }

    // 2. Radio group
    const radios = group.locator('input[type="radio"]');
    if ((await radios.count().catch(() => 0)) > 0) {
      const checked = await group.locator('input[type="radio"]:checked').count().catch(() => 0);
      if (checked > 0) continue;
      const optLabels = [];
      const radioEls = await radios.all().catch(() => []);
      for (const r of radioEls) {
        const id = await r.getAttribute("id").catch(() => "");
        let txt = "";
        if (id) {
          const lbl = group.locator(`label[for="${id}"]`).first();
          if ((await lbl.count().catch(() => 0)) > 0) txt = ((await lbl.innerText().catch(() => "")) || "").trim();
        }
        if (!txt) txt = ((await r.getAttribute("value").catch(() => "")) || "").trim();
        if (txt) optLabels.push({ txt, r, id });
      }
      const options = optLabels.map((o) => o.txt);
      const ans = await resolveAnswer(label, "radio", options);
      const picked = ans ? fuzzyMatchOption(ans, options) : null;
      const match = picked ? optLabels.find((o) => o.txt === picked) : null;
      if (match) {
        if (match.id) {
          const lbl = group.locator(`label[for="${match.id}"]`).first();
          if ((await lbl.count().catch(() => 0)) > 0) await lbl.click({ timeout: 3000 }).catch(() => match.r.click({ force: true }));
          else await match.r.click({ force: true }).catch(() => {});
        } else {
          await match.r.click({ force: true }).catch(() => {});
        }
        filled++;
      } else {
        unknown.push({ question: label, field_type: "radio", options });
      }
      continue;
    }

    // 3. Checkbox
    const checkbox = group.locator('input[type="checkbox"]').first();
    if ((await checkbox.count().catch(() => 0)) > 0) {
      const ans = await resolveAnswer(label, "checkbox", ["Yes", "No"]);
      if (ans) {
        const want = /^(yes|true|1|agree|checked)$/i.test(String(ans).trim());
        const isChecked = await checkbox.isChecked().catch(() => false);
        if (want !== isChecked) {
          await checkbox.click({ force: true }).catch(() => {});
          filled++;
        }
      }
      continue;
    }

    // 4. Textarea / Text / Number input
    const box = group.locator('textarea, input[type="text"], input[type="number"], input[type="tel"], input[type="email"], input:not([type])').first();
    if ((await box.count().catch(() => 0)) > 0 && (await box.isVisible().catch(() => false))) {
      const cur = ((await box.inputValue().catch(() => "")) || "").trim();
      if (cur) continue;
      const tag = await box.evaluate((el) => el.tagName.toLowerCase()).catch(() => "input");
      const type = (await box.getAttribute("type").catch(() => "")) || "text";
      const fieldType = tag === "textarea" ? "textarea" : type === "number" ? "number" : "text";
      const ans = await resolveAnswer(label, fieldType, []);
      if (ans) {
        await box.fill(String(ans)).catch(() => {});
        filled++;
      } else {
        unknown.push({ question: label, field_type: fieldType, options: [] });
      }
    }
  }
  return { filled, unknown };
}

async function readErrors(page, platform) {
  const sel = BOARD_SELECTORS[platform];
  const els = await page.locator(sel.formErrors).all().catch(() => []);
  const errs = [];
  for (const el of els) {
    if (!(await el.isVisible().catch(() => false))) continue;
    const t = ((await el.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
    if (t) errs.push(t);
  }
  return errs;
}

async function dismissLinkedInDiscard(page) {
  const sel = BOARD_SELECTORS.linkedin;
  const dlg = page.locator(sel.discardDialog);
  if ((await dlg.count().catch(() => 0)) > 0) {
    const btn = dlg.locator(sel.discardButton).first();
    if ((await btn.count().catch(() => 0)) > 0) {
      await btn.click({ timeout: 3000 }).catch(() => {});
      await humanDelay(300, 600);
    }
  }
}

/**
 * Execute a complete job application workflow on LinkedIn, Indeed, or ZipRecruiter.
 *
 * Returns one of:
 * - `{ status: "delegate_external", page, url }` — redirected to direct employer ATS
 * - `{ status: "applied", note, filled }` — confirmed submitted (or already applied)
 * - `{ status: "skipped", skip_reason }` — closed/expired posting
 * - `{ status: "needs_help", help_reason, note, unknown? }` — dry-run, captcha, session expired, or unanswered required fields
 */
export async function applyBoardJob(page, platform, job, opts = {}) {
  const sel = BOARD_SELECTORS[platform];
  const domain = BOARD_HOSTS[platform];
  const dryRun = Boolean(opts.dryRun);
  const resolveAnswer = opts.resolveAnswer || (async () => null);

  const targetUrl = normalizeBoardUrl(platform, job.apply_url || job.url);
  if (targetUrl && page.url() !== targetUrl) {
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await humanDelay(1200, 2200);
  }

  const wall = await checkVerificationWall(page, platform);
  if (wall.blocked) return { status: "needs_help", help_reason: wall.help_reason, note: wall.note };

  // Already redirected off-board on initial load (e.g. Indeed rc/clk redirect)
  if (!isOnDomain(page.url(), domain)) {
    return { status: "delegate_external", page, url: page.url() };
  }

  const body = ((await page.innerText("body").catch(() => "")) || "");
  if (CLOSED_RE.test(body)) return { status: "skipped", skip_reason: "posting closed" };

  if (sel.appliedBadge && (await page.locator(sel.appliedBadge).count().catch(() => 0)) > 0) {
    return { status: "applied", note: `${platform}: already applied` };
  }

  // Check for external apply link first if the job is marked external or no native apply button exists
  const nativeBtn = page.locator(sel.applyButton).first();
  const externalBtn = sel.externalApplyLink ? page.locator(sel.externalApplyLink).first() : null;
  const hasNative = (await nativeBtn.count().catch(() => 0)) > 0 && (await nativeBtn.isVisible().catch(() => false));
  const hasExternal = externalBtn && (await externalBtn.count().catch(() => 0)) > 0 && (await externalBtn.isVisible().catch(() => false));

  // If an external apply link is present and there is no native Easy Apply button, follow it directly without needing board login!
  if (!hasNative && hasExternal) {
    const pagesBefore = [...page.context().pages()];
    await clickAndWaitForPopup(page, externalBtn, 6000).catch(() => {});
    await humanDelay(1500, 2500);
    const redirectPage = await findExternalRedirect(page, domain, pagesBefore);
    if (redirectPage) return { status: "delegate_external", page: redirectPage, url: redirectPage.url() };
  }

  // Native board flow requires authentication on LinkedIn (and usually Indeed/ZipRecruiter)
  if (platform === "linkedin") {
    await dismissLinkedInLoginPopup(page);
    if (!(await isLoggedIn(page, platform))) {
      const auth = await ensureBoardAuth(page, platform, opts.account, opts);
      if (!auth.ok) return { status: "needs_help", help_reason: auth.help_reason, note: auth.note };
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await humanDelay(1200, 2000);
    }
  }

  const activeBtn = page.locator(sel.applyButton).first();
  if ((await activeBtn.count().catch(() => 0)) === 0) {
    return { status: "needs_help", help_reason: "no_apply_button", note: `${platform}: no apply button visible on posting` };
  }

  const pagesBefore = [...page.context().pages()];
  await clickAndWaitForPopup(page, activeBtn, 5000).catch(() => {});
  await humanDelay(1500, 2500);

  // Clicking Apply may redirect off-board (Indeed & ZipRecruiter frequently redirect to company ATS)
  const redirected = await findExternalRedirect(page, domain, pagesBefore);
  if (redirected) return { status: "delegate_external", page: redirected, url: redirected.url() };

  // Multi-step native board application loop
  let totalFilled = 0;
  const allUnknown = [];
  let prevSig = "";
  const maxSteps = 10;

  for (let step = 0; step < maxSteps; step++) {
    await humanDelay(800, 1500);

    const stepWall = await checkVerificationWall(page, platform);
    if (stepWall.blocked) return { status: "needs_help", help_reason: stepWall.help_reason, note: stepWall.note };

    if ((await page.locator(sel.successConfirmation).count().catch(() => 0)) > 0) {
      return { status: "applied", note: `${platform}: application confirmed`, filled: totalFilled };
    }

    const scope =
      platform === "linkedin" && (await page.locator(sel.easyApplyModal).count().catch(() => 0)) > 0
        ? page.locator(sel.easyApplyModal).first()
        : page;

    await uploadFileIfPresent(scope, opts.resumePath, platform === "linkedin" ? sel.resumeUploaded : null);
    if (opts.coverLetterPath) {
      const inputs = await scope.locator('input[type="file"]').all().catch(() => []);
      if (inputs.length > 1 && existsSync(opts.coverLetterPath)) {
        await inputs[1].setInputFiles(opts.coverLetterPath).catch(() => {});
        await humanDelay(500, 1000);
      }
    }

    const { filled, unknown } = await fillBoardQuestionGroups(scope, platform, resolveAnswer);
    totalFilled += filled;
    allUnknown.push(...unknown);

    // Review button (LinkedIn two-step Review -> Submit)
    if (sel.reviewButton) {
      const rev = scope.locator(sel.reviewButton).first();
      if ((await rev.count().catch(() => 0)) > 0 && (await rev.isVisible().catch(() => false))) {
        await rev.click({ timeout: 5000 }).catch(() => {});
        await humanDelay(1200, 2200);
        continue;
      }
    }

    // Final Submit button
    const submitBtn = scope.locator(sel.submitButton).first();
    const hasSubmit = (await submitBtn.count().catch(() => 0)) > 0 && (await submitBtn.isVisible().catch(() => false));
    if (hasSubmit) {
      const submitText = ((await submitBtn.innerText().catch(() => "")) || "").toLowerCase();
      const isFinal = /submit|apply/.test(submitText) && !/continue|next|review/.test(submitText);
      if (isFinal) {
        if (dryRun) {
          if (platform === "linkedin") await dismissLinkedInDiscard(page);
          return { status: "needs_help", help_reason: "dry_run", note: `dry run (${platform}): filled ${totalFilled} field(s), stopped before Submit`, unknown: allUnknown };
        }
        await submitBtn.click({ timeout: 6000 }).catch(() => {});
        await humanDelay(2000, 3500);
        if ((await page.locator(sel.successConfirmation).count().catch(() => 0)) > 0) {
          return { status: "applied", note: `${platform}: application submitted and confirmed`, filled: totalFilled };
        }
        const errs = await readErrors(page, platform);
        if (errs.length) {
          if (platform === "linkedin") await dismissLinkedInDiscard(page);
          return { status: "needs_help", help_reason: "validation_error", note: `${platform} form error: ${errs.join("; ").slice(0, 220)}`, unknown: allUnknown };
        }
        // If modal closed cleanly with no errors, confirm via Applied badge
        if (sel.appliedBadge && (await page.locator(sel.appliedBadge).count().catch(() => 0)) > 0) {
          return { status: "applied", note: `${platform}: submitted (applied badge confirmed)`, filled: totalFilled };
        }
        return { status: "needs_help", help_reason: "unconfirmed", note: `${platform}: clicked Submit but no confirmation banner appeared` };
      }
    }

    // Next / Continue button
    const nextSel = sel.nextStepButton || sel.continueButton;
    const nextBtn = nextSel ? scope.locator(nextSel).first() : null;
    if (!nextBtn || (await nextBtn.count().catch(() => 0)) === 0 || !(await nextBtn.isVisible().catch(() => false))) {
      if (platform === "linkedin") await dismissLinkedInDiscard(page);
      return { status: "needs_help", help_reason: "no_submit_button", note: `${platform}: no Next or Submit button found at step ${step + 1}`, unknown: allUnknown };
    }

    const curSig = ((await scope.innerText().catch(() => "")) || "").slice(0, 300);
    await nextBtn.click({ timeout: 6000 }).catch(() => {});
    await humanDelay(1200, 2200);

    const errs = await readErrors(page, platform);
    if (errs.length) {
      // Retry filling once on validation error
      const retry = await fillBoardQuestionGroups(scope, platform, resolveAnswer);
      totalFilled += retry.filled;
      allUnknown.push(...retry.unknown);
      await nextBtn.click({ timeout: 5000 }).catch(() => {});
      await humanDelay(1200, 2000);
      const errs2 = await readErrors(page, platform);
      if (errs2.length) {
        if (platform === "linkedin") await dismissLinkedInDiscard(page);
        return { status: "needs_help", help_reason: "validation_error", note: `${platform} required fields: ${errs2.join("; ").slice(0, 220)}`, unknown: allUnknown };
      }
    }

    const newSig = ((await scope.innerText().catch(() => "")) || "").slice(0, 300);
    if (newSig && newSig === curSig && curSig === prevSig) {
      if (platform === "linkedin") await dismissLinkedInDiscard(page);
      return { status: "needs_help", help_reason: "stuck_step", note: `${platform}: form did not advance at step ${step + 1}`, unknown: allUnknown };
    }
    prevSig = curSig;
  }

  if (platform === "linkedin") await dismissLinkedInDiscard(page);
  return { status: "needs_help", help_reason: "max_steps", note: `${platform}: exceeded ${maxSteps} steps without reaching Submit`, unknown: allUnknown };
}