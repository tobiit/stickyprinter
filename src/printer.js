'use strict';

/**
 * Printer integration module for C17 / TiMiniPrint compatible thermal printers.
 *
 * Native BLE printing (the C17 speaks Bluetooth Low Energy, not a desktop
 * driver protocol) is handled by the companion Android app, which streams
 * the same composed PNG (see printRender.js) to the printer over BLE. This
 * module is the fallback path for a moderator PC without that app:
 * 1. CLI integration: hands the composed PNG to a TiMiniPrint-compatible CLI
 *    binary on PATH, if one is configured.
 * 2. Stub: logs the print job when no CLI is available.
 *
 * The TiMiniPrint project: https://github.com/Dejniel/TiMini-Print
 */

const { execFile } = require('child_process');
const { writeFileSync, unlinkSync, mkdtempSync } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');
const { composeStickyPng } = require('./printRender');

const TIMINI_CLI = process.env.TIMINI_CLI || 'timiniprint';
const PRINTER_MODEL = process.env.PRINTER_MODEL || '';

/**
 * Check if the TiMiniPrint CLI is available.
 * @returns {Promise<boolean>}
 */
function isCLIAvailable() {
  return new Promise((resolve) => {
    execFile(TIMINI_CLI, ['--version'], { timeout: 3000 }, (err) => {
      resolve(!err);
    });
  });
}

/**
 * Print a rendered sticky image using the TiMiniPrint CLI.
 * @param {Buffer} png - Composed print image
 * @returns {Promise<void>}
 */
function printViaCLI(png) {
  return new Promise((resolve, reject) => {
    const dir = mkdtempSync(join(tmpdir(), 'stickyprinter-'));
    const file = join(dir, 'sticky.png');
    try {
      writeFileSync(file, png);
      const args = [file];
      if (PRINTER_MODEL) {
        args.push('--printer-model', PRINTER_MODEL);
      }
      execFile(TIMINI_CLI, args, { timeout: 30000 }, (err, stdout, stderr) => {
        try { unlinkSync(file); } catch (_) {}
        if (err) {
          reject(new Error(`Print failed: ${stderr || err.message}`));
        } else {
          resolve();
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Print a sticky note. Falls back to console output if no CLI is configured.
 * @param {object} sticky - Sticky note record from DB
 * @param {object} participant - Participant record from DB
 * @param {object} workshop - Workshop record from DB
 * @returns {Promise<{printed: boolean, method: string}>}
 */
async function printSticky(sticky, participant, workshop) {
  const png = await composeStickyPng(sticky, participant, workshop);

  const available = await isCLIAvailable();
  if (available) {
    await printViaCLI(png);
    return { printed: true, method: 'cli' };
  }

  // Fallback: no locally attached printer/CLI — log that the job was composed.
  console.log(
    `[PRINTER] No printer CLI found. Composed print job for ${workshop.code} / ` +
    `${participant.name} sticky #${sticky.participant_sticky_index} (${png.length} bytes PNG). ` +
    `Use the Android app to print over Bluetooth, or set TIMINI_CLI.`
  );
  return { printed: true, method: 'stub' };
}

module.exports = { printSticky };
