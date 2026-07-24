# AWI Resolve — Autonomous Remote IT Support
## Product Specification v1.0 (red-teamed)

**Owner:** Alpha Web Initiative (alphawebin.com)
**Date:** 2026-07-24
**Status:** Draft for review → build
**Sibling specs:** AWI Sentinel v1.1, AWI IntelliScan

---

## 1. One-line pitch

An agent installed on the customer's PC lets an AI technician diagnose and fix software
issues end-to-end — no human IT support on either side. Diagnostics run automatically;
fixes run after a one-click plain-language consent from the customer.

## 2. Why us, why now

- **Existing wedge:** Alpha Web already supports Gespage (Cartadis) print-management
  customers and has a RAG knowledge base (Gespage AI support on alphawebin.com).
  Print + Windows issues are a narrow, repetitive, well-understood problem space —
  ideal for automation.
- **Proven pattern in-house:** the PrintDiyo print agent (Node service on a customer
  machine, talking to our cloud) is the same architecture at smaller scope.
- **Market:** NinjaOne / Atera / Fixify are adding AI as an assist for human techs.
  Our differentiator is *no human in the loop for tier-1*, verticalized playbooks,
  and India pricing.

**First market:** Gespage / Alpha Web customers (decided 2026-07-24).
**Autonomy level v1:** customer-consent-gated fixes; free-running diagnostics (decided 2026-07-24).

## 3. Explicit non-goals (v1)

- No screen/pixel remote control (no VNC/RDP/screenshot-driven control). Command-level only.
- No macOS/Linux agents (Windows 10/11 only).
- No hardware diagnostics beyond what software can read (SMART, driver state).
- No unattended fleet-wide actions (each session is one machine, one ticket).
- No password resets, account recovery, or identity operations — ever (see §8).

## 4. Problem taxonomy (launch playbooks)

Tier-1 issues the AI must fully resolve at launch, drawn from Gespage support history:

| # | Playbook | Typical root causes |
|---|----------|--------------------|
| 1 | Print job stuck / queue frozen | spooler hung, corrupt job, port offline |
| 2 | Printer offline / not found | IP change, driver, WSD vs TCP port, firewall |
| 3 | Gespage client not starting | service down, Java runtime, config corruption |
| 4 | Gespage authentication failures | server URL change, certificate, AD sync |
| 5 | Slow printing / wrong output | driver mismatch, spooler settings, PCL/PS confusion |
| 6 | App won't start (general) | missing dependency, corrupt profile, pending update |
| 7 | Disk full / PC very slow | temp bloat, startup apps, Windows Update leftovers |
| 8 | Windows Update stuck/failing | component store, service state, disk space |
| 9 | Network drive / share unreachable | credentials cache, DNS, SMB config |
| 10 | Certificate / date-time errors | clock skew, expired root store |

Each playbook = diagnostic decision tree + allowlisted fix set + verification step,
stored as versioned markdown in the knowledge base (RAG-retrievable).

## 5. Architecture

```
CUSTOMER PC                                 ALPHA WEB CLOUD
┌───────────────────────────┐              ┌──────────────────────────────┐
│ Resolve Agent (tray app)  │              │ Orchestrator (Node/TS)       │
│ ├ Chat UI (ticket intake) │◄───wss/TLS──►│ ├ Session manager            │
│ ├ Consent prompt UI       │   (outbound  │ ├ AI engine (Claude Agent    │
│ ├ Tool executor (service) │    only)     │ │  SDK, server-side loop)    │
│ ├ Local audit recorder    │              │ ├ Policy engine (allowlist,  │
│ └ Kill switch / pause     │              │ │  risk tiers, rate limits)  │
└───────────────────────────┘              │ ├ Playbook KB (RAG, reuses   │
                                           │ │  Gespage support corpus)   │
                                           │ └ Supabase (auth, tickets,   │
                                           │    audit, telemetry)         │
                                           └──────────────┬───────────────┘
                                           ┌──────────────┴───────────────┐
                                           │ Ops Dashboard (Next.js)      │
                                           │ live sessions · audit replay │
                                           │ escalation queue · metrics   │
                                           └──────────────────────────────┘
```

### 5.1 Resolve Agent (customer side)

- **Stack:** Node.js service (tool executor, runs as LocalSystem with constrained
  command surface) + Electron tray app (chat, consent prompts). Reuse PrintDiyo
  agent scaffolding.
- **Connectivity:** outbound-only WebSocket over TLS to the orchestrator. No inbound
  ports, no NAT traversal needed, works behind corporate firewalls.
- **Identity:** per-install device key (generated at enrollment, stored in DPAPI),
  enrolled against a customer account. Every session additionally uses a short-lived
  session token minted when the customer opens a ticket.
- **The agent never receives free-form shell commands.** It receives `{tool_id, params}`
  messages, validates them against its *locally compiled* allowlist (defense in depth —
  the cloud policy engine is not the only gate), executes, returns structured output.
- **Kill switch:** tray menu "Pause support session" instantly severs the session;
  uninstall is standard Add/Remove Programs.
- **Updates:** signed packages only (code-signing cert); agent verifies signature
  before applying. Staged rollout (canary → fleet).

### 5.2 AI engine (cloud side)

- **Claude Agent SDK** running the loop server-side per ticket:
  1. Read ticket text (+ machine snapshot the agent sends at session start: OS build,
     installed printers, Gespage client version, disk free, recent event-log errors).
  2. Retrieve matching playbook(s) from KB.
  3. Diagnostic loop: call read-only tools freely, form hypothesis.
  4. Propose fix: policy engine checks tier → if Tier-2, customer sees consent prompt.
  5. Apply, verify (re-run the failing check), close or iterate.
  6. After N=8 fix attempts or low confidence → escalate (§10).
- **Model routing:** Haiku-class for triage/classification, Sonnet-class for the main
  loop; escalate model tier only when the loop stalls. Keeps per-ticket cost low.
- **Tool outputs are data, not instructions** (prompt-injection defense, §9.3).

### 5.3 Backend

- Supabase: `customers`, `devices`, `tickets`, `sessions`, `actions` (audit),
  `consents`, `playbooks`, `escalations`. RLS by customer org.
- Orchestrator on the existing Vercel/hosting account; WebSocket server on a small
  VPS or Fly.io (Vercel doesn't hold long-lived sockets well).

## 6. Tool allowlist (v1)

Three tiers. Tier-0 runs silently; Tier-2 requires customer consent per action
(plain-language prompt, 60-second timeout → treated as declined); Tier-X does not exist
in the codebase at all.

**Tier-0 — read-only diagnostics (no prompt)**

| Tool | Implementation notes |
|------|---------------------|
| get_system_snapshot | OS, uptime, disk, memory, pending reboots |
| list_printers / printer_status | Win32_Printer + PrintUI |
| get_print_queue | jobs, states, owner shown as hash not name |
| read_service_status | named services from a fixed list |
| read_event_log | System/Application, filtered, last 24h, size-capped |
| read_app_log | Gespage client logs, spooler logs — fixed paths only |
| test_network | ping/traceroute/DNS to printer IPs + Gespage server |
| read_config | Gespage client config, printer port config (secrets redacted by agent before send) |
| check_disk_space / list_temp_usage | sizes only, no file contents |
| get_installed_version | specific apps from a fixed list |

**Tier-1 — low-risk fixes (no prompt, but shown in session log in real time)**

| Tool | Notes |
|------|-------|
| clear_dns_cache | ipconfig /flushdns |
| refresh_group_policy | gpupdate (no /force) |
| reconnect_network_drive | re-map with cached credentials (never prompts for creds) |

**Tier-2 — state-changing fixes (customer consent required, one prompt per action)**

| Tool | Consent prompt example |
|------|------------------------|
| restart_service | "Restart the print spooler? Queued jobs will be cancelled." |
| clear_print_queue | "Delete the 3 stuck print jobs?" |
| set_printer_port | "Point 'HP LaserJet' at its new address 192.168.1.44?" |
| reinstall_driver | "Reinstall the printer driver? Takes ~2 minutes." |
| repair_app | msiexec repair for allowlisted product codes only |
| clean_temp_files | Windows temp + update cache only, shows MB to be freed |
| reset_windows_update | stop svc, rename SoftwareDistribution, restart |
| set_time_sync | w32tm resync |
| restart_machine | always last resort, always consented, warns about open work |
| update_gespage_client | signed installer from our CDN only |

**Tier-X — structurally impossible (not implemented in the agent binary)**

Free-form shell/PowerShell execution · reading/writing user documents · browser data,
credential stores, password ops · disabling AV/firewall/Defender · registry writes
outside 4 named key paths · installing software outside the signed-installer list ·
outbound uploads of any file content other than the fixed log paths · anything
touching other machines on the network.

Adding a tool = code change + spec update + red-team review. Never config-only.

## 7. Consent & UX model

- **Enrollment (once):** customer admin installs agent, signs in with their Alpha Web
  customer account, accepts the support terms (explicit: "allows Alpha Web's automated
  technician to run the diagnostics and repairs listed here on this machine").
- **Per ticket:** customer opens tray chat, describes issue. Session banner shows
  "AI technician connected — everything it does is listed below" with a live action feed.
- **Per Tier-2 action:** native prompt, plain language, Accept/Decline. Three declines
  or a timeout → AI wraps up and escalates rather than nagging.
- **Consent fatigue mitigation:** AI batches where honest ("I need to restart the
  spooler and clear the queue — one approval covers both"), but a batch is max 3
  actions and is itemized in the prompt.
- **Transparency artifact:** on close, customer gets a summary in chat: what was
  wrong, what was done, what to do if it recurs. Same summary is emailed.

## 8. Hard product lines (policy, not just code)

1. Never handle credentials: no password entry, no reset, no MFA interaction. If an
   issue needs credentials (e.g., network drive with expired password), the AI
   instructs the *customer* to type them into the Windows dialog and waits.
2. Never read user-created files (documents, mail, browser). Log paths are a fixed
   compiled-in list.
3. Never operate when the consent UI can't render (locked session, RDP disconnected).
4. Data residency: audit logs and telemetry in the Supabase region; log excerpts sent
   to the model are minimized and PII-scrubbed by the agent (usernames → hashes)
   before leaving the machine. DPDP Act 2023 basis: contract performance; retention
   90 days for session transcripts, 1 year for audit metadata.

## 9. Red-team findings & mitigations

### 9.1 "You are shipping a C2 backdoor" (the big one)
The agent is remote-execution infrastructure; if our cloud is compromised, every
customer machine is reachable. Mitigations:
- No free-form execution anywhere in the pipeline (Tier-X list is compiled out).
- Agent-side allowlist validation — a compromised orchestrator still can't exceed the
  tool surface; worst case is malicious use of legitimate tools, which is bounded
  (restart services, clear queues) and fully audited.
- Commands are signed by the orchestrator's key; agent pins the cert. Session tokens
  are single-ticket, 30-min expiry.
- Rate limits agent-side: max actions/minute, max Tier-2/session.
- Update packages signed with an offline key (separate from server keys).
- Kill switch cloud-side (suspend all sessions) and customer-side (tray pause).

### 9.2 Malicious customer / abuse of the AI
Customer tries to social-engineer the AI ("run this command for me", "read that file").
The AI *cannot* comply — the tools don't exist (Tier-X). Prompts requesting them get a
scripted refusal + optional human escalation. Ticket text is treated as untrusted.

### 9.3 Prompt injection via machine data
Log lines, filenames, printer names could contain adversarial text ("ignore previous
instructions…"). Mitigations: tool results wrapped in delimited data blocks with a
standing system-prompt rule that content inside them is never instructions; the policy
engine (deterministic code, not the model) is the actual gate on every action — the
model can *request* only allowlisted tools, so a fully hijacked model still can't
exceed §6. Consent prompts are template-generated from `{tool_id, params}`, not
model-written, so injection can't forge what the customer sees.

### 9.4 Wrong fix / destructive mistake
Clearing a queue kills a payroll print job; a restart loses unsaved work. Mitigations:
consent prompts state consequences explicitly; restart_machine warns and requires
typed "RESTART" in v1; verification step after every fix; per-playbook blast-radius
notes the model must surface. Insurance: session replay proves exactly what happened.

### 9.5 Availability / trust failures
- Agent offline → ticket falls back to the existing web-based Gespage AI support.
- Model outage → queue tickets + notify, never degrade to weaker safety.
- False "fixed" claims → ticket auto-reopens if customer replies within 48h;
  reopen rate is a first-class metric (§12).

### 9.6 Supply chain
Electron/Node dependency risk in a binary customers install. Lockfile + `npm audit`
in CI, dependency review on update, minimal dependency budget for the service
process (the executor should be near-stdlib), SBOM published per release.

## 10. Escalation (no human ≠ no safety net)

When the AI gives up (N attempts, low confidence, customer declines, out-of-scope):
1. Generates a structured handoff: symptoms, diagnostics run, hypotheses ruled out,
   suggested next steps — the same quality bar as the Cartadis escalation drafts in
   Gespage AI support.
2. Files to the escalation queue on the ops dashboard; email to Alpha Web support.
3. For Gespage product bugs: drafts the Cartadis escalation for human approval
   (existing flow, reused).
Human resolution gets written back as a candidate playbook amendment (human-reviewed
before entering the KB) — the flywheel that grows autonomous coverage.

## 11. MVP scope & phases

**Phase 0 — spec sign-off + skeleton (this week)**
Repo `Projects\awi-resolve` (agent/, orchestrator/, dashboard/, playbooks/).
Supabase schema. Agent↔orchestrator handshake with device enrollment.

**Phase 1 — diagnostic loop (week 1–2)**
Tier-0 tools end-to-end. Claude Agent SDK loop produces a correct diagnosis + written
fix instructions (no execution yet) for playbooks 1–5 on a test machine. Audit log +
session replay in dashboard.

**Phase 2 — consented fixes (week 2–3)**
Tier-1/2 tools, consent UI, policy engine, verification steps. Playbooks 1–7 fully
autonomous on test machines (incl. a deliberately broken spooler VM).

**Phase 3 — pilot (week 4+)**
2–3 friendly Gespage customers, 10–20 machines. Success gate to go wider: ≥60%
tickets closed with zero human touch, zero Tier-X attempts, reopen rate <10%.

**Deferred:** screen-share assist mode, macOS agent, fleet health monitoring
(preventive fixes), MSP white-label, multi-language chat (Hindi first).

## 12. Metrics

- **Autonomous resolution rate** (closed with no human) — north star; target 60% pilot, 80% at 6 months.
- Reopen rate <10% · median time-to-resolution <10 min · consent-decline rate (UX
  signal) · escalation quality score (human-rated) · AI cost per ticket (target <₹30).

## 13. Pricing sketch

- Per-device/month: ₹149–299 for Gespage customers (bundled discount with support
  contracts); or per-incident ₹199 for non-subscribers.
- Anchor against human tier-1 cost (₹300–600/incident loaded) — priced as "always-on
  IT staff", not "software".

## 14. Open questions for v1.1

1. Company vehicle: Alpha Web product line (like Gespage AI support) vs separate entity?
2. Does the Cartadis relationship allow bundling this with Gespage contracts, and can
   Cartadis become a distribution channel (their other resellers)?
3. Windows-service hardening review: run executor as LocalSystem vs a custom
   virtual service account with narrower rights (leaning: custom account, elevate
   per-tool only where needed).
4. Liability wording in support terms — get the draft reviewed before pilot.
5. Offline/air-gapped customer sites (some Gespage installs): out of scope or
   store-and-forward diagnostics?

---
*v1.0 — drafted 2026-07-24 with Claude. Review §9 before any code; adding any tool
to §6 requires a spec bump.*
