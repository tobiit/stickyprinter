# Android app plan — native C17 printer support

Status: **not started.** This is research + a recommended approach from
2026-07-31, to be used as the starting brief for a separate Android/Kotlin
project (new repo — this is a different toolchain from the Node app here).

## Why Android instead of a Windows desktop app

The original README asked for a Windows desktop app for the moderator.
Decided instead to build a native Android app, because:
- The C17 printer only talks Bluetooth LE — a Windows app would need the
  same protocol-porting work anyway, with a worse Bluetooth story on
  Windows than on Android.
- The user wants to build Android/Kotlin know-how (explicit goal).
- A commercial closed-source Android app for this exact printer family
  already exists (proof the approach works): "TiMini Print", Google Play
  `pl.wtrymiga.timiniprint`, by the same author as the open-source project
  below. No source available, existence-proof only.

## The printer: facts verified from source, not guessed

Source: [Dejniel/TiMini-Print](https://github.com/Dejniel/TiMini-Print)
(Apache-2.0 licensed — legally fine to port/reuse with attribution/NOTICE).
This is a Python desktop app/CLI; **there is no Android code in it** — the
protocol implementation is the useful part to port.

- Bluetooth device name **"C17"** maps to protocol family **`v5x`** in the
  catalog (`timiniprint/devices/catalog.py`, model_key `v5x`). Same family
  covers rebrands: X1, X2, MXW01, MXW-W5, AC695X_PRINT, JK01,
  PORTABLEPRINTER, INSTAPRINTPLUS, REKA, HDMDT-00, KERUI, BH03 — all the
  same protocol, only the C17 matters for this project.
- **Transport: Bluetooth Low Energy (GATT), not classic SPP**
  (`use_spp: false` on the profile). This determines the Android API
  surface: `BluetoothLeScanner` + `BluetoothGatt`, not `BluetoothSocket`/
  RFCOMM.
- BLE specifics for the v5x family
  (`timiniprint/devices/bluetooth_profiles.py`):
  - Service UUID: `0000ae30-0000-1000-8000-00805f9b34fb`
  - Notify characteristic: `0000ae02-0000-1000-8000-00805f9b34fb`
  - Write characteristic (bulk): `0000ae03-0000-1000-8000-00805f9b34fb`
  - Chunk size: 180 bytes, write delay: 30ms, **flow-controlled** (must
    respect device-sent pause/resume markers, not just fire-and-forget)
- Printer raster spec (`printer_profiles.json`, profile `v5x`, paper preset
  `default_384r`): **384px width @ 203 DPI** (~48mm paper), encoding
  `v5x_dot` (1-bit, dithered, LSB-first packed rows). Grayscale
  (GRAY4/GRAY8) is also supported by the family but dot/BW1 is the default
  for this profile. Density levels 1–5 map to fixed byte tables (different
  for dot vs. gray jobs).
- Protocol handshake (`timiniprint/protocol/families/v5x.py`), fixed
  packets + CRC8:
  ```
  GET_SERIAL → CONNECT_INIT → wait for START_READY notify →
  stream raster data in chunks (respecting PAUSE/RESUME notify markers) →
  FINALIZE → STATUS_POLL
  ```
  Named constants for all of these packets already exist in `v5x.py` as
  hex literals — that file (~5.6KB) plus `packet.py`, `plan.py`,
  `steps.py`, `v5_common.py` is the actual scope to port, not the whole
  143-model library.

## Recommended approach: native Kotlin (decided, 2026-07-31)

Two options were considered:

1. **Native Kotlin** (chosen) — port the v5x protocol family to Kotlin,
   drive it directly with `BluetoothGatt`. Cleanest, smallest APK, no extra
   runtime. Bounded scope since only one protocol family is needed.
2. Embed Python via Chaquopy — less porting risk for the tricky bits
   (CRC/dithering), but BLE I/O still has to be written in Kotlin either
   way (Python has no direct Android BLE access), plus ~15–25MB APK
   overhead and a Chaquopy license to check. Rejected in favor of (1).

## Suggested stack

| Piece | Choice | Notes |
|---|---|---|
| UI | Kotlin + Jetpack Compose | current Android standard |
| REST client | Retrofit/OkHttp against the existing `/api/*` routes | backend needs no changes for this |
| Live notifications | OkHttp streaming call parsing `/api/stream/:code` manually | Android has no built-in `EventSource` |
| BLE printer module | own Kotlin module porting `v5x.py`/`packet.py`/`plan.py`/`steps.py` | Apache-2.0 source as reference/port basis |

Feature parity target: everything the README's moderator section asks for
(login, create workshop, submitted-sticky notifications with name/counter/
preview, autoprint toggle, print/postpone/reject) — this is mostly a thin
Compose UI over the existing REST API; **the actual new engineering is the
BLE module.**

### Print bitmap source

Don't reimplement the sticky layout (header + text + drawing) in Kotlin.
Fetch `GET /api/stickies/:id/print-render` (see `src/printRender.js` in
this repo) — it already renders at the real 384px printer width. Decode
with `BitmapFactory`, apply 1-bit dithering, pack rows LSB-first, and feed
into the v5x raster job builder. If PNG decode + dithering on-device turns
out to be awkward, consider adding a raw-pixel/bitmap variant of the
endpoint later — not needed yet, decide when actually implementing this.

### Permissions

`BLUETOOTH_SCAN` / `BLUETOOTH_CONNECT` (Android 12+, with
`neverForLocation` since no location use), `ACCESS_FINE_LOCATION` fallback
for older Android versions (BLE scanning requires it pre-12).

## Effort estimate

The BLE/protocol port (v5x family only) is a well-scoped ~2–4 week task for
one experienced Kotlin/BLE developer, including testing against real
hardware. The surrounding app (thin REST UI) is comparatively small — most
of the real risk and effort is in the BLE handshake/flow-control state
machine, not the UI.

## Open questions for whoever picks this up

- New repo, or a module inside this one? (Recommendation: new repo — fully
  different toolchain/build system, no shared code beyond "hits the same
  REST API".)
- Should the web app's "Print" button be deprecated/removed once the
  Android app exists, or kept as a fallback? (See `PROJECT_STATUS.md`
  next steps.)
- Raw dithered-pixel endpoint vs. on-device PNG decode+dither — decide once
  actually wiring up the BLE send path and it's clear which is less code.
