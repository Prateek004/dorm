'use strict';

const express = require('express');
const router  = express.Router();

const { authenticate, requireRole, sameProperty } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/auditLog');

const authCtrl     = require('../controllers/authController');
const bedsCtrl     = require('../controllers/bedsController');
const checkinCtrl  = require('../controllers/checkinController');
const paymentsCtrl = require('../controllers/paymentsController');
const financeCtrl  = require('../controllers/financeController');
const staffCtrl    = require('../controllers/staffController');

// ── Auth (public) ─────────────────────────────────────────
router.post('/auth/login',           authCtrl.login);
router.get ('/auth/me',              authenticate, authCtrl.me);
router.post('/auth/change-password', authenticate, authCtrl.changePassword);

// ── Dashboard (all authenticated roles) ───────────────────
router.get('/dashboard', authenticate, sameProperty, financeCtrl.getDashboard);

// ── Beds (all roles can read; manager+ to add/edit) ───────
router.get ('/beds',           authenticate, sameProperty, bedsCtrl.getBedMap);
router.get ('/beds/available', authenticate, sameProperty, bedsCtrl.getAvailableBeds);
router.post('/beds',           authenticate, sameProperty, requireRole('manager'), bedsCtrl.addBed);
router.put ('/beds/:bedId/status',
  authenticate, sameProperty, requireRole('reception'),
  auditMiddleware('BED_STATUS_CHANGED', 'bed'),
  bedsCtrl.updateBedStatus
);

// ── Residents ─────────────────────────────────────────────
router.get ('/residents',          authenticate, sameProperty, checkinCtrl.listResidents);
router.get ('/residents/:id',      authenticate, sameProperty, checkinCtrl.getResident);
router.post('/checkin',
  authenticate, sameProperty,
  auditMiddleware('CHECKIN', 'resident'),
  checkinCtrl.checkIn
);
router.post('/checkout/:residentId',
  authenticate, sameProperty,
  auditMiddleware('CHECKOUT', 'resident'),
  checkinCtrl.checkOut
);
router.post('/residents/:id/extend',
  authenticate, sameProperty, requireRole('manager'),
  checkinCtrl.extendStay
);

// ── Payments ──────────────────────────────────────────────
router.post('/payments',
  authenticate, sameProperty,
  auditMiddleware('PAYMENT_CREATED', 'payment'),
  paymentsCtrl.createPayment
);
router.get('/payments/resident/:residentId', authenticate, sameProperty, paymentsCtrl.getResidentLedger);
router.get('/payments/pending',              authenticate, sameProperty, requireRole('manager'), paymentsCtrl.getPendingDues);
router.get('/payments/pending-approvals',    authenticate, sameProperty, requireRole('manager'), paymentsCtrl.getPendingApprovals);
router.post('/payments/:paymentId/approve',
  authenticate, sameProperty, requireRole('manager'),
  auditMiddleware('REFUND_DECISION', 'payment'),
  paymentsCtrl.approveRefund
);

// ── Finance / Reports (manager+ only) ────────────────────
router.get ('/finance/report',  authenticate, sameProperty, requireRole('manager'), financeCtrl.getReport);
router.get ('/finance/export',  authenticate, sameProperty, requireRole('manager'), financeCtrl.exportReport);
router.get ('/finance/audit',   authenticate, sameProperty, requireRole('manager'), financeCtrl.getAuditLog);
router.post('/expenses',        authenticate, sameProperty, requireRole('manager'), auditMiddleware('EXPENSE_CREATED', 'expense'), financeCtrl.createExpense);
router.get ('/expenses',        authenticate, sameProperty, requireRole('manager'), financeCtrl.listExpenses);

// ── Staff Management (owner only) ────────────────────────
router.get   ('/staff',           authenticate, sameProperty, requireRole('manager'), staffCtrl.listStaff);
router.post  ('/staff',           authenticate, sameProperty, requireRole('owner'),   staffCtrl.addStaff);
router.put   ('/staff/:userId',   authenticate, sameProperty, requireRole('owner'),   staffCtrl.updateStaff);
router.delete('/staff/:userId',   authenticate, sameProperty, requireRole('owner'),   staffCtrl.deactivateStaff);

// ── Health check ──────────────────────────────────────────
router.get('/health', (_req, res) => res.json({ status: 'ok', app: 'sthappit', version: '1.0.0' }));

module.exports = router;
