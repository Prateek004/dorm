'use strict';

const jwt    = require('jsonwebtoken');
const { getDb } = require('../db/connection');

const JWT_SECRET = (() => {
  const s = process.env.JWT_SECRET;
  if (!s || s === 'change_this_secret' || s === 'CHANGE_ME_use_openssl_rand_base64_48') {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('JWT_SECRET environment variable is not set or is a placeholder. Set a strong secret before deploying.');
    }
    console.warn('[AUTH] WARNING: Using default JWT_SECRET — set JWT_SECRET env var before deploying!');
    return 'change_this_secret_dev_only';
  }
  return s;
})();

// ── Role hierarchy ────────────────────────────────────────
const ROLE_WEIGHT = { owner: 3, manager: 2, reception: 1 };

/**
 * Verify JWT from Authorization: Bearer <token>
 * Attaches req.user = { id, property_id, role, name }
 */
function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    // Refresh user from DB to catch deactivated accounts
    const db = getDb();
    const user = db.prepare(
      'SELECT id, property_id, name, role, is_active FROM users WHERE id = ?'
    ).get(payload.sub);

    if (!user || !user.is_active) {
      return res.status(401).json({ error: 'User not found or deactivated' });
    }

    req.user = {
      id:          user.id,
      property_id: user.property_id,
      name:        user.name,
      role:        user.role,
    };

    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Require minimum role level.
 * Usage: requireRole('manager')  — allows owner + manager
 *        requireRole('owner')    — allows only owner
 */
function requireRole(minRole) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthenticated' });

    const userWeight = ROLE_WEIGHT[req.user.role] || 0;
    const minWeight  = ROLE_WEIGHT[minRole]  || 99;

    if (userWeight < minWeight) {
      return res.status(403).json({
        error: `Access denied. Requires role: ${minRole} or above.`
      });
    }
    next();
  };
}

/**
 * Strip financial fields from a response object for reception/cashier role.
 * Safe to call on any object — returns the object unchanged for owner/manager.
 */
function stripFinancialFields(user, data) {
  if (!user || user.role !== 'reception') return data;

  const HIDDEN = [
    'total_income', 'total_expenses', 'net_profit', 'today_collection',
    'pending_amount', 'revenue', 'expenses', 'net', 'amount',
    'rent_amount', 'deposit_amount', 'refund_amount', 'pending_dues',
    'monthly_revenue', 'monthly_expenses', 'net_income',
  ];

  function sanitize(obj) {
    if (Array.isArray(obj)) return obj.map(sanitize);
    if (obj && typeof obj === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(obj)) {
        if (HIDDEN.includes(k)) {
          out[k] = '[restricted]';
        } else {
          out[k] = sanitize(v);
        }
      }
      return out;
    }
    return obj;
  }

  return sanitize(data);
}

/**
 * Mask Aadhaar number — always return XXXX XXXX XXXX in API responses.
 * Pass the raw (encrypted) value; this returns the display-safe version.
 */
function maskAadhaar() {
  return 'XXXX XXXX XXXX';
}

/**
 * Ensure the authenticated user belongs to the same property_id as the
 * resource being accessed. Reads property_id from req.params or req.body.
 */
function sameProperty(req, res, next) {
  const resourcePropertyId =
    req.params.propertyId ||
    req.body?.property_id ||
    req.query?.property_id;

  if (resourcePropertyId && resourcePropertyId !== req.user.property_id) {
    return res.status(403).json({ error: 'Cross-property access denied' });
  }
  // If no property_id in params, attach the user's own
  req.property_id = req.user.property_id;
  next();
}

module.exports = {
  authenticate,
  requireRole,
  stripFinancialFields,
  maskAadhaar,
  sameProperty,
  ROLE_WEIGHT,
};
