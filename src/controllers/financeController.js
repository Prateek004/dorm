'use strict';

const { v4: uuidv4 } = require('uuid');
const ExcelJS = require('exceljs');
const { getDb } = require('../db/connection');
const { writeAudit } = require('../middleware/auditLog');

/**
 * GET /api/finance/dashboard
 * Dashboard summary: today's collection, pending dues, monthly P&L.
 */
function getDashboard(req, res) {
  const db         = getDb();
  const propertyId = req.user.property_id;
  const today      = new Date().toISOString().substring(0, 10);
  const thisMonth  = today.substring(0, 7);

  // Bed summary
  const beds = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'available' THEN 1 ELSE 0 END) as available,
      SUM(CASE WHEN status = 'occupied'  THEN 1 ELSE 0 END) as occupied,
      SUM(CASE WHEN status = 'reserved'  THEN 1 ELSE 0 END) as reserved,
      SUM(CASE WHEN status = 'cleaning'  THEN 1 ELSE 0 END) as cleaning
    FROM beds WHERE property_id = ?
  `).get(propertyId);

  // Today's check-ins / check-outs
  const todayCheckins = db.prepare(`
    SELECT COUNT(*) as c FROM residents
    WHERE property_id = ? AND check_in_date = ?
  `).get(propertyId, today);

  const todayCheckouts = db.prepare(`
    SELECT COUNT(*) as c FROM residents
    WHERE property_id = ? AND actual_checkout = ?
  `).get(propertyId, today);

  // Overdue expected checkouts
  const overdueCheckouts = db.prepare(`
    SELECT COUNT(*) as c FROM residents
    WHERE property_id = ? AND status = 'active' AND expected_checkout < ?
  `).get(propertyId, today);

  // Today's collection
  const todayCollection = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total
    FROM payments
    WHERE property_id = ? AND direction = 'credit'
      AND date(paid_at) = ?
  `).get(propertyId, today);

  // Monthly income
  const monthlyIncome = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total
    FROM payments
    WHERE property_id = ? AND direction = 'credit'
      AND billing_month = ?
  `).get(propertyId, thisMonth);

  // Monthly expenses
  const monthlyExpenses = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total
    FROM expenses
    WHERE property_id = ?
      AND strftime('%Y-%m', expense_date) = ?
  `).get(propertyId, thisMonth);

  // Pending dues (active residents this month)
  const pendingDues = db.prepare(`
    SELECT
      COUNT(*) as count,
      COALESCE(SUM(r.rent_amount - COALESCE(paid.amount, 0)), 0) as total_pending
    FROM residents r
    LEFT JOIN (
      SELECT resident_id, SUM(amount) as amount
      FROM payments
      WHERE direction = 'credit' AND payment_type = 'rent' AND billing_month = ?
      GROUP BY resident_id
    ) paid ON paid.resident_id = r.id
    WHERE r.property_id = ? AND r.status = 'active'
      AND (r.rent_amount - COALESCE(paid.amount, 0)) > 0
  `).get(thisMonth, propertyId);

  // Refunds awaiting approval
  const pendingRefunds = db.prepare(`
    SELECT COUNT(*) as c FROM payments
    WHERE property_id = ? AND approval_status = 'pending'
  `).get(propertyId);

  const net = (monthlyIncome.total || 0) - (monthlyExpenses.total || 0);

  return res.json({
    beds,
    today: {
      date:            today,
      checkins:        todayCheckins.c,
      checkouts:       todayCheckouts.c,
      collection:      todayCollection.total,
      overdue_checkouts: overdueCheckouts.c,
    },
    monthly: {
      month:           thisMonth,
      income:          monthlyIncome.total,
      expenses:        monthlyExpenses.total,
      net_profit:      net,
    },
    pending: {
      dues_count:      pendingDues.count,
      dues_total:      pendingDues.total_pending,
      refunds_awaiting: pendingRefunds.c,
    },
  });
}

/**
 * GET /api/finance/report
 * Query params: period (daily|weekly|monthly|yearly|custom),
 *               start_date, end_date (for custom)
 */
function getReport(req, res) {
  const db         = getDb();
  const propertyId = req.user.property_id;
  const { period = 'monthly', start_date, end_date } = req.query;

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  if (start_date && !DATE_RE.test(start_date)) {
    return res.status(400).json({ error: 'start_date must be YYYY-MM-DD' });
  }
  if (end_date && !DATE_RE.test(end_date)) {
    return res.status(400).json({ error: 'end_date must be YYYY-MM-DD' });
  }

  const { from, to } = getDateRange(period, start_date, end_date);

  const income = db.prepare(`
    SELECT
      COALESCE(SUM(amount), 0) as total,
      SUM(CASE WHEN payment_type = 'rent' THEN amount ELSE 0 END) as rent_income,
      SUM(CASE WHEN payment_type = 'deposit' THEN amount ELSE 0 END) as deposit_income,
      SUM(CASE WHEN payment_type = 'extra_charge' THEN amount ELSE 0 END) as extras_income
    FROM payments
    WHERE property_id = ? AND direction = 'credit'
      AND date(paid_at) BETWEEN ? AND ?
  `).get(propertyId, from, to);

  const refunds = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total
    FROM payments
    WHERE property_id = ? AND direction = 'debit' AND approval_status = 'approved'
      AND date(paid_at) BETWEEN ? AND ?
  `).get(propertyId, from, to);

  const expenses = db.prepare(`
    SELECT
      COALESCE(SUM(amount), 0) as total,
      category, SUM(amount) as cat_total
    FROM expenses
    WHERE property_id = ? AND expense_date BETWEEN ? AND ?
    GROUP BY category
  `).all(propertyId, from, to);

  const totalExpenses = expenses.reduce((s, e) => s + e.cat_total, 0);
  const netIncome     = (income.total || 0) - totalExpenses - (refunds.total || 0);

  // Daily breakdown within range
  const daily = db.prepare(`
    SELECT
      date(paid_at) as day,
      SUM(CASE WHEN direction = 'credit' THEN amount ELSE 0 END) as income,
      SUM(CASE WHEN direction = 'debit' AND approval_status = 'approved' THEN amount ELSE 0 END) as refunds
    FROM payments
    WHERE property_id = ? AND date(paid_at) BETWEEN ? AND ?
    GROUP BY date(paid_at)
    ORDER BY day
  `).all(propertyId, from, to);

  return res.json({
    period, from, to,
    income: {
      total:         income.total,
      rent:          income.rent_income,
      deposits:      income.deposit_income,
      extras:        income.extras_income,
    },
    refunds:         refunds.total,
    expenses: {
      total:         totalExpenses,
      by_category:   expenses,
    },
    net_profit:      netIncome,
    daily_breakdown: daily,
  });
}

/**
 * POST /api/expenses
 * Record a property expense.
 */
function createExpense(req, res) {
  const db         = getDb();
  const propertyId = req.user.property_id;

  const { category, description, amount, expense_date, payment_mode, receipt_path } = req.body;

  if (!category || !amount || !expense_date) {
    return res.status(400).json({ error: 'category, amount, and expense_date are required' });
  }
  if (parseFloat(amount) <= 0 || isNaN(parseFloat(amount))) {
    return res.status(400).json({ error: 'Amount must be a positive number' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expense_date)) {
    return res.status(400).json({ error: 'expense_date must be YYYY-MM-DD' });
  }

  const expenseId = uuidv4();
  const now       = new Date().toISOString();

  db.prepare(`
    INSERT INTO expenses
      (id, property_id, category, description, amount, expense_date, payment_mode, receipt_path, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    expenseId, propertyId, category,
    description || null,
    parseFloat(amount), expense_date,
    payment_mode || 'cash',
    receipt_path || null,
    req.user.id, now
  );

  writeAudit({
    propertyId,
    userId:     req.user.id,
    userRole:   req.user.role,
    action:     'EXPENSE_CREATED',
    entityType: 'expense',
    entityId:   expenseId,
    after:      { category, amount, expense_date },
    ip:         req.ip,
  });

  const expense = db.prepare('SELECT * FROM expenses WHERE id = ?').get(expenseId);
  return res.status(201).json(expense);
}

/**
 * GET /api/expenses
 */
function listExpenses(req, res) {
  const db         = getDb();
  const propertyId = req.user.property_id;
  const { start_date, end_date } = req.query;

  let query  = 'SELECT * FROM expenses WHERE property_id = ?';
  const params = [propertyId];

  if (start_date) { query += ' AND expense_date >= ?'; params.push(start_date); }
  if (end_date)   { query += ' AND expense_date <= ?'; params.push(end_date); }

  query += ' ORDER BY expense_date DESC';
  return res.json(db.prepare(query).all(...params));
}

/**
 * GET /api/finance/export
 * Query: format=csv|excel, period, start_date, end_date
 */
async function exportReport(req, res, next) {
  try {
  const db         = getDb();
  const propertyId = req.user.property_id;
  const { format = 'csv', period = 'monthly', start_date, end_date } = req.query;

  const { from, to } = getDateRange(period, start_date, end_date);

  const payments = db.prepare(`
    SELECT
      p.*, r.full_name as resident_name
    FROM payments p
    JOIN residents r ON r.id = p.resident_id
    WHERE p.property_id = ? AND date(p.paid_at) BETWEEN ? AND ?
    ORDER BY p.paid_at DESC
  `).all(propertyId, from, to);

  const expenses = db.prepare(`
    SELECT * FROM expenses
    WHERE property_id = ? AND expense_date BETWEEN ? AND ?
    ORDER BY expense_date DESC
  `).all(propertyId, from, to);

  if (format === 'csv') {
    const lines = [
      '=== PAYMENTS ===',
      'Date,Resident,Type,Amount,Mode,Status',
      ...payments.map(p =>
        `${p.paid_at?.substring(0, 10)},${p.resident_name},${p.payment_type},${p.amount},${p.payment_mode},${p.direction}`
      ),
      '',
      '=== EXPENSES ===',
      'Date,Category,Description,Amount,Mode',
      ...expenses.map(e =>
        `${e.expense_date},${e.category},${e.description || ''},${e.amount},${e.payment_mode}`
      ),
    ];

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="sthappit-report-${from}-${to}.csv"`);
    return res.send(lines.join('\n'));
  }

  if (format === 'excel') {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Sthappit / DormBook';
    workbook.created = new Date();

    // Payments sheet
    const paySheet = workbook.addWorksheet('Payments');
    paySheet.columns = [
      { header: 'Date',          key: 'date',     width: 14 },
      { header: 'Resident',      key: 'resident',  width: 22 },
      { header: 'Type',          key: 'type',      width: 14 },
      { header: 'Amount (₹)',    key: 'amount',    width: 14 },
      { header: 'Mode',          key: 'mode',      width: 14 },
      { header: 'Direction',     key: 'direction', width: 12 },
      { header: 'Gateway TxnID', key: 'txn',       width: 24 },
    ];
    for (const p of payments) {
      paySheet.addRow({
        date:      p.paid_at?.substring(0, 10),
        resident:  p.resident_name,
        type:      p.payment_type,
        amount:    p.amount,
        mode:      p.payment_mode,
        direction: p.direction,
        txn:       p.gateway_txn_id || '',
      });
    }

    // Expenses sheet
    const expSheet = workbook.addWorksheet('Expenses');
    expSheet.columns = [
      { header: 'Date',        key: 'date',     width: 14 },
      { header: 'Category',    key: 'cat',       width: 18 },
      { header: 'Description', key: 'desc',      width: 28 },
      { header: 'Amount (₹)',  key: 'amount',    width: 14 },
      { header: 'Mode',        key: 'mode',      width: 14 },
    ];
    for (const e of expenses) {
      expSheet.addRow({
        date:   e.expense_date,
        cat:    e.category,
        desc:   e.description || '',
        amount: e.amount,
        mode:   e.payment_mode,
      });
    }

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="sthappit-report-${from}-${to}.xlsx"`
    );

    await workbook.xlsx.write(res);
    return res.end();
  }

  return res.status(400).json({ error: 'format must be csv or excel' });
  } catch (err) { return next(err); }
}

/**
 * GET /api/finance/audit
 * Audit trail — owner/manager only.
 */
function getAuditLog(req, res) {
  const db         = getDb();
  const propertyId = req.user.property_id;
  const rawLimit  = parseInt(req.query.limit,  10);
  const rawOffset = parseInt(req.query.offset, 10);
  const safeLimit  = (!isNaN(rawLimit)  && rawLimit  > 0 && rawLimit  <= 500) ? rawLimit  : 100;
  const safeOffset = (!isNaN(rawOffset) && rawOffset >= 0)                    ? rawOffset : 0;

  const rows = db.prepare(`
    SELECT a.*, u.name as user_name
    FROM audit_logs a
    JOIN users u ON u.id = a.user_id
    WHERE a.property_id = ?
    ORDER BY a.created_at DESC
    LIMIT ? OFFSET ?
  `).all(propertyId, safeLimit, safeOffset);

  const total = db.prepare('SELECT COUNT(*) as c FROM audit_logs WHERE property_id = ?')
    .get(propertyId);

  return res.json({ total: total.c, rows });
}

// ── Helpers ────────────────────────────────────────────────
function getDateRange(period, start_date, end_date) {
  const today = new Date();
  const pad   = n => String(n).padStart(2, '0');
  const fmt   = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  switch (period) {
    case 'daily':
      return { from: fmt(today), to: fmt(today) };

    case 'weekly': {
      const mon = new Date(today);
      mon.setDate(today.getDate() - today.getDay() + 1);
      const sun = new Date(mon);
      sun.setDate(mon.getDate() + 6);
      return { from: fmt(mon), to: fmt(sun) };
    }

    case 'monthly': {
      const first = new Date(today.getFullYear(), today.getMonth(), 1);
      const last  = new Date(today.getFullYear(), today.getMonth() + 1, 0);
      return { from: fmt(first), to: fmt(last) };
    }

    case 'yearly': {
      return {
        from: `${today.getFullYear()}-01-01`,
        to:   `${today.getFullYear()}-12-31`,
      };
    }

    case 'custom':
      if (!start_date || !end_date) {
        throw new Error('start_date and end_date required for custom period');
      }
      return { from: start_date, to: end_date };

    default:
      return { from: fmt(today), to: fmt(today) };
  }
}

module.exports = {
  getDashboard,
  getReport,
  createExpense,
  listExpenses,
  exportReport,
  getAuditLog,
};
