# StickyPrinter — Project Status & Continuation Notes

Last updated: 2026-07-31. This file is the handoff document for continuing
work on this project from any machine — read this first, then
[`docs/android-app.md`](android-app.md) if you're picking up the Android
work specifically.

## Current state

The web app (Node/Express backend + vanilla-JS SPA frontend) is functional
end-to-end: moderator login/register, workshop creation, participant join
via workshop code, sticky creation (text + canvas drawing), submit/print/
postpone/reject flow, live moderator notifications via SSE, autoprint
toggle, and a print preview that shows exactly what would be sent to the
physical printer.

Test suite: `npm test` (Jest + Supertest, 30 tests, all passing).
**Requires Node.js ≥ 22** (see "Why Node ≥ 22" below).

## Architecture decisions made this session

### Session store: custom SQLite-backed store, not Redis
`express-session`'s default `MemoryStore` loses all sessions on restart and
isn't multi-process safe. Instead of adding Redis (new infrastructure for a
single-instance, on-prem workshop tool), [`src/sessionStore.js`](../src/sessionStore.js)
is a ~50-line custom `session.Store` implementation reusing the app's
existing `better-sqlite3` connection. Verified: a session (cookie) survives
a full server restart against the same DB file.

Considered and rejected: `better-sqlite3-session-store` (GPL-3.0 — license
friction), `connect-sqlite3` (pulls in a second, separate SQLite driver).

### Print composition: server-rendered PNG at real printer resolution
The C17 printer's actual raster width is **384px @ ~203 DPI** (~48mm paper) —
confirmed from the TiMiniPrint source (see android-app.md). The original ask
for a "230×440 preview" was resolved (user decision, 2026-07-31) to instead
use the *real* printer resolution as the source of truth: width fixed at
384px, height variable (like an actual receipt printout), not a fixed
230×440 box.

[`src/printRender.js`](../src/printRender.js) composes a sticky (workshop/
participant header + text and/or the canvas drawing) into a single PNG at
that resolution, using `@napi-rs/canvas` (prebuilt native bindings, MIT,
no build step). This PNG is now the **single source of truth** for "what
gets printed":
- `GET /api/stickies/:id/print-render` — moderator-only endpoint returning
  the PNG directly (`Content-Type: image/png`).
- The moderator web UI (`renderModeratorSticky` in `public/js/app.js`)
  displays this PNG scaled down as the print preview.
- `src/printer.js`'s CLI/stub fallback now prints this PNG instead of
  text-only — this also fixed a real bug found during review: the old
  `buildPrintText()` ignored `image_data` entirely, so drawn stickies
  printed as "(no text)". Drawings are now included.
- **This is the artifact the Android app should fetch and stream to the
  printer over BLE** (after 1-bit dithering) — don't reimplement the layout
  logic in Kotlin, just consume this endpoint (or extract the same
  composition server-side into a raw-pixel endpoint if the Android app
  ends up needing pre-dithered data instead of PNG — not decided yet).

Security note: `image_data` is untrusted participant input. `loadImage()`
from `@napi-rs/canvas` will fetch a plain URL string, which would be an SSRF
vector if a participant submitted `image_data: "http://internal/..."`
instead of a real data URL. Guarded in two places: `isValidImageDataUrl()`
in `printRender.js` (defense in depth) and the `PUT /api/stickies/:id`
route (rejects non-`data:image/...` values with 400 at the actual input
boundary).

### Why Node ≥ 22
`better-sqlite3@13` requires it (native ABI). `package.json` now has an
`engines` field. `@napi-rs/canvas` only requires Node ≥ 10, not the
constraint here.

### DB hygiene
`data/stickyprinter.db` was committed to git (with real bcrypt hashes in
it) — untracked via `git rm --cached` and added to `.gitignore`
(`/data/*.db*`). If you're setting up a fresh clone, the DB is created
automatically on first run (`src/db.js`).

## Known gaps / deliberately deferred

- **No real BLE printing from the Node backend.** `printer.js` only shells
  out to a `timiniprint` CLI binary if one happens to be on `PATH`
  (unlikely — see android-app.md, the real project is a Python library, not
  a CLI you'd install on a print server) or logs a stub. Real printing is
  intentionally being pushed to the Android app (native BLE), not solved
  server-side — see decision below.
- **Windows desktop app: dropped.** The original README asked for a
  Windows desktop app for the moderator. Decision (this session): replace
  it with a native Android app instead, both because BLE printer access is
  what's actually needed (a desktop app would need Bluetooth too, with the
  same protocol-porting work) and because the user wants to build Android/
  Kotlin know-how. The README already reflects this.
- Moderator submitted-stickies **list** thumbnails (`renderSubmittedList`)
  still show the raw `image_data`/text preview, not the composed
  print-render PNG — deliberate, to avoid N extra server-side canvas
  renders just for a list glance. Only the sticky **detail** view
  (`renderModeratorSticky`) shows the real print composition.
- No rate limiting on `/api/auth/login` or `/register` (brute-force is
  possible). Not addressed yet.
- No CI pipeline (tests exist, nothing runs them automatically on push).

## Deployment

`deploy/install.sh` — idempotent Debian/Ubuntu install script: Node 22 (via
NodeSource, following their currently-documented deb822 method, not a blind
`curl | bash`), nginx, certbot, a dedicated `stickyprinter` system user,
rsync-based deploy to `/opt/stickyprinter`, a hardened systemd unit, and an
nginx vhost with a **non-buffered** `/api/stream/` location (required — SSE
breaks under nginx's default buffering) and `client_max_body_size 12m`
(sticky drawings are base64 PNGs up to the app's 10MB JSON limit).

```
sudo DOMAIN=stickies.basisadresse.de CERTBOT_EMAIL=you@example.com deploy/install.sh
```

Re-running the script redeploys code safely without touching the existing
DB, the generated session secret, or the certificate (see the `--exclude`
list in the rsync step and the `.env`-exists check).

If `basisadresse.de` was a placeholder rather than the real domain, just
override `DOMAIN=`.

## Next steps (pick up here)

1. Android app — see [`docs/android-app.md`](android-app.md) for the full
   technical plan (protocol details, BLE specifics, effort estimate). Not
   started yet; it's a separate project/repo, not part of this Node
   codebase.
2. Rate limiting on auth endpoints.
3. CI (run `npm test` on push).
4. Decide whether `printer.js`'s CLI fallback is worth keeping at all once
   the Android app exists, or whether the web "Print" button should simply
   be removed/repurposed in favor of "printed via the Android app".
