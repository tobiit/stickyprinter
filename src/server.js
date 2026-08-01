'use strict';

const express = require('express');
const session = require('express-session');
const path = require('path');
const { randomBytes } = require('crypto');
const { getDb, stickyOps } = require('./db');
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

// Static files. "no-cache" (not "no-store") keeps ETag/Last-Modified
// revalidation — the browser still gets fast 304s for unchanged files, but
// never silently serves a stale copy without checking. Without this,
// browsers apply heuristic freshness caching and can keep serving an old
// app.js/blePrinter.js after a code change (locally during `run-local.sh`
// or after a production redeploy) until a hard refresh — this app has no
// build step / content-hashed filenames to bust the cache otherwise.
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res) => res.set('Cache-Control', 'no-cache'),
}));

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
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Error handler
app.use((err, req, res, _next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

function runStickyCleanup() {
  try {
    const deleted = stickyOps.deleteExpired();
    if (deleted > 0) {
      console.log(`[cleanup] Deleted ${deleted} sticky/stickies submitted over 24h ago (not marked valuable).`);
    }
  } catch (err) {
    console.error('[cleanup] Failed to delete expired stickies:', err);
  }
}

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`StickyPrinter server running on http://localhost:${PORT}`);
  });
  runStickyCleanup();
  setInterval(runStickyCleanup, CLEANUP_INTERVAL_MS).unref();
}

module.exports = app;
