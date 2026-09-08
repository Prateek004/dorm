'use strict';

const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/connection');
const { writeAudit } = require('../middleware/auditLog');

const CLEANING_MINUTES = parseInt(process.env.CLEANING_AUTO_REVERT_MINUTES || '120', 10);

/**
 * GET /api/beds
 * Returns full property bed map with floor/room hierarchy.
 * Automatically reverts "cleaning" beds if timer expired.
 */
function getBedMap(req, res) {
  const db         = getDb();
  const propertyId = req.user.property_id;

  // Auto-revert cleaning beds past timer (if CLEANING_MINUTES > 0)
  if (CLEANING_MINUTES > 0) {
    db.prepare(`
      UPDATE beds
      SET status = 'available', cleaning_started_at = NULL, updated_at = datetime('now')
      WHERE property_id = ?
        AND status = 'cleaning'
        AND cleaning_started_at IS NOT NULL
        AND (julianday('now') - julianday(cleaning_started_at)) * 1440 >= ?
    `).run(propertyId, CLEANING_MINUTES);
  }

  const floors = db.prepare(
    'SELECT * FROM floors WHERE property_id = ? ORDER BY floor_number'
  ).all(propertyId);

  const result = floors.map(floor => {
    const rooms = db.prepare(
      'SELECT * FROM rooms WHERE floor_id = ? ORDER BY room_number'
    ).all(floor.id);

    return {
      ...floor,
      rooms: rooms.map(room => {
        const beds = db.prepare(`
          SELECT b.*, r.full_name as resident_name, r.id as resident_id
          FROM beds b
          LEFT JOIN residents r ON r.bed_id = b.id AND r.status = 'active'
          WHERE b.room_id = ?
          ORDER BY b.bed_label
        `).all(room.id);

        return { ...room, beds };
      }),
    };
  });

  // Summary counts
  const summary = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'available' THEN 1 ELSE 0 END) as available,
      SUM(CASE WHEN status = 'occupied'  THEN 1 ELSE 0 END) as occupied,
      SUM(CASE WHEN status = 'reserved'  THEN 1 ELSE 0 END) as reserved,
      SUM(CASE WHEN status = 'cleaning'  THEN 1 ELSE 0 END) as cleaning
    FROM beds WHERE property_id = ?
  `).get(propertyId);

  return res.json({ summary, floors: result });
}

/**
 * PUT /api/beds/:bedId/status
 * Body: { status: 'available' | 'reserved' | 'cleaning' }
 * Cannot set to 'occupied' directly — use check-in flow.
 */
function updateBedStatus(req, res) {
  const db     = getDb();
  const { bedId } = req.params;
  const { status, notes } = req.body;

  const ALLOWED = ['available', 'reserved', 'cleaning'];
  if (!ALLOWED.includes(status)) {
    return res.status(400).json({
      error: `Status must be one of: ${ALLOWED.join(', ')}. Use check-in to set 'occupied'.`
    });
  }

  const bed = db.prepare(
    'SELECT * FROM beds WHERE id = ? AND property_id = ?'
  ).get(bedId, req.user.property_id);

  if (!bed) return res.status(404).json({ error: 'Bed not found' });

  if (bed.status === 'occupied') {
    return res.status(409).json({
      error: 'Cannot change an occupied bed status directly. Use the check-out flow.'
    });
  }

  const cleaningStarted = status === 'cleaning' ? new Date().toISOString() : null;

  db.prepare(`
    UPDATE beds
    SET status = ?, cleaning_started_at = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(status, cleaningStarted, bedId);

  writeAudit({
    propertyId: req.user.property_id,
    userId:     req.user.id,
    userRole:   req.user.role,
    action:     'BED_STATUS_CHANGED',
    entityType: 'bed',
    entityId:   bedId,
    before:     { status: bed.status },
    after:      { status },
    ip:         req.ip,
  });

  const updated = db.prepare('SELECT * FROM beds WHERE id = ?').get(bedId);
  return res.json(updated);
}

/**
 * POST /api/beds
 * Body: { floor_id, room_number, bed_label, room_type? }
 * Owner/Manager only — adds a new bed (and room if needed).
 */
function addBed(req, res) {
  const db         = getDb();
  const propertyId = req.user.property_id;
  const { floor_id, room_number, bed_label, room_type = 'shared' } = req.body;

  if (!floor_id || !room_number || !bed_label) {
    return res.status(400).json({ error: 'floor_id, room_number, and bed_label are required' });
  }

  // Verify floor belongs to property
  const floor = db.prepare('SELECT * FROM floors WHERE id = ? AND property_id = ?')
    .get(floor_id, propertyId);
  if (!floor) return res.status(404).json({ error: 'Floor not found' });

  // Get or create room
  let room = db.prepare('SELECT * FROM rooms WHERE floor_id = ? AND room_number = ?')
    .get(floor_id, room_number);

  if (!room) {
    const roomId = uuidv4();
    db.prepare(`
      INSERT INTO rooms (id, floor_id, property_id, room_number, room_type, created_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `).run(roomId, floor_id, propertyId, room_number, room_type);
    room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
  }

  // Check for duplicate bed label in this room
  const existing = db.prepare(
    'SELECT id FROM beds WHERE room_id = ? AND bed_label = ?'
  ).get(room.id, bed_label);
  if (existing) {
    return res.status(409).json({ error: `Bed ${bed_label} already exists in room ${room_number}` });
  }

  const bedId = uuidv4();
  db.prepare(`
    INSERT INTO beds (id, room_id, property_id, bed_label, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'available', datetime('now'), datetime('now'))
  `).run(bedId, room.id, propertyId, bed_label);

  const bed = db.prepare('SELECT * FROM beds WHERE id = ?').get(bedId);
  return res.status(201).json(bed);
}

/**
 * GET /api/beds/available
 * Returns only available beds — used in check-in dropdown.
 */
function getAvailableBeds(req, res) {
  const db         = getDb();
  const propertyId = req.user.property_id;

  const beds = db.prepare(`
    SELECT
      b.id, b.bed_label, b.status,
      r.room_number, r.id as room_id,
      f.label as floor_label, f.floor_number
    FROM beds b
    JOIN rooms r ON r.id = b.room_id
    JOIN floors f ON f.id = r.floor_id
    WHERE b.property_id = ? AND b.status = 'available'
    ORDER BY f.floor_number, r.room_number, b.bed_label
  `).all(propertyId);

  return res.json(beds.map(b => ({
    ...b,
    display_label: `${b.floor_label} - Room ${b.room_number} - Bed ${b.bed_label}`,
  })));
}

module.exports = { getBedMap, updateBedStatus, addBed, getAvailableBeds };
