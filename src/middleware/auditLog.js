'use strict';

const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/connection');

/**
 * Write a row to audit_logs.
 * Called directly from controllers for maximum precision.
 *
 * @param {object} opts
 * @param {string} opts.propertyId
 * @param {string} opts.userId
 * @param {string} opts.userRole
 * @param {string} opts.action       — e.g. 'PAYMENT_CREATED', 'CHECKOUT', 'REFUND_APPROVED'
 * @param {string} opts.entityType   — e.g. 'payment', 'resident', 'bed'
 * @param {string} opts.entityId
 * @param {object} [opts.before]     — state before change (optional)
 * @param {object} [opts.after]      — state after change (optional)
 * @param {string} [opts.ip]
 */
function writeAudit(opts) {
  const db = getDb();
  db.prepare(`
    INSERT INTO audit_logs
      (id, property_id, user_id, user_role, action, entity_type, entity_id,
       before_state, after_state, ip_address, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    uuidv4(),
    opts.propertyId,
    opts.userId,
    opts.userRole,
    opts.action,
    opts.entityType,
    opts.entityId,
    opts.before ? JSON.stringify(opts.before) : null,
    opts.after  ? JSON.stringify(opts.after)  : null,
    opts.ip     || null,
  );
}

/**
 * Express middleware factory.
 * Creates an automatic audit log entry for the route it wraps.
 * Captures req body snapshot before passing to next handler.
 *
 * Usage: router.post('/payments', auditMiddleware('PAYMENT_CREATED', 'payment'), handler)
 */
function auditMiddleware(action, entityType) {
  return (req, res, next) => {
    // Store the original json method so we can intercept the response
    const originalJson = res.json.bind(res);

    res.json = function (data) {
      if (res.statusCode < 400 && req.user) {
        const entityId =
          data?.id || data?.paymentId || data?.residentId || data?.bedId || 'unknown';

        writeAudit({
          propertyId: req.user.property_id,
          userId:     req.user.id,
          userRole:   req.user.role,
          action,
          entityType,
          entityId:   String(entityId),
          after:      data,
          ip:         req.ip,
        });
      }
      return originalJson(data);
    };

    next();
  };
}

module.exports = { writeAudit, auditMiddleware };
