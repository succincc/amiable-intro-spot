// Quick checks of the parts that decide things without a browser: what goes
// on a resume, who a note may be sent to, what counts as a fresh posting.
//
// These are the rules that would do the most harm if a later change bent
// them quietly — a job filed under education, an invented number kept, a
// note addressed to privacy@. They run in a second, before every applier
// run, and a failure stops the run.
//
//   node unit.mjs

process.env.OUTREACH_IMPORT_ONLY = "1";
process.env.JOBPOSTING_IMPORT_ONLY = "1";
process.env.FEEDS_IMPORT_ONLY = "1";
process.env.PRETAILOR_IMPORT_ONLY = "1";
process.env.SF_IMPORT_ONLY = "1";

const tailor = await import("./tailor.mjs");
const outreach = await import("./outreach.mjs");
const jobposting = await import("./jobposting.mjs");
const feeds = await import("./feeds.mjs");
const pretailor = await import("./pretailor.mjs");
const sf = await import("./successfactors.mjs");
const quiet = await import("./quiet.mjs");
process.env.BOARDS_IMPORT_ONLY = "1";
const boards = await import("./boards.mjs");
process.env.MEASURE_IMPORT_ONLY = "1";
const measure = await import("./measure.mjs");

let failed = 0;
let passed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) passed++;
  else {
    failed++;
    console.log(`FAIL  ${name}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  }
}
const truthy = (name, got) => check(name, Boolean(got), true);

// ---------------------------------------------------------------------------
// The smaller hiring systems' public lists
// ---------------------------------------------------------------------------
{
  check("boards: a board's host is told from a system's own pages", [boards.boardOf("acme.bamboohr.com")?.ats, boards.boardOf("https://acme.applytojob.com/apply")?.ats, boards.boardOf("www.bamboohr.com"), boards.boardOf("example.com")], ["bamboohr", "jazzhr", null, null]);
  check("boards: BambooHR's list", boards.readBamboo({ result: [{ id: 41, jobOpeningName: "Store Manager", location: { city: "Exampleton", state: "New Jersey" }, isRemote: false }, { id: 0, jobOpeningName: "" }] }, "acme.bamboohr.com"),
    [{ id: "41", url: "https://acme.bamboohr.com/careers/41", title: "Store Manager", location: "Exampleton, New Jersey", remote: false, posted_at: null }]);
  const rec = boards.readRecruitee({ offers: [{ id: 7, title: "Operations Lead", careers_url: "https://acme.recruitee.com/o/operations-lead", city: "Exampleton", state_code: "NJ", country_code: "us", remote: true, published_at: "2026-11-20 10:00:00 UTC", description: "<p>Run the <b>floor</b>.</p>", status: "published" }, { id: 8, title: "Closed", careers_url: "x", status: "archived" }] });
  check("boards: Recruitee's offers, published ones only, text without its markup", [rec.length, rec[0].location, rec[0].country, rec[0].remote, rec[0].description], [1, "Exampleton, NJ", "US", true, "Run the floor ."]);
  const jazz = boards.readJazz('<li><a href="/apply/AbC123/Assistant-Manager">Assistant Manager</a><ul><li>Exampleton, NJ</li></ul></li><li><a href="https://acme.applytojob.com/apply/Zz9/Driver">Driver</a> Remote</li><a href="/apply/AbC123/Assistant-Manager">Apply</a>', "acme.applytojob.com");
  check("boards: JazzHR's page of links, each once", jazz.map((j) => [j.id, j.url, j.title, j.location, j.remote]), [["AbC123", "https://acme.applytojob.com/apply/AbC123/Assistant-Manager", "Assistant Manager", "Exampleton, NJ", false], ["Zz9", "https://acme.applytojob.com/apply/Zz9/Driver", "Driver", null, true]]);
  const tt = boards.readTeamtailor("<rss><channel><item><title><![CDATA[Shift Lead]]></title><link>https://acme.teamtailor.com/jobs/1-shift-lead</link><pubDate>Fri, 20 Nov 2026 10:00:00 +0000</pubDate><description><![CDATA[<p>Lead a shift.</p>]]></description></item></channel></rss>");
  check("boards: Teamtailor's feed", [tt[0].title, tt[0].url, tt[0].posted_at, tt[0].description], ["Shift Lead", "https://acme.teamtailor.com/jobs/1-shift-lead", "2026-11-20T10:00:00.000Z", "Lead a shift."]);
  check("boards: a posting's words from its JobPosting data", boards.describeFrom('<html><script type="application/ld+json">{"@type":"JobPosting","description":"<p>Count the till.</p>","datePosted":"2026-11-21"}</script><body>x</body></html>'), { description: "Count the till.", posted_at: "2026-11-21T00:00:00.000Z" });
check("boards: an Eightfold list, with the country taken off the place", boards.readEightfold({ count: 3, positions: [
    { id: 123, name: "Store Manager", location: "Exampleton, NJ, US", t_create: 1795000000, canonicalPositionUrl: "https://acme.eightfold.ai/careers/job/123" },
    { id: 124, name: "Office Lead", location: "Bengaluru, India", t_create: 1795000000 },
    { id: 125, name: "Analyst", location: "Albany, New York", work_location_option: "remote" },
  ] }, "acme.eightfold.ai").map((r) => [r.id, r.url, r.location, r.country, r.remote, r.posted_at?.slice(0, 4)]), [
    ["123", "https://acme.eightfold.ai/careers/job/123", "Exampleton, NJ", "US", false, "2026"],
    ["124", "https://acme.eightfold.ai/careers/job/124", "Bengaluru, India", "India", false, "2026"],
    ["125", "https://acme.eightfold.ai/careers/job/125", "Albany, New York", null, true, null],
  ]);
  check("boards: the domain an Eightfold page asks its list by", [boards.eightfoldDomain('<script>window.x = {"domain": "acme.com", "y": 1}</script>'), boards.eightfoldDomain('<a href="/careers?domain=acme.co.uk&x=1">'), boards.eightfoldDomain("<p>none</p>")], ["acme.com", "acme.co.uk", null]);
  check("boards: an Eightfold host is known", boards.boardOf("acme.eightfold.ai")?.ats, "eightfold");
    check("boards: and its place, where the posting states one", boards.describeFrom('<script type="application/ld+json">{"@type":"JobPosting","description":"x","jobLocation":{"@type":"Place","address":{"addressLocality":"Exampleton","addressRegion":"NJ"}}}</script>').location, "Exampleton, NJ");
  check("boards: a wanted title needs half the words of one the owner searches", [boards.wanted("Assistant Store Manager", ["store manager"], []), boards.wanted("Software Engineer", ["store manager"], []), boards.wanted("Store Manager Intern", ["store manager"], ["intern"])], [true, false, false]);
}

// ---------------------------------------------------------------------------
// A place the geocoder cannot find as written, said more plainly
// ---------------------------------------------------------------------------
{
  check("measure: a street after the town is dropped", measure.simplerPlaces("NJ, Exampleton, 100 Park Ave"), ["Exampleton, NJ"]);
  check("measure: a building's name is dropped", measure.simplerPlaces("Exampleton NJ Distribution Center"), ["Exampleton, NJ"]);
  check("measure: a state spelt out", measure.simplerPlaces("Exampleton Corporate Office, New Jersey, United States of America"), ["Exampleton, NJ"]);
  check("measure: a town with no state is never guessed", measure.simplerPlaces("Exampleton Main Office"), []);
  check("measure: nothing plainer than what was asked", measure.simplerPlaces("Exampleton, NJ"), []);
}

// ---------------------------------------------------------------------------
// A resume with no headings, put into the standard layout
// ---------------------------------------------------------------------------
const RAW = `Pat Example
pat@example.com
Princeton, NJ
Hands-on retail operations leader and former business founder with experience in store management, sales and analytics. Previously built an agency serving 100+ clients.
Assistant Store Manager
Hazlet, NJ
Staples
Jul 2026 - Present
Serve as the General Manager's second-in-command and lead the store when the GM is absent
Coach associates on consultative selling and execution against store sales goals
Customer Service & Sales Associate - Financial Services
Clayton, NJ
Example Pharmacy
Apr 2022 - May 2023
Supported merchandise sales, point-of-sale service and money-transfer transactions
Bachelor of Arts, Law & Justice Studies
New Jersey
Example State University
Jan 2023 - Dec 2023
Associate of Arts, Criminal Justice
New Jersey
Example Community College
Jan 2021 - Dec 2021
Page 2
Google Analytics Certification
Google Analytics Certification (2026-2027)
Gmail
Microsoft Power BI`;
{
  const d = tailor.structureResume(RAW, {});
  truthy("structure: recognised", d);
  check("structure: jobs", d.experience.map((e) => [e.company, e.title, e.bullets.length]), [
    ["Staples", "Assistant Store Manager", 2],
    ["Example Pharmacy", "Customer Service & Sales Associate - Financial Services", 1],
  ]);
  check("structure: a Sales Associate is not a degree", d.education.map((e) => e.school), ["Example State University", "Example Community College"]);
  check("structure: certifications, once each", d.certifications, [{ name: "Google Analytics Certification", dates: "2026-2027" }]);
  check("structure: skills", d.skills, { Tools: "Gmail, Microsoft Power BI" });
  truthy("structure: summary kept", d.summary.startsWith("Hands-on retail"));
  check("structure: 'Page 2' is not content", tailor.standardResume(RAW, { full_name: "Pat Example" }).includes("Page 2"), false);
  check("structure: a resume already under headings is left alone", tailor.structureResume("Pat\nx\ny\nSUMMARY\na\nEXPERIENCE\nb\nc\nd\ne\nf", {}), null);
  check("structure: too little to go on is left alone", tailor.structureResume("just a line", {}), null);
}

// ---------------------------------------------------------------------------
// Arranged for one posting, with no model
// ---------------------------------------------------------------------------
{
  const base = {
    headline: "",
    summary: "s",
    skills: { Tools: "Gmail, Salesforce, Microsoft Excel" },
    experience: [
      { company: "Staples", title: "Assistant Store Manager", dates: "Jul 2026 - Present", bullets: ["Open and close the store each day and count the registers", "Coach associates on consultative selling against store sales goals", "Track vendor deliveries"] },
      { company: "Agency", title: "Founder", dates: "Aug 2021 - Jan 2026", bullets: ["Hired a ten person team", "Managed client accounts in Salesforce and reported pipeline weekly", "a", "b", "c", "d"] },
      { company: "School", title: "Paraprofessional", dates: "Jan 2023 - Jun 2025", bullets: ["Supported classrooms"] },
      { company: "Pharmacy", title: "Sales Associate", dates: "Apr 2022 - May 2023", bullets: ["Handled sales at the register"] },
    ],
    education: [],
    certifications: [],
  };
  const job = { title: "Account Manager", company: "Acme", description: "Requirements: experience managing client accounts in Salesforce. Consultative selling. Pipeline reporting. Salesforce required. Client accounts, consultative selling and Salesforce are essential to this role, along with pipeline reporting and account management." };
  const bank = [{ company: "Old Co", title: "Account Executive", start_date: "2018", end_date: "2020", details: "Managed forty client accounts in Salesforce with consultative selling. Reported pipeline to the regional director every week." }];
  const a = tailor.arrangeForPosting(base, job, bank);
  truthy("arrange: done", a);
  check("arrange: the bullet the posting cares about leads its role", a.data.experience.find((e) => e.company === "Agency").bullets[0], "Managed client accounts in Salesforce and reported pipeline weekly");
  check("arrange: the current role is kept and leads", a.data.experience[0].company, "Staples");
  check("arrange: at most four roles", a.data.experience.length, 4);
  truthy("arrange: a relevant role from the settings list takes a place", a.data.experience.some((e) => e.company === "Old Co"));
  check("arrange: most recent first", a.data.experience.map((e) => e.company).indexOf("Old Co"), 3);
  truthy("arrange: a skill the posting names leads", a.data.skills.Tools.startsWith("Salesforce"));
  const all = new Set([...base.experience.flatMap((e) => e.bullets), "Managed forty client accounts in Salesforce with consultative selling.", "Reported pipeline to the regional director every week."]);
  check("arrange: every line is one the owner wrote", a.data.experience.flatMap((e) => e.bullets).every((b) => all.has(b)), true);
  check("arrange: no posting text, nothing to arrange to", tailor.arrangeForPosting(base, { title: "x", description: "" }, []), null);

  // The opening lines, written for the posting from the owner's own words.
  const store = { title: "Store Manager - Princeton, NJ (R-1234)", company: "Acme Parts", description: "Requirements: inventory management, scheduling, customer service and sales experience. Salesforce a plus. Inventory management and scheduling of staff are daily duties. Vendor management. Python and SQL required." };
  const mine = { ...base, summary: "", experience: [{ ...base.experience[0], bullets: [...base.experience[0].bullets, "Manage inventory counts weekly", "Build the weekly schedule for 14 associates"] }, ...base.experience.slice(1)] };
  const o = tailor.arrangeForPosting(mine, store, []);
  truthy("opening: strengths the posting asks for and the resume says", ["scheduling", "inventory management", "Salesforce"].every((t) => o.strengths.includes(t)));
  check("opening: nothing the resume does not say", o.strengths.some((t) => /python|sql|customer service/i.test(t)), false);
  truthy("opening: the headline is the title held, then what matters here", o.data.headline.startsWith("Assistant Store Manager | ") && /Inventory Management|Scheduling/.test(o.data.headline));
  check("opening: the headline never claims the posted title", /^Store Manager/.test(o.data.headline), false);
  truthy("opening: the summary names the role and the employer", o.data.summary.includes("the Store Manager role at Acme Parts") && o.data.summary.startsWith("Assistant Store Manager at Staples"));
  check("opening: the posting's place and number stay out of it", /Princeton|R-1234/.test(o.data.summary), false);
  const kept = tailor.arrangeForPosting({ ...mine, summary: "Retail leader who runs busy stores." }, store, []);
  truthy("opening: the owner's own summary is kept and added to", kept.data.summary.startsWith("Retail leader who runs busy stores. Experience in "));
  const thin = tailor.arrangeForPosting({ ...mine, headline: "Operations", skills: {} }, { title: "Chemist", company: "Lab", description: "Requirements: titration, spectroscopy, chromatography, laboratory notebooks, reagent preparation and assays." }, []);
  check("opening: with nothing in common, the opening is left as it was", [thin.data.headline, thin.data.summary], ["Operations", ""]);
}

// ---------------------------------------------------------------------------
// What the model wrote, held against what it was given
// ---------------------------------------------------------------------------
{
  const source = "Staples - Assistant Store Manager\nLed 12 associates\nExample State University, BA";
  const r = tailor.checkAgainstSource(
    {
      summary: "Leader of 12 associates.",
      skills: { Ops: "scheduling" },
      experience: [
        { company: "Staples", title: "Assistant Store Manager", dates: "2024 - Present", bullets: ["Led 12 associates", "Grew sales 40%", "Ran weekly counts"] },
        { company: "Invented Corp", title: "VP", dates: "2020", bullets: ["x"] },
      ],
      education: [{ school: "Example State University", degree: "BA" }, { school: "Harvard", degree: "MBA" }],
    },
    source,
  );
  check("check: an employer not in the source is removed", r.data.experience.map((e) => e.company), ["Staples"]);
  check("check: a number not in the source takes its bullet with it", r.data.experience[0].bullets, ["Led 12 associates", "Ran weekly counts"]);
  check("check: a school not in the source is removed", r.data.education.map((e) => e.school), ["Example State University"]);
  check("check: what was taken out is counted", r.removed, { roles: 1, bullets: 1, schools: 1 });
  check("check: nothing usable is nothing", tailor.checkAgainstSource({ experience: [{ company: "Nowhere", bullets: [] }] }, source), null);
  check("check: not an object is nothing", tailor.checkAgainstSource(null, source), null);
}

// ---------------------------------------------------------------------------
// Who a follow-up note may be sent to
// ---------------------------------------------------------------------------
{
  const page = `<a href="mailto:jane.doe@acme.com">Jane</a> help@acme.com info&#64;acme.com privacy@acme.com
    careers@acme.com sales@acme.com noreply@acme.com accessibility@acme.com x@other.com logo@2x.png`;
  check("contacts: role addresses only, best first", outreach.contactsIn(page, "acme.com"), [
    { addr: "careers@acme.com", tier: 0 },
    { addr: "info@acme.com", tier: 1 },
    { addr: "help@acme.com", tier: 2 },
  ]);
  check("contacts: another company's address is not this one's", outreach.contactsIn("careers@other.com", "acme.com"), []);
  check(
    "person: named beside hiring words",
    outreach.hiringPersonIn("Questions about this role? Contact our recruiter at jane.doe@acme.com today.", "acme.com"),
    { addr: "jane.doe@acme.com", first: "Jane" },
  );
  check("person: a name with no hiring words near it is left alone", outreach.hiringPersonIn("Our founder bob.boss@acme.com loves fishing.", "acme.com"), null);
  check("person: a role address is not a person", outreach.hiringPersonIn("Recruiting: careers@acme.com", "acme.com"), null);
  check("site: a subdomain belongs to its site", [outreach.site("careers.acme.com"), outreach.site("www.acme.co.uk")], ["acme.com", "acme.co.uk"]);
  const note = outreach.plainNote({ title: "Account Manager", company: "Acme", name: "Pat Example", phone: "555-0100", email: "pat@example.com", resume: "Pat\nx\n\nSUMMARY\nHands-on retail leader with experience in sales. As Assistant Manager, serves as second-in-command.\nSKILLS" });
  truthy("note: speaks in the first person", note.includes("I am a hands-on retail leader"));
  check("note: nothing about the applicant in the third person", /\bserves as\b/.test(note), false);
  truthy("note: opens plainly and is signed", note.startsWith("Hello,") && note.trim().endsWith("555-0100 | pat@example.com"));
}

// ---------------------------------------------------------------------------
// Postings read from employers' own pages
// ---------------------------------------------------------------------------
{
  const recent = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const html = `<script type="application/ld+json">{"@graph":[{"@type":"WebSite"},{"@type":["JobPosting"],"title":"Account Manager",
    "datePosted":"${recent}","jobLocation":[{"address":{"addressLocality":"Edison","addressRegion":"NJ"}}],
    "hiringOrganization":{"name":"Acme Co."},"description":"&lt;p&gt;Sell things&lt;/p&gt;","url":"/jobs/123"}]}</script>
    <a href="/careers/jobs/senior-account-manager-99">Senior Account Manager</a><a href="/about">About</a><a href="/jobs/1">Intern, Account Manager</a>
    <a href="/jobs/100%-remote-account-manager">Account Manager</a>`;
  const found = jobposting.postingsIn(html);
  check("posting: found inside a graph", found.length, 1);
  const j = jobposting.shape(found[0], "https://acme.com/careers", "Acme");
  check("posting: read", [j.title, j.where, j.url, j.description], ["Account Manager", "Edison, NJ", "https://acme.com/jobs/123", "Sell things"]);
  check("posting: three days old is fresh", jobposting.fresh(j), true);
  check("posting: no date is not fresh", jobposting.fresh({ posted_at: null, closes_at: null }), false);
  check("posting: a month old but closing this week is fresh", jobposting.fresh({ posted_at: new Date(Date.now() - 30 * 86_400_000).toISOString(), closes_at: new Date(Date.now() + 3 * 86_400_000).toISOString() }), true);
  check("posting: already closed is not fresh", jobposting.fresh({ posted_at: recent, closes_at: new Date(Date.now() - 86_400_000).toISOString() }), false);
  check("links: wanted titles only, an odd address does not break it", jobposting.jobLinks(html, "https://acme.com/careers", ["account manager"], ["intern"]), [
    "https://acme.com/careers/jobs/senior-account-manager-99",
    "https://acme.com/jobs/100%-remote-account-manager",
  ]);
  check("posting: broken data is skipped", jobposting.postingsIn('<script type="application/ld+json">{not json</script>'), []);
}

// ---------------------------------------------------------------------------
// Employers from the public feeds
// ---------------------------------------------------------------------------
{
  check("feeds: a posting's own board, where it names one", [feeds.boardLink("https://boards.greenhouse.io/acme/jobs/123?gh_src=x"), feeds.boardLink("https://jobs.lever.co/acme/abc-def/apply"), feeds.boardLink("https://jobs.ashbyhq.com/Acme/1b2c"), feeds.boardLink("https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/NY/Role_R1"), feeds.boardLink("https://remoteok.com/l/123")], ["https://boards.greenhouse.io/acme", "https://jobs.lever.co/acme", "https://jobs.ashbyhq.com/Acme", "https://acme.wd5.myworkdayjobs.com/en-US/Careers", null]);
  check("feeds: a company's own site, guessed from its name", feeds.guessCareersUrl("Northwell Health, Inc."), "https://www.northwellhealth.com/careers");
  check("feeds: too short a name gives no guess", feeds.guessCareersUrl("AB"), null);
  check("feeds: titles", [feeds.wanted("Senior Account Manager", ["account manager"], ["intern"]), feeds.wanted("Account Manager Intern", ["account manager"], ["intern"])], [true, false]);
}

// ---------------------------------------------------------------------------
// Where a Workday posting is read from
// ---------------------------------------------------------------------------
{
  check(
    "workday: the feed behind a posting's page",
    pretailor.workdayFeedUrl("https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Edison-NJ/Account-Manager_R123"),
    "https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/Careers/job/Edison-NJ/Account-Manager_R123",
  );
  check(
    "workday: with no language in the address",
    pretailor.workdayFeedUrl("https://acme.wd1.myworkdayjobs.com/External/job/Remote/Title_1"),
    "https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/External/job/Remote/Title_1",
  );
  check("workday: another site is not Workday", pretailor.workdayFeedUrl("https://boards.greenhouse.io/acme/jobs/1"), null);
  check("workday: not an address", pretailor.workdayFeedUrl("nope"), null);
}

// ---------------------------------------------------------------------------
// A SuccessFactors search page
// ---------------------------------------------------------------------------
{
  const page = `<table><tbody>
    <tr class="data-row clickable">
      <td class="colTitle" headers="hdrTitle">
        <span class="jobTitle hidden-phone"><a href="/job/Piscataway-Store-Manager-NJ-08854/1234567800/" class="jobTitle-link">Store Manager &amp; Lead</a></span>
        <div class="jobdetail-phone visible-phone"><span class="jobTitle visible-phone"><a class="jobTitle-link" href="/job/Piscataway-Store-Manager-NJ-08854/1234567800/">Store Manager &amp; Lead</a></span></div>
      </td>
      <td class="colLocation hidden-phone" headers="hdrLocation"><span class="jobLocation"> Piscataway, NJ, US, 08854 </span></td>
      <td class="colDate hidden-phone" headers="hdrDate"><span class="jobDate">Nov 24, 2026 </span></td>
    </tr>
    <tr class="data-row">
      <td><a class="jobTitle-link" href="/job/Edison-Analyst-NJ/99/">Analyst</a></td>
      <td><span class="jobLocation">Edison, NJ, US</span></td>
    </tr>
    <tr class="header-row"><td>not a posting</td></tr>
  </tbody></table>`;
  const rows = sf.rowsIn(page, "https://jobs.example.com");
  check("successfactors: one row per posting, though each prints its title twice", rows.length, 2);
  check("successfactors: a row", rows[0], { url: "https://jobs.example.com/job/Piscataway-Store-Manager-NJ-08854/1234567800/", title: "Store Manager & Lead", location: "Piscataway, NJ, US, 08854", posted: "Nov 24, 2026" });
  check("successfactors: a row with no date still reads", rows[1].posted, "");
  check("successfactors: the place without its country and postcode", sf.placeOf("Piscataway, NJ, US, 08854"), "Piscataway, NJ");
  check("successfactors: the date as printed", sf.postedAt("Nov 24, 2026"), "2026-11-24T12:00:00.000Z");
  check("successfactors: no date is no date", sf.postedAt(""), null);
  check("successfactors: a page with no rows", sf.rowsIn("<html><body>No results</body></html>", "https://jobs.example.com"), []);
  // The newer layout: tiles in a list, the place and date in labelled boxes.
  const tiles = `<ul><li class="job-tile job-id-77 job-row-index-0 linkhovercolor">
      <a class='jobTitle-link fontcolorb' href='/acme/job/Edison-Driver&apos;s-Helper-NJ-08817/77/'>Driver&#39;s Helper</a>
      <div id="job-77-desktop-section-location-value">Edison, NJ, US, 08817 +3 more…</div>
      <div id="job-77-desktop-section-date-value">Nov 20, 2026</div>
    </li></ul>`;
  const t = sf.rowsIn(tiles, "https://jobs.example.com");
  check("successfactors: a tile reads as a row", t[0], { url: "https://jobs.example.com/acme/job/Edison-Driver's-Helper-NJ-08817/77/", title: "Driver's Helper", location: "Edison, NJ, US, 08817", posted: "Nov 20, 2026", more: true });
}

// ---------------------------------------------------------------------------
// What a run may say out loud
// ---------------------------------------------------------------------------
{
  const profile = { full_name: "Pat Q. Example", email: "pat.example@mail.test", phone: "(732) 555-0100", address: "12 Sample Street", linkedin_url: "https://www.linkedin.com/in/patexample/", resume_file_name: "Pat_Example_Resume.pdf" };
  const roles = { experience: [{ company: "Staples", title: "Assistant Store Manager" }], education: [{ school: "Example State University" }], certifications: [{ name: "Google Analytics Certification" }] };
  const terms = quiet.privateTerms(profile, roles);
  const say = (t) => quiet.scrub(t, terms, "(?:\\+?1[\\s.-]?)?\\(?732\\)?[\\s.-]?555[\\s.-]?0100");
  quiet.hideJob({ title: "Assistant Store Manager - Trenton", company: "Garden State Foods" });
  check("quiet: an address becomes the kind of portal", /^form: \[workday [0-9a-f]{5}\] done$/.test(quiet.scrubPlaces("form: https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Trenton/Manager_R1?x=1 done")), true);
  check("quiet: a bare host too", /^the wall at \[site [0-9a-f]{5}\]/.test(quiet.scrubPlaces("the wall at careers.acme.com/apply/1: {}")), true);
  check("quiet: the system's own addresses and file names are left", quiet.scrubPlaces("https://abc.supabase.co/rest/v1/jobs apply.mjs resume.pdf e.message"), "https://abc.supabase.co/rest/v1/jobs apply.mjs resume.pdf e.message");
quiet.hideJob({ company: "ZQ" });
  check("quiet: a two-letter employer is hidden as written, and only standing alone", [/^ok employer-[0-9a-f]{5} read$/.test(quiet.asPrinted("ok ZQ read")), quiet.asPrinted("the zq and AZQ1")], [true, "the zq and AZQ1"]);
    check("quiet: the same employer, the same alias", [quiet.aliasFor("Garden State Foods") === quiet.aliasFor("garden state  foods!"), /^employer-[0-9a-f]{5}$/.test(quiet.aliasFor("Garden State Foods"))], [true, true]);
  check("quiet: a record's shape and none of its words", quiet.shape({ Title: "Manager", n: 3, tags: ["a"], x: null }), { Title: "text of 7", n: "number", tags: "list of 1", x: "empty" });
  {
    const t2 = quiet.privateTerms({ full_name: "Pat Q. Example", city: "Springfield Township", state: "NJ" }, { experience: [{ company: "Fixture Goods Digital Marketing LLC", title: "Owner and Operator" }] });
    const say2 = (t) => quiet.scrub(t, t2);
    check("quiet: the town on its own, and the state spelled out", say2('found options under "Springfield"; picker -> "New Jersey"'), 'found options under "[…]"; picker -> "[…]"');
    check("quiet: an employer from the resume, cut to a width", say2('wanted "Fixture Goods Digital Ma" -> empty'), 'wanted "[…]" -> empty');
  }
  check("quiet: a name", say("resume for Pat Q. Example attached"), "resume for […] attached");
  check("quiet: a surname alone, any case", say("hello EXAMPLE"), "hello […]");
  check("quiet: an email address", say("code sent to pat.example@mail.test"), "code sent to […]");
  check("quiet: a phone number however it is written", [say("call 732-555-0100"), say("call +1 732.555.0100"), say("call 7325550100")], ["call […]", "call […]", "call […]"]);
  check("quiet: a street", say("12  Sample Street, typed"), "[…], typed");
  check("quiet: an employer and a title from the resume", say("title Assistant Store Manager at Staples"), "title […] at […]");
  check("quiet: a school and a certification", say("Example State University; Google Analytics Certification"), "[…]; […]");
  check("quiet: a file name", say("uploaded Pat_Example_Resume.pdf"), "uploaded […]");
  check("quiet: a short first name is not struck out of other words", say("dispatch the patrol"), "dispatch the patrol");
  check("quiet: what is not the owner's is left alone", say("step 2: advanced with \"Save and Continue\" at Acme"), "step 2: advanced with \"Save and Continue\" at Acme");
  check("quiet: nothing to strike out, nothing changed", quiet.scrub("plain line", [], null), "plain line");
}

console.log(failed ? `unit: ${failed} failed, ${passed} passed.` : `unit: all ${passed} passed.`);
process.exit(failed ? 1 : 0);
