'use strict';

require('dotenv').config();
const path     = require('path');
const Database = require('better-sqlite3');
const { initDb, DB_PATH } = require('./init');

let _db = null;

function getDb() {
  if (_db) return _db;
  // initDb creates directory + runs schema if tables don't exist
  _db = initDb();
  // Enforce foreign keys on every connection
  _db.pragma('foreign_keys = ON');
  _db.pragma('journal_mode = WAL');
  return _db;
}

module.exports = { getDb };
