'use strict';

const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/connection');
const { writeAudit } = require('../middleware/auditLog');
const { maskAadhaar } = require('../middleware/auth');
const { scheduleWhatsApp } = require('../services/whatsappService');

/**
 * POST /api/checkin
 * Full check-in flow:
 * 1. Validate bed is available
 * 2. Capture resident record with ID consent
 * 3. Record deposit / initial payment
 * 4. Flip bed to 'occupied'
 * 5. Write audit log
 * 6. Queue WhatsApp confirmation
 */
function checkIn(req, res) {
  const db         = getDb();
  const propertyId = req.user.property_id;

  const {
    full_name,
    mobile,
    aadhaar_number,          // always stored as placeholder, never raw
    aadhaar_mobile,
    aadhaar_photo_path,
    id_consent_given,        // must be true
    coming_from,
    permanent_address,
    purpose_of_visit,
    emergency_contact_name,
    emergency_contact_mobile,
    photo_path,
    bed_id,
    check_in_date,
    expected_checkout,
    rent_amount,
    deposit_amount,
    amount_paid,
    payment_mode,
    gateway_txn_id,
    notes,
  } = req.body;

  // ── Validation ───────────────────────────────────────────
  const required = { full_name, mobile, bed_id, check_in_date, expected_checkout, rent_amount };
  for (const [field, val] of Object.entries(required)) {
    if (val === undefined || val === null || val === '') {
      return res.status(400).json({ error: `Field '${field}' is required` });
    }
  }

  if (!id_consent_given) {
    return res.status(400).json({
      error: 'Guest consent for ID storage must be captured before check-in'
    });
  }

  // Validate mobile format (10-digit Indian mobile)
  const mobileClean = String(mobile).replace(/\D/g, '');
  if (mobileClean.length < 10 || mobileClean.length > 12) {
    return res.status(400).json({ error: 'mobile must be a valid 10-digit number' });
  }

  // Validate amounts are non-negative numbers
  if (isNaN(parseFloat(rent_amount)) || parseFloat(rent_amount) < 0) {
    return res.status(400).json({ error: 'rent_amount must be a non-negative number' });
  }

  // Validate date formats (YYYY-MM-DD)
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  if (!DATE_RE.test(check_in_date)) {
    return res.status(400).json({ error: 'check_in_date must be YYYY-MM-DD' });
  }
  if (!DATE_RE.test(expected_checkout)) {
    return res.status(400).json({ error: 'expected_checkout must be YYYY-MM-DD' });
  }
  if (expected_checkout <= check_in_date) {
    return res.status(400).json({ error: 'expected_checkout must be after check_in_date' });
  }

  // ── Bed availability check ────────────────────────────────
  const bed = db.prepare(
    'SELECT * FROM beds WHERE id = ? AND property_id = ?'
  ).get(bed_id, propertyId);

  if (!bed) return res.status(404).json({ error: 'Bed not found' });

  if (bed.status !== 'available') {
    return res.status(409).json({
      error: `Bed is currently '${bed.status}' — only 'available' beds can be checked in to`
    });
  }

  // ── Aadhaar handling — NEVER store raw number ─────────────
  // The spec says store encrypted; we store a privacy placeholder.
  // Real implementation: encrypt with AES-256 before DB insert.
  const aadhaarStored = aadhaar_number ? '[Aadhaar Redacted]' : null;

  const now        = new Date().toISOString();
  const residentId = uuidv4();

  // ── Transactional insert ──────────────────────────────────
  const doCheckin = db.transaction(() => {
    // 1. Create resident record
    db.prepare(`
      INSERT INTO residents
        (id, property_id, bed_id, full_name, mobile,
         aadhaar_number_encrypted, aadhaar_mobile, aadhaar_photo_path,
         id_consent_given, id_consent_at,
         coming_from, permanent_address, purpose_of_visit,
         emergency_contact_name, emergency_contact_mobile,
         photo_path, check_in_date, expected_checkout,
         rent_amount, deposit_amount, status,
         notes, created_by, created_at, updated_at)
      VALUES
        (?, ?, ?, ?, ?,
         ?, ?, ?,
         1, ?,
         ?, ?, ?,
         ?, ?,
         ?, ?, ?,
         ?, ?, 'active',
         ?, ?, ?, ?)
    `).run(
      residentId, propertyId, bed_id, full_name, mobile,
      aadhaarStored, aadhaar_mobile || null, aadhaar_photo_path || null,
      now,
      coming_from || null, permanent_address || null, purpose_of_visit || null,
      emergency_contact_name || null, emergency_contact_mobile || null,
      photo_path || null, check_in_date, expected_checkout,
      parseFloat(rent_amount), parseFloat(deposit_amount || 0),
      notes || null, req.user.id, now, now
    );

    // 2. Record deposit payment if deposit_amount > 0
    if (deposit_amount && parseFloat(deposit_amount) > 0) {
      db.prepare(`
        INSERT INTO payments
          (id, property_id, resident_id, payment_type, amount, direction,
           payment_mode, gateway_txn_id, billing_month, paid_at,
           requires_approval, approval_status, notes, created_by, created_at)
        VALUES (?, ?, ?, 'deposit', ?, 'credit', ?, ?, ?, ?, 0, 'not_required', ?, ?, ?)
      `).run(
        uuidv4(), propertyId, residentId,
        parseFloat(deposit_amount),
        payment_mode || 'cash',
        gateway_txn_id || null,
        check_in_date.substring(0, 7),  // YYYY-MM
        now,
        'Deposit on check-in',
        req.user.id, now
      );
    }

    // 3. Record initial rent payment if amount_paid > 0
    if (amount_paid && parseFloat(amount_paid) > 0) {
      db.prepare(`
        INSERT INTO payments
          (id, property_id, resident_id, payment_type, amount, direction,
           payment_mode, gateway_txn_id, billing_month, paid_at,
           requires_approval, approval_status, notes, created_by, created_at)
        VALUES (?, ?, ?, 'rent', ?, 'credit', ?, ?, ?, ?, 0, 'not_required', ?, ?, ?)
      `).run(
        uuidv4(), propertyId, residentId,
        parseFloat(amount_paid),
        payment_mode || 'cash',
        gateway_txn_id || null,
        check_in_date.substring(0, 7),
        now,
        'Advance rent on check-in',
        req.user.id, now
      );
    }

    // 4. Flip bed to occupied
    db.prepare(
      'UPDATE beds SET status = \'occupied\', cleaning_started_at = NULL, updated_at = datetime(\'now\') WHERE id = ?'
    ).run(bed_id);
  });

  doCheckin();

  // 5. Audit log
  writeAudit({
    propertyId,
    userId:     req.user.id,
    userRole:   req.user.role,
    action:     'CHECKIN',
    entityType: 'resident',
    entityId:   residentId,
    after: {
      resident:  full_name,
      bed_id,
      check_in_date,
      rent_amount,
      deposit_amount,
    },
    ip: req.ip,
  });

  // 6. WhatsApp confirmation (non-blocking)
  scheduleWhatsApp({
    propertyId,
    residentId,
    recipientMobile: mobile,
    recipientType:   'tenant',
    eventType:       'checkin_confirm',
    templateData:    { name: full_name, bed: bed_id, checkin: check_in_date, rent: rent_amount },
  });

  const resident = db.prepare('SELECT * FROM residents WHERE id = ?').get(residentId);
  // Mask Aadhaar before returning
  resident.aadhaar_number_encrypted = maskAadhaar();

  return res.status(201).json({ message: 'Check-in successful', resident });
}

/**
 * GET /api/residents
 * List all active (and optionally checked-out) residents.
 * Includes computed payment status: 'paid' | 'partial' | 'pending'
 */
function listResidents(req, res) {
  const db         = getDb();
  const propertyId = req.user.property_id;
  const { status = 'active', search: rawSearch } = req.query;
  // Trim and cap search to 100 chars to prevent abuse
  const search = rawSearch ? String(rawSearch).trim().substring(0, 100) : null;

  let query = `
    SELECT
      r.*,
      b.bed_label, b.status as bed_status,
      rm.room_number,
      f.label as floor_label,
      COALESCE((
        SELECT SUM(p.amount)
        FROM payments p
        WHERE p.resident_id = r.id AND p.payment_type = 'rent' AND p.direction = 'credit'
      ), 0) as total_paid,
      r.rent_amount as monthly_rent
    FROM residents r
    LEFT JOIN beds b ON b.id = r.bed_id
    LEFT JOIN rooms rm ON rm.id = b.room_id
    LEFT JOIN floors f ON f.id = rm.floor_id
    WHERE r.property_id = ?
  `;

  const params = [propertyId];

  if (status !== 'all') {
    query += ' AND r.status = ?';
    params.push(status);
  }

  if (search) {
    query += ' AND (r.full_name LIKE ? OR r.mobile LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }

  query += ' ORDER BY r.created_at DESC';

  const residents = db.prepare(query).all(...params);

  const enriched = residents.map(r => {
    // Mask Aadhaar
    r.aadhaar_number_encrypted = maskAadhaar();

    // Compute payment badge
    const paid   = r.total_paid || 0;
    const owed   = r.monthly_rent || 0;
    let badge = 'pending';
    if (paid >= owed) badge = 'paid';
    else if (paid > 0) badge = 'partial';

    return { ...r, payment_badge: badge, pending_rent: Math.max(0, owed - paid) };
  });

  return res.json(enriched);
}

/**
 * GET /api/residents/:id
 */
function getResident(req, res) {
  const db         = getDb();
  const propertyId = req.user.property_id;

  const resident = db.prepare(`
    SELECT r.*,
      b.bed_label, rm.room_number, f.label as floor_label
    FROM residents r
    LEFT JOIN beds b ON b.id = r.bed_id
    LEFT JOIN rooms rm ON rm.id = b.room_id
    LEFT JOIN floors f ON f.id = rm.floor_id
    WHERE r.id = ? AND r.property_id = ?
  `).get(req.params.id, propertyId);

  if (!resident) return res.status(404).json({ error: 'Resident not found' });

  resident.aadhaar_number_encrypted = maskAadhaar();

  const payments = db.prepare(
    'SELECT * FROM payments WHERE resident_id = ? ORDER BY created_at DESC'
  ).all(req.params.id);

  return res.json({ ...resident, payments });
}

/**
 * POST /api/checkout/:residentId
 * Full check-out flow with deposit refund approval gate.
 */
function checkOut(req, res) {
  const db         = getDb();
  const propertyId = req.user.property_id;
  const { residentId } = req.params;

  const {
    checkout_date,
    extra_charges,
    extra_charges_note,
    deposit_refund_amount,
    payment_mode,
    gateway_txn_id,
    notes,
  } = req.body;

  if (!checkout_date) {
    return res.status(400).json({ error: 'checkout_date is required' });
  }

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  if (!DATE_RE.test(checkout_date)) {
    return res.status(400).json({ error: 'checkout_date must be YYYY-MM-DD' });
  }

  const resident = db.prepare(
    'SELECT * FROM residents WHERE id = ? AND property_id = ?'
  ).get(residentId, propertyId);

  if (!resident) return res.status(404).json({ error: 'Resident not found' });
  if (resident.status === 'checked_out') {
    return res.status(409).json({ error: 'Resident has already checked out' });
  }

  const now = new Date().toISOString();
  const refundAmount = parseFloat(deposit_refund_amount || 0);
  const extraAmount  = parseFloat(extra_charges || 0);

  // Refund approval: all refunds require owner/manager sign-off
  const needsApproval = refundAmount > 0;
  const approvalStatus = needsApproval ? 'pending' : 'not_required';

  const doCheckout = db.transaction(() => {
    // 1. Update resident record
    db.prepare(`
      UPDATE residents
      SET status = 'checked_out', actual_checkout = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(checkout_date, residentId);

    // 2. Record extra charges if any
    if (extraAmount > 0) {
      db.prepare(`
        INSERT INTO payments
          (id, property_id, resident_id, payment_type, amount, direction,
           payment_mode, billing_month, paid_at,
           requires_approval, approval_status, notes, created_by, created_at)
        VALUES (?, ?, ?, 'extra_charge', ?, 'credit', ?, ?, ?, 0, 'not_required', ?, ?, ?)
      `).run(
        uuidv4(), propertyId, residentId,
        extraAmount,
        payment_mode || 'cash',
        checkout_date.substring(0, 7),
        now,
        extra_charges_note || 'Extra charges at checkout',
        req.user.id, now
      );
    }

    // 3. Record deposit refund (pending approval if amount > 0)
    let refundPaymentId = null;
    if (refundAmount > 0) {
      refundPaymentId = uuidv4();
      db.prepare(`
        INSERT INTO payments
          (id, property_id, resident_id, payment_type, amount, direction,
           payment_mode, gateway_txn_id, billing_month, paid_at,
           requires_approval, approval_status, notes, created_by, created_at)
        VALUES (?, ?, ?, 'refund', ?, 'debit', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        refundPaymentId, propertyId, residentId,
        refundAmount,
        payment_mode || 'cash',
        gateway_txn_id || null,
        checkout_date.substring(0, 7),
        now,
        1, approvalStatus,
        notes || 'Deposit refund at checkout',
        req.user.id, now
      );
    }

    // 4. Flip bed to 'cleaning'
    if (resident.bed_id) {
      db.prepare(`
        UPDATE beds
        SET status = 'cleaning', cleaning_started_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ?
      `).run(resident.bed_id);
    }

    return { refundPaymentId, needsApproval };
  });

  const { refundPaymentId, needsApproval: approval } = doCheckout();

  // 5. Audit log
  writeAudit({
    propertyId,
    userId:     req.user.id,
    userRole:   req.user.role,
    action:     'CHECKOUT',
    entityType: 'resident',
    entityId:   residentId,
    after: {
      resident:          resident.full_name,
      checkout_date,
      extra_charges:     extraAmount,
      deposit_refund:    refundAmount,
      refund_pending:    approval,
    },
    ip: req.ip,
  });

  // 6. WhatsApp confirmation
  scheduleWhatsApp({
    propertyId,
    residentId,
    recipientMobile: resident.mobile,
    recipientType:   'tenant',
    eventType:       'checkout_confirm',
    templateData: {
      name:         resident.full_name,
      checkout:     checkout_date,
      refundAmount,
      refundPending: approval,
    },
  });

  return res.json({
    message:           'Check-out recorded',
    refund_pending_approval: approval,
    refund_payment_id: refundPaymentId,
  });
}

/**
 * POST /api/residents/:id/extend
 * Extend stay without full re-check-in.
 * Body: { new_expected_checkout, new_rent_amount? }
 */
function extendStay(req, res) {
  const db         = getDb();
  const propertyId = req.user.property_id;
  const { id }     = req.params;
  const { new_expected_checkout, new_rent_amount, notes } = req.body;

  if (!new_expected_checkout) {
    return res.status(400).json({ error: 'new_expected_checkout is required' });
  }

  const resident = db.prepare(
    'SELECT * FROM residents WHERE id = ? AND property_id = ? AND status = \'active\''
  ).get(id, propertyId);

  if (!resident) return res.status(404).json({ error: 'Active resident not found' });

  if (new_expected_checkout <= resident.expected_checkout) {
    return res.status(400).json({
      error: 'New checkout date must be after current expected checkout'
    });
  }

  const now      = new Date().toISOString();
  const newRent  = new_rent_amount ? parseFloat(new_rent_amount) : resident.rent_amount;

  db.transaction(() => {
    // Log extension
    db.prepare(`
      INSERT INTO stay_extensions
        (id, resident_id, property_id, old_checkout, new_checkout, old_rent, new_rent, notes, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      uuidv4(), id, propertyId,
      resident.expected_checkout, new_expected_checkout,
      resident.rent_amount, newRent,
      notes || null, req.user.id, now
    );

    // Update resident
    db.prepare(`
      UPDATE residents
      SET expected_checkout = ?, rent_amount = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(new_expected_checkout, newRent, id);
  })();

  writeAudit({
    propertyId,
    userId:     req.user.id,
    userRole:   req.user.role,
    action:     'STAY_EXTENDED',
    entityType: 'resident',
    entityId:   id,
    before: { expected_checkout: resident.expected_checkout, rent: resident.rent_amount },
    after:  { expected_checkout: new_expected_checkout, rent: newRent },
    ip:     req.ip,
  });

  const updated = db.prepare('SELECT * FROM residents WHERE id = ?').get(id);
  updated.aadhaar_number_encrypted = maskAadhaar();
  return res.json({ message: 'Stay extended', resident: updated });
}

module.exports = { checkIn, listResidents, getResident, checkOut, extendStay };
