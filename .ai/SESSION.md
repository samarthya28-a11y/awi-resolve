# Session

- **Goal:** Security visibility over the customer consoles — an org can see its
  own activity, and a run of refused sign-ins reaches us.
- **Constraints:** Deploy only from a clean worktree (`flyctl` ships the working
  tree). Never write a live token into `.ai/`. Refresh `.ai/` after every request.
- **Current step:** Done. Connector **v23**; `main` `15d95a4` (wording fix is
  text-only, no redeploy). alphawebin PRs #12 and #13 merged and green.
- **Out of scope:** Mac agent; durable ticket storage; code-signing.
- **Verify:** seven suites under `tools/test-*.js` (see HANDOFF); `/health`;
  sign in at `/admin/knowledge` and confirm Recent activity lists events.

Keep this file ≤40 lines. Replace stale lines; do not append a diary.
