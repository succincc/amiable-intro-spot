// The extension's by-hand list, run in a real browser against a made-up portal
// and a made-up panel on this machine. Three runs: plain, WALL=1 (a check a
// person answers first), EXTRA=1 (a question only its owner can answer).
//   node extension-test.mjs "$PWD/extension"
// A check: made-up people only. Its printing goes through the same nets as everything else.
import "./quiet.mjs";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { chromium } from "playwright";

const SRC = process.argv[2];
const work = fs.mkdtempSync(path.join(os.tmpdir(), "apx-"));
const ext = path.join(work, "ext");
fs.cpSync(SRC, ext, { recursive: true });
const man = JSON.parse(fs.readFileSync(path.join(ext, "manifest.json"), "utf8"));
man.host_permissions.push("http://127.0.0.1/*");
man.content_scripts[0].matches.push("http://127.0.0.1/*");
fs.writeFileSync(path.join(ext, "manifest.json"), JSON.stringify(man));

const WALL = process.env.WALL === "1";
let patched = [];
let got = null;
let wallCleared = !WALL;
const POSTING = `<!doctype html><title>Store Manager</title><h1>Store Manager</h1><p>About the job.</p>
<a id="go" href="/apply">I'm interested</a>`;
const WALLPAGE = `<!doctype html><title>check</title><p>Please verify you are a human</p><button id="human" onclick="fetch('/cleared').then(()=>location.reload())">I am a person</button>`;
const FORM = `<!doctype html><title>Apply</title><h1>Apply</h1>
<x-field label="First name" kind="text" req></x-field>
<x-field label="Last name" kind="text" req></x-field>
<x-field label="Email" kind="email" req></x-field>
<x-field label="Phone number" kind="tel" req></x-field>
<x-field label="Resume" kind="file"></x-field>
${process.env.EXTRA === "1" ? '<x-field label="What is your favourite colour of forklift" kind="text" req></x-field>' : ""}
<button id="send" type="button">Submit</button>
<script>
customElements.define("x-field", class extends HTMLElement {
  connectedCallback() {
    const r = this.attachShadow({ mode: "open" });
    const id = "f" + Math.random().toString(36).slice(2);
    r.innerHTML = '<label for="' + id + '">' + this.getAttribute("label") + '</label><input id="' + id + '" type="' + this.getAttribute("kind") + '"' + (this.hasAttribute("req") ? " required" : "") + '>';
  }
  get box() { return this.shadowRoot.querySelector("input"); }
});
document.getElementById("send").onclick = () => {
  const f = [...document.querySelectorAll("x-field")].map((x) => x.box);
  const out = Object.fromEntries(f.map((b, i) => [i, b.type === "file" ? (b.files[0] ? b.files[0].name + ":" + b.files[0].size : null) : b.value]));
  if (f.some((b) => b.required && !b.value)) { document.title = "missing"; return; }
  fetch("/got", { method: "POST", body: JSON.stringify(out) }).then(() => { document.body.innerHTML = "<h2>Thank you for applying</h2>"; });
};
</script>`;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const send = (t, b, s = 200) => { res.writeHead(s, { "Content-Type": t, "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" }); res.end(b); };
  if (req.method === "OPTIONS") return send("text/plain", "");
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    if (u.pathname === "/job") return send("text/html", POSTING);
    if (u.pathname === "/cleared") { wallCleared = true; return send("text/plain", "ok"); }
    if (u.pathname === "/apply") return send("text/html", wallCleared ? FORM : WALLPAGE);
    if (u.pathname === "/got") { got = JSON.parse(body); return send("application/json", "{}"); }
    if (u.pathname.startsWith("/auth/v1/")) return send("application/json", JSON.stringify({ access_token: "t", refresh_token: "r", expires_in: 3600 }));
    if (u.pathname.startsWith("/storage/v1/object/")) return send("application/pdf", Buffer.from("%PDF-1.4 a resume, such as it is"));
    if (u.pathname === "/rest/v1/profile") return send("application/json", JSON.stringify([{ id: 1, full_name: "Sam Fixture", email: "sam.fixture@example.com", phone: "7325550100", resume_file_path: "u/1/resume.pdf", resume_file_name: "Sam_Fixture.pdf", resume_text: "x" }]));
    if (u.pathname === "/rest/v1/answers") return send("application/json", req.method === "GET" ? "[]" : "");
    if (u.pathname === "/rest/v1/v_stats") return send("application/json", "[{}]");
    if (u.pathname === "/rest/v1/jobs") {
      if (req.method === "PATCH") { patched.push({ q: u.search, body: JSON.parse(body) }); return send("application/json", ""); }
      const open = !patched.some((p) => p.body.status);
      return send("application/json", JSON.stringify(open ? [{ id: "j1", title: "Store Manager", company: "Fixture Co", url: base + "/job", apply_url: base + "/job", ats: "smartrecruiters" }] : []));
    }
    return send("application/json", "[]");
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const ctx = await chromium.launchPersistentContext(path.join(work, "profile"), {
  channel: "chromium",
  headless: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
let sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
const id = sw.url().split("/")[2];
await sw.evaluate(async (b) => {
  await chrome.storage.local.set({ url: b, key: "k", session: { access_token: "t", refresh_token: "r", expires_at: Date.now() + 3600e3 } });
}, base);
const pop = await ctx.newPage();
await pop.goto(`chrome-extension://${id}/popup.html`);
await pop.waitForTimeout(1500);
console.log("by-hand count shown:", await pop.locator("#s_hand").innerText());
await pop.click("#hand");

const deadline = Date.now() + 70_000;
let clicked = false;
let typed = false;
while (Date.now() < deadline && !patched.some((p) => p.body.status)) {
  await new Promise((r) => setTimeout(r, 1500));
  for (const pg of ctx.pages()) {
    if (WALL && !clicked && (await pg.locator("#human").count().catch(() => 0))) { clicked = true; console.log("banner at the wall:", await pg.locator("#__applypilot_banner").innerText().catch(() => "(none)")); await pg.click("#human"); }
    if (process.env.EXTRA === "1" && !typed && pg.url().endsWith("/apply")) {
      const b = await pg.locator("#__applypilot_banner").innerText().catch(() => "");
      if (/left for you/.test(b)) { typed = true; console.log("banner:", b); await pg.locator("x-field[label^=What] input").fill("orange"); await pg.click("#send"); }
    }
  }
}
console.log("form was given:", JSON.stringify(got));
console.log("panel was told:", JSON.stringify(patched.map((p) => ({ status: p.body.status, help: p.body.help_reason, err: p.body.last_error }))));
const ok = got && got[0] === "Sam" && got[1] === "Fixture" && got[2] === "sam.fixture@example.com" && /732/.test(got[3]) && /^Sam_Fixture\.pdf:\d+$/.test(got[4] ?? "") && patched.some((p) => p.body.status === "applied");
console.log(ok ? "PASS" : "FAIL");
await ctx.close();
server.close();
process.exit(ok ? 0 : 1);
