# Token Governor Protocol

Read this when installing the kit, writing a handoff, or when token use is the task. Do not paste this file into every chat.

## Goal

Cut **redundant** tokens. Keep **quality** (correctness, tests, required reads).

## Model of cost

On typical hosted assistants, each turn is billed on:

1. System / tool instructions
2. The full conversation so far
3. Tool results already in history (file dumps, logs)
4. The new user message

So cost grows with **thread age**, not with how hard the latest ask is. The fix is to keep durable knowledge in files and keep chats short.

## Three memories

| Memory | Where | Lifetime | Size budget |
| --- | --- | --- | --- |
| Scratch | The current chat | One task | Keep the thread short |
| Session | `.ai/SESSION.md` | Active workstream | ≤40 lines |
| Project | `.ai/MAP.md`, `.ai/DECISIONS.md`, code, tests | Until changed | Pointers, not dumps |

If a fact will matter in the next chat, it belongs in a file. If it only mattered for a failed attempt, let it die with the thread.

## Always-on agent rules (keep under ~40 lines in AGENTS.md)

1. **One task per chat.** New feature, bug, or refactor → new chat after a handoff.
2. **Search, then targeted read.** Grep/glob before opening a file. Read a line range, not a whole tree.
3. **Do not re-read** files that have not changed in this chat.
4. **Do not paste** file contents, architecture essays, or prior transcripts into replies unless asked.
5. **Do not guess** file contents to save tokens. Read the slice you will change.
6. **Never skip** tests, types, error handling, or security checks as a token tactic.
7. **After every finished user request**, replace `.ai/HANDOFF.md` and `.ai/SESSION.md` before the final reply (append DECISIONS if needed).
8. **On “handoff” / “compact” / “new chat”:** write those files, then stop. Do not start the next task in the same thread.

## Session lifecycle

```
start → read SESSION + MAP (if present) → do one task → update SESSION
                                              ↓
                         long thread or task done → write HANDOFF → new chat
```

**Start prompt (cheap, high quality):**

```text
Read .ai/HANDOFF.md and .ai/SESSION.md. Do only the next step. Do not restate the whole project.
```

**Handoff prompt:**

```text
Write .ai/HANDOFF.md and update .ai/SESSION.md. Record goal, done, remaining, files, pitfalls, next step. Then stop.
```

## File contracts

### `.ai/SESSION.md` (≤40 lines)

- Goal (one sentence)
- Constraints (bullets)
- Current step
- Out of scope
- Link to tests or commands that prove quality

### `.ai/MAP.md` (≤80 lines)

- Where things live (paths + one-line purpose)
- How to run tests / the app
- No source dumps, no generated docs

### `.ai/DECISIONS.md`

- One bullet per decision: date, choice, why (one line)
- Append only; do not rewrite history unless the decision changed

### `.ai/HANDOFF.md` (≤60 lines)

- Goal
- Done
- Remaining (ordered)
- Files touched
- Pitfalls / failed approaches (short)
- Exact next step
- How to verify

## Modes

- **lean** (default): retrieve minimally; edit the smallest set of files.
- **deep**: investigation, incident, unfamiliar code. Broader reads allowed. Compact into HANDOFF when the picture is clear.
- **handoff**: write the memory files and stop. Do not start the next task in the same thread.

## What wastes tokens (and quality)

- One chat for the whole product
- “Here’s the entire codebase” / pasting files the agent can read
- “Continue from everything we discussed” in a long thread
- Huge always-on rules (they are billed every turn)
- A 20-page `CONTEXT.md` that is resent forever
- Saving tokens by skipping a required read, then retrying three times

## What preserves quality cheaply

- Short chats anchored on `.ai/HANDOFF.md`
- Tests as the quality signal (run them; don’t narrate the whole suite)
- Decisions written once in `.ai/DECISIONS.md`
- Asking for a diff-sized change, not a tour of the repo

## Measuring savings

Vendors do not expose a live “tokens saved” meter. Token Governor estimates the **avoided resend** of a long thread versus short chats plus `.ai` files.

```powershell
.\scripts\savings.ps1 -Turns 40 -HandoffEvery 8 -DumpTokens 50000 -Model sonnet-5
```

Optional: `-DumpPath C:\path\to\src` uses that tree as the naive dump size. Output is percent, API-equivalent USD, and INR. It is a model, not an invoice. Cursor/Claude subscriptions may bundle usage.

Prices live in `kit/prices.json` (`as_of` date). Override FX with `-UsdInr`.

## Portability

The same contracts are pointed at from:

- `AGENTS.md` (Cursor and many others)
- `CLAUDE.md` (Claude Code)
- `GEMINI.md` (Gemini CLI)
- `.github/copilot-instructions.md` (GitHub Copilot)

Tool-specific wrappers must stay **short** and **point here**. Duplicating this protocol into every adapter would raise cost on every turn.
