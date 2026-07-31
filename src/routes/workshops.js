'use strict';

const express = require('express');
const router = express.Router();
const { workshopOps, participantOps } = require('../db');
const { requireModerator } = require('../middleware/auth');

// POST /api/workshops - Create a new workshop (moderator only)
router.post('/', requireModerator, (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Workshop name is required' });
  }
  try {
    const workshop = workshopOps.create(name.trim(), req.session.moderatorId);
    return res.status(201).json(sanitizeWorkshop(workshop));
  } catch (err) {
    console.error('Create workshop error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/workshops - List moderator's workshops
router.get('/', requireModerator, (req, res) => {
  try {
    const workshops = workshopOps.findByModerator(req.session.moderatorId);
    return res.json(workshops.map(sanitizeWorkshop));
  } catch (err) {
    console.error('List workshops error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/workshops/:code - Get workshop info (public, for participants to join)
router.get('/:code', (req, res) => {
  try {
    const workshop = workshopOps.findByCode(req.params.code.toUpperCase());
    if (!workshop) {
      return res.status(404).json({ error: 'Workshop not found' });
    }
    return res.json(sanitizeWorkshop(workshop));
  } catch (err) {
    console.error('Get workshop error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/workshops/:code/autoprint - Toggle autoprint (moderator only)
router.put('/:code/autoprint', requireModerator, (req, res) => {
  try {
    const workshop = workshopOps.findByCode(req.params.code.toUpperCase());
    if (!workshop) {
      return res.status(404).json({ error: 'Workshop not found' });
    }
    if (workshop.moderator_id !== req.session.moderatorId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { autoprint } = req.body;
    workshopOps.setAutoprint(workshop.code, autoprint);
    return res.json({ code: workshop.code, autoprint: !!autoprint });
  } catch (err) {
    console.error('Set autoprint error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/workshops/:code/join - Join a workshop as participant
router.post('/:code/join', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Participant name is required' });
  }
  try {
    const workshop = workshopOps.findByCode(req.params.code.toUpperCase());
    if (!workshop) {
      return res.status(404).json({ error: 'Workshop not found' });
    }
    const participant = participantOps.create(workshop.id, name.trim());
    // Store participant token in session
    req.session.participantToken = participant.token;
    req.session.participantId = participant.id;
    req.session.workshopId = workshop.id;
    return res.status(201).json({
      token: participant.token,
      participant: { id: participant.id, name: participant.name },
      workshop: sanitizeWorkshop(workshop),
    });
  } catch (err) {
    console.error('Join workshop error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

function sanitizeWorkshop(w) {
  return {
    id: w.id,
    code: w.code,
    name: w.name,
    autoprint: !!w.autoprint,
    created_at: w.created_at,
  };
}

module.exports = router;
