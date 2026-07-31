'use strict';

/**
 * Renders a sticky note to a PNG matching the real raster width of the C17
 * mini printer (TiMiniPrint protocol family "v5x": 384px @ ~203 DPI, ~48mm
 * paper). Height is variable, like an actual receipt-roll printout.
 *
 * This PNG is the single source of truth for "what gets printed": the
 * moderator web preview displays it scaled down, printer.js sends it (best
 * effort) to a locally attached printer, and the companion Android app will
 * dither and stream this same bitmap over BLE to the physical printer.
 */

const { createCanvas, loadImage } = require('@napi-rs/canvas');

const PRINTER_WIDTH_PX = 384;
const PADDING = 12;
const LINE_HEIGHT = 20;
const FONT = '16px sans-serif';
const HEADER_FONT = 'bold 16px sans-serif';

// Only accept actual embedded image data, never a remote/file URL — image_data
// is untrusted participant input and @napi-rs/canvas's loadImage() would
// happily fetch a string that looks like a URL (SSRF risk otherwise).
const DATA_URL_RE = /^data:image\/(png|jpeg|jpg|webp);base64,/i;

function isValidImageDataUrl(value) {
  return typeof value === 'string' && DATA_URL_RE.test(value);
}

async function composeStickyPng(sticky, participant, workshop) {
  const contentWidth = PRINTER_WIDTH_PX - PADDING * 2;
  const headerLines = [
    `Workshop: ${workshop.name} (${workshop.code})`,
    `From: ${participant.name} — Sticky #${sticky.participant_sticky_index}`,
  ];

  const measure = createCanvas(PRINTER_WIDTH_PX, 10).getContext('2d');
  measure.font = FONT;
  const textLines = sticky.content ? wrapText(measure, sticky.content, contentWidth) : [];

  const hasImage = isValidImageDataUrl(sticky.image_data);
  const image = hasImage ? await loadImage(sticky.image_data) : null;
  const imageHeight = image ? Math.round((image.height / image.width) * contentWidth) : 0;

  let height = PADDING;
  height += headerLines.length * LINE_HEIGHT + 10; // header + divider gap
  if (image) height += imageHeight + 10;
  if (textLines.length) height += textLines.length * LINE_HEIGHT;
  if (!image && !textLines.length) height += LINE_HEIGHT; // "(no content)" placeholder
  height += PADDING;

  const canvas = createCanvas(PRINTER_WIDTH_PX, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, PRINTER_WIDTH_PX, height);
  ctx.fillStyle = '#000000';
  ctx.textBaseline = 'top';

  let y = PADDING;
  ctx.font = HEADER_FONT;
  for (const line of headerLines) {
    ctx.fillText(line, PADDING, y);
    y += LINE_HEIGHT;
  }
  y += 4;
  drawDivider(ctx, y, PRINTER_WIDTH_PX);
  y += 6;

  if (image) {
    ctx.drawImage(image, PADDING, y, contentWidth, imageHeight);
    y += imageHeight + 10;
  }

  ctx.font = FONT;
  if (textLines.length) {
    for (const line of textLines) {
      ctx.fillText(line, PADDING, y);
      y += LINE_HEIGHT;
    }
  } else if (!image) {
    ctx.fillText('(no content)', PADDING, y);
    y += LINE_HEIGHT;
  }

  return canvas.encode('png');
}

function wrapText(ctx, text, maxWidth) {
  const lines = [];
  for (const paragraph of text.split('\n')) {
    let current = '';
    for (const word of paragraph.split(' ')) {
      const candidate = current ? `${current} ${word}` : word;
      if (current && ctx.measureText(candidate).width > maxWidth) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    lines.push(current);
  }
  return lines;
}

function drawDivider(ctx, y, width) {
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, y + 0.5);
  ctx.lineTo(width, y + 0.5);
  ctx.stroke();
}

module.exports = { composeStickyPng, isValidImageDataUrl, PRINTER_WIDTH_PX };
