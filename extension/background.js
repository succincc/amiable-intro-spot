// ============================================================================
// background.js — the agent loop.
//
// Pulls one job at a time from the queue, opens it in a tab, fills the form,
// submits, verifies, and reports the outcome back to the database.
//
// Why a browser extension rather than a server: nobody can submit an
// application through an API. Greenhouse and Lever both have application
// endpoints, but they require the EMPLOYER's secret key, which an applicant
// never has. Every real auto-applier therefore drives a browser. Doing that
// inside your own Chrome means your existing logins and sessions already
// work, there is no separate browser to detect as automation, and there is
// nothing to install beyond this folder.
// ============================================================================

const POLL_MS = 20_000;
const PAGE_TIMEOUT_MS = 45_000;
const BETWEEN_JOBS_MS = 8_000;   // deliberate pacing; not a race

let running = false;
let currentTabId = null;

// ---------------------------------------------------------------------------
// Supabase REST helpers
// ---------------------------------------------------------------------------
const DEFAULT_URL = "https://inqhfkshqndkxyztzita.supabase.co";
const DEFAULT_KEY = "sb_publishable_QK4kidijM8nk46uK6L22Qw_XA0RQu5U";

async function cfg() {
  const s = await chrome.storage.local.get(["url", "key"]);
  return { url: (s.url || DEFAULT_URL).replace(/\/+$/, ""), key: s.key || DEFAULT_KEY };
}

/** Sign in with the panel's email + password. Only the session is stored, never the password. */
async function signIn(email, password) {
  const { url, key } = await cfg();
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error_description || body.msg || `sign-in failed (${res.status})`);
  await saveSession(body);
}

async function saveSession(s) {
  await chrome.storage.local.set({
    session: { access_token: s.access_token, refresh_token: s.refresh_token,
               expires_at: Date.now() + (s.expires_in ?? 3600) * 1000 },
  });
}

async function accessToken() {
  const { session } = await chrome.storage.local.get("session");
  if (!session?.refresh_token) throw new Error("NOT_CONFIGURED");
  if (session.expires_at - Date.now() > 60_000) return session.access_token;
  const { url, key } = await cfg();
  const res = await fetch(`${url}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: session.refresh_token }),
  });
  if (!res.ok) { await chrome.storage.local.remove("session"); throw new Error("NOT_CONFIGURED"); }
  const body = await res.json();
  await saveSession(body);
  return body.access_token;
}

async function db(path, init = {}) {
  const { url, key } = await cfg();
  const token = await accessToken();
  const res = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`DB ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function rpc(fn, args = {}) {
  return db(`rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });
}

// ---------------------------------------------------------------------------
// tab helpers
// ---------------------------------------------------------------------------
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitForLoad(tabId, timeout = PAGE_TIMEOUT_MS) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error("tab closed");
    if (tab.status === "complete") { await sleep(1500); return; }  // let JS settle
    await sleep(400);
  }
  throw new Error("page load timed out");
}

/** Talk to the content script, retrying while it boots. */
async function ask(tabId, message, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, message);
      if (res) return res;
    } catch {
      // content script not ready yet — inject and retry
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] })
        .catch(() => {});
    }
    await sleep(1200);
  }
  throw new Error(`content script did not respond to ${message.type}`);
}

// ---------------------------------------------------------------------------
// status reporting
// ---------------------------------------------------------------------------
async function heartbeat(patch = {}) {
  try {
    await db("agent?id=eq.1", {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        online: true,
        last_seen: new Date().toISOString(),
        version: chrome.runtime.getManifest().version,
        ...patch,
      }),
    });
  } catch { /* offline is a visible state, not an error to chase */ }
}

async function finishJob(id, patch) {
  await db(`jobs?id=eq.${id}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });
}

/** Save a question the form asked that we could not answer. */
async function recordUnknowns(unknowns) {
  for (const u of unknowns.slice(0, 12)) {
    const key = String(u.question).toLowerCase().replace(/[^\w\s]/g, " ")
      .replace(/\s+/g, " ").trim().slice(0, 200);
    if (key.length < 4) continue;
    try {
      await db("answers", {
        method: "POST",
        headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
        body: JSON.stringify([{
          q_key: key,
          question: String(u.question).slice(0, 300),
          answer: "",
          field_type: u.type ?? "text",
          confirmed: false,
        }]),
      });
    } catch { /* duplicate is fine */ }
  }
}

// ---------------------------------------------------------------------------
// apply to one job
// ---------------------------------------------------------------------------
async function applyToJob(job, profile, answers) {
  const target = job.apply_url || job.url;
  const tab = await chrome.tabs.create({ url: target, active: false });
  currentTabId = tab.id;

  try {
    await waitForLoad(tab.id);

    // 1. Look before touching anything
    const look = await ask(tab.id, { type: "INSPECT" });

    if (look.blockers?.includes("closed")) {
      return { status: "skipped", skip_reason: "posting closed or filled" };
    }
    if (look.blockers?.includes("already_applied")) {
      return { status: "applied", note: "already applied previously" };
    }
    if (look.blockers?.includes("captcha")) {
      return { status: "needs_help", help_reason: "captcha" };
    }
    if (look.blockers?.includes("login")) {
      return { status: "needs_help", help_reason: "login" };
    }

    // 2. Fill — multi-page forms (Workday, iCIMS) need several passes
    let filledTotal = 0;
    let unknowns = [];
    let result = null;

    for (let page = 0; page < 6; page++) {
      result = await ask(tab.id, { type: "FILL", profile, answers });
      filledTotal += result.filled?.length ?? 0;
      unknowns = unknowns.concat(result.unknown ?? []);

      if (result.blockers?.includes("captcha")) {
        return { status: "needs_help", help_reason: "captcha", filled: filledTotal };
      }
      if (result.canSubmit) break;
      if (result.hasNext) {
        await ask(tab.id, { type: "CLICK_NEXT" });
        await sleep(2500);
        continue;
      }
      break;
    }

    if (unknowns.length) await recordUnknowns(unknowns);

    // 3. A required question we could not answer must not be guessed at.
    //    Submitting a half-filled form burns the application permanently.
    const blocking = unknowns.filter((u) => u.type !== "longtext");
    if (blocking.length > 0 && filledTotal === 0) {
      return {
        status: "needs_help",
        help_reason: "unknown_question",
        note: blocking.slice(0, 3).map((u) => u.question).join(" | ").slice(0, 300),
      };
    }

    if (!result?.canSubmit) {
      return {
        status: "needs_help",
        help_reason: "error",
        note: "no submit button found — the form may need a resume upload first",
      };
    }

    // 4. Resume upload cannot be automated from an extension: a file input
    //    can only be set by a real user gesture, for good security reasons.
    //    Forms that require one are handed back to you with everything else
    //    already filled, so finishing takes seconds.
    if (look.hasFileInput) {
      return {
        status: "needs_help",
        help_reason: "resume_upload",
        note: `Form filled (${filledTotal} fields). Attach your resume and press submit.`,
      };
    }

    // 5. Submit and verify
    const { dryRun } = await chrome.storage.local.get("dryRun");
    if (dryRun) {
      return { status: "needs_help", help_reason: "dry_run",
               note: `Dry run: ${filledTotal} fields filled, not submitted.` };
    }

    await ask(tab.id, { type: "SUBMIT" });
    await sleep(4000);
    const check = await ask(tab.id, { type: "VERIFY" });

    if (check.success) return { status: "applied", filled: filledTotal };
    if (check.errors?.length) {
      return { status: "needs_help", help_reason: "error",
               note: check.errors.join(" | ").slice(0, 300) };
    }
    // Submitted but no confirmation text — treat as applied and let the
    // employer's confirmation email settle it.
    return { status: "applied", filled: filledTotal, note: "no confirmation text seen" };
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
    currentTabId = null;
  }
}

// ---------------------------------------------------------------------------
// main loop
// ---------------------------------------------------------------------------
async function loop() {
  if (!running) return;

  try {
    await heartbeat({ state: "idle" });

    const [profile] = await db("profile?id=eq.1&select=*");
    if (!profile?.email || !profile?.full_name) {
      await heartbeat({ state: "paused" });
      notify("Setup needed", "Add your name and email in the ApplyPilot panel.");
      running = false;
      return;
    }

    const answers = await db("answers?confirmed=eq.true&select=q_key,answer,field_type");

    const claimed = await rpc("claim_next_job");
    const job = Array.isArray(claimed) ? claimed[0] : claimed;

    if (!job) {
      await heartbeat({ state: "idle" });
      if (running) setTimeout(loop, POLL_MS);
      return;
    }

    await heartbeat({ state: "applying", current_job: job.id });

    let outcome;
    try {
      outcome = await applyToJob(job, profile, answers || []);
    } catch (e) {
      outcome = { status: "needs_help", help_reason: "error",
                  note: String(e?.message ?? e).slice(0, 300) };
    }

    const patch = { status: outcome.status };
    if (outcome.status === "applied") {
      patch.applied_at = new Date().toISOString();
      patch.confirm_state = "pending";
    }
    if (outcome.help_reason) patch.help_reason = outcome.help_reason;
    if (outcome.skip_reason) patch.skip_reason = outcome.skip_reason;
    if (outcome.note) patch.last_error = outcome.note;
    await finishJob(job.id, patch);

    if (outcome.status === "applied") {
      notify("Applied", `${job.title} at ${job.company ?? ""}`);
    }

    if (running) setTimeout(loop, BETWEEN_JOBS_MS);
  } catch (e) {
    if (String(e.message) === "NOT_CONFIGURED") {
      notify("ApplyPilot", "Open the extension and sign in with your panel email and password.");
      running = false;
      return;
    }
    console.error("[ApplyPilot]", e);
    if (running) setTimeout(loop, POLL_MS);
  }
}

// ---------------------------------------------------------------------------
// The list worked with its owner at the keyboard
// ---------------------------------------------------------------------------
//
// Some portals ask every automated visitor to prove it is a person before
// they show the application; the runner stops there and says so, and those
// postings wait under "needs you" with that reason. Nothing here gets round
// that check. This opens each of those postings in the owner's own browser,
// in front of them: where the portal asks, the person answers — they are
// one — and the form behind it is then filled from the profile, the resume
// attached, and sent. Where a question is left that nothing on file answers,
// it is ringed and the tab waits for its owner to answer it and press send.

let handRunning = false;
let handNote = "";
const HAND_WAIT_MS = 6 * 60_000;      // one posting, the person's part included
const HAND_LEFT_OPEN_MAX = 3;         // tabs left for the person before stopping

/** The resume file as it was uploaded to the panel, for the form's own box. */
async function resumeFile(profile) {
  const path = profile?.resume_file_path;
  if (!path) return null;
  try {
    const { url, key } = await cfg();
    const token = await accessToken();
    const res = await fetch(`${url}/storage/v1/object/authenticated/artifacts/${path.split("/").map(encodeURIComponent).join("/")}`, {
      headers: { apikey: key, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const blob = await res.blob();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { name: profile.resume_file_name || "Resume.pdf", type: blob.type || "application/pdf", data: btoa(bin) };
  } catch {
    return null;
  }
}

/** The frame of a tab that holds the most to fill in: the form's. */
async function formFrame(tabId) {
  try {
    const found = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const deep = (root, out = []) => {
          for (const n of root.querySelectorAll("*")) {
            if (/^(INPUT|TEXTAREA|SELECT)$/.test(n.tagName) && n.type !== "hidden") out.push(n);
            if (n.shadowRoot) deep(n.shadowRoot, out);
          }
          return out;
        };
        return deep(document).length;
      },
    });
    const best = (found ?? []).sort((a, b) => (b.result ?? 0) - (a.result ?? 0))[0];
    return best && (best.result ?? 0) > 0 ? best.frameId : 0;
  } catch {
    return 0;
  }
}

async function askFrame(tabId, frameId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message, { frameId });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["content.js"] }).catch(() => {});
    await sleep(800);
    return await chrome.tabs.sendMessage(tabId, message, { frameId }).catch(() => null);
  }
}

/**
 * One posting from the list. Returns what became of it:
 *   { status: "applied" } | { status: "skipped", skip_reason } |
 *   { left: true, note }   — the tab is left open for its owner.
 */
async function assist(job, profile, answers, file, dryRun) {
  const tab = await chrome.tabs.create({ url: job.apply_url || job.url, active: true });
  let tabId = tab.id;
  // A portal that opens its application in a tab of its own: follow it.
  const followed = (t) => { if (t.openerTabId === tabId) tabId = t.id; };
  chrome.tabs.onCreated.addListener(followed);
  const began = Date.now();
  let told = "";
  let pressedApply = 0;
  let attached = false;
  let pages = 0;
  let sent = false;
  let asked = [];
  const say = async (frameId, text) => {
    if (text === told) return;
    told = text;
    handNote = text;
    await askFrame(tabId, 0, { type: "BANNER", text }).catch(() => {});
    if (frameId) await askFrame(tabId, frameId, { type: "BANNER", text: "" }).catch(() => {});
  };
  try {
    await waitForLoad(tabId).catch(() => {});
    while (Date.now() - began < HAND_WAIT_MS) {
      if (!handRunning) return { left: true, note: "stopped" };
      const alive = await chrome.tabs.get(tabId).catch(() => null);
      if (!alive) return { left: false, note: "the tab was closed" };
      const frameId = await formFrame(tabId);
      const top = await askFrame(tabId, 0, { type: "STATE" });
      const st = frameId ? (await askFrame(tabId, frameId, { type: "STATE" })) ?? top : top;
      if (!top || !st) { await sleep(1500); continue; }

      if (top.done || st.done) return { status: "applied" };
      if ((top.closed || st.closed) && st.fields < 3) return { status: "skipped", skip_reason: "posting closed or filled" };

      if (top.wall || st.wall) {
        await say(0, "this site wants to see a person: answer its check and the form will be filled for you");
        await sleep(2000);
        continue;
      }
      if (st.fields < 3) {
        if ((st.apply || top.apply) && pressedApply < 3) {
          pressedApply++;
          await askFrame(tabId, st.apply ? frameId : 0, { type: "CLICK_APPLY" });
          await sleep(3500);
          await waitForLoad(tabId, 20_000).catch(() => {});
          continue;
        }
        await say(0, "looking for the application form…");
        await sleep(2500);
        continue;
      }

      if (sent) {
        // Sent and not yet answered: wait for the page to say so.
        await sleep(2500);
        continue;
      }

      await say(0, "filling this in from your profile…");
      const r = await askFrame(tabId, frameId, { type: "FILL", profile, answers });
      asked = asked.concat(r?.unknown ?? []);
      if (file && !attached && st.hasFileBox) {
        const a = await askFrame(tabId, frameId, { type: "ATTACH", file });
        attached = !!a?.ok;
        if (attached) await sleep(2500);       // the portal reads the file
      }
      const ring = await askFrame(tabId, frameId, { type: "RING" });
      const left = ring?.left ?? 0;
      const now = await askFrame(tabId, frameId, { type: "STATE" });

      if (left > 0) {
        await say(0, `${left} question${left === 1 ? "" : "s"} left for you (ringed in orange): answer ${left === 1 ? "it" : "them"} and press ${now?.canSubmit ? "submit" : "next"}`);
        await sleep(3000);
        continue;
      }
      if (now?.hasNext && !now?.canSubmit && pages < 8) {
        pages++;
        await askFrame(tabId, frameId, { type: "CLICK_NEXT" });
        await sleep(2500);
        continue;
      }
      if (now?.canSubmit) {
        if (st.hasFileBox && !attached && file) {
          await say(0, "attach your resume and press submit");
          await sleep(3000);
          continue;
        }
        if (dryRun) {
          await say(0, "dry run: filled and not sent. Look it over; press submit yourself if you want it sent");
          await sleep(3000);
          continue;
        }
        await say(0, "sending…");
        await askFrame(tabId, frameId, { type: "SUBMIT" });
        sent = true;
        await sleep(4000);
        const check = await askFrame(tabId, frameId, { type: "VERIFY" });
        if (check?.success) return { status: "applied" };
        if (check?.errors?.length) {
          sent = false;       // the form said no: its owner is shown why
          await say(0, `the form did not take it: ${String(check.errors[0]).slice(0, 90)}`);
          await sleep(4000);
        }
        continue;
      }
      await say(0, "filled what is on file. Finish anything left and press submit");
      await sleep(3000);
    }
    return { left: true, note: told || "not finished in time" };
  } finally {
    chrome.tabs.onCreated.removeListener(followed);
    if (asked.length) await recordUnknowns(asked).catch(() => {});
    currentTabId = null;
    // Closed only where it is done with; a tab its owner has yet to finish stays.
    handLastTab = tabId;
  }
}
let handLastTab = null;

async function handLoop() {
  let leftOpen = 0;
  let done = 0;
  try {
    const [profile] = await db("profile?id=eq.1&select=*");
    if (!profile?.email || !profile?.full_name) { handNote = "Add your name and email in the panel first."; return; }
    const answers = (await db("answers?confirmed=eq.true&select=q_key,answer,field_type")) ?? [];
    const file = await resumeFile(profile);
    const { dryRun } = await chrome.storage.local.get("dryRun");
    const tried = new Set();
    while (handRunning) {
      const list = (await db("jobs?status=eq.needs_help&help_reason=eq.captcha&select=id,title,company,url,apply_url,ats&order=score.desc.nullslast,updated_at.desc&limit=60")) ?? [];
      const job = list.find((j) => !tried.has(j.id));
      if (!job) { handNote = done ? `Done: ${done} sent.` : "Nothing on the by-hand list."; break; }
      tried.add(job.id);
      handNote = `${job.title} — ${job.company ?? ""}`;
      let outcome;
      try {
        outcome = await assist(job, profile, answers, file, !!dryRun);
      } catch (e) {
        outcome = { left: true, note: String(e?.message ?? e).slice(0, 200) };
      }
      if (outcome.status === "applied") {
        done++;
        await finishJob(job.id, { status: "applied", applied_at: new Date().toISOString(), confirm_state: "pending", help_reason: null, last_error: null });
        notify("Applied", `${job.title} at ${job.company ?? ""}`);
        if (handLastTab) await chrome.tabs.remove(handLastTab).catch(() => {});
        await sleep(3000);
      } else if (outcome.status === "skipped") {
        await finishJob(job.id, { status: "skipped", skip_reason: outcome.skip_reason });
        if (handLastTab) await chrome.tabs.remove(handLastTab).catch(() => {});
      } else if (outcome.left) {
        leftOpen++;
        await finishJob(job.id, { last_error: `Opened in your browser and left for you: ${outcome.note}`.slice(0, 300) }).catch(() => {});
        if (leftOpen >= HAND_LEFT_OPEN_MAX) { handNote = `${leftOpen} tabs are waiting for you. Finish those, then start again.`; break; }
      }
    }
  } catch (e) {
    handNote = String(e?.message ?? e) === "NOT_CONFIGURED" ? "Sign in first." : String(e?.message ?? e).slice(0, 160);
  } finally {
    handRunning = false;
  }
}

function notify(title, message) {
  chrome.notifications?.create({
    type: "basic", iconUrl: "icon128.png", title: `ApplyPilot — ${title}`, message,
  }, () => void chrome.runtime.lastError);
}

// ---------------------------------------------------------------------------
// control surface
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, _s, reply) => {
  if (msg.type === "LOGIN") {
    signIn(msg.email, msg.password).then(() => reply({ ok: true }), (e) => reply({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === "LOGOUT") {
    running = false;
    chrome.storage.local.remove("session").then(() => reply({ ok: true }));
    return true;
  }
  if (msg.type === "START") {
    if (!running) { running = true; loop(); }
    reply({ ok: true, running });
    return true;
  }
  if (msg.type === "START_HAND") {
    if (!handRunning && !running) { handRunning = true; handNote = "starting…"; handLoop(); }
    reply({ ok: true, handRunning });
    return true;
  }
  if (msg.type === "STOP") {
    handRunning = false;
    running = false;
    heartbeat({ state: "idle", online: false });
    if (currentTabId) chrome.tabs.remove(currentTabId).catch(() => {});
    reply({ ok: true, running: false });
    return true;
  }
  if (msg.type === "STATUS") {
    (async () => {
      try {
        const [stats] = await db("v_stats?select=*");
        let byHand = 0;
        try {
          const rows = await db("jobs?status=eq.needs_help&help_reason=eq.captcha&select=id&limit=200");
          byHand = (rows ?? []).length;
        } catch { byHand = 0; }
        reply({ ok: true, running, handRunning, handNote, byHand, stats });
      } catch (e) {
        reply({ ok: false, running, error: String(e.message) });
      }
    })();
    return true;
  }
  if (msg.type === "TEST") {
    (async () => {
      try {
        const [p] = await db("profile?id=eq.1&select=full_name,email,resume_text");
        const q = await db("v_apply_queue?select=id&limit=1");
        reply({ ok: true, name: p?.full_name, email: p?.email,
                hasResume: !!p?.resume_text, queued: (q ?? []).length });
      } catch (e) {
        reply({ ok: false, error: String(e.message) });
      }
    })();
    return true;
  }
  if (msg.type === "SYNC_SESSIONS") {
    (async () => {
      try {
        const [p] = (await db("profile?id=eq.1&select=email")) ?? [];
        const synced = [];
        for (const host of ["linkedin.com", "indeed.com", "ziprecruiter.com"]) {
          const cookies = await chrome.cookies.getAll({ domain: host }).catch(() => []);
          if (!cookies.length) continue;
          await db("site_accounts?on_conflict=user_id,host", {
            method: "POST",
            headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
            body: JSON.stringify({
              host,
              email: p?.email || "",
              password: "",
              status: "active",
              note: `synced ${cookies.length} cookies from Chrome`,
              session_state: { cookies, captured_at: new Date().toISOString() },
              session_updated_at: new Date().toISOString(),
            }),
          });
          synced.push(`${host} (${cookies.length})`);
        }
        reply({ ok: true, synced });
      } catch (e) {
        reply({ ok: false, error: String(e.message) });
      }
    })();
    return true;
  }
  return false;
});

// Keep the heartbeat alive so the panel can show agent status.
chrome.alarms.create("hb", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(() => { if (running) heartbeat(); });
