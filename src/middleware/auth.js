'use strict';

/**
 * requireModerator middleware - rejects requests without a valid moderator session.
 */
function requireModerator(req, res, next) {
  if (!req.session || !req.session.moderatorId) {
    return res.status(401).json({ error: 'Moderator authentication required' });
  }
  next();
}

/**
 * requireParticipant middleware - rejects requests without a valid participant token.
 * Checks Authorization header (****** or session.
 */
function requireParticipant(participantOps) {
  return (req, res, next) => {
    let token = req.session && req.session.participantToken;
    const authHeader = req.headers.authorization;
    if (!token && authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7);
    }
    if (!token) {
      return res.status(401).json({ error: 'Participant authentication required' });
    }
    const participant = participantOps.findByToken(token);
    if (!participant) {
      return res.status(401).json({ error: 'Invalid participant token' });
    }
    req.participant = participant;
    next();
  };
}

module.exports = { requireModerator, requireParticipant };
