'use strict';

/**
 * Creates a moderator account directly in the DB, bypassing the HTTP API.
 * Used by deploy/run-local.sh --clean-db to seed a bootstrap admin account
 * for local testing. Safe to run against an existing DB: skips if the
 * username is already taken instead of erroring.
 *
 * Usage: node deploy/bootstrap-admin.js <username> <password>
 * Respects DB_PATH like the app itself (see src/db.js).
 */

const bcrypt = require('bcryptjs');
const { moderatorOps } = require('../src/db');

const [, , username, password] = process.argv;

if (!username || !password) {
  console.error('Usage: node bootstrap-admin.js <username> <password>');
  process.exit(1);
}

(async () => {
  if (moderatorOps.findByUsername(username)) {
    console.log(`Moderator "${username}" already exists, skipping bootstrap.`);
    return;
  }
  const passwordHash = await bcrypt.hash(password, 12);
  moderatorOps.create(username, passwordHash);
  console.log(`Bootstrap moderator "${username}" created.`);
})().catch((err) => {
  console.error('Bootstrap failed:', err);
  process.exit(1);
});
