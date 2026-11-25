# ApplyPilot roadmap

The owner's requirements, in their words where it matters, with where each
stands. Two rules sit above everything else:

1. **Zero cost.** Nothing in this project may cost money beyond the Claude and
   Lovable subscriptions. Anything that needs a paid service is out until a
   free way exists.
2. **Fully autonomous.** No question, form or step waits for the owner.

## Stage 1 — Applying (current)

| Item | State |
| --- | --- |
| Greenhouse applications, incl. emailed security code | Working. Confirmed by employer receipts (Block, MongoDB, Datadog, Carvana). |
| Workday applications | Working on more tenants each run. "How did you hear about us?" — the field that stopped most of them — is solved (it is a folder: category, then source), and is only ever answered with something true: never an agency, a referral or an event. Confirmed sent: Bristol-Myers Squibb, Expedia, Church & Dwight, AIG, Live Nation, Target. |
| Self-test before every run | Working. Two fixture applications must pass or nothing is sent. |
| Answers without the owner | Built: resume first, then the ordinary answer; self-identification never assumed. New rules are added from each run's log of questions nothing answered. |
| Commuting radius enforced at apply time | Built. Radius is the owner's setting (25 mi today; test runs use 40, which brings New York into range). |
| Distance measured for every waiting job | Built (`measure.mjs`, every six hours). |
| Recent or closing soon — built in, not a setting | Built. Posted within 14 days, in both discovery and the applier; a Workday posting with a week or less left to apply also counts. |
| At most 3 applications per employer per day | Built; counts everything sent in the last day however it is filed. |
| One runner per portal, daily cap shared | Built for scheduled runs. |
| Autopilot (check and apply on a schedule) | Built; off until the owner turns it on. |
| A receipt email marks an unconfirmed submission as applied | Built (database trigger). |
| Portal account that exists with an unknown password | Working: the portal's own forgot-password email is read from the connected inbox, a new password is set and saved, and the applier signs in. Seen working at Prudential. |
| Workday skills search, salary ranges, notice period, availability, and other screening questions | Working; each run's log lists the questions nothing answered and rules are added from it. |

Still to do in this stage:

- Workday tenants whose registration is dropped without a word (Kohl's, CarMax, Cushman & Wakefield) — the reset route is now tried there too; unproven.
- Johnson & Johnson stops on "Hispanic or Latino?", which only the owner's own race/ethnicity answer in the panel can settle.
- Lever, Ashby, iCIMS, Taleo, SmartRecruiters forms (few jobs in the queue today).

## Stage 2 — More jobs

Supply is the limit on volume, not the applier: with a 40-mile radius and the
fourteen-day rule there were about fifty postings ready to apply to. Three
things widen it without loosening either rule.

- **Employer list.** The S&P 500 list has about 100 working careers links and
  roughly 200 that do not resolve. Every company should have a working link.
  `resolve.mjs` (weekly, and on demand) opens each unresolved careers site in
  a real browser, follows it to a posting's Apply button, checks what it
  finds against that system's public job feed and saves it. Its first trial
  resolved 7 of 24 in three minutes. Employers on a system the applier cannot
  use yet are counted by system, which is the list of what to build next.
- **Employers that are actually here.** The S&P 500 is national. The file
  `employers-local.txt` names about 170 employers that hire inside the
  radius — hospital systems, pharmaceutical companies, banks and insurers in
  New Jersey, and New York companies on Greenhouse, which the applier already
  completes end to end. The resolver adds and checks them like the rest.
- **Reading every employer.** One discovery request reads a few dozen
  employers and stops. The sweep now repeats until all have been read, six
  times a day; before, most employers waited days for their turn.
- **Job boards (LinkedIn, Indeed, ZipRecruiter).** Wanted as sources. Logging
  in as the owner and applying by automation is against those sites' terms and
  gets accounts banned, and getting past their CAPTCHAs is not something this
  project will do. The free route that keeps the account safe: the owner turns
  on job-alert emails on each board, the panel reads those alerts through the
  Gmail connection it already has, and each alert's posting is followed to the
  employer's own application form, which the applier already handles.
- Daily check-and-apply cycle across every source.

## Stage 3 — After the application

- A short email to the employer after applying, written from the posting and
  the resume, with the tailored resume attached, sent through the connected
  Gmail. Only possible where a posting or receipt gives a real contact address.
- Replies handled automatically: interview requests answered with times.
- Google Calendar: the owner marks working days and free time; the system
  offers and books interview slots from it, treating phone, video and
  in-person differently. Needs a calendar permission added to the Google
  connection, which is the owner's decision.

## Stage 4 — Ideas the owner raised for later

- A cloned voice answering recruiter phone calls, and an AI stand-in on video
  interviews. Not planned: both mean an employer believing they are speaking
  with the owner when they are not, and neither is free. What can be built
  instead: call and interview scheduling, a briefing before each one, and
  practice sessions.

## Working without a middleman

- Everything in `apply.mjs`, `measure.mjs`, `resolve.mjs`, `selftest.mjs` and
  the workflows is live the moment it is pushed.
- Only changes under `src/` (the panel) need Lovable to publish. If Lovable's
  publish-on-sync setting is on, those go live without the owner relaying
  anything.
- Passwords are never to be pasted into chat.
