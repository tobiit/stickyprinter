# stickyprinter
Remote Meeting Participants can create sticky-notes on the web and the moderator on site can instantly print them.

## Description

The context is as follows: sometimes workshops happen to be hybrid although they were planned to be onsite. While the majority of participants usually is gathered onsite in a meeting room, a minority (one or a few participants) join via online conferencing means. Workshops often require the participants to write on sticky notes or pin cards to flipcharts or boards - the remote participants are either excluded from those activities or require an onsite person to write those cards for them, mailing, texting the content to this person.

The project provides a web-based interface, that allows all remote participants to join a workshop using a workshop code, to create notes save and modify those notes online and submit them to the workshop. The workshop moderator is able to see the notes and to print them on a C17 mini printer ( The protocol was reverse engineered and is available via https://github.com/Dejniel/TiMini-Print as TiMiniPrint repository). The moderator should be able to set an "autoprint" option whereby submitted stickies are automatically printed. If this option is not set, a sticky will be shown to the moderator who then can initiate it to be printed, postpone it or reject it back to the author for rework.

### The moderator should use a web frontend and possibly late a native android app. 

The moderator has the following possibilities:

- login as moderator
- create a workshop, generating a short unique workshop id (e. g. WS-ABCD-1234)
- be notified about a submitted sticky with name of participant, counter of participant sticky and first few words on sticky
- set stickies to be autoprinted immediatly
- view the sticky with the options: print, postpone (return to workshop overview page without printing), reject/revert to participant for rework.

### The participant should have the possibility only via web/browser:

- Join Workshop with workshop code
- create new sticky
- use basic drawing functions & Text
- submit sticky to moderator, save sticky (and return to sticky overview), delete sticky

## Status

The web app (Node/Express backend + vanilla-JS frontend) implements the
full flow above and is deployable. The native Android app is planned but
not started. **See [`docs/PROJECT_STATUS.md`](docs/PROJECT_STATUS.md) for
the current implementation state, architecture decisions, and next steps —
read that first when picking this project back up.** Android-specific
research and the implementation plan are in
[`docs/android-app.md`](docs/android-app.md).

## Development

Requires **Node.js ≥ 22** (`better-sqlite3`'s native bindings need it).

```bash
npm install
npm run dev    # starts the server with --watch on http://localhost:3000
npm test       # Jest + Supertest, 30 tests
```

Environment variables (all optional, see `src/server.js` / `src/db.js`):
`PORT` (default 3000), `SESSION_SECRET` (random if unset — set it in
production so sessions survive process restarts with a *known* key),
`DB_PATH` (default `data/stickyprinter.db`), `NODE_ENV=production` (enables
secure cookies + trusts the reverse proxy), `TIMINI_CLI` / `PRINTER_MODEL`
(optional local printer CLI fallback, see `src/printer.js`).

## Deployment

`deploy/install.sh` sets up a Debian/Ubuntu server end-to-end: Node.js,
nginx (reverse proxy, SSE-safe), Let's Encrypt via certbot, and a systemd
service.

```bash
sudo DOMAIN=stickies.basisadresse.de CERTBOT_EMAIL=you@example.com deploy/install.sh
```

Safe to re-run for redeploys. See the script's header comment and
[`docs/PROJECT_STATUS.md`](docs/PROJECT_STATUS.md) for details.
