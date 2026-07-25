# Deploying the AWI Resolve connector (cloud)

The **connector** (orchestrator) is the always-on cloud service that customer agents
dial into. Vercel can't hold those long-lived connections, so the connector runs on a
small always-on host (Fly.io here); Vercel/alphawebin.com front the website + dashboard.

This is a one-time setup. Steps marked **[you]** need your accounts/decisions; the rest
is already built.

## 0. What's already built
- `Dockerfile`, `fly.toml` — ready-to-deploy container.
- Orchestrator hardened: reads `PORT`, `ANTHROPIC_API_KEY`, `RESOLVE_ENROLLMENT_SECRET`
  from host env; `/health` endpoint; rejects agents without the door key.
- Agent reads `config.json` (`orchestratorUrl`, `enrollmentSecret`).

## 1. [you] Create a Fly.io account
- Sign up at https://fly.io (needs a card; a tiny always-on machine is ~$2–4/month).
- Install the CLI: `iwr https://fly.io/install.ps1 -useb | iex` (PowerShell), then `fly auth login`.

## 2. Pick a door key and deploy
From the project folder (`C:\Users\ASUS\Projects\awi-resolve`):

```bash
fly launch --no-deploy
```
- Accept the existing `fly.toml`. Choose a unique app name (e.g. `awi-resolve-connector`)
  and the Singapore (`sin`) region.

Set the two secrets (these live only on Fly, never in code):
```bash
fly secrets set ANTHROPIC_API_KEY=sk-ant-...your key...
fly secrets set RESOLVE_ENROLLMENT_SECRET=pick-a-long-random-string
```
Then deploy:
```bash
fly deploy
```
Check it's healthy:
```bash
fly status
```
Your connector is now live at `https://<app-name>.fly.dev` (health: `/health`).
Agents will connect at `wss://<app-name>.fly.dev`.

## 3. [you] Point alphawebin.com at it
In your DNS (GoDaddy) for alphawebin.com, add a subdomain for the connector:
```bash
fly certs add connect.alphawebin.com
```
Fly prints the exact DNS record to create (a CNAME to `<app-name>.fly.dev`, plus a
validation record). Add those in GoDaddy. Once it validates, agents connect at
`wss://connect.alphawebin.com`.

(The marketing page + ops dashboard for AWI Resolve stay on Vercel under alphawebin.com,
as with the rest of the site.)

## 4. Rebuild the customer package pointed at production
Edit `packaging/config.template.json`:
```json
{
  "orchestratorUrl": "wss://connect.alphawebin.com",
  "enrollmentSecret": "the-same-string-you-set-in-step-2",
  "uiPort": 8790
}
```
Then rebuild:
```bash
powershell packaging\build.ps1
```
`dist\AWI-Resolve` now points at the cloud. Hand that folder to a customer; they run
`Install AWI Resolve.cmd` and it works from anywhere.

## Notes / follow-ups
- **Door key:** one shared secret gates all agents for the pilot. Per-customer tokens
  (spec §5.1) are a later hardening step.
- **Storage:** the connector currently writes tickets/escalations to its local disk,
  which resets on redeploy. Before a real pilot, move these to Supabase
  (`db/schema.sql` is ready).
- **Cost:** keep `min_machines_running = 1` (in `fly.toml`) so the connector never
  sleeps — it must stay up to hold customer connections.
