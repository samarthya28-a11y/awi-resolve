# Map

Pointers only. Keep ≤80 lines.

## Layout

| Path | Purpose |
| --- | --- |
| `agent/ui/index.html` | Support window; co-branding; Licence button; renewal banner |
| `agent/ui/licence.html` | Licence details window (holder, validity, renew) |
| `agent/agent.js` | Logo serving, brand cache, once-a-day reminder |
| `orchestrator/server.js` | Connector; routes; `licenceSummary`; tool dispatch |
| `orchestrator/licensing.js` | Verify licence + `identity()` fields |
| `orchestrator/licence-issue.js` | Signing, shared by CLI and the admin API |
| `orchestrator/org-kb.js` | Customer-uploaded documentation (volume-backed) |
| `orchestrator/kb.js` | Shipped knowledge base; exports the shared tokenizer |
| `orchestrator/org-library.js` | Approved software + per-org admin tokens |
| `orchestrator/audit-log.js` | Audit append, rolling, and scoped reads |
| `orchestrator/alerts.js` | Alpha Web notifications incl. refused-sign-in bursts |
| `orchestrator/performance.js` | Fleet + per-customer commercials |
| `orchestrator/ui/org-knowledge.html` | Customer console: docs, activity, rotate |
| `orchestrator/ui/org-software.html` | Approved software library console |
| `orchestrator/ui/console.html` | Usage console |
| `packaging/build.ps1` | Builds `dist\AWI-Resolve` |
| `packaging/make-generic-package.ps1` | `AWI-Resolve-Setup.zip` (needs the secret) |
| `tools/licgen.js`, `Create-License.cmd` | Issue `RSLIC1-…` keys |
| `fly.toml`, `Dockerfile` | `awi-resolve-connector`, volume at `/data` |

## Customer-facing URLs (all on the connector)

| Path | Who | Auth |
| --- | --- | --- |
| `/admin/knowledge` | IT admin — upload manuals, activity, rotate token | org id + token |
| `/admin/software` | IT admin — approved software | same token |
| `/console` | Usage + monthly limits | same token |
| `/api/admin/audit` | That org's events, newest first | same token |

## Runtime state (on the Fly volume, `/data`)

`ledger.json`, `admin-tokens.json`, `devices.json`, `audit.jsonl` (+ rolled
generations), `org-libraries/`, `org-kb/<customerId>/`, `reports/`.

## Run / test

```text
node orchestrator/server.js      # connector
node agent/agent.js              # agent → http://127.0.0.1:8790
RESOLVE_DATA_DIR=<scratch> node tools/test-<suite>.js
```

## Where to look first

- Next action → `.ai/HANDOFF.md`
- Spec → `docs/AWI-Resolve-Spec-v1.0.md`
- Fly → `docs/DEPLOY.md`
