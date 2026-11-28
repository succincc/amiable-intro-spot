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

## Open, in order

See the end of this file: it is rewritten as work proceeds.

