// popup.js — connection setup and the start/stop control.

const $ = (id) => document.getElementById(id);

function say(text, kind = "ok") {
  const el = $("msg");
  el.textContent = text;
  el.className = kind;
}

async function refresh() {
  const { session, dryRun } = await chrome.storage.local.get(["session", "dryRun"]);
  $("dry").checked = !!dryRun;

  if (!session?.refresh_token) {
    $("setup").open = true;
    say("Sign in with the same email and password you use on the panel.", "warn");
    $("start").disabled = true;
    return;
  }

  chrome.runtime.sendMessage({ type: "STATUS" }, (res) => {
    if (chrome.runtime.lastError) return;
    if (!res?.ok) {
      say(res?.error ?? "Could not reach the database.", "err");
      return;
    }
    const s = res.stats ?? {};
    $("stats").style.display = "grid";
    $("s_queued").textContent = s.queued ?? 0;
    $("s_today").textContent = s.applied_today ?? 0;
    $("s_help").textContent = s.needs_help ?? 0;

    const busy = res.running || res.handRunning;
    $("dot").className = busy ? "dot live" : "dot";
    $("state").textContent = res.handRunning ? "working your by-hand list" : res.running ? "applying" : "idle";
    $("start").style.display = busy ? "none" : "block";
    $("stop").style.display = busy ? "block" : "none";
    $("hand").style.display = busy ? "none" : "block";
    $("s_hand").textContent = res.byHand ?? 0;
    $("handnote").style.display = res.handNote ? "block" : "none";
    $("handnote").textContent = res.handNote ?? "";
    $("start").disabled = false;

    if (!busy && (s.queued ?? 0) === 0 && (res.byHand ?? 0) === 0) {
      say("Queue is empty. Run discovery in the panel first.", "warn");
    }
  });
}

$("save").onclick = async () => {
  const email = $("email").value.trim();
  const password = $("password").value;
  if (!email || !password) { say("Enter your panel email and password.", "err"); return; }
  say("Signing in…", "warn");
  const login = await chrome.runtime.sendMessage({ type: "LOGIN", email, password });
  $("password").value = "";
  if (!login?.ok) { say(`Sign-in failed: ${login?.error ?? "unknown"}`, "err"); return; }
  chrome.runtime.sendMessage({ type: "TEST" }, (res) => {
    if (!res?.ok) {
      say(`Connection failed: ${res?.error ?? "unknown"}`, "err");
      return;
    }
    if (!res.name || !res.email) {
      say("Connected, but your profile has no name/email yet. Fill it in the panel.", "warn");
      return;
    }
    if (!res.hasResume) {
      say(`Connected as ${res.name}. No resume uploaded yet — add one in the panel.`, "warn");
      return;
    }
    say(`Connected as ${res.name}. ${res.queued} job(s) queued.`, "ok");
    $("setup").open = false;
    refresh();
  });
};

$("logout").onclick = async () => {
  await chrome.runtime.sendMessage({ type: "LOGOUT" });
  say("Signed out.", "warn");
  refresh();
};

$("dry").onchange = async (e) => {
  await chrome.storage.local.set({ dryRun: e.target.checked });
  say(e.target.checked
    ? "Dry run on: forms get filled but never submitted."
    : "Dry run off: applications will be submitted.", "warn");
};

$("start").onclick = () => {
  chrome.runtime.sendMessage({ type: "START" }, () => {
    say("Running. You can close this popup — it keeps going.", "ok");
    setTimeout(refresh, 600);
  });
};

// The postings a portal's human check stopped: opened here, in front of
// you, one at a time. You answer the check where one is shown; the form is
// filled, the resume attached, and it is sent.
$("hand").onclick = () => {
  chrome.runtime.sendMessage({ type: "START_HAND" }, () => {
    say("Opening the first one. Keep this window in front: where a site asks you to prove you are a person, do, and the rest is done for you.", "ok");
    setTimeout(refresh, 600);
  });
};

$("stop").onclick = () => {
  chrome.runtime.sendMessage({ type: "STOP" }, () => {
    say("Stopped.", "warn");
    setTimeout(refresh, 400);
  });
};

$("sync").onclick = () => {
  say("Syncing LinkedIn, Indeed, and ZipRecruiter sessions…", "warn");
  chrome.runtime.sendMessage({ type: "SYNC_SESSIONS" }, (res) => {
    if (!res?.ok) { say(`Sync failed: ${res?.error ?? "unknown"}`, "err"); return; }
    if (!res.synced?.length) {
      say("No active LinkedIn, Indeed, or ZipRecruiter cookies found. Sign in to them in Chrome first.", "warn");
      return;
    }
    say(`Synced: ${res.synced.join(", ")}`, "ok");
  });
};

refresh();
setInterval(refresh, 5000);
