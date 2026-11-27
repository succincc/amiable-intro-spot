// ============================================================================
// content.js — the form filler. Runs inside the job application page.
//
// This is the part that does the actual applying. It reads the page, works
// out what each field is asking for, fills it from your profile, answers
// screening questions from your saved answer bank, and submits.
//
// Design notes that matter:
//
//  * Fields are identified by their LABEL, not by selectors. Every ATS uses
//    different markup, but they all show the human a label like "First Name".
//    Deriving the label the way a person reads it — <label for>, aria-label,
//    placeholder, the text just above the box — works across Greenhouse,
//    Lever, Ashby, Workable, Workday and most custom forms, instead of
//    needing a hand-written selector map per vendor that breaks on redesign.
//
//  * Every value is set through the native setter and followed by input +
//    change events. React, Vue and Angular all ignore a plain `el.value = x`
//    because their state never hears about it, so the field looks filled but
//    submits empty. This is the single most common reason naive autofill
//    "works" visually and then fails.
//
//  * Nothing is submitted unless the required fields are actually populated.
//    A half-filled submit burns the application permanently.
// ============================================================================

(() => {
  if (window.__applypilotLoaded) return;
  window.__applypilotLoaded = true;

  const log = (...a) => console.log("%c[ApplyPilot]", "color:#10b981", ...a);

  // Every element that matches, including the ones a portal draws inside
  // components of its own. SmartRecruiters builds its whole application out
  // of those, and a plain search of the page finds none of its boxes.
  const deepAll = (sel, root = document, out = []) => {
    for (const n of root.querySelectorAll("*")) {
      if (n.matches(sel)) out.push(n);
      if (n.shadowRoot) deepAll(sel, n.shadowRoot, out);
    }
    return out;
  };
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  // ------------------------------------------------------------------
  // React-safe value setting
  // ------------------------------------------------------------------
  function setValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;

    el.focus();
    if (setter) setter.call(el, value);
    else el.value = value;

    // composed, so a component that holds the box hears it too.
    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true, composed: true }));
  }

  // ------------------------------------------------------------------
  // Label derivation — read the field the way a human does
  // ------------------------------------------------------------------
  function labelFor(el) {
    const parts = [];
    const root = el.getRootNode?.() ?? document;
    if (el.id) {
      const lab = root.querySelector?.(`label[for="${CSS.escape(el.id)}"]`);
      if (lab) parts.push(lab.innerText);
    }
    // A box inside a component: the component carries the question.
    for (let host = root.host, d = 0; host && d < 3; host = host.getRootNode?.().host, d++) {
      for (const attr of ["label", "aria-label", "placeholder", "name", "data-test", "data-testid"]) {
        const v = host.getAttribute?.(attr);
        if (v) parts.push(v);
      }
      const near = host.closest?.("label") ?? host.parentElement?.querySelector?.("label");
      if (near?.innerText) parts.push(near.innerText);
    }
    const wrapping = el.closest("label");
    if (wrapping) parts.push(wrapping.innerText);

    for (const attr of ["aria-label", "placeholder", "name", "id", "data-qa", "title"]) {
      const v = el.getAttribute?.(attr);
      if (v) parts.push(v);
    }

    const labelledBy = el.getAttribute?.("aria-labelledby");
    if (labelledBy) {
      for (const id of labelledBy.split(/\s+/)) {
        const node = document.getElementById(id);
        if (node) parts.push(node.innerText);
      }
    }

    // Text sitting directly above the control (Workday, iCIMS do this)
    let probe = el.parentElement;
    for (let depth = 0; probe && depth < 3; depth++, probe = probe.parentElement) {
      const text = Array.from(probe.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent.trim())
        .filter((t) => t.length > 2 && t.length < 160)
        .join(" ");
      if (text) { parts.push(text); break; }
    }

    return parts.join(" ")
      .replace(/\s+/g, " ")
      .replace(/\*/g, "")
      .trim()
      .toLowerCase();
  }

  // Word-boundary match. Plain substring matching is actively dangerous
  // here: "state" is inside "united states", so "Are you legally authorized
  // to work in the United States?" matched the state field and got answered
  // "FL"; "city" is inside "ethnicity", so the race question got answered
  // "Tampa". Both put nonsense on a real application, and the second is a
  // legally sensitive field. Matching whole words only prevents the entire
  // class of error.
  const has = (label, ...needles) =>
    needles.some((n) => {
      const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(?<![a-z])${escaped}(?![a-z])`, "i").test(label);
    });

  // Questions the form is ASKING (as opposed to fields it wants filled in).
  // These are evaluated before field mapping, because a question that happens
  // to contain a field word must be answered as a question.
  function booleanAnswer(label, p) {
    if (has(label, "authorized to work", "legally authorized", "work authorization",
                   "eligible to work", "right to work", "authorised to work")) {
      return p.work_authorized;
    }
    if (has(label, "sponsorship", "visa", "h-1b", "h1b", "work permit")) {
      return p.needs_sponsorship;
    }
    if (has(label, "18 years", "over 18", "age of majority", "at least 18")) return p.over_18;
    if (has(label, "background check", "drug screen", "drug test")) return p.can_background_check;
    if (has(label, "relocate", "relocation", "willing to move")) return p.willing_to_relocate;
    if (has(label, "veteran", "protected veteran")) return p.veteran_status;
    if (has(label, "disability", "disabled", "impairment")) return p.disability_status;
    if (has(label, "gender", "sex", "pronouns")) return p.gender;
    if (has(label, "race", "ethnicity", "hispanic", "latino")) return p.race_ethnicity;
    if (has(label, "previously worked", "former employee", "worked here before",
                   "previously employed")) return "No";
    if (has(label, "convicted", "felony", "criminal", "conviction")) return "No";
    if (has(label, "non-compete", "noncompete", "restrictive covenant")) return "No";
    return null;
  }

  // ------------------------------------------------------------------
  // Map a label to a profile value
  // ------------------------------------------------------------------
  function valueForLabel(label, p) {
    // Order matters: the most specific tests come first, because "name"
    // appears inside "first name", "last name" and "company name".
    if (has(label, "first name", "given name", "forename", "fname")) return p.first_name;
    if (has(label, "last name", "surname", "family name", "lname")) return p.last_name;
    if (has(label, "preferred name", "nickname", "goes by")) return p.preferred_name || p.first_name;
    if (has(label, "full name", "your name", "legal name", "candidate name")) return p.full_name;
    if (has(label, "email", "e-mail")) return p.email;
    if (has(label, "phone", "mobile", "telephone", "cell")) return p.phone;

    if (has(label, "linkedin")) return p.linkedin_url;
    if (has(label, "github")) return p.github_url;
    if (has(label, "portfolio", "website", "personal site", "url")) return p.portfolio_url;

    if (has(label, "street", "address line 1", "address 1", "street address")) return p.address;
    if (has(label, "address") && !has(label, "email", "e-mail")) return p.address;
    if (has(label, "city", "town", "locality")) return p.city;
    if (has(label, "state", "province", "region") && !has(label, "united states")) return p.state;
    if (has(label, "zip", "postal", "postcode")) return p.postal_code;
    if (has(label, "country")) return p.country;
    if (has(label, "location") && !has(label, "relocate", "relocation")) {
      return [p.city, p.state].filter(Boolean).join(", ");
    }

    if (has(label, "current company", "current employer", "present employer")) {
      return p.current_company;
    }
    if (has(label, "current title", "current role", "job title", "position title",
                   "most recent title")) return p.target_role;
    if (has(label, "years of experience", "years experience", "how many years",
                   "total experience")) return p.years_experience;
    if (has(label, "school", "university", "college", "institution")) return p.school;
    if (has(label, "degree", "education level", "highest level", "qualification")) {
      return p.education_level;
    }

    if (has(label, "desired salary", "salary expectation", "expected salary",
                   "expected compensation", "compensation expectation",
                   "salary requirement", "desired compensation", "desired pay",
                   "salary range", "target salary")) {
      return p.salary_expectation != null ? String(p.salary_expectation) : null;
    }

    if (has(label, "start date", "available", "when can you start", "earliest",
                   "availability", "notice period")) {
      return has(label, "notice period") ? "2 weeks" : p.earliest_start;
    }
    if (has(label, "how did you hear", "referral source", "source", "referred by")) {
      return "Company website";
    }

    return null;
  }

  // ------------------------------------------------------------------
  // Dropdowns: pick the option that best matches the intended answer
  // ------------------------------------------------------------------
  function selectOption(sel, want) {
    if (!want) return false;
    const target = String(want).toLowerCase().trim();
    const opts = Array.from(sel.options);

    let hit = opts.find((o) => o.text.toLowerCase().trim() === target)
           || opts.find((o) => o.value.toLowerCase().trim() === target);

    if (!hit) hit = opts.find((o) => o.text.toLowerCase().includes(target) && o.value);

    if (!hit && /^(yes|no)$/i.test(target)) {
      hit = opts.find((o) => new RegExp(`^${target}\\b`, "i").test(o.text.trim()) && o.value);
    }
    if (!hit && target.includes("decline")) {
      hit = opts.find((o) => /decline|prefer not|do not wish|not to answer/i.test(o.text));
    }
    if (!hit && target.includes("not a protected veteran")) {
      hit = opts.find((o) => /not a protected veteran|not a veteran/i.test(o.text));
    }
    if (!hit && target.includes("do not wish")) {
      hit = opts.find((o) => /do not wish|don't wish|prefer not|decline/i.test(o.text));
    }

    if (!hit) return false;
    setValue(sel, hit.value);
    return true;
  }

  function clickRadio(group, want) {
    if (!want) return false;
    const target = String(want).toLowerCase().trim();
    for (const radio of group) {
      const label = labelFor(radio);
      const value = (radio.value || "").toLowerCase();
      if (label.includes(target) || value === target ||
          (/^(yes|no)$/.test(target) && new RegExp(`\\b${target}\\b`).test(label))) {
        radio.click();
        return true;
      }
    }
    return false;
  }

  // ------------------------------------------------------------------
  // Fill everything we can; report what we could not
  // ------------------------------------------------------------------
  function fill(profile, answers) {
    const p = { ...profile };
    const names = (p.full_name || "").trim().split(/\s+/);
    p.first_name = p.first_name || names[0] || "";
    p.last_name = p.last_name || (names.length > 1 ? names[names.length - 1] : "");

    const answerMap = new Map(
      (answers || []).map((a) => [String(a.q_key).toLowerCase(), a.answer]),
    );
    const lookupSaved = (label) => {
      if (answerMap.has(label)) return answerMap.get(label);
      for (const [k, v] of answerMap) {
        if (k.length > 12 && (label.includes(k) || k.includes(label))) return v;
      }
      return null;
    };

    const filled = [];
    const unknown = [];
    const seenRadioGroups = new Set();

    const controls = deepAll("input, select, textarea").filter((el) => {
      if (el.disabled || el.readOnly) return false;
      if (["hidden", "submit", "button", "image", "reset"].includes(el.type)) return false;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return false;              // invisible
      if (el.name && /honeypot|bot[-_]?field|leave[-_]?blank/i.test(el.name)) return false;
      return true;
    });

    for (const el of controls) {
      const label = labelFor(el);
      if (!label) continue;

      try {
        // --- radio groups ---
        if (el.type === "radio") {
          const name = el.name;
          if (!name || seenRadioGroups.has(name)) continue;
          seenRadioGroups.add(name);
          const group = Array.from((el.getRootNode?.() ?? document).querySelectorAll(`input[type=radio][name="${CSS.escape(name)}"]`));
          const groupLabel = labelFor(group[0]) + " " + (group[0].closest("fieldset")?.innerText ?? "").slice(0, 200).toLowerCase();
          const want = booleanAnswer(groupLabel, p) ?? lookupSaved(groupLabel);
          if (clickRadio(group, want)) filled.push(groupLabel.slice(0, 60));
          else unknown.push({ question: groupLabel.slice(0, 200), type: "radio",
                              options: group.map((g) => labelFor(g).slice(0, 40)) });
          continue;
        }

        // --- checkboxes: only tick consent/agreement boxes ---
        if (el.type === "checkbox") {
          if (has(label, "agree", "consent", "acknowledge", "certify", "terms",
                         "privacy", "accurate", "true and complete")) {
            if (!el.checked) el.click();
            filled.push(label.slice(0, 60));
          }
          continue;
        }

        // --- file inputs are handled separately by the agent ---
        if (el.type === "file") continue;

        // --- selects ---
        if (el.tagName === "SELECT") {
          if (el.value && el.selectedIndex > 0) continue;              // already set
          const want = booleanAnswer(label, p) ?? valueForLabel(label, p) ?? lookupSaved(label);
          if (selectOption(el, want)) { filled.push(label.slice(0, 60)); }
          else {
            unknown.push({
              question: label.slice(0, 200), type: "select",
              options: Array.from(el.options).map((o) => o.text.trim()).filter(Boolean).slice(0, 25),
            });
          }
          continue;
        }

        // --- text-ish inputs ---
        if (el.value && el.value.trim()) continue;                     // don't clobber
        // Questions are answered as questions first. A field labelled
        // "Are you authorized to work in the United States?" must not be
        // treated as a state field just because the word appears in it.
        const want = booleanAnswer(label, p) ?? valueForLabel(label, p) ?? lookupSaved(label);
        if (want) { setValue(el, String(want)); filled.push(label.slice(0, 60)); continue; }

        // A long free-text box is usually "why do you want this role?"
        if (el.tagName === "TEXTAREA" || el.maxLength > 200) {
          unknown.push({ question: label.slice(0, 200), type: "longtext" });
        } else if (el.required || el.getAttribute("aria-required") === "true") {
          unknown.push({ question: label.slice(0, 200), type: "text" });
        }
      } catch (err) {
        log("field error", label, err);
      }
    }

    return { filled, unknown };
  }

  // ------------------------------------------------------------------
  // Page understanding
  // ------------------------------------------------------------------
  function detectATS() {
    const h = location.hostname, html = document.documentElement.innerHTML;
    if (h.includes("greenhouse.io") || html.includes("greenhouse.io")) return "greenhouse";
    if (h.includes("lever.co")) return "lever";
    if (h.includes("ashbyhq.com")) return "ashby";
    if (h.includes("workable.com")) return "workable";
    if (h.includes("myworkdayjobs.com") || h.includes("workday")) return "workday";
    if (h.includes("icims.com")) return "icims";
    if (h.includes("smartrecruiters.com")) return "smartrecruiters";
    if (h.includes("jobvite.com")) return "jobvite";
    if (h.includes("bamboohr.com")) return "bamboohr";
    return "unknown";
  }

  function findSubmit() {
    const candidates = deepAll('button, input[type=submit], a[role=button], div[role=button]').filter(shown);
    const wanted = /^(submit|submit application|apply|send application|finish|complete application)$/i;
    const loose = /(submit|apply now|send application)/i;

    let best = candidates.find((b) => wanted.test((b.innerText || b.value || "").trim()));
    if (!best) best = candidates.find((b) => loose.test((b.innerText || b.value || "").trim()));
    if (best && (best.disabled || best.getAttribute("aria-disabled") === "true")) return null;
    return best ?? null;
  }

  function findNext() {
    const candidates = deepAll("button, a[role=button]").filter(shown);
    return candidates.find((b) =>
      /^(next|continue|save and continue|save & continue)$/i.test((b.innerText || "").trim())
      && !b.disabled) ?? null;
  }

  function blockers() {
    const found = [];
    const html = document.documentElement.innerHTML;
    if (document.querySelector(".g-recaptcha, .h-captcha, .cf-turnstile, iframe[src*='recaptcha'], iframe[src*='hcaptcha']")
        || /recaptcha|hcaptcha|turnstile/i.test(html)) found.push("captcha");

    const text = document.body.innerText.toLowerCase();
    if (/sign in|log in to apply|create an account|password/.test(text)
        && document.querySelector("input[type=password]")) found.push("login");

    if (/already applied|you have applied/i.test(text)) found.push("already_applied");
    if (/no longer accepting|position (has been )?filled|posting (is )?closed|expired/i.test(text)) {
      found.push("closed");
    }
    return found;
  }

  // ------------------------------------------------------------------
  // Message handling from the background worker
  // ------------------------------------------------------------------
  // ---- for the list worked with its owner at the keyboard -----------------

  /** A check that wants a person, standing in front of the page right now. */
  function wallUp() {
    const frame = deepAll("iframe").find((f) => shown(f) && f.getBoundingClientRect().height > 80 &&
      /captcha-delivery|datadome|hcaptcha\.com|recaptcha\/api2\/bframe|challenges\.cloudflare|arkoselabs|px-captcha/i.test(f.src || ""));
    if (frame) return true;
    const text = (document.body?.innerText ?? "").slice(0, 1500).toLowerCase();
    return /verify (that )?you are (a )?human|are you a robot|press (and|&) hold|unusual activity|checking your browser/.test(text);
  }
  const APPLY_WORDS = /^(apply|apply now|apply for this job|apply to this job|apply online|start application|start your application|i'?m interested|apply for this position)$/i;
  function findApply() {
    return deepAll("a, button, [role=button]").filter(shown)
      .find((b) => APPLY_WORDS.test((b.innerText || b.value || "").replace(/\s+/g, " ").trim())) ?? null;
  }
  function fieldCount() {
    return deepAll("input, select, textarea").filter((el) =>
      shown(el) && !el.disabled && !["hidden", "submit", "button", "search"].includes(el.type)).length;
  }
  /** The resume, put in the form's own resume box as if it had been chosen. */
  function attach(file) {
    const boxes = deepAll("input[type=file]");
    if (!boxes.length) return { ok: false, why: "no file box" };
    const about = (b) => `${labelFor(b)} ${(b.closest("div, section, fieldset")?.innerText ?? "").slice(0, 120)}`.toLowerCase();
    const box = boxes.find((b) => /resume|cv|curriculum/.test(about(b)) && !/cover/.test(labelFor(b))) ?? boxes[0];
    if (box.files?.length) return { ok: true, already: true };
    const bytes = Uint8Array.from(atob(file.data), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], file.name, { type: file.type || "application/pdf" }));
    box.files = dt.files;
    box.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    box.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    return { ok: box.files.length > 0 };
  }
  /** What is still empty and wanted, ringed so the eye finds it. */
  function ringLeft() {
    let n = 0;
    for (const el of deepAll("input, select, textarea")) {
      if (!shown(el) || el.disabled || ["hidden", "submit", "button", "file", "checkbox", "radio", "search"].includes(el.type)) continue;
      const wanted = el.required || el.getAttribute("aria-required") === "true";
      if (wanted && !String(el.value ?? "").trim()) {
        el.style.outline = "3px solid #f59e0b";
        el.style.outlineOffset = "2px";
        n++;
      } else if (el.style.outline.includes("245, 158, 11") || el.style.outline.includes("#f59e0b")) {
        el.style.outline = "";
      }
    }
    return n;
  }
  function banner(text) {
    let b = document.getElementById("__applypilot_banner");
    if (!text) { b?.remove(); return; }
    if (!b) {
      b = document.createElement("div");
      b.id = "__applypilot_banner";
      b.style.cssText = "position:fixed;z-index:2147483647;left:50%;top:10px;transform:translateX(-50%);background:#0b1220;color:#e5e7eb;border:1px solid #10b981;padding:8px 14px;font:13px/1.4 system-ui,sans-serif;border-radius:6px;box-shadow:0 6px 24px rgba(0,0,0,.35);max-width:80vw";
      document.documentElement.appendChild(b);
    }
    b.textContent = `ApplyPilot — ${text}`;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    try {
      if (msg.type === "STATE") {
        const text = (document.body?.innerText ?? "").toLowerCase();
        reply({
          ok: true,
          wall: wallUp(),
          fields: fieldCount(),
          apply: !!findApply(),
          canSubmit: !!findSubmit(),
          hasNext: !!findNext(),
          hasFileBox: deepAll("input[type=file]").length > 0,
          done: /thank you for applying|application (has been )?(received|submitted|sent)|we('ve| have) received your application|successfully (applied|submitted)|thanks for applying|your application was sent/.test(text),
          closed: /no longer accepting|position (has been )?filled|posting (is )?closed|job (is )?no longer available|this job has expired/.test(text),
          text: text.length,
        });
        return true;
      }
      if (msg.type === "CLICK_APPLY") {
        const b = findApply();
        if (b) { b.scrollIntoView({ block: "center" }); b.click(); }
        reply({ ok: !!b });
        return true;
      }
      if (msg.type === "ATTACH") {
        reply(attach(msg.file));
        return true;
      }
      if (msg.type === "RING") {
        reply({ ok: true, left: ringLeft() });
        return true;
      }
      if (msg.type === "BANNER") {
        banner(msg.text);
        reply({ ok: true });
        return true;
      }
      if (msg.type === "PING") {
        reply({ ok: true, ats: detectATS(), url: location.href });
        return true;
      }

      if (msg.type === "INSPECT") {
        reply({
          ok: true,
          ats: detectATS(),
          blockers: blockers(),
          hasForm: !!document.querySelector("form, input[type=email]"),
          hasFileInput: !!document.querySelector("input[type=file]"),
          submitText: findSubmit()?.innerText?.trim() ?? null,
          nextText: findNext()?.innerText?.trim() ?? null,
        });
        return true;
      }

      if (msg.type === "FILL") {
        const result = fill(msg.profile, msg.answers);
        reply({
          ok: true, ...result,
          blockers: blockers(),
          canSubmit: !!findSubmit(),
          hasNext: !!findNext(),
        });
        return true;
      }

      if (msg.type === "CLICK_NEXT") {
        const btn = findNext();
        if (btn) { btn.click(); reply({ ok: true }); }
        else reply({ ok: false, error: "no next button" });
        return true;
      }

      if (msg.type === "SUBMIT") {
        const btn = findSubmit();
        if (!btn) { reply({ ok: false, error: "no submit button found" }); return true; }
        btn.scrollIntoView({ block: "center" });
        btn.click();
        reply({ ok: true, clicked: (btn.innerText || "").trim() });
        return true;
      }

      if (msg.type === "VERIFY") {
        const text = document.body.innerText.toLowerCase();
        const success = /thank you|application (has been )?(received|submitted|sent)|we('ve| have) received|successfully (applied|submitted)|thanks for applying/.test(text);
        const errors = Array.from(document.querySelectorAll(
          '[role=alert], .error, .field-error, [class*="error"]:not([class*="no-error"])',
        )).map((e) => e.innerText.trim()).filter((t) => t && t.length < 200).slice(0, 8);
        reply({ ok: true, success, errors, url: location.href });
        return true;
      }
    } catch (err) {
      reply({ ok: false, error: String(err?.message ?? err) });
    }
    return true;
  });

  log("ready on", detectATS(), location.href);
})();
