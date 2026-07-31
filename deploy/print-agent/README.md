# StickyPrinter print agent (Windows)

Bridges the gap between the web-hosted StickyPrinter backend and the C17
printer in the room. The backend (e.g. running on a VPS behind
`stickies.basisadresse.de`) has no physical/Bluetooth connection to the
printer — this agent runs on the moderator's own Windows PC, which *is*
Bluetooth-paired with the C17, and does the actual printing.

**How it works:** the agent polls the StickyPrinter API for stickies the
backend has already marked "printed" (via the moderator's Print button or
autoprint) that it hasn't physically printed yet, fetches the print-ready
PNG, and sends it to the printer over Bluetooth using the
[TiMiniPrint](https://github.com/Dejniel/TiMini-Print) library. No changes
to the main StickyPrinter server are required for this to work.

Requires no changes on the server side — it only uses existing endpoints
(login, the sticky list, and the print-render PNG).

## Prerequisites

- Windows 10/11 with the C17 printer already paired in **Settings →
  Bluetooth & devices**.
- [Python 3.11+](https://www.python.org/downloads/windows/) — during
  install, check **"Add python.exe to PATH"**.
- [Git for Windows](https://git-scm.com/download/win) — used once by setup
  to fetch the TiMiniPrint library (it isn't published on PyPI).

## Setup

1. Copy this whole `print-agent` folder to the moderator's PC (or clone
   the StickyPrinter repo there).
2. Double-click **`setup.bat`**. It creates a Python virtual environment,
   downloads the TiMiniPrint library into `vendor\TiMini-Print`, installs
   all dependencies, and creates `config.json` from the example.
3. Edit **`config.json`**:

   ```json
   {
     "server_url": "https://stickies.basisadresse.de",
     "username": "admin",
     "password": "changeme",
     "workshop_codes": ["WS-ABCD-1234"],
     "printer_name": "C17",
     "poll_interval_seconds": 3,
     "blackening": 3
   }
   ```

   | Field | Meaning |
   |---|---|
   | `server_url` | Base URL of the StickyPrinter server |
   | `username` / `password` | A moderator login on that server |
   | `workshop_codes` | Which workshop(s) to watch (list — usually one) |
   | `printer_name` | Bluetooth device name to print to (`C17` by default) |
   | `poll_interval_seconds` | How often to check for new print jobs |
   | `blackening` | Print darkness, 1 (lightest) to 5 (darkest) |

   Keep this file private — it contains a real password. It's already
   excluded from git via `.gitignore` in this folder.

## Running

Double-click **`run-agent.bat`**. Leave the console window open — it logs
what it's doing and keeps polling until you close it (Ctrl+C to stop
cleanly). Typical output:

```
2026-08-01 10:03:12 [INFO] Logged in as admin
2026-08-01 10:03:12 [INFO] Watching workshop(s) WS-ABCD-1234 every 3.0s for printer 'C17'
2026-08-01 10:04:47 [INFO] Printing sticky #3 from Alice (workshop WS-ABCD-1234)
2026-08-01 10:04:47 [INFO] Looking for printer 'C17' ...
2026-08-01 10:04:50 [INFO] Printed sticky 9f2c...
```

To run it automatically at login instead of double-clicking every time,
create a Windows **Task Scheduler** entry that runs `run-agent.bat` "At
log on" for your user account.

## Troubleshooting

- **"Printer 'C17' not found"** — make sure the printer is powered on and
  already paired in Windows' own Bluetooth settings (this agent connects
  to an already-paired device, it doesn't pair new ones).
- **"Login failed"** — check `username`/`password` in `config.json`.
- **"Could not reach `<server_url>`"** — check the URL and your internet
  connection; if the server uses a self-signed certificate this will also
  fail (use a real certificate, e.g. via `deploy/install.sh`'s Let's
  Encrypt setup).
- A sticky never prints even though its status is "printed" in the
  moderator UI — check the console output for a per-sticky error; it's
  logged there and the agent keeps retrying on the next poll cycle only if
  you restart it (see "State" below), otherwise it will not retry the same
  sticky automatically since it doesn't know if a partial print already
  came out of the printer.

## State

The agent remembers which sticky IDs it has already printed in
`agent-state.json` (next to `agent.py`), so restarting it doesn't reprint
everything. Delete that file if you ever want to force a full reprint of
everything currently marked "printed".

## Updating the TiMiniPrint library

`setup.ps1` only clones it once. To pull in upstream fixes later, delete
the `vendor\TiMini-Print` folder and re-run `setup.bat`.

## Limitations (v1)

- Single agent instance per printer assumed — running two agents against
  the same workshop would race to print the same stickies.
- If the physical print fails (e.g. printer out of paper), the moderator
  web UI still shows the sticky as "printed" — the failure is only visible
  in this agent's console/log, not reflected back to the web UI.
- Credentials are stored in plain text in `config.json`. Fine for a
  single trusted moderator PC; don't share this folder around.
