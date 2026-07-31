'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const { randomBytes } = require('crypto');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'stickyprinter.db');

let db;

function getDb() {
  if (!db) {
    const fs = require('fs');
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initialize(db);
  }
  return db;
}

function initialize(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS moderators (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS workshops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      moderator_id INTEGER NOT NULL REFERENCES moderators(id),
      autoprint INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS participants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workshop_id INTEGER NOT NULL REFERENCES workshops(id),
      name TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      sticky_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS stickies (
      id TEXT PRIMARY KEY,
      workshop_id INTEGER NOT NULL REFERENCES workshops(id),
      participant_id INTEGER NOT NULL REFERENCES participants(id),
      content TEXT NOT NULL DEFAULT '',
      image_data TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      participant_sticky_index INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      submitted_at TEXT,
      printed_at TEXT
    );
  `);
}

// Workshop code generation: WS-ABCD-1234
function generateWorkshopCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const digits = '0123456789';
  const randomLetter = () => letters[randomBytes(1)[0] % letters.length];
  const randomDigit = () => digits[randomBytes(1)[0] % digits.length];
  const letterPart = Array.from({ length: 4 }, randomLetter).join('');
  const digitPart = Array.from({ length: 4 }, randomDigit).join('');
  return `WS-${letterPart}-${digitPart}`;
}

// Participant token generation
function generateToken() {
  return randomBytes(24).toString('hex');
}

// Moderator operations
const moderatorOps = {
  create(username, passwordHash) {
    const db = getDb();
    return db.prepare('INSERT INTO moderators (username, password_hash) VALUES (?, ?)').run(username, passwordHash);
  },
  findByUsername(username) {
    return getDb().prepare('SELECT * FROM moderators WHERE username = ?').get(username);
  },
  findById(id) {
    return getDb().prepare('SELECT * FROM moderators WHERE id = ?').get(id);
  },
};

// Workshop operations
const workshopOps = {
  create(name, moderatorId) {
    const db = getDb();
    let code;
    let attempts = 0;
    do {
      code = generateWorkshopCode();
      attempts++;
      if (attempts > 10) throw new Error('Could not generate unique workshop code');
    } while (db.prepare('SELECT id FROM workshops WHERE code = ?').get(code));
    db.prepare('INSERT INTO workshops (code, name, moderator_id) VALUES (?, ?, ?)').run(code, name, moderatorId);
    return db.prepare('SELECT * FROM workshops WHERE code = ?').get(code);
  },
  findByCode(code) {
    return getDb().prepare('SELECT * FROM workshops WHERE code = ?').get(code);
  },
  findByModerator(moderatorId) {
    return getDb().prepare('SELECT * FROM workshops WHERE moderator_id = ? ORDER BY created_at DESC').all(moderatorId);
  },
  setAutoprint(code, autoprint) {
    return getDb().prepare('UPDATE workshops SET autoprint = ? WHERE code = ?').run(autoprint ? 1 : 0, code);
  },
};

// Participant operations
const participantOps = {
  create(workshopId, name) {
    const db = getDb();
    const token = generateToken();
    const result = db.prepare('INSERT INTO participants (workshop_id, name, token) VALUES (?, ?, ?)').run(workshopId, name, token);
    return db.prepare('SELECT * FROM participants WHERE id = ?').get(result.lastInsertRowid);
  },
  findByToken(token) {
    return getDb().prepare('SELECT * FROM participants WHERE token = ?').get(token);
  },
  findById(id) {
    return getDb().prepare('SELECT * FROM participants WHERE id = ?').get(id);
  },
  findByWorkshop(workshopId) {
    return getDb().prepare('SELECT * FROM participants WHERE workshop_id = ?').all(workshopId);
  },
  incrementStickyCount(id) {
    const db = getDb();
    db.prepare('UPDATE participants SET sticky_count = sticky_count + 1 WHERE id = ?').run(id);
    return db.prepare('SELECT sticky_count FROM participants WHERE id = ?').get(id).sticky_count;
  },
};

// Sticky note operations
const stickyOps = {
  create(workshopId, participantId) {
    const db = getDb();
    const { randomUUID } = require('crypto');
    const id = randomUUID();
    const index = participantOps.incrementStickyCount(participantId);
    db.prepare(`
      INSERT INTO stickies (id, workshop_id, participant_id, content, status, participant_sticky_index)
      VALUES (?, ?, ?, '', 'draft', ?)
    `).run(id, workshopId, participantId, index);
    return db.prepare('SELECT * FROM stickies WHERE id = ?').get(id);
  },
  findById(id) {
    return getDb().prepare('SELECT * FROM stickies WHERE id = ?').get(id);
  },
  findByParticipant(participantId) {
    return getDb().prepare('SELECT * FROM stickies WHERE participant_id = ? ORDER BY created_at DESC').all(participantId);
  },
  findByWorkshop(workshopId, status) {
    const db = getDb();
    if (status) {
      return db.prepare('SELECT * FROM stickies WHERE workshop_id = ? AND status = ? ORDER BY submitted_at ASC').all(workshopId, status);
    }
    return db.prepare('SELECT * FROM stickies WHERE workshop_id = ? ORDER BY created_at DESC').all(workshopId);
  },
  update(id, content, imageData) {
    const db = getDb();
    db.prepare(`
      UPDATE stickies SET content = ?, image_data = ?, updated_at = datetime('now') WHERE id = ?
    `).run(content, imageData || null, id);
    return db.prepare('SELECT * FROM stickies WHERE id = ?').get(id);
  },
  submit(id) {
    const db = getDb();
    db.prepare(`
      UPDATE stickies SET status = 'submitted', submitted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?
    `).run(id);
    return db.prepare('SELECT * FROM stickies WHERE id = ?').get(id);
  },
  print(id) {
    const db = getDb();
    db.prepare(`
      UPDATE stickies SET status = 'printed', printed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?
    `).run(id);
    return db.prepare('SELECT * FROM stickies WHERE id = ?').get(id);
  },
  reject(id) {
    const db = getDb();
    db.prepare(`
      UPDATE stickies SET status = 'draft', submitted_at = NULL, updated_at = datetime('now') WHERE id = ?
    `).run(id);
    return db.prepare('SELECT * FROM stickies WHERE id = ?').get(id);
  },
  delete(id) {
    return getDb().prepare('DELETE FROM stickies WHERE id = ?').run(id);
  },
};

module.exports = { getDb, moderatorOps, workshopOps, participantOps, stickyOps };
