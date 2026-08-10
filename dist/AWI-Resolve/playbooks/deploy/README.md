# Deployment manuals (Level 1 — guided deployment)

Each `.md` file here is a deployment manual for one piece of software. When a
customer asks the AI to install / set up / deploy that software, the AI reads the
matching manual, checks the customer's PC (read-only), and produces clear,
tailored, numbered steps for a person to follow. **In Level 1 the AI only
guides — it does not run the installation itself.**

## How to add a manual

1. Copy `_template.md` to a new file, e.g. `gespage-client.md`.
2. Fill in the header and the steps (paste in the official vendor manual / your SOP).
3. Save. It's picked up automatically the next time the connector starts.

## File format

A short header (between the `---` lines), then the manual body in plain English:

```
---
product: Gespage Client
aliases: gespage, gespage client, print client
version: 3.x
---

# Deploying the Gespage Client
...your steps, prerequisites, settings, and gotchas...
```

- **product** — the friendly name the AI matches against ("install the Gespage client").
- **aliases** — other names/keywords customers might use (comma-separated).
- **version** — optional, for your own tracking.

Files starting with `_` (like `_template.md`) and this README are ignored.

## Good manuals = good guidance

The AI is only as accurate as the manual. Include: prerequisites, where to get the
installer (an approved/trusted source), the exact steps, required settings (server
address, etc.), how to verify success, and common problems. Do **not** put licence
keys or passwords in a manual — those the customer supplies at install time.
