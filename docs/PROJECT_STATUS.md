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

Two independent physical-printing paths now exist (the backend itself
can't print — see "Local print agent" below for why): a Windows Python
agent (`deploy/print-agent/`) and direct Web Bluetooth printing from the
moderator's Chrome/Edge tab (`public/js/blePrinter.js`). Neither has been
confirmed against real hardware yet — see "Next steps".

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

**Two real bugs hit and fixed during first real-world use (2026-07-31):**
1. `setup.ps1` had em-dashes in `Write-Host` strings; the file has no UTF-8
   BOM, and Windows PowerShell 5.1 (the default `powershell.exe`, not
   `pwsh`) reads non-BOM `.ps1` files in the system codepage, garbling
   those bytes into stray quote-like characters — "string has no
   terminator" parse errors. Fixed by keeping all `.ps1`/`.bat` files
   strict ASCII (verified by actually parsing the fixed files with a real
   PowerShell 7 binary, not just inspection).
2. `Bluetooth scan failed (ble: unhashable type: 'list')` on first real
   Windows run — not a permissions issue. TiMiniPrint's own
   `requirements.txt` pins `bleak>=0.22` with no ceiling; a fresh install
   grabs the newest `bleak` (3.0.x at time of writing), three major
   versions past what TiMiniPrint was evidently developed against, which
   breaks Windows/WinRT scanning inside bleak itself. Fixed by pinning
   `bleak<1.0.0` in `deploy/print-agent/requirements.txt` (verified pip
   resolves this to 0.22.3, satisfying both constraints) — **not yet
   confirmed this actually fixes the real Bluetooth scan** on the user's
   machine, only that the version pin resolves correctly. If it recurs,
   the next step is bisecting bleak versions between 0.22.3 and 1.0.0, or
   filing it upstream with TiMiniPrint.
3. **Correction: the printer does not need Windows-level pairing at all.**
   The user found that Windows' own Settings > Bluetooth pairing failed to
   pair the printer, but https://print.natey.me/ (an open-source Web
   Bluetooth webapp for this exact printer family, see below) connected to
   it immediately. Reason: BLE GATT connections don't require classic
   bonding/pairing unless a characteristic demands encryption, and this
   printer doesn't. `deploy/print-agent/README.md` and `agent.py`'s error
   message were both wrong to suggest pairing first — corrected to say the
   agent does a live scan and connects directly, no Windows pairing step
   needed or recommended. The sweep initially missed `setup.ps1`'s own
   post-install success message ("Pair the C17 printer in Windows
   Bluetooth settings...") — the user caught this by actually running it
   again after the first "fix", which is why it's worth grepping the whole
   directory (`grep -rni pair deploy/print-agent/`) rather than trusting
   memory of which files were touched, if this class of message ever needs
   changing again.

## Web Bluetooth printing (public/js/blePrinter.js), 2026-07-31

A second printing path, added alongside the Python agent (not instead of
it — user explicitly asked for both). Prints directly from the moderator's
Chrome/Edge tab via the browser's native Web Bluetooth API — no local
process to install/run at all, at the cost of needing that tab open and a
one-time user-gesture device picker per session.

**Where this came from:** the user found https://print.natey.me/
("catprinter" by dropalltables, AGPL-3.0) — a Web Bluetooth webapp
specifically for the MXW01 model (same v5x protocol family as the C17) —
and confirmed it connects and prints successfully where Windows-level
pairing did not. Its `PROTOCOL.md` is duplicated from the actual primary
source, https://github.com/jeremy46231/MXW01-catprinter (**MIT**
licensed), which includes a full Python reference implementation.

**Implementation is a clean-room rewrite in `public/js/blePrinter.js`**,
written from the documented protocol facts, not copied from either repo
(the AGPL-3.0 site's code was deliberately avoided; the MIT repo's code
was read for cross-validation but not copied either — this project isn't
MIT and mixing licenses casually should be a deliberate choice, not an
accident). Covers: GATT service/characteristic discovery (`AE30`/`AE01`
control/`AE02` notify/`AE03` data), the `22 21`-preamble packet format,
CRC-8 (poly `0x07`, init `0x00`, no reflect/xorout, computed over payload
only), the command set needed for printing (`A1` status, `A2` intensity,
`A9` print request, `AD` flush, `AA` complete notification, `AB` battery),
and 1-bit image encoding (LSB-first bit packing, 48 bytes/row, padded to
4320 bytes minimum) from the `GET /api/stickies/:id/print-render` PNG.

**Verified without hardware, about as far as that can go:**
- The CRC-8 implementation was checked byte-for-byte against
  jeremy46231/MXW01-catprinter's actual lookup-table implementation across
  5000 random inputs (0 mismatches) — this is an independent, ground-truth
  reference, not my own derivation being checked against itself.
- `buildPacket()`'s output matches the exact byte sequence you'd hand-
  compute from the spec (e.g. a GET_STATUS command encodes to
  `22 21 a1 00 01 00 00 00 ff`).
- `parseNotification()` correctly decodes a battery-response notification
  built from the **actual bytes in the user's own captured log** from
  print.natey.me (payload byte `0x5f` → 95%, matching their console output
  exactly).
- **Not verified:** an actual GATT connection, a real print, or the
  browser-side image-encoding path (`encodePngTo1Bit`, which needs
  `createImageBitmap`/`Canvas` — browser-only APIs, can't run in Node).
  Needs a real on-site test in Chrome with the C17 in range.

Integrated into `renderModeratorSticky` in `public/js/app.js`: a
"🔵 Print via Bluetooth" button (only shown when
`isWebBluetoothSupported()`) alongside the existing "🖨️ Print
(agent/local)" button, which still hits the old server-side endpoint (for
the Python agent / local-CLI path). Both end up calling
`POST /api/stickies/:id/print` to mark the sticky printed — the Bluetooth
path just does the actual physical printing client-side first.

**Not yet evaluated: `clementvp/mxw01-thermal-printer`** — an npm package
(`mxw01-thermal-printer`, TypeScript) the user also found, with adapters
for *both* Web Bluetooth and Node.js (via `@stoprocent/noble`), better
dithering than my simple luminance threshold, and zero core dependencies.
License: `package.json` says MIT but there's no separate `LICENSE` file in
the repo — probably fine, but worth a sanity check before depending on it.
Its Node.js adapter is a potentially much cleaner replacement for the
*entire Python print agent* (same language as the rest of this backend, no
venv/pip/bleak version wrangling) — flagged as a next step, not yet acted
on.

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

1. **Verify both print paths against real hardware, on-site with the C17:**
   - Web Bluetooth: open the moderator sticky view in Chrome, click
     "Print via Bluetooth", confirm a real print. This is the biggest
     untested piece of what exists so far — protocol-level correctness is
     well-verified (see above), but nothing browser/GATT-specific has run
     against real hardware yet.
   - Python agent: confirm the `bleak<1.0.0` pin actually fixes the
     Windows scan (not just that pip resolves it), now without the
     Windows-pairing red herring.
2. **Consider rewriting the print agent in Node instead of Python**, using
   `clementvp/mxw01-thermal-printer`'s Node/`@stoprocent/noble` adapter
   (see above) — would eliminate the whole venv/pip/bleak-version class of
   problems by staying in the same language as the rest of this backend.
   Not started; check the license situation first (package.json says MIT,
   no separate LICENSE file).
3. Android app — see [`docs/android-app.md`](android-app.md) for the full
   technical plan (protocol details, BLE specifics, effort estimate). Not
   started yet; it's a separate project/repo, not part of this Node
   codebase. The Web Bluetooth research done today (protocol details, two
   independently cross-validated reference implementations) is directly
   reusable for the Android BLE module too.
4. Rate limiting on auth endpoints.
5. CI (run `npm test` on push).
6. Decide whether `printer.js`'s server-side CLI fallback is worth keeping
   now that there are two working local-printing paths (agent, Web
   Bluetooth), or whether it should just be removed to avoid three
   different "how printing happens" code paths.
7. Print-agent v2 ideas (not needed yet): a real moderator API token
   instead of plain-text password in `config.json`; report physical print
   failures back to the web UI instead of only logging them locally.
