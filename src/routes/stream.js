'use strict';

/**
 * Server-Sent Events (SSE) module for real-time moderator notifications.
 * Maintains a registry of active SSE connections keyed by workshop code.
 */

const express = require('express');
const router = express.Router();
const { workshopOps } = require('../db');
const { requireModerator } = require('../middleware/auth');

// Map<workshopCode, Set<Response>>
const sseClients = new Map();

function getSseClients(workshopCode) {
  return sseClients.get(workshopCode) || new Set();
}

function addSseClient(workshopCode, res) {
  if (!sseClients.has(workshopCode)) {
    sseClients.set(workshopCode, new Set());
  }
  sseClients.get(workshopCode).add(res);
}

function removeSseClient(workshopCode, res) {
  const clients = sseClients.get(workshopCode);
  if (clients) {
    clients.delete(res);
    if (clients.size === 0) {
      sseClients.delete(workshopCode);
    }
  }
}

// GET /api/stream/:code - SSE endpoint for moderator notifications
router.get('/:code', requireModerator, (req, res) => {
  const code = req.params.code.toUpperCase();
  const workshop = workshopOps.findByCode(code);
  if (!workshop) {
    return res.status(404).json({ error: 'Workshop not found' });
  }
  if (workshop.moderator_id !== req.session.moderatorId) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Send initial connection confirmation
  res.write(`data: ${JSON.stringify({ type: 'connected', workshop: code })}\n\n`);

  addSseClient(code, res);

  // Heartbeat every 25 seconds to prevent timeout
  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch (_) {
      clearInterval(heartbeat);
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    removeSseClient(code, res);
  });
});

module.exports = { router, getSseClients };
