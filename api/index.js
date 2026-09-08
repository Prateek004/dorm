'use strict';

/**
 * Vercel Serverless Entry Point
 * ─────────────────────────────
 * Vercel's /tmp is the only writable directory in a serverless function.
 * We override DB_PATH before any module loads the database so better-sqlite3
 * writes there instead of ./data/ (which is read-only on Vercel).
 *
 * ⚠️  Caveats:
 *   • /tmp is ephemeral — a fresh DB is created on every cold start.
 *     For durable production data use an external DB (Turso, PlanetScale, etc.)
 *   • The background scheduler (WhatsApp cron) does NOT run on Vercel because
 *     serverless functions are stateless. Use a Vercel Cron Job or an external
 *     scheduler service to hit the /api/health endpoint on a schedule instead.
 */

// Point SQLite at /tmp so the serverless function can write to it
if (!process.env.DB_PATH) {
  process.env.DB_PATH = '/tmp/sthappit.db';
}

// Import the Express app (does NOT call app.listen — server.js guards that)
const app = require('../src/server');

module.exports = app;
