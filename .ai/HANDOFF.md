# Handoff

Same workstream as `AWI Resolve V2\.ai\HANDOFF.md`. This repo is the product.

## Goal

Windows agent + Fly connector. Current thread: customer-managed knowledge,
console access, and security visibility over both.

## Done (2026-08-22, all on `main`, all pushed)

- `0cddf4c` Co-branding, `/licence` window, daily renewal reminder
- `cbf0493` Cost-per-ticket margin analysis in `performance.js`
- `c0f9adf` Customer documentation console (`/admin/knowledge`, `org-kb.js`)
- `2bb0b6d` Console sign-in; token no longer travels in the URL
- `7fd050c` Rotate access token from the console
- `c14d8f9` Audit trail capped + readable (`audit-log.js`, `/api/admin/audit`)
- `4b47da1` Recent-activity card + alert on bursts of refused sign-ins
- `15d95a4` Licence manager wording — the pass is fully loaded, its days are a
  redemption window, and activation is in-app (text only, no deploy needed)

**Connector deployed: v23 = `4b47da1`.** Setup zip published as **v1.3**.

## Remaining (ordered)

1. 24-Hour Pass pilot; durable ticket storage; code-sign the installer.
   Mac agent remains a non-goal.

No half-shipped work: every feature has both its connector and its website
half live, and `main` matches the deployed connector image.

## Pitfalls / failed approaches

- **`flyctl deploy` ships the WORKING TREE, not HEAD.** Deploy from a clean
  `git worktree` at `main`, or you ship someone's uncommitted WIP.
- `readJsonBody` caps at 2 MB deliberately; uploads use `readLargeJsonBody`.
- `loadAdminTokens()` lets `RESOLVE_CUSTOMER_ADMIN_TOKENS` win over the file, so
  rotation refuses for a pinned org rather than silently doing nothing.
- `orgLibrary.slugify('')` returns the literal `org`, a fallback bucket — check
  raw input before slugifying when it matters.
- Only extracted TEXT of a manual is stored. The 1 GB volume also holds
  `ledger.json`; filling it breaks billing, not logging.
- Console pages are unauthenticated by design (empty shells); the APIs are not.
- `audit()` must never throw — serialisation is inside its `try`.
- Do not casually rotate `alpha-web`'s token; it is in daily use. Tokens are
  never written into these files — mint one with the command below.

## Next step

Nothing queued. The next real decision is the 24-Hour Pass pilot, which needs a
customer rather than code.

## Verify

```text
for t in access-alerts audit admin-token org-kb licence-details performance customer-spend; do
  RESOLVE_DATA_DIR=<scratch> node tools/test-$t.js; done
curl https://awi-resolve-connector.fly.dev/health
# Mint / re-read an org console token (needs the Fly dashboard secret):
curl -X POST "https://awi-resolve-connector.fly.dev/api/admin/bootstrap-token?token=$RESOLVE_DASHBOARD_TOKEN" \
  -H "Content-Type: application/json" -d '{"customerId":"alpha-web"}'
```
