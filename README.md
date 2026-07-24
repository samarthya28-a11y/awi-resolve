# AWI Resolve

Autonomous AI remote IT support for Gespage / Alpha Web customers.
An agent installed on the customer's PC lets a cloud AI technician diagnose and fix
software issues — diagnostics run automatically, fixes only after the customer clicks OK.

**Full product spec:** [docs/AWI-Resolve-Spec-v1.0.md](docs/AWI-Resolve-Spec-v1.0.md)

## What's in this folder (plain English)

| Folder | What it is |
|--------|-----------|
| `agent/` | The program that will be installed on the **customer's PC**. It connects OUT to our cloud (never accepts incoming connections), and only ever executes actions from its built-in approved list. |
| `orchestrator/` | The **cloud side** — receives agent connections, manages support sessions, and (from Phase 1) hosts the AI technician. Runs locally on this PC during development. |
| `db/` | The database blueprint (tables for customers, devices, tickets, audit log). Will be loaded into Supabase when we go to the cloud. |
| `playbooks/` | Step-by-step fix knowledge the AI follows, one file per issue type. |
| `docs/` | The product spec. |

## Current status — Phase 0 (plumbing) ✅

- Agent and orchestrator talk to each other over a secure-style WebSocket handshake.
- Agent enrolls itself with a unique device identity on first run.
- Agent answers Tier-0 (read-only) diagnostic requests: system snapshot, service status.
- Agent **refuses** any request not on its allowlist — even from its own server.
  This is the core security promise of the product (spec §6/§9.1).

## How to run the Phase 0 demo (Claude does this; noted for reference)

```
npm install          (first time only)
node orchestrator/server.js       (terminal 1 — the "cloud")
node agent/agent.js               (terminal 2 — the "customer PC")
```

The orchestrator automatically runs a demo sequence when the agent connects and writes
the result to `orchestrator/data/demo-report.json`.

## Next phases (spec §11)

1. **Phase 1** — AI diagnostic loop: Claude reads a ticket, runs Tier-0 tools, produces a diagnosis.
2. **Phase 2** — Consent UI + Tier-2 fixes + chat window (tray app the customer sees).
3. **Phase 3** — Pilot with 2–3 Gespage customers.
