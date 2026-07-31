'use strict';

const express = require('express');
const session = require('express-session');
const path = require('path');
const { randomBytes } = require('crypto');
const { getDb } = require('./db');
const { SqliteSessionStore } = require('./sessionStore');

const app = express();

// Trust the nginx reverse proxy so req.secure / the "secure" cookie flag
// reflect the original HTTPS connection instead of the plain-HTTP hop to Node.
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Session
const sessionSecret = process.env.SESSION_SECRET || randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) {
  console.warn('SESSION_SECRET not set — using a random secret; sessions will not survive a restart.');
}
app.use(
  session({
    store: new SqliteSessionStore(getDb()),
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    },
  })
);

// Static files
app.use(express.static(path.join(__dirname, '..', 'public')));

// API routes
const authRouter = require('./routes/auth');
const workshopsRouter = require('./routes/workshops');
const stickiesRouter = require('./routes/stickies');
const { router: streamRouter } = require('./routes/stream');

app.use('/api/auth', authRouter);
app.use('/api/workshops', workshopsRouter);
app.use('/api/stickies', stickiesRouter);
app.use('/api/stream', streamRouter);

// SPA fallback - serve index.html for all non-API routes
app.get(/^\/(?!api).*/, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Error handler
app.use((err, req, res, _next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`StickyPrinter server running on http://localhost:${PORT}`);
  });
}

module.exports = app;
