---
product: Gespage Popup (print client)
aliases: gespage, gespage client, gespage popup, popup, print client, cartadis client
version: 7.3.4 (installers held by Alpha Web); procedure per Gespage Server manual v9
---

# Deploying the Gespage Popup client on a user's PC

The **Gespage Popup** is the client application that runs on each user's workstation.
It notifies the user of Gespage messages — a printing rule being applied, a request for
a job code, or a redirection to accept. It is a Java application.

> Source: Gespage Server manual (v9 / November 2022), section "Client applications —
> Gespage Popup". Ports per Alpha Web's "Enabling Inbound and Outbound Ports".

## Prerequisites
- Windows 10/11 workstation.
- The **Gespage server address** for this customer (IP or hostname). The deployer must
  have this to hand — the AI never supplies or guesses it.
- Network path from the workstation to the server on **TCP 7180** (standard) and
  **7181** (secured / user web portal). The client only makes *outgoing* calls, so the
  workstation's own firewall is rarely the blocker — the path through the network
  firewall to the server is what matters.
- Administrator rights on the workstation to install.

## Which installer to use
Alpha Web holds both forms of the client installer:
- **`GespagePopup_Setup_<version>.msi`** — use this for automated or GPO deployment
  (it accepts pre-configuration parameters).
- **`GespagePopup_Setup_<version>_win.exe`** — the interactive installer, for a
  one-off manual install.

Only ever use the installer from Alpha Web's approved source.

## Automated / silent install (preferred)
The MSI accepts pre-configuration parameters so the client is installed *and* pointed
at the server in one step:

```
msiexec.exe /i GespagePopup_Setup_<version>.msi /qn SERVER_IP=<server address>
```

Additional pre-configuration parameters documented for the MSI:
- `SERVER_IP` — the Gespage server address.
- `AUTHENT` — authentication mode.
- `USER` — default user.

> VERSION NOTE: the parameter example in the manual is written against release 8.2.4.
> Alpha Web's current installer is 7.3.4. Confirm the parameter names against the
> installer in hand (or with Cartadis) before relying on them for a mass rollout —
> if a parameter is not accepted, install interactively and set the server address in
> the client afterwards.

## Interactive install (deployer at the machine)
1. Run `GespagePopup_Setup_<version>_win.exe` as administrator.
2. Work through the installer wizard and accept the defaults unless the customer's
   setup requires otherwise.
3. When prompted (or afterwards in the client's settings), enter the **Gespage server
   address**. The customer/deployer enters this — it is never guessed.
4. Finish the wizard.

## Verify it worked
- The Gespage Popup appears in the notification area (system tray) on the workstation.
- Send a test print. The Popup should appear, and the job should show against the user
  in the Gespage server's print monitoring.
- If the Popup never appears, it is not reaching the server — see below.

## Common problems
| Symptom | What to check |
|---|---|
| "Server could not be reached" / Popup never appears | Confirm the server address is correct. Check the workstation can resolve and reach it — an unusual DNS setting will break a *hostname* even when the IP works. Then confirm TCP 7180/7181 are open through the network firewall to the server. |
| Popup installs but the user is never identified | The server identifies the workstation by username, IP and machine name. If any of those are not unique on the network, that criterion must be disabled in the server's Popup identification settings (Server manual, "Advanced parameters for the Popup client identification mode"). |
| Prints do not appear in Gespage at all | This is usually a server/print-queue side issue rather than the client — check the Gespage Agent and the print queue configuration on the server. |

## Related
- **Gespage Agent** (`Gespage_Agent_Setup_<version>_win.exe`) — installed where print
  queues are hosted, not usually on an end-user PC.
- **eTerminal** setup is per printer brand (Kyocera, Ricoh, Xerox, Sharp, Toshiba,
  Lexmark, Samsung, HP, Epson, Konica Minolta) — search the knowledge base for that
  brand's eTerminal manual.
