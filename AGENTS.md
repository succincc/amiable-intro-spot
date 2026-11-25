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
- Gmail Settings reads an authenticated metadata-only server function; refresh and access tokens never enter page responses or query caches.
- Large-employer imports run sequential authenticated batches from Settings, with database-backed progress and resumable pending rows, to avoid one unbounded server request.
- Employer retry passes use a fixed checked-at cutoff and wait for server completion, so unresolved employers are checked once per pass rather than endlessly retried.
- Discovery and scoring run as TanStack server functions (`src/lib/*.server.ts` via `engine.functions.ts`), not Supabase Edge Functions — keeps everything on one backend with no extra deploy step.
- Scoring uses Gemini only when `GEMINI_API_KEY` is set, otherwise a free local keyword scorer — the user requires zero cost.
- Applying happens only in the Chrome extension (`extension/`, packaged to `public/applypilot-extension.zip`); it signs in with the panel's email/password because RLS allows `authenticated` only. Re-zip after editing it.
- Cloud applying runs in GitHub Actions (`apply.mjs` + `.github/workflows/apply.yml`), triggered by `runApplier` via GITHUB_TOKEN/GITHUB_REPO; it signs in with the panel email/password from repo secrets because no service key exists on Lovable Cloud.
