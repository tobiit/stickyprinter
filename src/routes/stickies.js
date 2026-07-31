'use strict';

const express = require('express');
const router = express.Router();
const { stickyOps, participantOps, workshopOps } = require('../db');
const { requireModerator, requireParticipant } = require('../middleware/auth');
const { printSticky } = require('../printer');
const { getSseClients } = require('./stream');

const participantAuth = requireParticipant(participantOps);

// POST /api/stickies - Create a new sticky note (participant only)
router.post('/', participantAuth, (req, res) => {
  try {
    const sticky = stickyOps.create(req.participant.workshop_id, req.participant.id);
    return res.status(201).json(sticky);
  } catch (err) {
    console.error('Create sticky error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/stickies/mine - List participant's stickies
router.get('/mine', participantAuth, (req, res) => {
  try {
    const stickies = stickyOps.findByParticipant(req.participant.id);
    return res.json(stickies);
  } catch (err) {
    console.error('List stickies error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/stickies/workshop/:code - List stickies for a workshop (moderator only)
router.get('/workshop/:code', requireModerator, (req, res) => {
  try {
    const workshop = workshopOps.findByCode(req.params.code.toUpperCase());
    if (!workshop) {
      return res.status(404).json({ error: 'Workshop not found' });
    }
    if (workshop.moderator_id !== req.session.moderatorId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { status } = req.query;
    const stickies = stickyOps.findByWorkshop(workshop.id, status || null);
    const enriched = stickies.map((s) => {
      const participant = participantOps.findById(s.participant_id);
      return { ...s, participant_name: participant ? participant.name : 'Unknown' };
    });
    return res.json(enriched);
  } catch (err) {
    console.error('List workshop stickies error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/stickies/:id - Get a sticky note
router.get('/:id', (req, res) => {
  try {
    const sticky = stickyOps.findById(req.params.id);
    if (!sticky) {
      return res.status(404).json({ error: 'Sticky not found' });
    }
    // Moderators can view any sticky in their workshops; participants can only view their own
    const isModerator = req.session && req.session.moderatorId;
    if (isModerator) {
      const db = require('../db').getDb();
      const workshopRow = db.prepare('SELECT * FROM workshops WHERE id = ?').get(sticky.workshop_id);
      if (!workshopRow || workshopRow.moderator_id !== req.session.moderatorId) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      const participant = participantOps.findById(sticky.participant_id);
      return res.json({
        ...sticky,
        workshop_code: workshopRow.code,
        participant_name: participant ? participant.name : 'Unknown',
      });
    }
    // Participant check via token
    let token = req.session && req.session.participantToken;
    const authHeader = req.headers.authorization;
    if (!token && authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7);
    }
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const participant = participantOps.findByToken(token);
    if (!participant || participant.id !== sticky.participant_id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    return res.json(sticky);
  } catch (err) {
    console.error('Get sticky error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/stickies/:id - Update a sticky note (participant only, must be draft or returned)
router.put('/:id', participantAuth, (req, res) => {
  try {
    const sticky = stickyOps.findById(req.params.id);
    if (!sticky) {
      return res.status(404).json({ error: 'Sticky not found' });
    }
    if (sticky.participant_id !== req.participant.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (!['draft'].includes(sticky.status)) {
      return res.status(409).json({ error: 'Cannot edit a sticky that has been submitted' });
    }
    const { content, image_data } = req.body;
    const updated = stickyOps.update(sticky.id, content || '', image_data || null);
    return res.json(updated);
  } catch (err) {
    console.error('Update sticky error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/stickies/:id/submit - Submit a sticky (participant only)
router.post('/:id/submit', participantAuth, async (req, res) => {
  try {
    const sticky = stickyOps.findById(req.params.id);
    if (!sticky) {
      return res.status(404).json({ error: 'Sticky not found' });
    }
    if (sticky.participant_id !== req.participant.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (sticky.status !== 'draft') {
      return res.status(409).json({ error: 'Sticky is already submitted' });
    }

    const submitted = stickyOps.submit(sticky.id);
    const workshop = workshopOps.findByCode(
      require('../db').getDb().prepare('SELECT code FROM workshops WHERE id = ?').get(sticky.workshop_id).code
    );
    const participant = participantOps.findById(sticky.participant_id);

    // Notify moderator via SSE
    const preview = (submitted.content || '').substring(0, 60);
    notifyModerator(workshop.code, {
      type: 'sticky_submitted',
      sticky_id: submitted.id,
      participant_name: participant.name,
      participant_sticky_index: submitted.participant_sticky_index,
      preview,
      autoprint: !!workshop.autoprint,
    });

    // Autoprint if enabled
    if (workshop.autoprint) {
      try {
        await printSticky(submitted, participant, workshop);
        stickyOps.print(submitted.id);
        notifyModerator(workshop.code, {
          type: 'sticky_printed',
          sticky_id: submitted.id,
          method: 'autoprint',
        });
      } catch (printErr) {
        console.error('Autoprint error:', printErr);
      }
    }

    return res.json(stickyOps.findById(submitted.id));
  } catch (err) {
    console.error('Submit sticky error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/stickies/:id/print - Print a sticky (moderator only)
router.post('/:id/print', requireModerator, async (req, res) => {
  try {
    const sticky = stickyOps.findById(req.params.id);
    if (!sticky) {
      return res.status(404).json({ error: 'Sticky not found' });
    }
    const db = require('../db').getDb();
    const workshopRow = db.prepare('SELECT * FROM workshops WHERE id = ?').get(sticky.workshop_id);
    if (!workshopRow || workshopRow.moderator_id !== req.session.moderatorId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (!['submitted', 'printed'].includes(sticky.status)) {
      return res.status(409).json({ error: 'Sticky must be submitted before printing' });
    }

    const participant = participantOps.findById(sticky.participant_id);
    const result = await printSticky(sticky, participant, workshopRow);
    const updated = stickyOps.print(sticky.id);
    return res.json({ ...updated, print_result: result });
  } catch (err) {
    console.error('Print sticky error:', err);
    return res.status(500).json({ error: 'Print error: ' + err.message });
  }
});

// POST /api/stickies/:id/reject - Reject/return a sticky to participant (moderator only)
router.post('/:id/reject', requireModerator, (req, res) => {
  try {
    const sticky = stickyOps.findById(req.params.id);
    if (!sticky) {
      return res.status(404).json({ error: 'Sticky not found' });
    }
    const db = require('../db').getDb();
    const workshopRow = db.prepare('SELECT * FROM workshops WHERE id = ?').get(sticky.workshop_id);
    if (!workshopRow || workshopRow.moderator_id !== req.session.moderatorId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (sticky.status !== 'submitted') {
      return res.status(409).json({ error: 'Only submitted stickies can be rejected' });
    }
    const updated = stickyOps.reject(sticky.id);
    return res.json(updated);
  } catch (err) {
    console.error('Reject sticky error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/stickies/:id - Delete a sticky (participant only, must be draft)
router.delete('/:id', participantAuth, (req, res) => {
  try {
    const sticky = stickyOps.findById(req.params.id);
    if (!sticky) {
      return res.status(404).json({ error: 'Sticky not found' });
    }
    if (sticky.participant_id !== req.participant.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (sticky.status !== 'draft') {
      return res.status(409).json({ error: 'Cannot delete a submitted sticky' });
    }
    stickyOps.delete(sticky.id);
    return res.json({ message: 'Deleted' });
  } catch (err) {
    console.error('Delete sticky error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

function notifyModerator(workshopCode, event) {
  const clients = getSseClients(workshopCode);
  const data = JSON.stringify(event);
  for (const client of clients) {
    try {
      client.write(`data: ${data}\n\n`);
    } catch (_) {}
  }
}

module.exports = router;
