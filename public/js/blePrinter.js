/* StickyPrinter — Web Bluetooth printing for C17 / MXW01-family ("v5x" protocol) thermal printers.
 *
 * Independent implementation written from the documented protocol facts
 * (packet structure, GATT UUIDs, CRC, command IDs), cross-checked against
 * two independent open-source projects: TiMiniPrint (Apache-2.0,
 * github.com/Dejniel/TiMini-Print) and MXW01-catprinter (MIT,
 * github.com/jeremy46231/MXW01-catprinter). No code from either was
 * copied — this is a clean-room implementation against their documented
 * wire format, chosen deliberately to avoid the AGPL-3.0 license used by
 * the reference web app (github.com/dropalltables/catprinter) that
 * originally demonstrated Web Bluetooth working with this printer family.
 *
 * Why this exists alongside deploy/print-agent/ (the Python agent): BLE
 * GATT connections to this printer don't need OS-level pairing — Windows'
 * Settings > Bluetooth pairing flow may not even work for it. A page
 * running in Chrome/Edge can connect directly via the Web Bluetooth API,
 * no separate local process required, as long as the moderator keeps that
 * tab open with the printer in range.
 *
 * Browser support: Chrome/Edge/Opera only (Web Bluetooth is not
 * implemented in Firefox or Safari).
 */
'use strict';

const BLE_SERVICE_UUID = '0000ae30-0000-1000-8000-00805f9b34fb';
const BLE_CONTROL_CHAR_UUID = '0000ae01-0000-1000-8000-00805f9b34fb'; // write without response
const BLE_NOTIFY_CHAR_UUID = '0000ae02-0000-1000-8000-00805f9b34fb'; // notify
const BLE_DATA_CHAR_UUID = '0000ae03-0000-1000-8000-00805f9b34fb'; // write without response, bulk image data

const PRINTER_WIDTH_PX = 384; // must match src/printRender.js's PRINTER_WIDTH_PX
const BYTES_PER_ROW = PRINTER_WIDTH_PX / 8; // 48
const MIN_DATA_BYTES = 4320; // printer's minimum buffer size (~90 lines)
const DATA_CHUNK_SIZE = 180; // matches TiMiniPrint's tuned v5x transport profile
const DATA_CHUNK_DELAY_MS = 30;

const CMD = {
  GET_STATUS: 0xa1,
  SET_INTENSITY: 0xa2,
  PRINT_REQUEST: 0xa9,
  FLUSH: 0xad,
  PRINT_COMPLETE: 0xaa,
  GET_BATTERY: 0xab,
};

function isWebBluetoothSupported() {
  return typeof navigator !== 'undefined' && !!navigator.bluetooth;
}

// CRC-8, poly 0x07, init 0x00, no input/output reflection, no XOR-out.
// Computed only over the payload field (not preamble/header/footer).
function crc8(bytes) {
  let crc = 0x00;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x80) ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

// Control-packet wire format: 0x22 0x21 | cmd | 0x00 | length_le(2) | payload | crc8(payload) | 0xFF
function buildPacket(commandId, payload) {
  const length = payload.length;
  const packet = new Uint8Array(2 + 1 + 1 + 2 + length + 1 + 1);
  packet[0] = 0x22;
  packet[1] = 0x21;
  packet[2] = commandId;
  packet[3] = 0x00;
  packet[4] = length & 0xff;
  packet[5] = (length >> 8) & 0xff;
  packet.set(payload, 6);
  packet[6 + length] = crc8(payload);
  packet[6 + length + 1] = 0xff;
  return packet;
}

// Notification wire format: 0x22 0x21 | cmd | unknown(1) | length_le(2) | payload | 0xFF
function parseNotification(dataView) {
  if (dataView.byteLength < 7 || dataView.getUint8(0) !== 0x22 || dataView.getUint8(1) !== 0x21) {
    return null;
  }
  const commandId = dataView.getUint8(2);
  const length = dataView.getUint8(4) | (dataView.getUint8(5) << 8);
  const payload = new Uint8Array(dataView.buffer, dataView.byteOffset + 6, length);
  return { commandId, payload };
}

/**
 * Converts a PNG (as fetched from GET /api/stickies/:id/print-render) into
 * the printer's 1-bit raster format: 48 bytes/row, LSB-first bit order
 * (bit 0 = leftmost pixel of each 8-pixel group), black = 1 / white = 0,
 * padded to the printer's minimum buffer size.
 */
async function encodePngTo1Bit(pngBlob) {
  const bitmap = await createImageBitmap(pngBlob);
  if (bitmap.width !== PRINTER_WIDTH_PX) {
    throw new Error(`Expected a ${PRINTER_WIDTH_PX}px-wide image, got ${bitmap.width}px`);
  }
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);

  const rowCount = Math.max(bitmap.height, Math.ceil(MIN_DATA_BYTES / BYTES_PER_ROW));
  const buffer = new Uint8Array(rowCount * BYTES_PER_ROW); // zero-filled = all white, handles bottom padding

  for (let y = 0; y < bitmap.height; y++) {
    for (let x = 0; x < PRINTER_WIDTH_PX; x++) {
      const i = (y * bitmap.width + x) * 4;
      const luminance = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
      const isBlack = luminance < 128 && data[i + 3] > 127; // treat transparent as white
      if (isBlack) {
        buffer[y * BYTES_PER_ROW + (x >> 3)] |= 1 << (x & 7);
      }
    }
  }

  return { buffer, rowCount };
}

class BlePrinter {
  constructor(device, server, controlChar, notifyChar, dataChar) {
    this.device = device;
    this.server = server;
    this.controlChar = controlChar;
    this.notifyChar = notifyChar;
    this.dataChar = dataChar;
    this.waiters = new Map(); // commandId -> [{resolve, reject}]
    notifyChar.addEventListener('characteristicvaluechanged', (e) => this._onNotification(e.target.value));
  }

  _onNotification(dataView) {
    const parsed = parseNotification(dataView);
    if (!parsed) return;
    const queue = this.waiters.get(parsed.commandId);
    if (queue && queue.length) {
      queue.shift().resolve(parsed.payload);
    }
  }

  _waitFor(commandId, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const queue = this.waiters.get(commandId);
        const idx = queue ? queue.findIndex((w) => w.resolve === wrappedResolve) : -1;
        if (idx >= 0) queue.splice(idx, 1);
        reject(new Error(`Timed out waiting for printer response 0x${commandId.toString(16)}`));
      }, timeoutMs);
      const wrappedResolve = (payload) => { clearTimeout(timer); resolve(payload); };
      if (!this.waiters.has(commandId)) this.waiters.set(commandId, []);
      this.waiters.get(commandId).push({ resolve: wrappedResolve, reject });
    });
  }

  async _send(commandId, payload) {
    await this.controlChar.writeValueWithoutResponse(buildPacket(commandId, payload));
  }

  async getBatteryLevel() {
    const responsePromise = this._waitFor(CMD.GET_BATTERY, 5000);
    await this._send(CMD.GET_BATTERY, new Uint8Array([0x00]));
    const payload = await responsePromise;
    return payload[0];
  }

  async checkStatus() {
    const responsePromise = this._waitFor(CMD.GET_STATUS, 5000);
    await this._send(CMD.GET_STATUS, new Uint8Array([0x00]));
    const payload = await responsePromise;
    const overallFlag = payload[12];
    if (overallFlag !== 0) {
      const errorCode = payload[13];
      const reasons = { 1: 'No paper', 9: 'No paper', 4: 'Overheated', 8: 'Low battery' };
      throw new Error(`Printer not ready: ${reasons[errorCode] || `error code ${errorCode}`}`);
    }
  }

  async setIntensity(level) {
    await this._send(CMD.SET_INTENSITY, new Uint8Array([level & 0xff]));
  }

  async printPng(pngBlob, { intensity = 0x5d } = {}) {
    const { buffer, rowCount } = await encodePngTo1Bit(pngBlob);

    await this.setIntensity(intensity);
    await this.checkStatus();

    const printAckPromise = this._waitFor(CMD.PRINT_REQUEST, 5000);
    await this._send(CMD.PRINT_REQUEST, new Uint8Array([rowCount & 0xff, (rowCount >> 8) & 0xff, 0x30, 0x00]));
    const ack = await printAckPromise;
    if (ack[0] !== 0x00) {
      throw new Error(`Printer rejected print request (status 0x${ack[0].toString(16)})`);
    }

    for (let offset = 0; offset < buffer.length; offset += DATA_CHUNK_SIZE) {
      const chunk = buffer.subarray(offset, offset + DATA_CHUNK_SIZE);
      await this.dataChar.writeValueWithoutResponse(chunk);
      await new Promise((resolve) => setTimeout(resolve, DATA_CHUNK_DELAY_MS));
    }

    const completePromise = this._waitFor(CMD.PRINT_COMPLETE, 30000);
    await this._send(CMD.FLUSH, new Uint8Array([0x00]));
    await completePromise;
  }

  disconnect() {
    if (this.device.gatt.connected) {
      this.device.gatt.disconnect();
    }
  }
}

/**
 * Prompts the user to pick a nearby Bluetooth device (browser-native
 * picker — requires a user gesture, e.g. a button click) and connects.
 * Shows all BLE devices rather than filtering by name, since the C17/
 * MXW01 family is sold under many different advertised names.
 */
async function connectBlePrinter() {
  if (!isWebBluetoothSupported()) {
    throw new Error('Web Bluetooth is not supported in this browser (use Chrome or Edge).');
  }
  const device = await navigator.bluetooth.requestDevice({
    acceptAllDevices: true,
    optionalServices: [BLE_SERVICE_UUID],
  });
  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(BLE_SERVICE_UUID);
  const controlChar = await service.getCharacteristic(BLE_CONTROL_CHAR_UUID);
  const notifyChar = await service.getCharacteristic(BLE_NOTIFY_CHAR_UUID);
  const dataChar = await service.getCharacteristic(BLE_DATA_CHAR_UUID);
  await notifyChar.startNotifications();
  return new BlePrinter(device, server, controlChar, notifyChar, dataChar);
}

// Exposes pure protocol-level functions to Node for testing, without
// affecting browser use (module is undefined there, so this is a no-op).
if (typeof module !== 'undefined') {
  module.exports = { crc8, buildPacket, parseNotification, encodePngTo1Bit, CMD, BYTES_PER_ROW, MIN_DATA_BYTES, PRINTER_WIDTH_PX };
}
