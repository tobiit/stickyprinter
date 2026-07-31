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

## Local print agent (deploy/print-agent/), 2026-07-31

Realized the backend (esp. once deployed remotely per `deploy/install.sh`)
structurally cannot print: the VPS has no Bluetooth connection to a printer
sitting in the workshop room. `printer.js`'s CLI-shelling fallback can only
ever work if the Node process itself runs on a machine paired with the
printer — never true for the production VPS deployment.

Fix, until the Android app exists: `deploy/print-agent/` is a standalone
**Python** agent (Windows-first, but platform-agnostic in principle) that
runs on the moderator's own PC — which *is* Bluetooth-paired with the C17.
It polls `GET /api/stickies/workshop/:code?status=printed` (existing
endpoint — the backend already marks stickies "printed" immediately on
manual print or autoprint, before/regardless of whether server-side
printing actually works), tracks which sticky IDs it has already
physically printed in a local `agent-state.json`, fetches
`GET /api/stickies/:id/print-render` for new ones, and prints via
TiMiniPrint's documented **library** API (`PrinterCatalog`,
`BluetoothDiscovery`, `connect_printer`, `printer.print_file(...)`) —
imported directly, not shelled out to a CLI. **Zero backend changes were
needed** — every endpoint it uses already existed.

TiMiniPrint isn't on PyPI, so `setup.ps1` clones
github.com/Dejniel/TiMini-Print (Apache-2.0) into `vendor/TiMini-Print` at
setup time rather than vendoring a copy into this repo. BLE goes through
`bleak`, which has a native Windows (WinRT) backend — confirmed via
`requirements.txt` (`winsdk` dependency on `sys_platform == "win32"`) — so
this works from a real Windows Python process. **Important: it will not
work from inside WSL** — WSL2 has no Bluetooth passthrough to
Windows-paired devices. The agent must run as native Windows Python, not
inside a WSL shell (even though development/testing of everything else in
this repo happens in WSL).

Tested in this session (see chat history around 2026-07-31): the full
import chain (`PrinterCatalog.load()`, `BluetoothDiscovery`), the REST
client (login, poll, print-render fetch) against a real running
StickyPrinter instance, state-tracking idempotency, and the error paths
(bad password, unreachable server, missing config) — all verified working.
**Not tested: an actual BLE print to a real C17** — no hardware available
in the dev sandbox. That still needs a real run on-site.

Known v1 limitations (documented in `deploy/print-agent/README.md`):
single-agent-per-printer assumed (no lock/coordination), a failed physical
print isn't reflected back to the web UI (sticky still shows "printed"),
credentials stored in plain-text `config.json`.

## Known gaps / deliberately deferred

- **No real BLE printing from the Node backend itself** — and this is now
  known to be structural, not just unimplemented (see "Local print agent"
  above): a remote-hosted backend has no path to a printer in the room.
  `printer.js`'s CLI fallback remains as dead-ish code for the case where
  someone runs the whole Node server locally on a printer-paired machine
  (e.g. via `deploy/run-local.sh`); in the normal VPS deployment it will
  never find a CLI and always falls through to the stub. The print agent
  (above) and, longer-term, the Android app are the real solutions.
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

1. **Verify the print agent against real hardware** — on-site with the
   actual C17: run `deploy/print-agent/setup.bat`/`run-agent.bat` on the
   moderator's Windows PC and confirm an actual physical print. This is
   the biggest untested piece of what exists so far.
2. Android app — see [`docs/android-app.md`](android-app.md) for the full
   technical plan (protocol details, BLE specifics, effort estimate). Not
   started yet; it's a separate project/repo, not part of this Node
   codebase.
3. Rate limiting on auth endpoints.
4. CI (run `npm test` on push).
5. Decide whether `printer.js`'s CLI fallback is worth keeping at all now
   that the print agent exists, or whether it should just be removed to
   avoid two different "how printing happens" code paths.
6. Print-agent v2 ideas (not needed yet): a real moderator API token
   instead of plain-text password in `config.json`; report physical print
   failures back to the web UI instead of only logging them locally.
