# Decisions

One bullet per decision. Append only unless a decision is reversed.

- 2026-08-22 — **Licence carries identity** (`licensedTo`, `licensedToEmail`,
  `brandName`) — signed, so a PC cannot be rebranded as another company;
  `brandName` falls back to `customer` so existing keys brand without reissue.
- 2026-08-22 — **Co-branding name from the licence, logo from a local file** —
  an image cannot travel inside a pasteable key.
- 2026-08-22 — **Renewal reminder is in-window, once per day** — marked as shown
  only when a window was open to show it in.
- 2026-08-22 — **Customer documentation lives on the DATA VOLUME** — the image is
  replaced on every deploy, so "permanent" could not mean the image.
- 2026-08-22 — **Store only extracted text, never the uploaded file** — the 1 GB
  volume also holds `ledger.json`; filling it breaks billing, not logging.
- 2026-08-22 — **Uploaded documentation is private per organisation** — the
  opposite of `learning.js`, whose notes are scrubbed so they CAN be shared.
- 2026-08-22 — **One admin token per organisation** — opens documentation,
  software library and usage console. Not three credentials.
- 2026-08-22 — **Console pages served unauthenticated; APIs are not** — lets the
  emailed link carry no credential, so forwarding an email grants nothing.
- 2026-08-22 — **Token in a header and sessionStorage, never the URL** — query
  strings reach proxy logs; localStorage outlives the tab on a shared PC.
- 2026-08-22 — **Rotation is authorised by the CURRENT token** — the person who
  needs it is the admin holding the leaked one; making them ask us first keeps
  the leak live.
- 2026-08-22 — **Audit trail capped at 4 MB × 5 generations on the volume** — an
  unbounded log ends as a ticket debit that cannot be written.
- 2026-08-22 — **Audit read scope comes from the credential, never the request** —
  an org token cannot widen its view by omitting `customerId`.
- 2026-08-22 — **Alert on 5 refused sign-ins in 5 minutes, then quiet for an
  hour** — an alert that arrives per attempt is one that gets filtered.
