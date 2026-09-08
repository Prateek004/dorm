'use strict';

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('./connection');

const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '12', 10);

async function seed() {
  const db = getDb();

  // ── Check if already seeded ──────────────────────────────
  const existing = db.prepare('SELECT COUNT(*) as c FROM properties').get();
  if (existing.c > 0) {
    console.log('ℹ️  Database already seeded. Skipping.');
    return;
  }

  const now = new Date().toISOString();

  // ── Property ─────────────────────────────────────────────
  const propertyId = uuidv4();
  const ownerId    = uuidv4();

  db.prepare(`
    INSERT INTO properties (id, name, address, city, state, pincode, owner_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(propertyId, 'Sunrise PG', '42, MG Road', 'Pune', 'Maharashtra', '411001', ownerId, now, now);

  // ── Users ─────────────────────────────────────────────────
  const ownerHash     = await bcrypt.hash('owner123', BCRYPT_ROUNDS);
  const managerHash   = await bcrypt.hash('manager123', BCRYPT_ROUNDS);
  const receptionHash = await bcrypt.hash('reception123', BCRYPT_ROUNDS);

  const managerId   = uuidv4();
  const receptionId = uuidv4();

  const insertUser = db.prepare(`
    INSERT INTO users (id, property_id, name, email, mobile, password_hash, role, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertUser.run(ownerId,     propertyId, 'Raj Sharma',   'raj@sunrisepg.com',       '9800000001', ownerHash,     'owner',     now, now);
  insertUser.run(managerId,   propertyId, 'Priya Desai',  'priya@sunrisepg.com',     '9800000002', managerHash,   'manager',   now, now);
  insertUser.run(receptionId, propertyId, 'Amit Kulkarni','amit@sunrisepg.com',      '9800000003', receptionHash, 'reception', now, now);

  // ── Floors ────────────────────────────────────────────────
  const floors = [
    { id: uuidv4(), num: 1, label: 'Floor 1' },
    { id: uuidv4(), num: 2, label: 'Floor 2' },
    { id: uuidv4(), num: 3, label: 'Floor 3' },
  ];

  const insertFloor = db.prepare(`
    INSERT INTO floors (id, property_id, floor_number, label, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const f of floors) {
    insertFloor.run(f.id, propertyId, f.num, f.label, now);
  }

  // ── Rooms & Beds ──────────────────────────────────────────
  const roomDefs = [
    // floor index, room number
    [0, '101'], [0, '102'],
    [1, '201'], [1, '202'],
    [2, '301'], [2, '302'],
  ];

  const bedLabels = ['A', 'B', 'C'];
  const bedStatuses = ['occupied', 'occupied', 'available', 'occupied', 'cleaning', 'available',
                       'occupied', 'occupied', 'reserved', 'available', 'occupied', 'occupied',
                       'occupied', 'available', 'occupied', 'occupied', 'occupied', 'available'];

  const insertRoom = db.prepare(`
    INSERT INTO rooms (id, floor_id, property_id, room_number, room_type, created_at)
    VALUES (?, ?, ?, ?, 'shared', ?)
  `);
  const insertBed = db.prepare(`
    INSERT INTO beds (id, room_id, property_id, bed_label, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  let bedStatusIdx = 0;
  const allBeds = [];

  for (const [floorIdx, roomNum] of roomDefs) {
    const roomId = uuidv4();
    insertRoom.run(roomId, floors[floorIdx].id, propertyId, roomNum, now);

    for (const label of bedLabels) {
      const bedId = uuidv4();
      const status = bedStatuses[bedStatusIdx % bedStatuses.length];
      const cleaningStarted = status === 'cleaning' ? now : null;
      insertBed.run(bedId, roomId, propertyId, label, status, now, now);
      allBeds.push({ id: bedId, roomNum, label, status, floorIdx });
      bedStatusIdx++;
      if (status === 'cleaning') {
        db.prepare(`UPDATE beds SET cleaning_started_at = ? WHERE id = ?`).run(now, bedId);
      }
    }
  }

  // ── Residents ─────────────────────────────────────────────
  const occupiedBeds = allBeds.filter(b => b.status === 'occupied').slice(0, 4);

  const residentData = [
    {
      name: 'Ramesh Kumar',
      mobile: '9811111111',
      from: 'Nashik, Maharashtra',
      purpose: 'Job / Work',
      checkin: '2026-09-01',
      expected: '2026-09-30',
      rent: 6000,
      deposit: 5000,
    },
    {
      name: 'Sanjay Patil',
      mobile: '9822222222',
      from: 'Nagpur, Maharashtra',
      purpose: 'Job / Work',
      checkin: '2026-09-01',
      expected: '2026-09-30',
      rent: 6000,
      deposit: 5000,
    },
    {
      name: 'Anita Verma',
      mobile: '9833333333',
      from: 'Delhi',
      purpose: 'Studies',
      checkin: '2026-08-15',
      expected: '2026-11-15',
      rent: 7000,
      deposit: 7000,
    },
    {
      name: 'Mohit Jain',
      mobile: '9844444444',
      from: 'Jaipur, Rajasthan',
      purpose: 'Job / Work',
      checkin: '2026-09-01',
      expected: '2026-09-30',
      rent: 6000,
      deposit: 5000,
    },
  ];

  const insertResident = db.prepare(`
    INSERT INTO residents
      (id, property_id, bed_id, full_name, mobile, aadhaar_number_encrypted,
       id_consent_given, id_consent_at, coming_from, purpose_of_visit,
       check_in_date, expected_checkout, rent_amount, deposit_amount,
       status, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
  `);

  const insertPayment = db.prepare(`
    INSERT INTO payments
      (id, property_id, resident_id, payment_type, amount, direction,
       payment_mode, billing_month, paid_at, requires_approval,
       approval_status, notes, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, 'credit', ?, ?, ?, 0, 'not_required', ?, ?, ?)
  `);

  const residentIds = [];
  for (let i = 0; i < residentData.length && i < occupiedBeds.length; i++) {
    const r = residentData[i];
    const bed = occupiedBeds[i];
    const resId = uuidv4();
    residentIds.push(resId);

    // NOTE: Aadhaar placeholder — never store real numbers. Using redacted placeholder.
    insertResident.run(
      resId, propertyId, bed.id, r.name, r.mobile,
      '[Aadhaar Redacted]',
      now, r.from, r.purpose, r.checkin, r.expected,
      r.rent, r.deposit, receptionId, now, now
    );

    // Deposit payment
    insertPayment.run(
      uuidv4(), propertyId, resId, 'deposit', r.deposit,
      'cash', '2026-09', now, 'Deposit on check-in', receptionId, now
    );
  }

  // Resident 0 (Ramesh) — fully paid rent
  insertPayment.run(
    uuidv4(), propertyId, residentIds[0], 'rent', 6000,
    'upi', '2026-09', now, 'September rent - full', receptionId, now
  );

  // Resident 1 (Sanjay) — partial rent (2 instalments)
  insertPayment.run(
    uuidv4(), propertyId, residentIds[1], 'rent', 3000,
    'cash', '2026-09', now, 'September rent - 1st instalment', receptionId, now
  );

  // Resident 2 (Anita) — no rent paid yet (pending)

  // Resident 3 (Mohit) — fully paid
  insertPayment.run(
    uuidv4(), propertyId, residentIds[3], 'rent', 6000,
    'upi', '2026-09', now, 'September rent - full', receptionId, now
  );

  // ── Expenses ──────────────────────────────────────────────
  const insertExpense = db.prepare(`
    INSERT INTO expenses (id, property_id, category, description, amount, expense_date, payment_mode, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const expenses = [
    { cat: 'Electricity',    desc: 'August electricity bill',     amount: 12000, date: '2026-09-01', mode: 'upi' },
    { cat: 'Water',          desc: 'Water tanker',                amount: 3000,  date: '2026-09-03', mode: 'cash' },
    { cat: 'Maintenance',    desc: 'Plumbing repair - bathroom 2',amount: 800,   date: '2026-09-04', mode: 'cash' },
    { cat: 'Housekeeping',   desc: 'Cleaning supplies',           amount: 1500,  date: '2026-09-02', mode: 'cash' },
    { cat: 'Internet',       desc: 'Monthly broadband',           amount: 2000,  date: '2026-09-01', mode: 'upi' },
    { cat: 'Security',       desc: 'Guard salary',                amount: 8000,  date: '2026-09-01', mode: 'cash' },
    { cat: 'Miscellaneous',  desc: 'Stationery and sundries',     amount: 500,   date: '2026-09-05', mode: 'cash' },
  ];

  for (const e of expenses) {
    insertExpense.run(uuidv4(), propertyId, e.cat, e.desc, e.amount, e.date, e.mode, ownerId, now);
  }

  // ── Audit log entries ─────────────────────────────────────
  const insertAudit = db.prepare(`
    INSERT INTO audit_logs (id, property_id, user_id, user_role, action, entity_type, entity_id, after_state, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (let i = 0; i < residentIds.length; i++) {
    insertAudit.run(
      uuidv4(), propertyId, receptionId, 'reception', 'CHECKIN',
      'resident', residentIds[i],
      JSON.stringify({ resident: residentData[i]?.name, bed: occupiedBeds[i]?.id }),
      now
    );
  }

  console.log('✅ Seed data inserted successfully.');
  console.log('   Property:', propertyId);
  console.warn('');
  console.warn('[SEED] DEMO credentials - CHANGE ALL PASSWORDS before going live!');
  console.log('   Owner login:     raj@sunrisepg.com    / owner123');
  console.log('   Manager login: priya@sunrisepg.com / manager123');
  console.log('   Reception login: amit@sunrisepg.com / reception123');
}

seed().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
