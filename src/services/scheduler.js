'use strict';

const { getDb } = require('../db/connection');
const { sendPending, sendDailySummary, sendOverdueReminders } = require('./whatsappService');

let _timers = [];

/**
 * Run all scheduled tasks once immediately (for testing).
 */
async function runNow() {
  const db         = getDb();
  const properties = db.prepare('SELECT id FROM properties').all();

  for (const p of properties) {
    sendDailySummary(p.id);
    sendOverdueReminders(p.id);
  }

  await sendPending();
}

/**
 * Start the scheduler.
 * - Every 5 minutes: flush the WhatsApp send queue
 * - At 21:00 IST daily: send daily summary + overdue reminders
 *
 * Uses simple setInterval — replace with node-cron for production.
 */
function startScheduler() {
  console.log('⏰ Scheduler started');

  // Flush send queue every 5 minutes
  const flushTimer = setInterval(async () => {
    try {
      await sendPending();
    } catch (err) {
      console.error('[Scheduler] sendPending error:', err.message);
    }
  }, 5 * 60 * 1000);

  // Daily 9 PM IST = 15:30 UTC
  const dailyTimer = setInterval(() => {
    const now = new Date();
    const utcH = now.getUTCHours();
    const utcM = now.getUTCMinutes();
    if (utcH === 15 && utcM >= 30 && utcM < 35) {
      runNow().catch(err => console.error('[Scheduler] runNow error:', err.message));
    }
  }, 5 * 60 * 1000); // re-check every 5 min

  _timers = [flushTimer, dailyTimer];
}

function stopScheduler() {
  _timers.forEach(t => clearInterval(t));
  _timers = [];
}

module.exports = { startScheduler, stopScheduler, runNow };
