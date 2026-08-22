# Invention Brief — AWI Resolve  
**Autonomous, consent-gated IT support agent with dual-gated privileged execution and pinned software deployment**

**Prepared for:** patent counsel (intake only — not a patent application)  
**Applicant (indicative):** Alpha Web Innovations Private Limited  
**Product:** AWI Resolve (on-device Windows agent + orchestrator)  
**Date:** 17 August 2026  
**Status:** Confidential — for attorney review  

---

## 1. Problem

Organisations want AI-driven IT support on end-user PCs, but existing approaches fail one or more safety requirements:

1. **Unsupervised shell / RMM** can change the machine without the end user seeing the exact action.  
2. **Chatbots** guide users but cannot safely apply fixes or install software with auditability.  
3. **“Attach an installer / URL”** workflows let end users smuggle unvetted binaries into automated install paths.  
4. **Privileged AI modes** (free-form PowerShell) are either always on (too risky) or absent (too weak), with no organisational second gate.  
5. **Customer-supplied manuals** either never reach the model mid-session, or are treated as instructions that could jailbreak the agent.

Needed: a system that *does* diagnose and fix, *can* deploy software, and *can* run broader commands when authorised — without letting end-user attachments or a single licence flag become a security bypass.

---

## 2. Technical solution (summary)

AWI Resolve runs a local Windows agent (diagnostics, consent UI, install/execution) and a support orchestrator (AI planner, catalogues, licensing, session state).

**Core mechanism — layered authority for change:**

| Layer | What it controls |
|--------|------------------|
| **A. Tool allowlist** | Default plans only invoke vetted tools (diagnostics + named fixes). No free-form shell. |
| **B. End-user consent** | Any non-trivial change (service restart, deploy, PowerShell) shows **exact** action/command; decline/timeout escalates. |
| **C. Global + org software catalogues** | Auto-install only via `productId` → pinned HTTPS URL + SHA-256 (and optional settings). End-user chat attachments **cannot** supply install URLs or unlock catalogue installs. |
| **D. Dual-gated Full IT Support** | `run_powershell` (and off-catalogue official installs via it) require **both** a Full licence capability **and** an org-admin “allow Full IT Support” toggle. Exact command is shown for Yes/No; runtime/output capped; illegitimate asks refused in policy. |
| **E. Untrusted document channel** | Customer PDFs/screenshots are queued per device, injected into the **same** conversation (including follow-ups) as marked untrusted reference data — usable for guidance, not as install authority. |

Session outputs include a structured report (what was checked, changed, declined, not done) for handoff.

---

## 3. Claims-style bullets (for counsel — illustrative, not formal claims)

1. A method of autonomous endpoint IT support comprising: performing read-only diagnostics via an on-device agent; proposing machine-changing actions only through a fixed tool interface; and gating each such action on explicit end-user consent that displays the precise action or command text.  

2. The method of (1), wherein software installation is permitted only by resolving a catalogue or organisation-library product identifier to a server-side pinned download location and cryptographic checksum, and wherein content attached by the end user in chat is excluded from supplying install locations or product identifiers for automatic installation.  

3. The method of (1)–(2), further comprising enabling a privileged execution tool (e.g. arbitrary PowerShell) only when both (i) a licence/capability flag for full support and (ii) an organisation-administrator policy flag are asserted, and presenting the exact command string for consent before execution under resource caps.  

4. The method of (3), wherein after catalogue and organisation-library checks fail to match a user-requested product, the privileged tool may install from a vendor official HTTPS source or package manager, subject to the dual gate and consent of (3).  

5. A system comprising an on-device agent and an orchestrator that maintain per-device pending attachments; extract text from uploaded documents; and inject those attachments into an ongoing multi-turn support session as delimited untrusted reference data without treating them as executable instructions or install authorisations.  

6. The system of (1)–(5), further generating a session record enumerating diagnostics performed, actions applied, actions declined or timed out, and items explicitly not done, for human escalation.  

7. A computer-readable medium storing instructions that, when executed, cause a computing system to perform any of (1)–(6).

---

## 4. Embodiments / implementation notes (non-limiting)

- Windows 10/11 agent UI with paperclip, clipboard paste, and drag-and-drop for images/docs.  
- Org software library: admin-stored manual text + HTTPS link + SHA-256; deploy tool accepts only `productId`.  
- Licensing plans (e.g. trial / standard / pro / full / time-bounded pass) map to capability sets including `fullSupport`.  
- Orchestrator refuses off-allowlist tools at the agent; safety probe can verify refusal.  

---

## 5. Prior art to search (suggested)

AI IT helpdesks; RMM with script approval; Intune/winget automation; “human-in-the-loop” LLM tool use; software catalogues with hash verification; DLP/untrusted document wrapping for LLMs.

---

## 6. Inventorship / filing notes for counsel

- Confirm inventors (engineering contributors to layers C–E and dual gate).  
- Check public disclosures (website, trials, GitHub) vs novelty deadlines (India / PCT).  
- Consider provisional + later PCT; parallel trademark for “AWI Resolve”.  
- Preserve unpublished implementation details as trade secret where not claimed.

---

*End of one-page brief. Expand into formal specification only under attorney direction.*
