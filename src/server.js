'use strict';

const express = require('express');
const session = require('express-session');
const path = require('path');
const { randomBytes } = require('crypto');

const app = express();

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Session
const sessionSecret = process.env.SESSION_SECRET || randomBytes(32).toString('hex');
app.use(
  session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
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
