'use strict';

/**
 * Renders a sticky note to a PNG for the C17 mini printer (TiMiniPrint
 * protocol family "v5x": 384px raster width @ ~203 DPI, ~48mm print head).
 *
 * The printer is physically narrow but feeds arbitrarily long paper, so a
 * naive "384px wide, text flows normally" composition forces tiny text
 * (only ~48mm of line width to work with) or a long thin strip. Instead,
 * this composes the sticky in a wide, short "logical" layout — like a
 * normal landscape note — with the font auto-sized to fill it, then
 * rotates the whole thing 90° for printing. The physical output comes out
 * ~57mm wide (fits standard 57×25mm adhesive label stock) by a target
 * ~101mm long (a "panorama" of ~4 label segments), meant to be mounted
 * with its long edge against the board/flipchart so the (now vertical)
 * text reads at full size.
 *
 * This PNG is the single source of truth for "what gets printed": the
 * moderator web preview displays it scaled down, printer.js/the print
 * agent/blePrinter.js all send this same bitmap to the physical printer.
 * Its final width is always PRINTER_WIDTH_PX regardless of content length,
 * which is the contract those consumers rely on.
 */

const { createCanvas, loadImage } = require('@napi-rs/canvas');

const PRINTER_WIDTH_PX = 384; // C17 raster width, ~48mm — fixed by hardware
const PX_PER_MM = 8; // ~203 DPI
const TARGET_LENGTH_MM = 101; // matches a 57x25mm label stock run 4-up ("panorama")
const TARGET_LENGTH_PX = TARGET_LENGTH_MM * PX_PER_MM; // 808
const MAX_LENGTH_PX = TARGET_LENGTH_PX * 4; // hard cap so pathological input can't print forever

// Logical (pre-rotation) authoring canvas: wide and short, like a normal
// landscape note. LOGICAL_HEIGHT is fixed (= the hardware raster width);
// LOGICAL_WIDTH starts at the 101mm target but can grow for long text (see
// fitTextBlock) since that axis becomes the printer's flexible length
// after rotation.
const LOGICAL_HEIGHT = PRINTER_WIDTH_PX;

const PADDING = 16;
const HEADER_FONT_SIZE = 20;
const HEADER_LINE_HEIGHT = 24;
const MIN_CONTENT_FONT = 26;
const MAX_CONTENT_FONT = 140;
const LINE_HEIGHT_RATIO = 1.25;
const WIDTH_GROW_STEP = 160;

// Only accept actual embedded image data, never a remote/file URL — image_data
// is untrusted participant input and @napi-rs/canvas's loadImage() would
// happily fetch a string that looks like a URL (SSRF risk otherwise).
const DATA_URL_RE = /^data:image\/(png|jpeg|jpg|webp);base64,/i;

function isValidImageDataUrl(value) {
  return typeof value === 'string' && DATA_URL_RE.test(value);
}

async function composeStickyPng(sticky, participant, workshop) {
  const hasImage = isValidImageDataUrl(sticky.image_data);
  const image = hasImage ? await loadImage(sticky.image_data) : null;
  const text = (sticky.content || '').trim();
  const hasText = text.length > 0;

  const headerLines = [
    `${workshop.name} (${workshop.code})`,
    `${participant.name} — #${sticky.participant_sticky_index}`,
  ];
  const headerHeight = headerLines.length * HEADER_LINE_HEIGHT + 12; // + divider gap
  const contentHeight = LOGICAL_HEIGHT - headerHeight - PADDING * 2;
  const contentAvailableWidth = TARGET_LENGTH_PX - PADDING * 2;

  // Text needs a measuring context before we know the final logical width
  // (fitTextBlock may grow it for long content).
  const measureCtx = createCanvas(10, 10).getContext('2d');
  let textBlock = null;
  let imageBoxHeight = 0;
  let logicalWidth = TARGET_LENGTH_PX;

  if (hasText && image) {
    imageBoxHeight = Math.round(contentHeight * 0.55);
    const textBoxHeight = contentHeight - imageBoxHeight - 10;
    textBlock = fitTextBlock(measureCtx, text, contentAvailableWidth, textBoxHeight);
  } else if (hasText) {
    textBlock = fitTextBlock(measureCtx, text, contentAvailableWidth, contentHeight);
  }
  if (textBlock) {
    logicalWidth = Math.max(TARGET_LENGTH_PX, textBlock.width + PADDING * 2);
  }

  const logical = createCanvas(logicalWidth, LOGICAL_HEIGHT);
  const ctx = logical.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, logicalWidth, LOGICAL_HEIGHT);
  ctx.fillStyle = '#000000';
  ctx.textBaseline = 'top';

  let y = PADDING;
  ctx.font = `bold ${HEADER_FONT_SIZE}px sans-serif`;
  for (const line of headerLines) {
    ctx.fillText(line, PADDING, y);
    y += HEADER_LINE_HEIGHT;
  }
  y += 4;
  drawDivider(ctx, y, logicalWidth);
  y += 8;

  const contentX = PADDING;
  const contentWidth = logicalWidth - PADDING * 2;

  if (hasText && image) {
    drawImageFit(ctx, image, contentX, y, contentWidth, imageBoxHeight);
    drawTextBlock(ctx, textBlock, contentX, y + imageBoxHeight + 10);
  } else if (image) {
    drawImageFit(ctx, image, contentX, y, contentWidth, contentHeight);
  } else if (hasText) {
    drawTextBlock(ctx, textBlock, contentX, y);
  } else {
    ctx.font = `${MIN_CONTENT_FONT}px sans-serif`;
    ctx.fillText('(no content)', contentX, y);
  }

  return rotate90Clockwise(logical).encode('png');
}

/**
 * Finds the largest font size (within MIN/MAX_CONTENT_FONT) whose wrapped
 * lines fit within maxHeight at the given width. If even the minimum size
 * doesn't fit, widens the wrap width in steps (up to MAX_LENGTH_PX) instead
 * of shrinking the font past legibility — the logical width becomes the
 * print *length* after rotation, which the printer can accommodate; the
 * logical height cannot grow, it's fixed by the hardware raster width.
 */
function fitTextBlock(ctx, text, startWidth, maxHeight) {
  for (let width = startWidth; width <= MAX_LENGTH_PX; width += WIDTH_GROW_STEP) {
    for (let fontSize = MAX_CONTENT_FONT; fontSize >= MIN_CONTENT_FONT; fontSize -= 2) {
      ctx.font = `${fontSize}px sans-serif`;
      const lines = wrapText(ctx, text, width);
      const lineHeight = Math.round(fontSize * LINE_HEIGHT_RATIO);
      if (lines.length * lineHeight <= maxHeight) {
        return { fontSize, lineHeight, lines, width };
      }
    }
  }
  // Content is pathologically long even at the width cap — use the
  // smallest font and let it overflow rather than fail.
  ctx.font = `${MIN_CONTENT_FONT}px sans-serif`;
  const lines = wrapText(ctx, text, MAX_LENGTH_PX);
  return { fontSize: MIN_CONTENT_FONT, lineHeight: Math.round(MIN_CONTENT_FONT * LINE_HEIGHT_RATIO), lines, width: MAX_LENGTH_PX };
}

function drawTextBlock(ctx, block, x, y) {
  ctx.font = `${block.fontSize}px sans-serif`;
  let cursorY = y;
  for (const line of block.lines) {
    ctx.fillText(line, x, cursorY);
    cursorY += block.lineHeight;
  }
}

function drawImageFit(ctx, image, x, y, maxWidth, maxHeight) {
  const scale = Math.min(maxWidth / image.width, maxHeight / image.height);
  const w = image.width * scale;
  const h = image.height * scale;
  ctx.drawImage(image, x + (maxWidth - w) / 2, y + (maxHeight - h) / 2, w, h);
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

// Rotates a canvas 90° clockwise into a new canvas (width/height swapped).
function rotate90Clockwise(source) {
  const rotated = createCanvas(source.height, source.width);
  const ctx = rotated.getContext('2d');
  ctx.translate(rotated.width, 0);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(source, 0, 0);
  return rotated;
}

module.exports = { composeStickyPng, isValidImageDataUrl, PRINTER_WIDTH_PX };
