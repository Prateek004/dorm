'use strict';

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || './data/sthappit.db';

function initDb() {
  // Ensure data directory exists
  const dir = path.dirname(path.resolve(DB_PATH));
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(path.resolve(DB_PATH));

  // WAL mode for concurrent reads
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const schema = fs.readFileSync(
    path.join(__dirname, 'schema.sql'),
    'utf8'
  );

  // Execute each statement separately (better-sqlite3 doesn't support multi-statement exec)
  const statements = schema
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith('--'));

  for (const stmt of statements) {
    try {
      db.prepare(stmt).run();
    } catch (err) {
      // PRAGMA statements that are selects return results — handle gracefully
      if (!err.message.includes('not an error')) {
        console.error(`Schema error on: ${stmt.substring(0, 60)}...`);
        throw err;
      }
    }
  }

  console.log('✅ Database initialised at', path.resolve(DB_PATH));
  return db;
}

module.exports = { initDb, DB_PATH };

// Allow direct execution: node src/db/init.js
if (require.main === module) {
  initDb();
}
