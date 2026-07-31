'use strict';

/**
 * Printer integration module for C17 / TiMiniPrint compatible thermal printers.
 *
 * This module provides two printing strategies:
 * 1. CLI integration: Calls the TiMiniPrint CLI binary if available on PATH.
 * 2. Direct stub: Logs the print job (useful when no printer is connected).
 *
 * The TiMiniPrint project: https://github.com/Dejniel/TiMini-Print
 */

const { execFile } = require('child_process');
const { writeFileSync, unlinkSync, mkdtempSync } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');

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
 * Build text content for a sticky note to be printed.
 * @param {object} sticky - Sticky note record from DB
 * @param {object} participant - Participant record from DB
 * @param {object} workshop - Workshop record from DB
 * @returns {string}
 */
function buildPrintText(sticky, participant, workshop) {
  const divider = '-'.repeat(32);
  const header = `Workshop: ${workshop.name} (${workshop.code})`;
  const from = `From: ${participant.name} [sticky #${sticky.participant_sticky_index}]`;
  const content = sticky.content || '(no text)';
  return [divider, header, from, divider, content, divider].join('\n');
}

/**
 * Print a sticky note using the TiMiniPrint CLI.
 * @param {string} text - Text content to print
 * @returns {Promise<void>}
 */
function printViaCLI(text) {
  return new Promise((resolve, reject) => {
    const dir = mkdtempSync(join(tmpdir(), 'stickyprinter-'));
    const file = join(dir, 'sticky.txt');
    try {
      writeFileSync(file, text, 'utf8');
      const args = ['--text', text];
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
 * Print a sticky note. Falls back to console output if CLI is unavailable.
 * @param {object} sticky - Sticky note record from DB
 * @param {object} participant - Participant record from DB
 * @param {object} workshop - Workshop record from DB
 * @returns {Promise<{printed: boolean, method: string}>}
 */
async function printSticky(sticky, participant, workshop) {
  const text = buildPrintText(sticky, participant, workshop);

  const available = await isCLIAvailable();
  if (available) {
    await printViaCLI(text);
    return { printed: true, method: 'cli' };
  }

  // Fallback: log the print job
  console.log('[PRINTER] No printer CLI found. Print job:\n' + text);
  return { printed: true, method: 'stub' };
}

module.exports = { printSticky, buildPrintText };
