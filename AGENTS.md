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

**`help_reason` values a page may show:** `captcha` (the portal asks for a human check), `login` (the portal takes applications only signed in), `incomplete` (a required question has no answer on file), `email_verification`, `assessment`, `unconfirmed` (sent, no confirmation seen), `error`, `no_form`, `dry_run`, `private_detail`.

**Publishing:** a migration is applied only when the owner's publish request names it.
