# Engineering backlog and continuation notes

Kept by the engineer working on the engine. This file is public, like the
rest of the repository: counts and system names only, nothing of anybody's.

Times are US Eastern. Each item says what it rests on: a measurement, a
run's own log, or nothing yet (in which case it is not to be "fixed" until
there is evidence).

## How to pick up from here

1. `node unit.mjs` and `APPLY_SELFTEST=1 node selftest.mjs` must pass before
   any push; `npx tsc --noEmit -p .` and `npx vitest run` when `src/` changed.
   Validate every workflow file as YAML. The round's gate runs the unit
   checks before a browser is installed: nothing they load may need one.
2. Root `*.mjs` and `.github/workflows` are live on push to `main`. `src/`
   and `supabase/migrations` reach production only when the owner asks
   Lovable to pull and publish (a migration only if named).
3. Numbers come from runs, not from reading code: `audit.yml` (inputs
   `only=supply` for the supply report alone), `crumbs.yml` (what stopped
   postings, by system), each lane's "In short" step in `apply.yml`.
4. The database answers 1,000 rows at most per request: use `allRows()`.
5. Nothing is printed that this program's own source does not already say
   (`quiet.mjs`). A workflow pipes outside text through `safe`.

## Standing limits (the owner's)

- Zero added cost. No paid service, proxy, cloud browser or subscription.
- No bypass of a human check; such postings are set out for the person.
- Nothing personal is guessed: citizenship, sponsorship, clearance,
  self-identification, pay history, experience not on record.
- An application whose sending is not known is never sent again from here.
- Radius, titles, pay floor, schedules and switches are the owner's: not
  changed by the engine or its engineer.
- The dependency branch `deps-audit-fix` is not merged without a yes.

## Measured baseline, 28 Nov (owner's account, last 7 days)

- Found 3,903 postings; in reach or remote 305; qualified 349; sent 164.
- Qualified and not sent 185: human check 94 (one system alone 67), waiting
  24, incomplete 15, sign-in 13, unconfirmed 13, error 12, left in hand 4.
- 73% of everything found was set aside for where it is.
- Employers whose lists are read: 821; with a job in reach in 30 days: 40.
- The map knows 2,616 employers within the radius; under a quarter were
  on file before 28 Nov.
- Employers not placed on a system: 1,047 (answered "not found" 248,
  refused the visit 181, no system recognised 217, system with no reader 172).

## Done on 28 Nov (see `git log` for hashes)

- One net under everything printed; leak checks; workflows' raw prints
  closed; hand-given addresses no longer echoed.
- Public files no longer name a home area (history still does).
- Supply report; origin of each employer kept; front page tried when a
  guessed careers address is missing; map intake 1,000 a run, every 3 days.
- A list of ages; a referrer's name "if applicable"; Oracle repair loop.
- Long lists read whole (`pages.mjs`).
- Unplaced postings marked with the map reading that failed.
- A posting left in hand by a stopped run is set out for the person.
- Each lane's evidence on the round's record; weekly roll-up in the audit.

## Also done, night of 28 Nov

- Outside words fenced and stripped of sentences addressed to a program;
  answers checked before use (`untrusted.mjs`).
- A dropped or busy read asked again, three times at most (`pages.mjs`).
- A saved answer reused for the same question written another way.
- Oracle's resume wait; lanes for people with autopilot off; the resolver
  looks again at a failure weekly, not daily.

- Fault fixtures in the self-test (a form that refuses after submit; an
  address that will not open); endurance keeps to the sendable forms.
- Parked postings retried only when the applying code changes.
- Audit: unconfirmed submits by page evidence; the record against itself;
  each lane's evidence added up; one-line summary at the end of the log.

## Measured at 4:50 AM, 28 Nov (owner's account)

- On record as sent 174 (was 157 at the start of the 27-28 Nov work):
  confirmed 122, probable 52; unverified 17 (held, never resent). Duplicates
  on record 3, all from before the guard was repaired; none since.
- The record against itself: 0 inconsistent rows of the 5 kinds checked.
- Ordinary rounds since lane evidence began (12 rounds, 24 lane runs):
  3 sent of 69 tried. The queue that remains is mostly what stops.
- The map's employers: 705 named, 494 looked at, 16 placed on a hiring
  system, 0 with a qualified posting yet. 318 of 500 looked at in one run
  showed no hiring system: they are small businesses with their own site,
  and are now read first by the own-site reader (jobposting.mjs).
- Qualified, not sent, 7 days: 178 of 347. Human checks 94 (one system
  67), sign-in 12, unconfirmed 13, error 9, no form 7, incomplete 3.
- Remote and open to the person: 108 qualified, 7 sent; 71 of the 101 not
  sent stopped at a human check.
- Endurance (fixtures, 10 rounds x 4 forms at once, one cut off on
  purpose): 39 of 39 went; 52 s a round first and last; memory 107 -> 108
  MB; no browser context left open.
- Measuring step: 93 s -> 24 s once unplaced postings stopped being re-read.
- Own-site reader, local employers first (5 AM run): 101 sites read in 6
  min (45 needed a browser); 2 published postings in the structured form
  search engines read; 16 postings, 16 for the person's titles, 1 in reach
  and fresh, 1 saved. Small businesses near home mostly do not publish
  their openings in a form a program can read: this source is real but thin.

## Explained since

- The Workday "never reached a form" stops: four postings of one employer
  open that employer's own careers page, 444 characters, no form, no human
  check. Retried with each change to the code; now left for the person
  after the second time (`NO_FORM_AGAIN`). Why their address leads there
  (a closed posting the page does not call closed?) is not known.

## Seen on the 2:30 AM round of 28 Nov and not yet explained

- **Workday: 12 postings ended "never reached a form"** in one round, all
  retries of postings that had earlier stopped on a question. Each lane's
  last lines now print what such a page looked like ("no form here, by
  shape", "no form; buttons on page"). Read those before touching the
  Workday path.
- **Workday "How did you hear about us?"**: the required multi-select
  (`source--source`) left at "0 items selected", twice. The lane now
  prints the picker's own trace ("source trace:").

## Open, in order (each with what it rests on)

0. **Workday "Desired hours (per week)"**, required, nothing on file: a
   question for the owner (it is on the Answers page), not to be guessed.
   **The resume PDF read back at 82% on one posting** (threshold not
   lowered; cause not known).
1. **Unconfirmed submits (17 on record; 13 from before the page's own
   evidence was kept).** The note now records what the
   page showed. After a few days: count how many showed a failed check or a
   required word. Only then decide whether "form still on screen, its own
   check failing on a required empty field" may be called not sent. It is
   never sent again from here without the owner's yes.
2. **Workday: "Are you 18 or older?" left empty (2), "How did you hear
   about us?" (2).** Seen in the stops; the cause is not. Read a Workday
   lane's log where one is retried before changing anything.
3. **Human checks: 94 of 185 stalls.** Not to be worked round. The one
   system that walls every application (67 a week) is set straight out for
   the person. Worth asking the owner: stop collecting from it?
4. **Sign-in walls: ADP 6, UKG 5.** An account exists and the password is
   not on file; a reset through the person's own mailbox is possible in
   principle and has not been built or approved.
5. **Local employers.** After the resolver has been through the map's
   employers: read `employers by how they were found` in the supply report.
   If "the map" places few on a system, the next reader to write is for
   whichever system holds most of the unplaced (ADP and UKG are read; Taleo
   21, Dayforce 14, Avature 9, Brassring 9, Jobvite 9, Paylocity 5 are not).
6. **Parked postings are retried after every commit**, whatever the commit
   changed (`requeueStaleParked`). With a deeper checkout the commit time
   of the applying code alone could be used.
7. **A model on the runner** (`LOCAL_AI_URL`) is wired and has never run:
   no model is set up there. The free model is at its limit for part of
   most rounds (resumes then "arranged without the model"). A small open
   model on the runner is free and slow; it changes what is written, so it
   waits for the owner's yes.
8. **Readers come round every 12 hours** by the owner's rule. A posting at
   an employer already being read was 48h old (median) when found. Reading
   the 40 employers with jobs in reach more often would cut that; it is a
   change to a schedule the owner set.
9. **Bare postcodes** in locations are not placed (no free offline table
   reachable from where this was built).
10. **Dependency branch** `deps-audit-fix`: rebuilt by `deps.yml`; merge
    waits for the owner.
