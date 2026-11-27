// A gate in front of every live run.
//
// Three times in one day a change to the shared submit path broke something
// that was working, and each time the only way anyone found out was a real
// application to a real employer going wrong:
//
//   - force-clicking Submit pressed a button the portal had disabled, so
//     complete forms were "submitted" into nothing;
//   - a watch that stopped on any alert stopped at once on Workday, whose
//     review screen has carried an upload notice since the resume went up,
//     so submitted applications were filed as failures;
//   - reading the top document after a submit could not see a confirmation
//     that Greenhouse renders inside an iframe.
//
// This runs the real applyToJob against two local pages that set those same
// traps, plus the emailed security code. If the applier cannot finish them,
// it has no business near an employer, and the workflow stops here.
//
// Nothing leaves the machine: the pages, the database and the mailbox are all
// one local server.
import http from "node:http";

const CODE = "48213907";

const GREENHOUSE_PAGE = `<!doctype html><html><head><title>Operations Associate</title></head><body>
<h1>Operations Associate</h1>
<p>Fixture Co is hiring an Operations Associate in New York, NY.</p>
<iframe src="/gh/form" style="width:900px;height:1400px;border:0"></iframe>
</body></html>`;

const GREENHOUSE_FORM = `<!doctype html><html><body>
<h2>Apply for this job</h2>
<form id="application-form">
  <p><label for="first_name">First Name *</label><input id="first_name" name="first_name" required></p>
  <p><label for="last_name">Last Name *</label><input id="last_name" name="last_name" required></p>
  <p><label for="email">Email *</label><input id="email" name="email" type="email" required></p>
  <p><label for="phone">Phone *</label><input id="phone" name="phone" type="tel" required></p>
  <p><label for="resume">Resume/CV *</label><input id="resume" name="resume" type="file"></p>
  <p><label for="question_1">Tell us a bit about why you're applying to work here. What excited you about this role? *</label>
     <textarea id="question_1" name="question_1" required></textarea></p>
  <fieldset>
    <legend>By clicking "accept," you agree that any disputes related to your application will be resolved by binding arbitration. *</legend>
    <input type="checkbox" id="q2" name="question_2[]" aria-required="true"> <label for="q2">Accept</label>
  </fieldset>

  <div id="sec" style="display:none">
    <p>Security code</p>
    <p>Copy and paste the code we emailed you into the boxes. After you enter the code, resubmit your application.</p>
    <div id="boxes"></div>
  </div>

  <!-- The confirmation below is MongoDB's own wording, which two real
       applications were accepted under and then filed as unconfirmed. -->
  <!-- Disabled until the "upload" finishes, exactly as the real one is. -->
  <p><button type="submit" id="go" disabled>Submit application</button></p>
</form>
<script>
  const go = document.getElementById("go");
  const sec = document.getElementById("sec");
  const boxes = document.getElementById("boxes");
  let asked = false;

  document.getElementById("resume").addEventListener("change", () => {
    setTimeout(() => { go.disabled = false; }, 2500);
  });

  for (let i = 0; i < 8; i++) {
    const b = document.createElement("input");
    b.id = "security-input-" + i; b.maxLength = 1; b.type = "text"; b.style.width = "2em";
    b.addEventListener("input", () => {
      if (b.value && b.nextElementSibling) b.nextElementSibling.focus();
      const all = Array.from(boxes.children).map((x) => x.value).join("");
      go.disabled = all.length !== 8;
    });
    boxes.appendChild(b);
  }

  document.getElementById("application-form").addEventListener("submit", (e) => {
    e.preventDefault();
    if (!document.getElementById("q2").checked) return;
    if (!asked) {
      // First submit: accepted, a code is emailed, and the button waits for it.
      asked = true; sec.style.display = "block"; go.disabled = true;
      return;
    }
    const typed = Array.from(boxes.children).map((x) => x.value).join("");
    if (typed === "${CODE}") {
      setTimeout(() => { document.body.innerHTML = "<h2>Thanks for taking the time to apply to Fixture Co!</h2><p>In the meantime, have a look around.</p>"; }, 1500);
    } else {
      sec.insertAdjacentHTML("beforeend", '<p role="alert">That code is incorrect.</p>');
    }
  });
</script>
</body></html>`;

// No iframe; an alert on the page before anything is submitted; and a
// confirmation that takes seven seconds — longer than the old fixed wait.
const PLAIN_FORM = `<!doctype html><html><head><title>Vendor Coordinator</title></head><body>
<h1>Vendor Coordinator</h1>
<form id="f">
  <p><label for="first_name">First Name *</label><input id="first_name" name="first_name" required></p>
  <p><label for="last_name">Last Name *</label><input id="last_name" name="last_name" required></p>
  <p><label for="email">Email *</label><input id="email" name="email" type="email" required></p>
  <p><label for="phone">Phone *</label><input id="phone" name="phone" type="tel" required></p>
  <!-- The letter's box comes FIRST, as it does on some real forms: the
       resume must still land in the resume's box and the letter in this one. -->
  <p><label for="cover_letter">Cover Letter</label><input id="cover_letter" name="cover_letter" type="file"></p>
  <p><label for="resume">Resume *</label><input id="resume" name="resume" type="file"></p>
  <p><label for="cover_letter_text">Cover letter (optional)</label><textarea id="cover_letter_text" name="cover_letter_text"></textarea></p>
  <div role="alert" id="up" style="display:none"></div>
  <p><button type="submit">Submit</button></p>
</form>
<script>
  document.getElementById("resume").addEventListener("change", (e) => {
    const up = document.getElementById("up");
    up.textContent = (e.target.files[0]?.name || "resume.pdf") + " successfully uploaded";
    up.style.display = "block";
  });
  document.getElementById("f").addEventListener("submit", (e) => {
    e.preventDefault();
    // What each box was given, told to the test's own server.
    fetch("/plain/got", { method: "POST", body: JSON.stringify({
      resume: document.getElementById("resume").files[0]?.name ?? null,
      letterFile: document.getElementById("cover_letter").files[0]?.name ?? null,
      letterText: document.getElementById("cover_letter_text").value,
    }) }).catch(() => {});
    setTimeout(() => { document.body.innerHTML = "<h2>Application submitted</h2><p>We have received your application.</p>"; }, 7000);
  });
</script>
</body></html>`;

// The shape of an Ashby board: one name box called "Name", a phone box called
// "Contact number", a question the resume answers, and a list to tick from.
// Every one of these stopped a real form with the rest of it filled.
const BOARD_FORM = `<!doctype html><html><head><title>Account Coordinator</title></head><body>
<h1>Account Coordinator</h1>
<form id="f" novalidate>
  <div><label for="_systemfield_name">Name</label><input id="_systemfield_name" name="_systemfield_name" type="text" placeholder="Type here..." required></div>
  <div><label for="_systemfield_email">Email</label><input id="_systemfield_email" name="_systemfield_email" type="email" placeholder="hello@example.com..." required></div>
  <div><label for="a2c71faa-5319-4d4a-8ec8-ebe9dcac45b3">Contact number</label><input id="a2c71faa-5319-4d4a-8ec8-ebe9dcac45b3" type="tel" placeholder="1-415-555-1234..." required></div>
  <div><label for="_systemfield_resume">Resume</label><input id="_systemfield_resume" type="file" required></div>
  <div><label for="c779ac6e-f4fe-4dfe-9dfa-acd7e2823ba7">Where have you most recently worked?</label><input id="c779ac6e-f4fe-4dfe-9dfa-acd7e2823ba7" type="text" placeholder="Type here..." required></div>
  <fieldset id="tools"><legend>Which of these have you worked with? (check all that apply)</legend>
    <label><input type="checkbox" name="tools[]" value="k"> Kubernetes clusters</label>
    <label><input type="checkbox" name="tools[]" value="v"> Vendor scheduling</label>
    <label><input type="checkbox" name="tools[]" value="n"> None of the above</label>
  </fieldset>
  <fieldset id="book"><legend>How many accounts were in your most recent book? *</legend>
    <label><input type="radio" name="question_31[]" value="a" required> Under 50</label>
    <label><input type="radio" name="question_31[]" value="b"> 50 to 150</label>
    <label><input type="radio" name="question_31[]" value="c"> 150 to 300</label>
  </fieldset>
  <p id="err" role="alert" style="display:none"></p>
  <p><button type="submit">Submit Application</button></p>
</form>
<script>
  document.getElementById("f").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = (id) => document.getElementById(id).value.trim();
    const ticked = Array.from(document.querySelectorAll('input[name="tools[]"]:checked')).map((b) => b.value);
    const book = document.querySelector('input[name="question_31[]"]:checked')?.value ?? "";
    const got = { book, name: v("_systemfield_name"), email: v("_systemfield_email"), phone: v("a2c71faa-5319-4d4a-8ec8-ebe9dcac45b3"), last: v("c779ac6e-f4fe-4dfe-9dfa-acd7e2823ba7"), ticked, resume: document.getElementById("_systemfield_resume").files[0]?.name ?? null };
    const empty = Object.entries(got).filter(([, x]) => (Array.isArray(x) ? !x.length : !x)).map(([k]) => k);
    if (empty.length) { const er = document.getElementById("err"); er.textContent = "Missing entry for required field: " + empty.join(", "); er.style.display = "block"; return; }
    fetch("/board/got", { method: "POST", body: JSON.stringify(got) }).catch(() => {});
    setTimeout(() => { document.body.innerHTML = "<h2>Application submitted</h2><p>Your application was successfully submitted.</p>"; }, 1500);
  });
</script>
</body></html>`;

let codeRequests = 0;
let plainGot = null;
let boardGot = null;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/plain/got") {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      try { plainGot = JSON.parse(body); } catch { plainGot = {}; }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
    return;
  }
  if (url.pathname === "/board/got") {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      try { boardGot = JSON.parse(body); } catch { boardGot = {}; }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
    return;
  }
  const send = (type, body, status = 200) => {
    res.writeHead(status, { "Content-Type": type });
    res.end(body);
  };
  if (url.pathname === "/gh/job") return send("text/html", GREENHOUSE_PAGE);
  if (url.pathname === "/gh/form") return send("text/html", GREENHOUSE_FORM);
  if (url.pathname === "/plain/job") return send("text/html", PLAIN_FORM);
  if (url.pathname === "/board/job") return send("text/html", BOARD_FORM);
  if (url.pathname === "/api/public/email/verify-code") {
    codeRequests++;
    return send("application/json", JSON.stringify({ code: CODE }));
  }
  if (url.pathname.startsWith("/auth/v1/")) {
    return send(
      "application/json",
      JSON.stringify({ access_token: "selftest", refresh_token: "selftest", expires_in: 3600, user: { id: "selftest" } }),
    );
  }
  if (url.pathname.startsWith("/rest/v1/")) return send("application/json", "[]");
  if (url.pathname.startsWith("/api/")) return send("application/json", "{}");
  return send("text/plain", "not found", 404);
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

// Everything the applier talks to is this server. Set before it is imported,
// because it reads its configuration at load.
Object.assign(process.env, {
  APPLY_SELFTEST: "1",
  SUPABASE_URL: base,
  SUPABASE_ANON_KEY: "selftest",
  APPLYPILOT_EMAIL: "selftest@example.com",
  APPLYPILOT_PASSWORD: "selftest",
  APP_URL: base,
  ENGINE_API_KEY: "selftest",
  DRY_RUN: "false",
});
delete process.env.GEMINI_API_KEY; // the model-free writer has to manage alone

const { chromium } = await import("playwright");
const { applyToJob } = await import("./apply.mjs");

const profile = {
  id: 1,
  full_name: "Sam Fixture",
  first_name: "Sam",
  last_name: "Fixture",
  email: "sam.fixture@example.com",
  phone: "7325550100",
  address: "1 Main St",
  city: "Princeton",
  state: "NJ",
  postal_code: "08540",
  country: "United States",
  work_authorized: "Yes",
  needs_sponsorship: "No",
  over_18: "Yes",
  create_accounts: false,
  resume_text:
    "Sam Fixture\nPrinceton, NJ\n\nEXPERIENCE\nOwner, Fixture Goods LLC, 2019 - 2025\n" +
    "Managed vendor relationships, scheduling and inventory. Handled upset customers and " +
    "complaint resolution daily. Built weekly sales reports.\n\nEDUCATION\nB.S. Business, Rutgers University, 2018",
};

const cases = [
  {
    name: "iframe form: disabled submit, emailed security code, confirmation inside the frame",
    job: {
      id: "selftest-gh",
      url: `${base}/gh/job`,
      apply_url: `${base}/gh/job`,
      title: "Operations Associate",
      company: "Fixture Co",
      ats: "greenhouse",
      location: "New York, NY",
      description: "Requirements: vendor management, scheduling, customer service and reporting.",
    },
    check: () => (codeRequests > 0 ? null : "the security code was never asked for"),
  },
  {
    name: "plain form: an alert already on the page, confirmation after seven seconds",
    job: {
      id: "selftest-plain",
      url: `${base}/plain/job`,
      apply_url: `${base}/plain/job`,
      title: "Vendor Coordinator",
      company: "Plain Co",
      ats: "none",
      location: "Princeton, NJ",
      description: "Requirements: vendor management and scheduling.",
    },
    // The resume in the resume's box, a letter in each of the letter's, and
    // the letter made of the applicant's own resume.
    check: () =>
      !plainGot ? "the form never said what it was given"
      : !/_Resume_/.test(plainGot.resume ?? "") ? `the resume's box holds ${plainGot.resume ?? "nothing"}`
      : !/_Cover_Letter_/.test(plainGot.letterFile ?? "") ? `the cover letter's upload holds ${plainGot.letterFile ?? "nothing"}`
      : !/^Dear Hiring Manager,/.test(plainGot.letterText ?? "") || !/Sam Fixture\s*$/.test(plainGot.letterText ?? "") ? "the cover letter box was not given a letter"
      : !/vendor relationships, scheduling and inventory/i.test(plainGot.letterText) ? "the letter does not use the resume's own words"
      : null,
  },
  {
    name: "board form: a box called Name, a contact number, the last employer, a list to tick from",
    job: {
      id: "selftest-board",
      url: `${base}/board/job`,
      apply_url: `${base}/board/job`,
      title: "Account Coordinator",
      company: "Board Co",
      ats: "ashby",
      location: "Princeton, NJ",
      description: "Requirements: vendor management and scheduling.",
    },
    check: () =>
      !boardGot ? "the form never said what it was given"
      : boardGot.name !== "Sam Fixture" ? `the name box holds "${boardGot.name}"`
      : !/7325550100|732.?555.?0100/.test(boardGot.phone ?? "") ? `the contact number holds "${boardGot.phone}"`
      : !/Fixture Goods/i.test(boardGot.last ?? "") ? `the last employer holds "${boardGot.last}"`
      : boardGot.book !== "a" ? `the pick-one holds "${boardGot.book}"`
      : JSON.stringify(boardGot.ticked) !== '["v"]' ? `the list has ${JSON.stringify(boardGot.ticked)} ticked`
      : null,
  },
];

const browser = await chromium.launch();
let failed = 0;
for (const c of cases) {
  const context = await browser.newContext();
  const started = Date.now();
  let outcome;
  try {
    outcome = await Promise.race([
      applyToJob(context, c.job, profile, []),
      new Promise((_, no) => setTimeout(() => no(new Error("took longer than 4 minutes")), 240_000)),
    ]);
  } catch (e) {
    outcome = { status: "threw", note: String(e?.message ?? e).split("\n")[0] };
  }
  await context.close().catch(() => {});

  const extra = outcome.status === "applied" ? c.check() : null;
  const ok = outcome.status === "applied" && !extra;
  if (!ok) failed++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${c.name}  (${Math.round((Date.now() - started) / 1000)}s)` +
      (ok ? "" : `\n      -> ${outcome.status}${outcome.help_reason ? "/" + outcome.help_reason : ""}: ${extra ?? outcome.note ?? ""}`),
  );
}
await browser.close();
server.close();

if (failed) {
  console.error(`\nself-test: ${failed} of ${cases.length} failed — not applying to anything real with this code.`);
  process.exit(1);
}
console.log(`\nself-test: all ${cases.length} passed.`);
process.exit(0);
