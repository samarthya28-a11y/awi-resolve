---
name: token-governor
description: Regulates AI token use with short chats, .ai file memory, targeted reads, and handoffs. Use when the user mentions tokens, context, compact, handoff, new chat, session memory, or when wrapping up a long thread without losing quality.
---

# Token Governor

Move durable knowledge into `.ai/` files. Keep the chat as scratch space. Do not lower quality to save tokens.

## When this skill applies

- User asks to compact, handoff, start a new chat, or cut token use
- A thread is long enough that follow-ups will be expensive
- Installing or updating Token Governor in a project

## Quality (non-negotiable)

- Do not skip tests, types, error handling, or reading a file you will edit
- Do not guess code to save tokens
- Compact **history**, not **correctness**

## Handoff workflow

When the user wants a handoff, compact, or new chat:

1. Write or replace `.ai/HANDOFF.md` using the contract below (≤60 lines).
2. Refresh `.ai/SESSION.md` (≤40 lines): goal, constraints, current step, out of scope, verify command.
3. Append new decisions to `.ai/DECISIONS.md` (one line each). Update `.ai/MAP.md` only if layout/commands changed.
4. Reply with 3–6 lines: what was written, the exact next-chat prompt, then **stop**. Do not start the next task in this thread.

### HANDOFF.md contract

- Goal
- Done
- Remaining (ordered)
- Files touched
- Pitfalls / failed approaches (short)
- Next step (one concrete action)
- Verify (command or test)

### Next-chat prompt to give the user

```text
Read .ai/HANDOFF.md and .ai/SESSION.md. Do only the next step. Do not restate the whole project.
```

## Lean work (default)

1. If `.ai/HANDOFF.md` or `.ai/SESSION.md` exists, read them before exploring.
2. Search (grep/glob) before opening files. Read line ranges, not trees.
3. Do not re-read unchanged files. Do not paste file contents unasked.
4. One task per chat.

## Deep work

Broader reads are allowed for incidents or unfamiliar code. When the picture is clear, run the handoff workflow.

## Savings report

When the user asks how much this saves (tokens, percent, dollars, rupees), run from the Token Governor repo:

```powershell
.\scripts\savings.ps1 -Turns 40 -HandoffEvery 8 -DumpTokens 50000 -Model sonnet-5
```

If they name a source tree, add `-DumpPath` so the naive dump size is real. Reply with percent saved plus API-equivalent USD and INR. State clearly that it is a model of resend-cost, not a Cursor/Claude invoice.

## Installing the kit

If the user wants this in another repo, run from the Token Governor project:

```powershell
.\scripts\install.ps1 -Target "C:\path\to\project"
```

Do not duplicate `PROTOCOL.md` into always-on agent files. Always-on text must stay tiny.
