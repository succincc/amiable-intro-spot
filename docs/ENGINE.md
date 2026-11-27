# The application engine: what it does, and where each part came from

One engine, run for each person in turn by the same START workflow
(`apply.yml` → `forusers.mjs` → `apply.mjs`). Nothing here is a separate
application, and nothing here costs anything to run.

## What it covers

| Asked of an engine | Where it lives |
|---|---|
| Forms it has not seen before | The general filler in `apply.mjs`: every control is read by its label, its kind and what it offers; answers come from the profile, the saved answers, the resume, and last the model |
| Adapters for known systems | Workday, Greenhouse, Oracle, SuccessFactors, Ashby, Lever, Eightfold and others, each as its own steps inside `apply.mjs`; readers in `oracle.mjs`, `successfactors.mjs`, `smartrecruiters.mjs`, `adp.mjs`, `ukg.mjs`, `icims.mjs` |
| More than one page | `advanceStep` walks a form screen by screen and says what stopped it |
| Fields and uploads checked | Required boxes left empty stop the application before it is sent; the resume box is read back after attaching; the PDF itself is read back as text (`quality.mjs`) |
| Resume and answers agree | The latest job is read once (`workHistory`) and every answer about it comes from that one reading; `quality.mjs` holds every figure and credential in the resume against the person's own material |
| Confirmation, and never twice | `confirm_state` on each job; `samejob.mjs` keys a job by role, employer and place |
| A queue that survives a stopped run | The queue is the `jobs` table. A job is only marked when its outcome is known, so a run that dies leaves its jobs queued |
| Failures sorted | Every stop carries a `help_reason` (`captcha`, `login`, `incomplete`, `assessment`, `email_verification`, …) and each run ends with one line per stop |
| A person only where one is needed | Human checks and sign-ins the engine may not get past go to the by-hand list; nothing else waits for anyone |
| Memory of what worked | Saved answers (`answers` table). An answer the model chose from a list is now kept there too, so the same question on the next form is answered without asking again, and is on the Answers page to correct |
| No model where none is needed | The profile, saved answers and the resume's own words are tried first, always; the model is the last resort |
| A model on the machine itself | Optional. See below |

## A local model (optional)

Set `LOCAL_AI_URL` to any server that speaks the chat-completions protocol
on the machine — for Ollama, `http://127.0.0.1:11434/v1` — and
`LOCAL_AI_MODEL` to the model's name.

- With no `GEMINI_API_KEY`, the local model is the only one asked.
- With `LOCAL_AI_FIRST=1`, it is asked first and the free outside models
  only if it gives nothing.
- Otherwise it is the first fall-back when the free allowance runs out.

GitHub's own runners have no such server, so these are read from repository
variables and are empty there. They matter on a self-hosted runner.

## What is not done, on purpose

No CAPTCHA is solved or avoided, no proxy or rented browser is used, and
nothing paid is called. A portal that will not take an application without
a person gets a person.

## Measured

The engine's own test forms (`selftest.mjs`), run against the engine as it
stood on the morning of 27 Nov 2026 and as it stands after that day's work:

| Form | Before | After |
|---|---|---|
| Framed form, emailed code | 6 fields, passes, 40s | 6 fields, passes, 40s |
| Plain form, late confirmation | 5 fields, passes, 26s | 5 fields, passes, 26s |
| Board form (one "Name" box, last employer, tick list, radios) | 1 of 6 fields, fails | 6 of 6, passes, 19s |

Rehearsals on real forms the same day, for an account whose profile is
thin (nothing was sent): Greenhouse 5 of 8 → 10 of 12 would submit; Ashby
0 of 8 → 2 of 8, the rest waiting on a LinkedIn address only the person
can supply.

## Other projects looked at

Read for how they approach the same problems. No code is copied from any
of them.

| Project | Licence | Use made of it |
|---|---|---|
| nturl/openapply | MIT | Read in source. Its duplicate check by company and similar title is what `samejob.mjs` already does; nothing to take |
| Partth101/jobrollo | MIT | Read; smaller than this engine in every part compared |
| Liam-Frost/AutoApply | PolyForm Noncommercial | Not used: the licence does not allow use in a product others use |
| Py528/stagehand-local | none stated | Not used: no licence, no right to reuse |
| TheCromazone/Personal-JobPilot | — | Could not be read (private or gone) |
| microsoft/playwright | Apache-2.0 | Already the browser layer, as a dependency |
| browserbase/stagehand, Skyvern-AI/skyvern, browser-use/browser-use | MIT / AGPL-3.0 / MIT | Not adopted. Each drives the page by asking a model at every step; this engine reads the page itself and asks a model last, which is cheaper, repeatable, and does not stop when a free allowance does. Skyvern's licence would also bind this whole codebase |
| ollama/ollama | MIT | Not bundled. Its server is what `LOCAL_AI_URL` can point at |

See also the header of `quality.mjs` for the document checks and their
sources.
