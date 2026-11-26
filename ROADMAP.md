# ApplyPilot roadmap

The owner's requirements, with where each stands. This repository and its run
logs are public, so nothing here names an employer applied to, a place, or
anything about the owner.

Three rules sit above everything else:

1. **Zero cost.** Nothing may cost money beyond the subscriptions already
   held. Anything that needs a paid service is out until a free way exists.
2. **Fully autonomous.** No step waits for the owner, except the few that are
   the owner's by nature (listed at the end).
3. **Honest.** Nothing invented on a resume or a form; self-identification
   entered only from the owner's saved answers; an application is counted as
   sent only on evidence.

## How it runs

Every three hours, on free GitHub Actions runners, in a chain that starts
itself: **find** postings → **measure** how far each is → **apply**, one lane
per application system. Each lane runs its unit checks and two fixture
applications first; if either fails, nothing is sent.

| System | State |
| --- | --- |
| Workday | Working. The bulk of what is sent. |
| Greenhouse | Working, including the emailed security code. |
| Oracle Recruiting | Working: emailed code, address, work history entered by hand when the portal cannot read the resume, degree, self-identification from saved answers. "You already applied" is recognised. |
| Employers' own sites | First application sent. Most pages reached are not application forms (job alerts, search pages) and are recognised as such. |
| SuccessFactors | In progress. The way in is the posting's own apply link; sign-in and the emailed passcode are being proven. |
| Ashby, Lever | Lanes exist; their queues have been empty, so untested on real postings. |
| iCIMS, Taleo, SmartRecruiters | Postings are read; applying is not built. |

## Built

- Resume written for each posting from the owner's own roles, or arranged for
  it without the model when the free model allowance is spent. Never more
  than one page; nothing added that the owner did not write.
- Work history filled from the resume where the owner has not entered it.
- Answers: resume first, then the saved answer, then the ordinary answer.
  Questions nothing could answer go to the Answers page once and are reused.
- Portal accounts made and kept; a forgotten password reset through the
  portal's own email; emailed links and codes read from the connected inbox.
  A job parked for mail that had not arrived is tried again half an hour on.
- Distance measured for every waiting posting; a location the map cannot find
  as written is tried again as its town and state, never a town alone.
- Newest postings first; posted within fourteen days, or closing soon.
- At most three applications per employer per day; a daily cap overall.
- A receipt email turns an unconfirmed submission into a confirmed one.
- Six key-free public feeds for discovering employers, on top of the
  employer list and the weekly resolver.
- Daily summary, interview-request replies and follow-up notes to addresses
  an employer publishes: built, each behind the owner's switch, off by
  default.
- Logs that say what happened by shape and count only.

## Next

1. **SuccessFactors**, end to end.
2. **Supply.** The applier now clears nearly everything it is given; the
   limit is how many postings are in reach. Levers, in order of yield: the
   owner's search settings (state rule, score threshold), job-alert emails
   from the big boards read through the inbox, more feed keys, more
   employers resolved.
3. **Ashby and Lever** on real postings as their queues fill.
4. **First run fourteen days back, then only what is new**; checking more
   often than every three hours, once the database is off its metered plan.
5. **Several users** (thirty at most, no technical setup, still zero cost):
   per-user tables and rules, and the database moved off the metered plan.

## Always the owner's

- Interviews themselves, offers, and employers' assessments.
- Any form that demands part of a social security number or a date of birth:
  parked, never filled, never asked for.
- Questions of fact about the owner that no resume settles (citizenship,
  ethnicity): asked once on the Answers page, never guessed.

## Not planned

- Logging in to job boards as the owner, or applying inside them. Their
  alert emails are read instead.
- Getting past CAPTCHAs or disguising the applier.
- A voice or a face standing in for the owner with an employer.

## Working without a middleman

- The `.mjs` files and the workflows are live the moment they are pushed.
- Only changes under `src/` and `supabase/` need the panel published.
- Secrets live in the repository's secrets and the panel's secret form, never
  in chat and never in this repository.
