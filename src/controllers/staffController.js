'use strict';

const bcrypt  = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/connection');
const { writeAudit } = require('../middleware/auditLog');

const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '12', 10);

/**
 * GET /api/staff
 * List all staff for this property (owner/manager only).
 */
function listStaff(req, res) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, name, email, mobile, role, is_active, created_at
    FROM users WHERE property_id = ?
    ORDER BY role, name
  `).all(req.user.property_id);
  return res.json(rows);
}

/**
 * POST /api/staff
 * Add a new staff member (owner only).
 * Body: { name, email, mobile, password, role }
 */
function addStaff(req, res) {
  const db         = getDb();
  const propertyId = req.user.property_id;
  const { name, email, mobile, password, role } = req.body;

  const VALID_ROLES = ['manager', 'reception'];
  if (!name || !mobile || !password || !role) {
    return res.status(400).json({ error: 'name, mobile, password, and role are required' });
  }

  // Validate email format if provided
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email format' });
  }
  if (!VALID_ROLES.includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  if (email) {
    const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
    if (exists) return res.status(409).json({ error: 'Email already in use' });
  }

  const userId = uuidv4();
  const now    = new Date().toISOString();
  const hash   = bcrypt.hashSync(password, BCRYPT_ROUNDS);

  db.prepare(`
    INSERT INTO users (id, property_id, name, email, mobile, password_hash, role, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, propertyId, name, email?.toLowerCase() || null, mobile, hash, role, now, now);

  writeAudit({
    propertyId,
    userId:     req.user.id,
    userRole:   req.user.role,
    action:     'STAFF_ADDED',
    entityType: 'user',
    entityId:   userId,
    after:      { name, email, mobile, role },
    ip:         req.ip,
  });

  const user = db.prepare(
    'SELECT id, name, email, mobile, role, is_active, created_at FROM users WHERE id = ?'
  ).get(userId);
  return res.status(201).json(user);
}

/**
 * PUT /api/staff/:userId
 * Update staff name, mobile, or role (owner only).
 */
function updateStaff(req, res) {
  const db         = getDb();
  const propertyId = req.user.property_id;
  const { userId } = req.params;
  const { name, mobile, role, is_active } = req.body;

  const staff = db.prepare(
    'SELECT * FROM users WHERE id = ? AND property_id = ?'
  ).get(userId, propertyId);

  if (!staff) return res.status(404).json({ error: 'Staff member not found' });

  // Cannot change own role
  if (userId === req.user.id && role && role !== staff.role) {
    return res.status(400).json({ error: 'Cannot change your own role' });
  }

  // Cannot demote/remove another owner
  if (staff.role === 'owner' && userId !== req.user.id) {
    return res.status(403).json({ error: 'Cannot modify another owner account' });
  }

  const updates = {
    name:      name      !== undefined ? name      : staff.name,
    mobile:    mobile    !== undefined ? mobile    : staff.mobile,
    role:      role      !== undefined ? role      : staff.role,
    is_active: is_active !== undefined ? (is_active ? 1 : 0) : staff.is_active,
  };

  db.prepare(`
    UPDATE users
    SET name = ?, mobile = ?, role = ?, is_active = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(updates.name, updates.mobile, updates.role, updates.is_active, userId);

  writeAudit({
    propertyId,
    userId:     req.user.id,
    userRole:   req.user.role,
    action:     'STAFF_UPDATED',
    entityType: 'user',
    entityId:   userId,
    before:     { name: staff.name, role: staff.role, is_active: staff.is_active },
    after:      updates,
    ip:         req.ip,
  });

  const updated = db.prepare(
    'SELECT id, name, email, mobile, role, is_active, created_at FROM users WHERE id = ?'
  ).get(userId);
  return res.json(updated);
}

/**
 * DELETE /api/staff/:userId
 * Deactivate (soft-delete) a staff member. Owner only.
 */
function deactivateStaff(req, res) {
  const db         = getDb();
  const propertyId = req.user.property_id;
  const { userId } = req.params;

  if (userId === req.user.id) {
    return res.status(400).json({ error: 'Cannot deactivate your own account' });
  }

  const staff = db.prepare(
    'SELECT * FROM users WHERE id = ? AND property_id = ?'
  ).get(userId, propertyId);

  if (!staff) return res.status(404).json({ error: 'Staff member not found' });

  db.prepare(
    'UPDATE users SET is_active = 0, updated_at = datetime(\'now\') WHERE id = ?'
  ).run(userId);

  writeAudit({
    propertyId,
    userId:     req.user.id,
    userRole:   req.user.role,
    action:     'STAFF_DEACTIVATED',
    entityType: 'user',
    entityId:   userId,
    after:      { is_active: false },
    ip:         req.ip,
  });

  return res.json({ message: 'Staff member deactivated' });
}

module.exports = { listStaff, addStaff, updateStaff, deactivateStaff };
