'use strict';

/**
 * Minimal SQLite-backed express-session store, built on the app's existing
 * better-sqlite3 connection. Avoids pulling in a second SQLite driver
 * (connect-sqlite3) or a GPL-licensed dependency (better-sqlite3-session-store)
 * for what is a small, well-defined interface (get/set/destroy/touch).
 */

const session = require('express-session');

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // matches the session cookie maxAge

class SqliteSessionStore extends session.Store {
  constructor(db) {
    super();
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `);
    this.getStmt = db.prepare('SELECT data, expires_at FROM sessions WHERE sid = ?');
    this.setStmt = db.prepare(
      'INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at'
    );
    this.destroyStmt = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this.touchStmt = db.prepare('UPDATE sessions SET expires_at = ? WHERE sid = ?');
    this.pruneStmt = db.prepare('DELETE FROM sessions WHERE expires_at < ?');

    // Periodically sweep expired sessions so the table doesn't grow unbounded.
    this.pruneInterval = setInterval(() => {
      try { this.pruneStmt.run(Date.now()); } catch (_) {}
    }, 60 * 60 * 1000);
    this.pruneInterval.unref();
  }

  get(sid, callback) {
    try {
      const row = this.getStmt.get(sid);
      if (!row || row.expires_at < Date.now()) return callback(null, null);
      callback(null, JSON.parse(row.data));
    } catch (err) {
      callback(err);
    }
  }

  set(sid, sessionData, callback) {
    try {
      const maxAge = sessionData.cookie && sessionData.cookie.maxAge;
      const expiresAt = Date.now() + (typeof maxAge === 'number' ? maxAge : DEFAULT_TTL_MS);
      this.setStmt.run(sid, JSON.stringify(sessionData), expiresAt);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  destroy(sid, callback) {
    try {
      this.destroyStmt.run(sid);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  touch(sid, sessionData, callback) {
    try {
      const maxAge = sessionData.cookie && sessionData.cookie.maxAge;
      const expiresAt = Date.now() + (typeof maxAge === 'number' ? maxAge : DEFAULT_TTL_MS);
      this.touchStmt.run(expiresAt, sid);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }
}

module.exports = { SqliteSessionStore };
