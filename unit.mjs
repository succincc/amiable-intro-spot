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
process.env.INDEXES_IMPORT_ONLY = "1";
process.env.CRAWL_IMPORT_ONLY = "1";
process.env.NEARBY_IMPORT_ONLY = "1";
process.env.PRETAILOR_IMPORT_ONLY = "1";
process.env.SF_IMPORT_ONLY = "1";

const tailor = await import("./tailor.mjs");
const outreach = await import("./outreach.mjs");
const jobposting = await import("./jobposting.mjs");
const feeds = await import("./feeds.mjs");
const pretailor = await import("./pretailor.mjs");
const sf = await import("./successfactors.mjs");
const quiet = await import("./quiet.mjs");
const near = await import("./near.mjs");
const school = await import("./school.mjs");
const zip = await import("./zipmcp.mjs");
const fp = await import("./fromprofile.mjs");
const cover = await import("./coverletter.mjs");
const idx = await import("./indexes.mjs");
const crawl = await import("./crawl.mjs");
const nearby = await import("./nearby.mjs");
process.env.PHONES_IMPORT_ONLY = "1";
const phones = await import("./phones.mjs");
process.env.USAJOBS_IMPORT_ONLY = "1";
const usajobs = await import("./usajobs.mjs");
process.env.BOARDS_IMPORT_ONLY = "1";
const boards = await import("./boards.mjs");
process.env.MEASURE_IMPORT_ONLY = "1";
const measure = await import("./measure.mjs");
const mbSel = await import("./major-boards-selectors.mjs");
const mbEng = await import("./major-boards-engine.mjs");
process.env.MAJOR_BOARDS_IMPORT_ONLY = "1";
const mbDisc = await import("./major-boards.mjs");

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
  check("page reader: the way in to the list is the plainest such link, and never a taught portal's", [
    jobposting.listLink('<a href="/about">About</a><a href="/careers/search">Search Jobs</a><a href="/x">View all of our current openings</a>', "https://acme.com/careers"),
    jobposting.listLink('<a href="https://acme.wd5.myworkdayjobs.com/x">Search jobs</a><a href="/news">News</a>', "https://acme.com/careers"),
  ], ["https://acme.com/careers/search", null]);
  check("page reader: site maps named in a robots file", jobposting.sitemapsIn("User-agent: *\nDisallow: /x\nSitemap: https://acme.com/jobs/sitemap.xml\nsitemap: https://acme.com/sitemap_index.xml"), ["https://acme.com/jobs/sitemap.xml", "https://acme.com/sitemap_index.xml"]);
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
  check("near: a state, the ones that touch it, and remote", ["Trenton, NJ", "Albany, New York", "Dover, DE, US", "Remote - US", "Austin, TX", "Portland, Oregon"].map((w) => near.nearPattern("New Jersey").test(w)), [true, true, true, true, false, false]);
  check("near: every border is kept from both sides", Object.entries(near.BORDERS).flatMap(([a, list]) => list.filter((b) => !near.BORDERS[b]?.includes(a)).map((b) => `${a}-${b}`)), []);
  check("near: with no state known, nothing is thrown away", [near.nearPattern(null).test("Austin, TX"), near.stateCode("nj"), near.stateName("NJ"), near.stateCode("Narnia")], [true, "NJ", "New Jersey", null]);
  check("quiet: a town with its state is not printed, nor a firm's other names", [quiet.asPrinted("based? Remote US Lincoln, NE (Hybrid) New Brunswick, NJ ok"), quiet.asPrinted("worked for employer-1a2b3 or any of acmef; next")], ["based? Remote US [a place] (Hybrid) [a place] ok", "worked for employer-1a2b3 or any of [its companies]; next"]);
  check("quiet: the owner's state is not printed in a reason", quiet.asPrinted('{"workday / outside NJ":33,"greenhouse / CA is far beyond 29 mi":51}'), '{"workday / outside the state":33,"greenhouse / another state, far beyond the radius":51}');
  check("usajobs: a search answer as postings", usajobs.readSearch({ SearchResult: { SearchResultItems: [
    { MatchedObjectDescriptor: { PositionTitle: "Supply Technician", PositionURI: "https://www.usajobs.gov/job/100", ApplyURI: ["https://www.usajobs.gov/job/100?apply"], OrganizationName: "Example Agency", PositionLocation: [{ CityName: "Exampleton, New Jersey", CountrySubDivisionCode: "New Jersey", Latitude: 40.2, Longitude: -74.7 }], PositionRemuneration: [{ MinimumRange: "45000", MaximumRange: "58000", Description: "Per Year" }], PublicationStartDate: "2026-11-20T00:00:00", ApplicationCloseDate: "2026-12-05T00:00:00", UserArea: { Details: { JobSummary: "<p>Keep the stock.</p>" } } } },
    { MatchedObjectDescriptor: { PositionTitle: "", PositionURI: "x" } },
  ] } }).map((r) => [r.title, r.company, r.location, r.lat, r.salary_text, r.posted_at?.slice(0, 10), r.description, r.apply_url]), [["Supply Technician", "Example Agency", "Exampleton, New Jersey", 40.2, "$45000 - $58000 per year", "2026-11-20", "Keep the stock.", "https://www.usajobs.gov/job/100?apply"]]);
  check("phones: the nearest place of that name with a number, and none from far away", [
    phones.nameKey("Example Office Supply, Inc."),
    phones.phoneFrom({ elements: [{ lat: 40.5, lon: -74.5, tags: { phone: "+1 732 555 0199" } }, { center: { lat: 40.201, lon: -74.701 }, tags: { "contact:phone": "+1-732-555-0100;+1-732-555-0101" } }] }, 40.2, -74.7),
    phones.phoneFrom({ elements: [{ lat: 41.5, lon: -74.5, tags: { phone: "+1 732 555 0199" } }] }, 40.2, -74.7),
  ], ["Example Office", "+1-732-555-0100", null]);
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
  check("school: the name alone, whatever was tacked on", [school.schoolNameOnly("Example State University - Bachelor of Arts"), school.schoolNameOnly("Example College, Springfield (2019)"), school.schoolNameOnly("Example State University")], ["Example State University", "Example College", "Example State University"]);
  check("school: the line that holds every word of the name, the shortest of them, and never a guess", [
    school.schoolOption([{ text: "Example State University - Online Campus" }, { text: "Example State University" }, { text: "Other State University" }], "Example State University")?.text,
    school.schoolOption([{ text: "Other State University" }, { text: "Sample College" }], "Example State University"),
  ], ["Example State University", null]);
  check("zip: a reply as plain JSON and as an event stream", [
    zip.readReply('{"jsonrpc":"2.0","id":1,"result":{"ok":1}}', "application/json")?.result,
    zip.readReply('event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":2}}\n\n', "text/event-stream")?.result,
    zip.readReply("not json", "application/json"),
  ], [{ ok: 1 }, { ok: 2 }, null]);
  check("zip: the search in the tool's own names, and nothing it has no place for", [
    zip.argsFor({ properties: { search: { type: "string" }, location: { type: "string" }, radius_miles: { type: "integer" }, days_ago: { type: "integer", enum: [1, 5, 10, 30] }, offset: { type: "integer" } } }, { title: "Manager", where: "Springfield, NJ", radius: 40, days: 30, offset: 5 }),
    zip.argsFor({ properties: { query: { type: "string" }, days: { type: "integer", enum: [1, 7] } } }, { title: "Manager", where: "Springfield, NJ", radius: 40, days: 30, offset: 0 }),
  ], [{ search: "Manager", location: "Springfield, NJ", radius_miles: 40, days_ago: 30, offset: 5 }, { query: "Manager" }]);
  check("zip: postings found wherever the answer keeps them", [
    zip.jobsIn({ structuredContent: { jobs: [{ title: "Manager", hiring_company: { name: "Example Goods" }, posted_time: "2026-11-20" }] } }).map((j) => [j.title, j.company, j.posted]),
    zip.jobsIn({ content: [{ type: "text", text: '{"results":[{"job_title":"Clerk","company_name":"Sample Co"}]}' }] }).map((j) => [j.title, j.company]),
    zip.jobsIn({ content: [{ type: "text", text: "Here are some jobs." }] }),
  ], [[["Manager", "Example Goods", "2026-11-20"]], [["Clerk", "Sample Co"]], []]);
  {
    const me = { citizenship: "United States only", github_url: "https://github.com/example", linkedin_url: "", portfolio_url: null };
    check("profile: citizenship, however it is asked", [
      fp.fromProfile("Please indicate which, if any, where you are a citizen. Cuba Syria North Korea Iran Sudan None of the above", me),
      fp.fromProfile("Are you a U.S. citizen?", me),
      fp.fromProfile("Do you hold dual citizenship?", me),
      fp.fromProfile("Country of citizenship", me),
      fp.fromProfile("Are you a US citizen?", { citizenship: "Another country" }),
      fp.fromProfile("Which, if any, of these countries are you a citizen of?", { citizenship: "United States and another country" }),
      fp.fromProfile("Are you a US citizen?", {}),
    ], ["None of the above", "Yes", "No", "United States", "No", null, null]);
    check("profile: a link is the profile's, and only when it is one", [
      fp.fromProfile("GitHub URL", me), fp.fromProfile("Link to your Git Hub profile", me), fp.fromProfile("LinkedIn Profile", me), fp.fromProfile("Portfolio or personal website", me),
      fp.fromProfile("How did you hear about us? LinkedIn", { linkedin_url: "https://linkedin.com/in/x" }),
    ], ["https://github.com/example", "https://github.com/example", null, null, null]);
  }
  check("indexes: the company in each row, not its ticker", idx.companiesIn('<table class="wikitable sortable" id="constituents"><tr><th>Symbol</th><th>Security</th></tr><tr><td><a rel="nofollow" class="external text" href="https://www.nyse.com/quote/XNYS:AA">AA</a></td><td><a href="/wiki/Alcoa" title="Alcoa">Alcoa</a></td><td><a href="/wiki/Materials" title="Materials">Materials</a></td></tr><tr><td><a class="external" href="https://x">BJ</a></td><td><a href="/wiki/BJ%27s_Wholesale_Club" title="x">BJ&#39;s Wholesale Club</a></td></tr></table>'), [{ title: "Alcoa", name: "Alcoa" }, { title: "BJ's Wholesale Club", name: "BJ's Wholesale Club" }]);
  check("indexes: an employer's name and where to start", [idx.employerName("Example Holdings, Inc."), idx.employerName("Sample Co (Class A)"), idx.careersFrom("https://www.example.com/en-us/home"), idx.careersFrom("example.org"), idx.careersFrom("")], ["Example Holdings", "Sample", "https://www.example.com/careers", "https://example.org/careers", null]);
  check("crawl: an address as the board it belongs to", [
    crawl.boardFrom("https://acme.wd5.myworkdayjobs.com/en-US/External/job/Town/Clerk_R1"),
    crawl.boardFrom("https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/External/jobs"),
    crawl.boardFrom("https://boards.greenhouse.io/Acme/jobs/123"),
    crawl.boardFrom("https://job-boards.greenhouse.io/embed/job_board?for=acme"),
    crawl.boardFrom("https://jobs.lever.co/acme/abc-123/apply"),
    crawl.boardFrom("https://jobs.ashbyhq.com/acme"),
    crawl.boardFrom("https://example.com/careers"),
  ].map((b) => (b ? `${b.ats} ${b.token}${b.site ? "/" + b.site : ""}` : null)), ["workday acme/External", null, "greenhouse acme", null, "lever acme", "ashby acme", null]);
  check("crawl: a board is kept for a wanted title in reach, and for nothing else", [
    crawl.forOwner("greenhouse", crawl.postingsOf("greenhouse", { jobs: [{ title: "Store Manager", location: { name: "Springfield, NJ" } }, { title: "Store Manager", location: { name: "Austin, TX" } }, { title: "Rocket Scientist", location: { name: "Springfield, NJ" } }] }), ["Store Manager"], [], near.nearPattern("NJ")),
    crawl.forOwner("workday", crawl.postingsOf("workday", { jobPostings: [{ title: "Store Manager", locationsText: "3 Locations" }] }), ["Store Manager"], [], near.nearPattern("NJ")),
    crawl.forOwner("lever", crawl.postingsOf("lever", [{ text: "Store Manager", categories: { location: "London" } }]), ["Store Manager"], [], near.nearPattern("NJ")),
  ], [1, 1, 0]);
  check("nearby: a business's own site, and the places of a chain counted as one employer", [
    nearby.siteOf("https://locations.example.com/nj/springfield"), nearby.siteOf("facebook.com/somecafe"), nearby.siteOf(""),
    nearby.employersFrom([{ tags: { name: "Example #12", brand: "Example", website: "https://www.example.com/a" } }, { tags: { name: "Example", brand: "Example", website: "example.com" } }, { tags: { name: "Corner Cafe", website: "https://cornercafe.test" } }, { tags: { name: "No Site" } }]).map((e) => `${e.name}:${e.site}:${e.places}`),
  ], ["example.com", null, null, ["Example:example.com:2", "Corner Cafe:cornercafe.test:1"]]);
  {
    const resume = "Pat Example\nExperience\nStore Manager | Example Goods | 01/2020 - Present\n• Ran a team of 12 and raised store sales 20% in one year\n• Hired, trained and scheduled all store staff\n• Handled customer complaints and vendor orders\nSkills\nSales, Scheduling";
    const job = { title: "Assistant Store Manager", company: "Sample Mart", description: "You will lead a team, drive store sales, and hire and train staff. Handle scheduling and customer service." };
    const me = { full_name: "Pat Example", phone: "732-555-0100", email: "pat@example.test", earliest_start: "Immediately" };
    check("cover: which boxes ask for one", [cover.isCoverLetter("Cover Letter"), cover.isCoverLetter("cover_letter_upload"), cover.isCoverLetter("Letter of Interest (optional)"), cover.isCoverLetter("Resume/CV"), cover.isCoverLetter("Why do you want to work here?")], [true, true, true, false, false]);
    check("cover: a bullet as a sentence", [cover.asSentence("Ran a team of 12;"), cover.asSentence("Hired, trained and scheduled all store staff."), cover.asSentence("Responsible for vendor orders")], ["I ran a team of 12.", "I hired, trained and scheduled all store staff.", "Responsible for vendor orders."]);
    const letter = cover.composeCoverLetter({ job, profile: me, resume });
    check("cover: the composed letter is the resume's own lines, addressed and signed", [
      letter.startsWith("Dear Hiring Manager,"), letter.endsWith("Sincerely,\nPat Example"), /Assistant Store Manager position at Sample Mart/.test(letter),
      /I ran a team of 12 and raised store sales 20% in one year\./.test(letter), /I hired, trained and scheduled all store staff\./.test(letter), /available to start immediately/.test(letter), /\[|\{/.test(letter),
    ], [true, true, true, true, true, true, false]);
    const good = "Dear Hiring Manager,\n\n" + "I ran a team of 12 and raised store sales 20% at Example Goods. ".repeat(12) + "\n\nSincerely,\nPat Example";
    check("cover: a model's letter is signed only if it can be stood behind", [
      cover.standsBehind(good, { resume, job, profile: me }),
      cover.standsBehind(good.replace("20%", "45%"), { resume, job, profile: me }),
      cover.standsBehind(good.replace("Pat Example", "[Your Name]"), { resume, job, profile: me }),
      cover.standsBehind("Dear Hiring Manager, I fit. Sincerely, Pat", { resume, job, profile: me }),
    ], [true, false, false, false]);
    const made = await cover.writeCoverLetter({ job, profile: me, resume, apiKey: "" });
    check("cover: with no model, the composed letter", [made.by, made.text === letter], ["rules", true]);
  }
  check("quiet: nothing to strike out, nothing changed", quiet.scrub("plain line", [], null), "plain line");
  check("major-boards: platform detection and canonical URLs", [
    mbSel.detectBoardPlatform("https://www.linkedin.com/jobs/view/devops-0-downtime-4384228814/"),
    mbSel.normalizeBoardUrl("linkedin", "https://www.linkedin.com/jobs/view/devops-0-downtime-4384228814/?ref=1"),
    mbSel.normalizeBoardUrl("indeed", "https://www.indeed.com/rc/clk?jk=abcdef123456"),
    mbSel.fuzzyMatchOption("bachelor", ["High School", "Bachelor's Degree"]),
    mbSel.detectHumanVerification("linkedin", "https://www.linkedin.com/checkpoint/challenge/1", "", "", false).help_reason,
    mbEng.normalizeSessionCookies([{ name: "li_at", value: "x", domain: ".linkedin.com", sameSite: "no_restriction" }], "linkedin").length,
    mbDisc.filterBoardPostings([{ title: "Account Manager", company: "Acme", url: "https://www.linkedin.com/jobs/view/1111111/", remote: false }], { titles: ["Account Manager"] }).length,
  ], ["linkedin", "https://www.linkedin.com/jobs/view/4384228814/", "https://www.indeed.com/viewjob?jk=abcdef123456", "Bachelor's Degree", "verification_required", 1, 1]);
}

{
  const sj = await import("./samejob.mjs");
  const k = (t, c, l) => sj.jobKey({ title: t, company: c, location: l });
  const a = k("Manager", "Example Goods", "Exampleton, NJ");
  check("same job: the same role, employer and place under other spellings, and nothing else", [
    a === k("Manager", "Example Goods Inc.", "Exampleton, New Jersey, United States"),
    a === k("Manager - R12345", "Example Goods", "US-NJ-Exampleton"),
    a === k("Manager", "Example Goods", "Sampleville, NJ"),
    a === k("Manager", "Sample Foods", "Exampleton, NJ"),
    a === k("Manager", "Example Goods", "Exampleton, NY"),
    a === k("Cashier", "Example Goods", "Exampleton, NJ"),
    k("Manager", "Example Goods", "") === k("Manager", "Example Goods", null),
    k("", "Example Goods", "x"),
  ], [true, true, false, false, false, false, true, null]);
}

{
  process.env.FORUSERS_IMPORT_ONLY = "1";
  const fu = await import("./forusers.mjs");
  check("the line: turned an hour at a time, and a job's time shared evenly", [
    fu.turnOrder(["a", "b", "c"], 0), fu.turnOrder(["a", "b", "c"], 3_600_000), fu.turnOrder(["a", "b", "c"], 2 * 3_600_000), fu.turnOrder(["a"], 5 * 3_600_000), fu.turnOrder([], 1),
    fu.shareOfTime(1, 300), fu.shareOfTime(2, 300), fu.shareOfTime(30, 300), fu.shareOfTime(100, 300),
  ], [["a", "b", "c"], ["b", "c", "a"], ["c", "a", "b"], ["a"], [], 300, 135, 9, 8]);
}

{
  process.env.SR_IMPORT_ONLY = "1";
  const sr = await import("./smartrecruiters.mjs");
  const r = sr.rowOf({ id: "744000012345678", name: " Store Manager ", releasedDate: "2026-11-20T10:00:00.000Z", location: { city: "Exampleton", region: "NJ", country: "us", remote: false }, company: { identifier: "ExampleGoods" } }, "examplegoods");
  check("smartrecruiters: an opening as a row, and its text from its sections", [
    r.title, r.location, r.country, r.href, r.remote, r.posted_at,
    sr.rowOf({ id: "1", name: "" }, "x"),
    sr.rowOf({ id: "2", name: "Clerk", location: { remote: true } }, "x").remote,
    sr.textOf({ jobAd: { sections: { jobDescription: { text: "<p>Runs the store.</p>" }, qualifications: { text: "<ul><li>Two years</li></ul>" } } } }),
    sr.textOf(null),
  ], ["Store Manager", "Exampleton, NJ", "us", "https://jobs.smartrecruiters.com/ExampleGoods/744000012345678", false, "2026-11-20T10:00:00.000Z", null, true, "Runs the store.\n\nTwo years", ""]);
}

{
  const { GONE_RE } = await import("./gone.mjs");
  check("gone: a page that says the posting is closed, and pages that do not", [
    GONE_RE.test("Sorry, this position is no longer available."),
    GONE_RE.test("This job is no longer accepting applications"),
    GONE_RE.test("The opportunity you are looking for has been filled"),
    GONE_RE.test("This posting has expired"),
    GONE_RE.test("We are no longer accepting applications for this role."),
    GONE_RE.test("Apply now. This position is open until filled and is available immediately."),
    GONE_RE.test("You will manage accounts that are not available elsewhere."),
    GONE_RE.test("Store Manager. Full time. Apply With LinkedIn."),
  ], [true, true, true, true, true, false, false, false]);
}

{
  // The last look at a document: what the posting requires apart from what
  // it would like, the writing, the claims, and nothing ever added.
  const q = await import("./quality.mjs");
  const posting = "About us\nWe are great.\n\nRequirements:\n- 5+ years of customer success experience\n- Salesforce and SQL\n\nNice to have:\n- Tableau\n\nBenefits\n- Health insurance";
  const resume = "Jane Doe\n\nEXPERIENCE\nAcme - Customer Success Manager (Jan 2020 - Present)\n• Leveraged Salesforce to successfully manage 120 accounts and grew revenue 35%\n• Managed renewals in order to cut churn across enterprise accounts\n• Managed renewals in order to cut churn across enterprise accounts\n• A results-driven, dynamic leader who built dynamic pricing models in SQL";
  const seg = q.segmentPosting(posting);
  const rep = q.requirementReport(resume, posting);
  const tidy = q.tidyWriting(resume);
  check("quality: a posting is read by its own headings, the writing tidied by taking out only, and a claim that is not the candidate's is named", [
    seg.marked, /Salesforce/.test(seg.required), /Tableau/.test(seg.preferred), /Health/.test(seg.required),
    rep.split, rep.preferred.missing.includes("tableau"),
    /Used Salesforce to manage 120 accounts and grew revenue 35%/.test(tidy.text),
    /A leader who built dynamic pricing models in SQL/.test(tidy.text),
    (tidy.text.match(/Managed renewals/g) ?? []).length,
    // every figure that was there is still there, and none is new
    q.unsupportedClaims(tidy.text, resume).length,
    q.unsupportedClaims(resume + "\n• Grew revenue 48% and holds a PMP", resume),
    q.writingFindings(resume).map((f) => f.kind).includes("said twice"),
    /not the employer's score/.test(q.documentCheck({ text: tidy.text, source: resume, posting }).line),
  ], [true, true, true, false, true, true, true, true, 1, 0, ["48%", "PMP"], true, true]);
}

{
  // What came back, against how it was sent: counted, and no rate drawn
  // from a handful.
  const o = await import("./outcomes.mjs");
  const day = (n) => new Date(Date.UTC(2026, 10, n)).toISOString();
  const few = [
    { status: "interview", ats: "greenhouse", score: 9, posted_at: day(1), applied_at: day(2), ats_match: 85, has_tailored: true },
    { status: "rejected", ats: "greenhouse", score: 6, posted_at: day(1), applied_at: day(20), ats_match: 50, has_tailored: false },
    { status: "applied", ats: "workday", score: 7, posted_at: null, applied_at: day(3), has_tailored: true },
    { status: "queued", ats: "workday" },
  ];
  const many = Array.from({ length: 40 }, (_, i) => ({ status: i < 4 ? "interview" : "applied", ats: "workday", score: 8, posted_at: day(1), applied_at: day(2), ats_match: 90, has_tailored: true }));
  const a = o.outcomes(few);
  const b = o.outcomes(many);
  check("outcomes: only what was sent is counted, each by what was known of it, and a rate is given only over enough", [
    a.all.sent, a.all.interviews, a.all.rejections, a.all.waiting, a.all.rate,
    a.by.system.greenhouse.sent, a.by["posting age when sent"]["0-2 days"].interviews, a.by["posting age when sent"]["15+ days"].rejections,
    a.by["posting age when sent"]["not dated"].sent, a.by["match to requirements"]["not measured"].sent,
    b.all.rate, b.by.resume["written for the posting"].rate,
    o.outcomeLines(a)[1].includes("counts only"),
  ], [3, 1, 1, 1, null, 2, 1, 1, 1, 1, 10, 10, true]);
}

{
  // The record against its evidence: the three things an audit of a real
  // account found wrong, each of which must be seen if it comes back.
  const e = await import("./evidence.mjs");
  const now = Date.UTC(2026, 10, 27);
  const at = (h) => new Date(now - h * 3_600_000).toISOString();
  const job = (id, o = {}) => ({ id, status: "applied", ats: "workday", company: `Co ${id}`, title: "Analyst", location: "Austin, TX", url: `https://x.example/${id}`, applied_at: at(100), ...o });
  const sent = [
    job(1, { status: "interview" }),                       // marked up, mail later re-read as a receipt
    job(2, { status: "interview" }),                       // really an interview
    job(3, { confirm_state: "confirmed" }),
    job(4, { company: "Co 3", applied_at: at(10) }),       // the same job as 3, sent again yesterday
    job(5, { ats: "greenhouse" }),                         // receipt filed under action_needed
    job(6, { ats: "greenhouse", applied_at: at(5) }),      // nothing but the applier's word
  ];
  const mail = [
    { category: "confirmation", subject: "Thank you for applying", job_id: 1 },
    { category: "interview", subject: "Schedule your interview", job_id: 2 },
    { category: "action_needed", subject: "We've received your application", job_id: 5 },
    { category: "action_needed", subject: "Confirm your identity", job_id: null },
    { category: "action_needed", subject: "Complete your assessment", job_id: null },
    { category: "action_needed", subject: "Reset your password", job_id: null },
  ];
  const r = e.evidence(sent, mail, [{ ats: "adp", status: "needs_help", help_reason: "login" }], now);
  const text = r.lines.join("\n");
  check("evidence: a stage with no mail behind it, a second sending and a receipt under the wrong heading are each seen", [
    r.failures.length, /1 job\(s\) marked interview with no interview mail/.test(r.failures.join(";")), /sent a second time/.test(r.failures.join(";")),
    r.corrected.filter((j) => j.status === "interview").length,
    /"verification_code":1/.test(text) && /"assessment":1/.test(text) && /"account_notice":1/.test(text) && /"acknowledgement":2/.test(text),
    /greenhouse: 2 \/ 1 /.test(text), /adp: 0 \/ 0 .* 1 \(login 1\)/.test(text), /Co \d/.test(text),
  ], [2, true, true, 1, true, true, true, false]);
  const clean = e.evidence([job(2, { status: "interview" }), job(3, { confirm_state: "confirmed" })], [{ category: "interview", subject: "Pick a time", job_id: 2 }], [], now);
  check("evidence: a true record has nothing wrong with it", clean.failures, []);
}

console.log(failed ? `unit: ${failed} failed, ${passed} passed.` : `unit: all ${passed} passed.`);
process.exit(failed ? 1 : 0);
