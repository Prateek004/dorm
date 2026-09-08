'use strict';

const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/connection');
const { writeAudit } = require('../middleware/auditLog');
const { scheduleWhatsApp } = require('../services/whatsappService');

/**
 * POST /api/payments
 * Record a payment (rent instalment, advance, extra charge).
 * Supports partial payments — multiple rows against same billing month.
 */
function createPayment(req, res) {
  const db         = getDb();
  const propertyId = req.user.property_id;

  const {
    resident_id,
    payment_type = 'rent',
    amount,
    payment_mode = 'cash',
    gateway_txn_id,
    billing_month,   // YYYY-MM
    due_date,
    notes,
  } = req.body;

  if (!resident_id || !amount) {
    return res.status(400).json({ error: 'resident_id and amount are required' });
  }

  if (parseFloat(amount) <= 0) {
    return res.status(400).json({ error: 'Amount must be greater than zero' });
  }

  const VALID_TYPES = ['rent', 'deposit', 'advance', 'extra_charge'];
  if (!VALID_TYPES.includes(payment_type)) {
    return res.status(400).json({ error: `payment_type must be one of: ${VALID_TYPES.join(', ')}` });
  }

  // Validate billing_month format if provided
  if (billing_month && !/^\d{4}-\d{2}$/.test(billing_month)) {
    return res.status(400).json({ error: 'billing_month must be YYYY-MM format' });
  }

  const resident = db.prepare(
    'SELECT * FROM residents WHERE id = ? AND property_id = ?'
  ).get(resident_id, propertyId);
  if (!resident) return res.status(404).json({ error: 'Resident not found' });

  const paymentId = uuidv4();
  const now       = new Date().toISOString();

  db.prepare(`
    INSERT INTO payments
      (id, property_id, resident_id, payment_type, amount, direction,
       payment_mode, gateway_txn_id, billing_month, due_date, paid_at,
       requires_approval, approval_status, notes, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, 'credit', ?, ?, ?, ?, ?, 0, 'not_required', ?, ?, ?)
  `).run(
    paymentId, propertyId, resident_id,
    payment_type, parseFloat(amount),
    payment_mode, gateway_txn_id || null,
    billing_month || now.substring(0, 7),
    due_date || null, now,
    notes || null, req.user.id, now
  );

  writeAudit({
    propertyId,
    userId:     req.user.id,
    userRole:   req.user.role,
    action:     'PAYMENT_CREATED',
    entityType: 'payment',
    entityId:   paymentId,
    after: { resident: resident.full_name, amount, payment_type, payment_mode },
    ip:   req.ip,
  });

  // WhatsApp receipt to tenant
  scheduleWhatsApp({
    propertyId,
    residentId:      resident_id,
    recipientMobile: resident.mobile,
    recipientType:   'tenant',
    eventType:       'payment_receipt',
    templateData: {
      name:    resident.full_name,
      amount,
      mode:    payment_mode,
      month:   billing_month || now.substring(0, 7),
    },
  });

  const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  return res.status(201).json(payment);
}

/**
 * GET /api/payments/resident/:residentId
 * Full payment ledger for one resident.
 */
function getResidentLedger(req, res) {
  const db         = getDb();
  const propertyId = req.user.property_id;

  const resident = db.prepare(
    'SELECT * FROM residents WHERE id = ? AND property_id = ?'
  ).get(req.params.residentId, propertyId);
  if (!resident) return res.status(404).json({ error: 'Resident not found' });

  const payments = db.prepare(
    'SELECT * FROM payments WHERE resident_id = ? ORDER BY paid_at DESC'
  ).all(req.params.residentId);

  const totalCredits = payments
    .filter(p => p.direction === 'credit')
    .reduce((s, p) => s + p.amount, 0);

  const totalDebits = payments
    .filter(p => p.direction === 'debit')
    .reduce((s, p) => s + p.amount, 0);

  const rentPaid = payments
    .filter(p => p.payment_type === 'rent' && p.direction === 'credit')
    .reduce((s, p) => s + p.amount, 0);

  const pendingDues = Math.max(0, (resident.rent_amount || 0) - rentPaid);

  return res.json({
    resident: {
      id:            resident.id,
      name:          resident.full_name,
      mobile:        resident.mobile,
      rent_amount:   resident.rent_amount,
      deposit_amount:resident.deposit_amount,
      check_in_date: resident.check_in_date,
      expected_checkout: resident.expected_checkout,
      status:        resident.status,
    },
    ledger: {
      total_credits: totalCredits,
      total_debits:  totalDebits,
      rent_paid:     rentPaid,
      pending_dues:  pendingDues,
    },
    payments,
  });
}

/**
 * GET /api/payments/pending
 * All residents with outstanding rent dues — used for owner dashboard.
 */
function getPendingDues(req, res) {
  const db         = getDb();
  const propertyId = req.user.property_id;

  const rows = db.prepare(`
    SELECT
      r.id as resident_id, r.full_name, r.mobile, r.expected_checkout,
      r.rent_amount, r.bed_id,
      b.bed_label, rm.room_number, f.label as floor_label,
      COALESCE((
        SELECT SUM(p2.amount)
        FROM payments p2
        WHERE p2.resident_id = r.id
          AND p2.payment_type = 'rent'
          AND p2.direction = 'credit'
          AND p2.billing_month = strftime('%Y-%m', 'now')
      ), 0) as rent_paid_this_month
    FROM residents r
    LEFT JOIN beds b ON b.id = r.bed_id
    LEFT JOIN rooms rm ON rm.id = b.room_id
    LEFT JOIN floors f ON f.id = rm.floor_id
    WHERE r.property_id = ? AND r.status = 'active'
    ORDER BY r.full_name
  `).all(propertyId);

  const pending = rows.map(r => ({
    ...r,
    pending_amount: Math.max(0, r.rent_amount - r.rent_paid_this_month),
    payment_status:
      r.rent_paid_this_month >= r.rent_amount ? 'paid' :
      r.rent_paid_this_month > 0 ? 'partial' : 'pending',
  })).filter(r => r.payment_status !== 'paid');

  const totalPendingAmount = pending.reduce((s, r) => s + r.pending_amount, 0);

  return res.json({ count: pending.length, total_pending: totalPendingAmount, residents: pending });
}

/**
 * POST /api/payments/:paymentId/approve
 * Owner/Manager approve or reject a pending refund.
 */
function approveRefund(req, res) {
  const db         = getDb();
  const propertyId = req.user.property_id;
  const { paymentId } = req.params;
  const { decision, notes } = req.body;  // decision: 'approved' | 'rejected'

  if (!['approved', 'rejected'].includes(decision)) {
    return res.status(400).json({ error: "decision must be 'approved' or 'rejected'" });
  }

  const payment = db.prepare(
    'SELECT * FROM payments WHERE id = ? AND property_id = ?'
  ).get(paymentId, propertyId);

  if (!payment) return res.status(404).json({ error: 'Payment not found' });
  if (payment.approval_status !== 'pending') {
    return res.status(409).json({ error: `Payment is already '${payment.approval_status}'` });
  }
  if (payment.payment_type !== 'refund') {
    return res.status(400).json({ error: 'Only refund payments require approval' });
  }

  const now = new Date().toISOString();

  db.prepare(`
    UPDATE payments
    SET approval_status = ?, approved_by = ?, approved_at = ?
    WHERE id = ?
  `).run(decision, req.user.id, now, paymentId);

  writeAudit({
    propertyId,
    userId:     req.user.id,
    userRole:   req.user.role,
    action:     decision === 'approved' ? 'REFUND_APPROVED' : 'REFUND_REJECTED',
    entityType: 'payment',
    entityId:   paymentId,
    before: { approval_status: 'pending' },
    after:  { approval_status: decision, approved_by: req.user.id },
    ip:     req.ip,
  });

  const updated = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  return res.json({ message: `Refund ${decision}`, payment: updated });
}

/**
 * GET /api/payments/pending-approvals
 * List all refunds awaiting approval — owner/manager only.
 */
function getPendingApprovals(req, res) {
  const db         = getDb();
  const propertyId = req.user.property_id;

  const rows = db.prepare(`
    SELECT p.*, r.full_name as resident_name, r.mobile as resident_mobile
    FROM payments p
    JOIN residents r ON r.id = p.resident_id
    WHERE p.property_id = ? AND p.approval_status = 'pending' AND p.payment_type = 'refund'
    ORDER BY p.created_at DESC
  `).all(propertyId);

  return res.json(rows);
}

module.exports = {
  createPayment,
  getResidentLedger,
  getPendingDues,
  approveRefund,
  getPendingApprovals,
};
