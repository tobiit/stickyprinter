"""
StickyPrinter local print agent.

Runs on the moderator's PC (in Bluetooth range of the C17 printer - no
Windows-level pairing needed, see README.md) and
bridges the gap between the web-hosted StickyPrinter backend and the
physical printer: the backend cannot reach the printer directly (it isn't
in the room), so this agent polls the backend for stickies that have
already been marked "printed" by a moderator click or autoprint, and are
not yet known to be physically printed by *this* agent, then prints them
over Bluetooth using the TiMiniPrint library.

No backend changes are required: this only uses existing endpoints
(POST /api/auth/login, GET /api/stickies/workshop/:code?status=printed,
GET /api/stickies/:id/print-render).

Setup: see README.md in this folder. Configure via config.json (copy
config.example.json first).
"""

from __future__ import annotations

import asyncio
import json
import logging
import sys
import tempfile
from pathlib import Path

import requests

# timiniprint (github.com/Dejniel/TiMini-Print, Apache-2.0) isn't published
# on PyPI - setup.ps1 clones it into ./vendor/TiMini-Print. Add it to
# sys.path so it can be imported without a system-wide install.
VENDOR_DIR = Path(__file__).parent / "vendor" / "TiMini-Print"
if VENDOR_DIR.exists():
    sys.path.insert(0, str(VENDOR_DIR))

try:
    from timiniprint.devices import PrinterCatalog
    from timiniprint.printing.connected import connect_printer
    from timiniprint.printing.settings import PrintSettings
    from timiniprint.transport.bluetooth import BleakBluetoothConnector, BluetoothDiscovery
except ImportError as exc:  # pragma: no cover - startup guard, not app logic
    raise SystemExit(
        "Could not import timiniprint. Run setup.ps1 first (it clones the library "
        f"into {VENDOR_DIR} and installs dependencies).\nOriginal error: {exc}"
    ) from exc

SCRIPT_DIR = Path(__file__).parent
CONFIG_PATH = SCRIPT_DIR / "config.json"
STATE_PATH = SCRIPT_DIR / "agent-state.json"
REQUIRED_CONFIG_FIELDS = ("server_url", "username", "password", "workshop_codes")

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("print-agent")


class Config:
    def __init__(self, data: dict):
        missing = [f for f in REQUIRED_CONFIG_FIELDS if f not in data]
        if missing:
            raise SystemExit(f"config.json is missing required field(s): {', '.join(missing)}")

        self.server_url: str = data["server_url"].rstrip("/")
        self.username: str = data["username"]
        self.password: str = data["password"]
        self.workshop_codes: list[str] = data["workshop_codes"]
        if not isinstance(self.workshop_codes, list) or not self.workshop_codes:
            raise SystemExit("config.json: workshop_codes must be a non-empty list")

        self.printer_name: str = data.get("printer_name", "C17")
        self.poll_interval: float = float(data.get("poll_interval_seconds", 3))
        self.blackening: int = int(data.get("blackening", 3))

    @classmethod
    def load(cls, path: Path) -> "Config":
        if not path.exists():
            raise SystemExit(
                f"Config file not found: {path}\n"
                "Copy config.example.json to config.json and fill in your details."
            )
        with open(path, "r", encoding="utf-8") as f:
            return cls(json.load(f))


class PrintedState:
    """Tracks sticky IDs this agent has already physically printed, so a
    restart doesn't reprint everything the backend has marked "printed"."""

    def __init__(self, path: Path):
        self.path = path
        self.printed_ids: set[str] = set()
        if path.exists():
            try:
                self.printed_ids = set(json.loads(path.read_text(encoding="utf-8")))
            except (json.JSONDecodeError, OSError):
                log.warning("Could not read state file %s, starting fresh", path)

    def mark_printed(self, sticky_id: str) -> None:
        self.printed_ids.add(sticky_id)
        self.path.write_text(json.dumps(sorted(self.printed_ids)), encoding="utf-8")


class StickyPrinterClient:
    """Thin wrapper around the StickyPrinter moderator REST API."""

    def __init__(self, config: Config):
        self.config = config
        self.session = requests.Session()
        self._login()

    def _login(self) -> None:
        resp = self.session.post(
            f"{self.config.server_url}/api/auth/login",
            json={"username": self.config.username, "password": self.config.password},
            timeout=10,
        )
        resp.raise_for_status()
        log.info("Logged in as %s", self.config.username)

    def _get(self, path: str, **kwargs):
        resp = self.session.get(f"{self.config.server_url}{path}", timeout=15, **kwargs)
        if resp.status_code == 401:
            log.info("Session expired, re-logging in")
            self._login()
            resp = self.session.get(f"{self.config.server_url}{path}", timeout=15, **kwargs)
        resp.raise_for_status()
        return resp

    def printed_stickies(self, workshop_code: str) -> list[dict]:
        resp = self._get(f"/api/stickies/workshop/{workshop_code}", params={"status": "printed"})
        return resp.json()

    def print_render_png(self, sticky_id: str) -> bytes:
        return self._get(f"/api/stickies/{sticky_id}/print-render").content


class PrinterAgent:
    """Owns the Bluetooth side: resolving the C17 and sending print jobs."""

    def __init__(self, config: Config):
        self.config = config
        self.catalog = PrinterCatalog.load()
        self.discovery = BluetoothDiscovery(self.catalog)
        self._device = None

    async def _resolve_device(self):
        if self._device is not None:
            return self._device
        log.info("Looking for printer %r ...", self.config.printer_name)
        device = await self.discovery.resolve_device(self.config.printer_name)
        if device is None:
            raise RuntimeError(
                f"Printer {self.config.printer_name!r} not found. Make sure it's "
                "powered on and within range. It does not need to be paired in "
                "Windows Bluetooth settings first - this does a live scan."
            )
        self._device = device
        return device

    async def print_png(self, png_bytes: bytes, tmp_dir: Path) -> None:
        device = await self._resolve_device()
        tmp_file = tmp_dir / "sticky.png"
        tmp_file.write_bytes(png_bytes)
        try:
            async with await connect_printer(device, BleakBluetoothConnector()) as printer:
                await printer.print_file(
                    str(tmp_file),
                    settings=PrintSettings(blackening=self.config.blackening),
                )
        finally:
            tmp_file.unlink(missing_ok=True)


async def poll_once(client: StickyPrinterClient, agent: PrinterAgent, state: PrintedState, config: Config, tmp_dir: Path) -> None:
    for code in config.workshop_codes:
        try:
            stickies = client.printed_stickies(code)
        except requests.RequestException as exc:
            log.error("Failed to poll workshop %s: %s", code, exc)
            continue

        for sticky in stickies:
            sid = sticky["id"]
            if sid in state.printed_ids:
                continue
            log.info(
                "Printing sticky #%s from %s (workshop %s)",
                sticky.get("participant_sticky_index"), sticky.get("participant_name"), code,
            )
            try:
                png = client.print_render_png(sid)
                await agent.print_png(png, tmp_dir)
                state.mark_printed(sid)
                log.info("Printed sticky %s", sid)
            except Exception as exc:  # noqa: BLE001 - one bad sticky must not kill the agent loop
                log.error("Failed to print sticky %s: %s", sid, exc)


async def run() -> None:
    config = Config.load(CONFIG_PATH)
    state = PrintedState(STATE_PATH)

    try:
        client = StickyPrinterClient(config)
    except requests.HTTPError as exc:
        log.error("Login failed (%s). Check username/password in config.json.", exc)
        return
    except requests.RequestException as exc:
        log.error("Could not reach %s: %s", config.server_url, exc)
        return

    agent = PrinterAgent(config)
    log.info(
        "Watching workshop(s) %s every %.1fs for printer %r",
        ", ".join(config.workshop_codes), config.poll_interval, config.printer_name,
    )

    with tempfile.TemporaryDirectory(prefix="stickyprinter-agent-") as tmp_dir_str:
        tmp_dir = Path(tmp_dir_str)
        while True:
            await poll_once(client, agent, state, config, tmp_dir)
            await asyncio.sleep(config.poll_interval)


def main() -> None:
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        log.info("Stopped.")


if __name__ == "__main__":
    main()
