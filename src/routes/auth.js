'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const { moderatorOps } = require('../db');

// POST /api/auth/register - Create a moderator account (first-time setup)
router.post('/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  if (username.length < 3 || username.length > 50) {
    return res.status(400).json({ error: 'Username must be between 3 and 50 characters' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  try {
    const existing = moderatorOps.findByUsername(username);
    if (existing) {
      return res.status(409).json({ error: 'Username already taken' });
    }
    const passwordHash = await bcrypt.hash(password, 12);
    const result = moderatorOps.create(username, passwordHash);
    req.session.moderatorId = result.lastInsertRowid;
    req.session.moderatorUsername = username;
    return res.status(201).json({ message: 'Account created', username });
  } catch (err) {
    console.error('Register error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  try {
    const moderator = moderatorOps.findByUsername(username);
    if (!moderator) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const valid = await bcrypt.compare(password, moderator.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    req.session.moderatorId = moderator.id;
    req.session.moderatorUsername = moderator.username;
    return res.json({ message: 'Logged in', username: moderator.username });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ message: 'Logged out' });
  });
});

// GET /api/auth/me
router.get('/me', (req, res) => {
  if (!req.session.moderatorId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  return res.json({ username: req.session.moderatorUsername, id: req.session.moderatorId });
});

module.exports = router;
