# Playbook 01 — Print job stuck / queue frozen

**Version:** 1 · **Tier-2 tools referenced:** restart_service, clear_print_queue (Phase 2)

## Symptoms the customer reports
"My print isn't coming out" · "documents stuck in queue" · "printer says printing but nothing happens"

## Diagnostic sequence (Tier-0, no consent needed)
1. `get_system_snapshot` — check the target printer exists and its status field.
2. `read_service_status {service: "Spooler"}` — is the Print Spooler running?
3. `get_print_queue` *(Phase 1 tool)* — how many jobs, oldest job age, any in Error state.

## Root causes → fixes
| Finding | Fix (consent prompt shown to customer) |
|---------|----------------------------------------|
| Spooler stopped/hung | `restart_service Spooler` — "Restart the print system? Queued jobs will need re-printing." |
| Job in Error state blocking queue | `clear_print_queue` — "Delete the N stuck jobs so new prints can go through?" |
| Printer offline / port unreachable | Go to Playbook 02 (printer offline). |
| Spooler fine, queue empty, still no output | Physical/hardware suspicion → escalate with findings. |

## Verification
Re-check spooler status = Running AND queue drains (job count reaches 0 within 60s of a
test print). Only then tell the customer it's fixed.

## Blast-radius notes (AI must mention in consent prompt)
- Restarting the spooler cancels ALL queued jobs for ALL printers on this PC.
- Never restart the spooler on a print SERVER (many users affected) — that's out of
  scope for v1; escalate instead. Detect: >5 shared printers on the machine.

## Escalate when
Two fix rounds don't restore printing, or the machine looks like a print server.
