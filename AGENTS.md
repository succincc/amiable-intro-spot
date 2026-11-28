<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## Architecture
- Workspace reset uses fixed user-scoped SQL after owner and target checks; elevated reset access must never execute assembled commands.
- Gmail Settings reads an authenticated metadata-only server function; refresh and access tokens never enter page responses or query caches.
- Large-employer imports run sequential authenticated batches from Settings, with database-backed progress and resumable pending rows, to avoid one unbounded server request.
- Employer retry passes use a fixed checked-at cutoff and wait for server completion, so unresolved employers are checked once per pass rather than endlessly retried.
- Discovery and scoring run as TanStack server functions (`src/lib/*.server.ts` via `engine.functions.ts`), not Supabase Edge Functions — keeps everything on one backend with no extra deploy step.
- Scoring uses Gemini only when `GEMINI_API_KEY` is set, otherwise a free local keyword scorer — the user requires zero cost.
- Applying happens only in the Chrome extension (`extension/`, packaged to `public/applypilot-extension.zip`); it signs in with the panel's email/password because RLS allows `authenticated` only. Re-zip after editing it.
- Cloud applying runs in GitHub Actions (`apply.mjs` + `.github/workflows/apply.yml`), triggered by `runApplier` via GITHUB_TOKEN/GITHUB_REPO; it signs in with the panel email/password from repo secrets because no service key exists on Lovable Cloud.
- LinkedIn, Indeed, and ZipRecruiter integrations live in `major-boards-selectors.mjs`, `major-boards-engine.mjs`, and `major-boards.mjs` (wired into `apply.mjs`, `watch.yml`, `apply.yml`, Settings, and Chrome extension cookie sync) so they reuse existing per-user `site_accounts` RLS, zero-cost AI/answer pipelines, and direct employer ATS delegation.

## Who owns what
The owner sets direction. Lovable hosts the app and owns the interface. The engine is built and kept by the engineer working from the repository. Each side leaves the other's files as they are, and asks the owner where a change needs both.

**Interface (Lovable):** `src/routes/**` pages and layout, `src/components/**`, styles, copy, navigation.

**Engine (do not rewrite from the editor):**
- every `*.mjs` at the repository root, and `.github/workflows/**`
- `extension/**` and `public/applypilot-extension.zip` (built from it)
- `src/lib/*.server.ts`, `src/lib/engine.functions.ts`, `src/routes/api/public/**`
- `supabase/migrations/**` — a new table or column the interface needs is added in a new migration, never by editing an old one

**What the interface can rely on:** the `jobs` table's `status` (`new`, `review`, `queued`, `applying`, `applied`, `needs_help`, `interview`, `offer`, `rejected`, `skipped`, `failed`), `help_reason`, `skip_reason`, `last_error`, `ats`, `score`, `distance_miles`, `applied_at`; `runs` for discovery and scoring rounds; `email_sync` for the mailbox; `profile`, `search_config`, `answers`, `user_keys` for settings. Every person-owned table is scoped by `user_id` under row-level security; a page reads only its own person's rows.

**`help_reason` values a page may show:** `captcha` (the portal asks for a human check), `login` (the portal takes applications only signed in), `incomplete` (a required question has no answer on file), `email_verification`, `assessment`, `unconfirmed` (sent, no confirmation seen), `error`, `no_form`, `dry_run`, `private_detail`; `interrupted` (the run working on it stopped before it finished — whether the application was sent is not known, so it is shown to the person and never sent again from here).

**Publishing:** a migration is applied only when the owner's publish request names it.

## This repository is public
Its files, and the log of every run, can be read by anybody.

- Nothing that says who the owner is or where they live goes in a file: no town in a comment or an example list, no list of employers near somebody. Places a script needs come from the person's own profile at run time.
- Every script that prints imports `quiet.mjs`, and `forusers.mjs` starts each job with it already in place. What is printed is reduced to words this program's own source uses; anything else — a name, an employer, a town, a code, a key — is struck out before it is written. A value that must never be printed is handed to `secret()`.
- A workflow never prints an answer from outside as it came (`cat` or `head` of a response file): it is piped through `safe`, which is `node quiet.mjs`.
- `unit.mjs` fails the build when a script or a workflow goes round any of this, and its checks try to leak a made-up person by every way of printing.
- The database answers a thousand rows at most per request, whatever `limit` asks for: a list that can be longer is read with `allRows()` from `pages.mjs`.
