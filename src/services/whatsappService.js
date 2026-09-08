'use strict';

const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/connection');

const TWILIO_SID    = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN  = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM   = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886';

// ── Message templates ─────────────────────────────────────
const TEMPLATES = {
  checkin_confirm: (d) =>
    `✅ *Check-in Confirmed*\nHello ${d.name}, your check-in has been recorded.\nBed: ${d.bed}\nDate: ${d.checkin}\nMonthly Rent: ₹${d.rent}\nWelcome to your new home! 🏠`,

  checkout_confirm: (d) =>
    `🔑 *Check-out Confirmed*\nHello ${d.name}, your check-out on ${d.checkout} has been recorded.\n${
      d.refundAmount > 0
        ? `Deposit refund of ₹${d.refundAmount} is ${d.refundPending ? 'pending approval.' : 'being processed.'}`
        : 'No deposit refund due.'
    }\nThank you for staying with us!`,

  payment_receipt: (d) =>
    `💰 *Payment Received*\nHello ${d.name}, we received ₹${d.amount} via ${d.mode} for ${d.month}.\nThank you!`,

  payment_due: (d) =>
    `⏰ *Rent Reminder*\nHello ${d.name}, your rent of ₹${d.amount} for ${d.month} is due on ${d.due_date}. Please arrange payment.\nThank you.`,

  overdue: (d) =>
    `🔴 *Overdue Rent*\nHello ${d.name}, your rent of ₹${d.amount} for ${d.month} is overdue. Please contact the manager immediately.`,

  daily_summary: (d) =>
    `📊 *DormBook Daily Summary — ${d.date}*\n\n` +
    `💵 Collection Today: ₹${d.collection}\n` +
    `⏳ Pending Dues: ₹${d.pending} (${d.pending_count} residents)\n` +
    `🏠 Check-ins: ${d.checkins} | Check-outs: ${d.checkouts}\n` +
    `🔔 Refunds Awaiting Approval: ${d.refunds_pending}\n\n` +
    `Open DormBook for full details.`,

  refund_alert: (d) =>
    `⚠️ *Refund Needs Approval*\nA deposit refund of ₹${d.amount} for ${d.resident} has been submitted and requires your approval.\nOpen DormBook → Approvals.`,
};

/**
 * Queue a WhatsApp message in the DB (async — does not block API response).
 * Actual sending happens via sendPending() called by the scheduler.
 */
function scheduleWhatsApp({ propertyId, residentId, recipientMobile, recipientType, eventType, templateData }) {
  try {
    const db      = getDb();
    const builder = TEMPLATES[eventType];
    if (!builder) return;

    const body = builder(templateData || {});

    db.prepare(`
      INSERT INTO notification_log
        (id, property_id, resident_id, recipient_mobile, recipient_type, event_type, message_body, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'))
    `).run(
      uuidv4(), propertyId, residentId || null,
      recipientMobile, recipientType, eventType, body
    );
  } catch (err) {
    console.error('[WhatsApp] Failed to queue message:', err.message);
  }
}

/**
 * Process pending WhatsApp messages from the queue.
 * Called by the daily cron scheduler.
 */
async function sendPending() {
  const db = getDb();
  const pending = db.prepare(
    'SELECT * FROM notification_log WHERE status = \'pending\' LIMIT 50'
  ).all();

  if (pending.length === 0) return;

  // Twilio is optional — if credentials missing, just mark as sent (dev mode)
  const hasTwilio = TWILIO_SID && TWILIO_TOKEN && !TWILIO_SID.startsWith('AC_');

  for (const msg of pending) {
    try {
      let providerMsgId = null;
      let status        = 'sent';

      if (hasTwilio) {
        const client   = require('twilio')(TWILIO_SID, TWILIO_TOKEN);
        const response = await client.messages.create({
          body: msg.message_body,
          from: TWILIO_FROM,
          to:   `whatsapp:+91${msg.recipient_mobile.replace(/\D/g, '').slice(-10)}`,
        });
        providerMsgId = response.sid;
        status        = 'delivered';
      } else {
        // Dev mode: log to console
        console.log(`[WhatsApp Dev] To: ${msg.recipient_mobile}`);
        console.log(`[WhatsApp Dev] Msg: ${msg.message_body.substring(0, 80)}...`);
        providerMsgId = `dev_${uuidv4()}`;
      }

      db.prepare(`
        UPDATE notification_log
        SET status = ?, provider_msg_id = ?, sent_at = datetime('now')
        WHERE id = ?
      `).run(status, providerMsgId, msg.id);
    } catch (err) {
      console.error(`[WhatsApp] Failed to send ${msg.id}:`, err.message);
      db.prepare(
        'UPDATE notification_log SET status = \'failed\' WHERE id = ?'
      ).run(msg.id);
    }
  }
}

/**
 * Send daily summary WhatsApp to owner(s).
 * Called nightly by cron.
 */
function sendDailySummary(propertyId) {
  const db = getDb();

  const today     = new Date().toISOString().substring(0, 10);
  const thisMonth = today.substring(0, 7);

  const collection = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total FROM payments
    WHERE property_id = ? AND direction = 'credit' AND date(paid_at) = ?
  `).get(propertyId, today);

  const pending = db.prepare(`
    SELECT
      COUNT(*) as count,
      COALESCE(SUM(r.rent_amount - COALESCE(paid.amount, 0)), 0) as total
    FROM residents r
    LEFT JOIN (
      SELECT resident_id, SUM(amount) as amount
      FROM payments WHERE direction = 'credit' AND payment_type = 'rent' AND billing_month = ?
      GROUP BY resident_id
    ) paid ON paid.resident_id = r.id
    WHERE r.property_id = ? AND r.status = 'active'
      AND (r.rent_amount - COALESCE(paid.amount, 0)) > 0
  `).get(thisMonth, propertyId);

  const checkins   = db.prepare(`SELECT COUNT(*) as c FROM residents WHERE property_id = ? AND check_in_date = ?`).get(propertyId, today);
  const checkouts  = db.prepare(`SELECT COUNT(*) as c FROM residents WHERE property_id = ? AND actual_checkout = ?`).get(propertyId, today);
  const refunds    = db.prepare(`SELECT COUNT(*) as c FROM payments WHERE property_id = ? AND approval_status = 'pending'`).get(propertyId);

  // Get owner(s) mobile
  const owners = db.prepare(
    'SELECT mobile FROM users WHERE property_id = ? AND role = \'owner\' AND is_active = 1'
  ).all(propertyId);

  for (const owner of owners) {
    scheduleWhatsApp({
      propertyId,
      residentId:      null,
      recipientMobile: owner.mobile,
      recipientType:   'owner',
      eventType:       'daily_summary',
      templateData: {
        date:           today,
        collection:     collection.total,
        pending:        pending.total,
        pending_count:  pending.count,
        checkins:       checkins.c,
        checkouts:      checkouts.c,
        refunds_pending: refunds.c,
      },
    });
  }
}

/**
 * Send overdue reminders to tenants with unpaid rent.
 * Called daily by cron.
 */
function sendOverdueReminders(propertyId) {
  const db        = getDb();
  const thisMonth = new Date().toISOString().substring(0, 7);

  const overdue = db.prepare(`
    SELECT r.id, r.full_name, r.mobile, r.rent_amount,
      COALESCE(paid.amount, 0) as paid_amount
    FROM residents r
    LEFT JOIN (
      SELECT resident_id, SUM(amount) as amount
      FROM payments WHERE direction = 'credit' AND payment_type = 'rent' AND billing_month = ?
      GROUP BY resident_id
    ) paid ON paid.resident_id = r.id
    WHERE r.property_id = ? AND r.status = 'active'
      AND (r.rent_amount - COALESCE(paid.amount, 0)) > 0
  `).all(thisMonth, propertyId);

  for (const r of overdue) {
    scheduleWhatsApp({
      propertyId,
      residentId:      r.id,
      recipientMobile: r.mobile,
      recipientType:   'tenant',
      eventType:       'overdue',
      templateData: {
        name:   r.full_name,
        amount: r.rent_amount - r.paid_amount,
        month:  thisMonth,
      },
    });
  }
}

module.exports = {
  scheduleWhatsApp,
  sendPending,
  sendDailySummary,
  sendOverdueReminders,
};
