'use strict';

const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/connection');

const JWT_SECRET = (() => {
  const s = process.env.JWT_SECRET;
  if (!s || s === 'change_this_secret' || s === 'CHANGE_ME_use_openssl_rand_base64_48') {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('JWT_SECRET environment variable is not set or is a placeholder.');
    }
    return 'change_this_secret_dev_only';
  }
  return s;
})();
const JWT_EXPIRES   = process.env.JWT_EXPIRES_IN || '8h';
const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '12', 10);

/**
 * POST /api/auth/login
 * Body: { email, password }
 * Returns: { token, user: { id, name, role, property_id } }
 */
function login(req, res) {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const db   = getDb();
  const user = db.prepare(
    'SELECT * FROM users WHERE email = ? AND is_active = 1'
  ).get(email.toLowerCase().trim());

  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const valid = bcrypt.compareSync(password, user.password_hash);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = jwt.sign(
    { sub: user.id, role: user.role, property: user.property_id },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );

  return res.json({
    token,
    user: {
      id:          user.id,
      name:        user.name,
      email:       user.email,
      mobile:      user.mobile,
      role:        user.role,
      property_id: user.property_id,
    },
  });
}

/**
 * POST /api/auth/change-password
 * Body: { current_password, new_password }
 */
function changePassword(req, res) {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'Both current and new password are required' });
  }
  if (new_password.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }

  const db   = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

  const valid = bcrypt.compareSync(current_password, user.password_hash);
  if (!valid) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  const newHash = bcrypt.hashSync(new_password, BCRYPT_ROUNDS);
  db.prepare('UPDATE users SET password_hash = ?, updated_at = datetime("now") WHERE id = ?')
    .run(newHash, req.user.id);

  return res.json({ message: 'Password updated successfully' });
}

/**
 * GET /api/auth/me
 */
function me(req, res) {
  const db   = getDb();
  const user = db.prepare(
    'SELECT id, name, email, mobile, role, property_id FROM users WHERE id = ?'
  ).get(req.user.id);
  return res.json(user);
}

module.exports = { login, changePassword, me };
