-- ============================================================
-- DormBook / Sthappit — SQLite Schema v1.0
-- ============================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ─── Users & Roles ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  property_id TEXT NOT NULL,
  name        TEXT NOT NULL,
  email       TEXT UNIQUE,
  mobile      TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  -- role: 'owner' | 'manager' | 'reception'
  role        TEXT NOT NULL DEFAULT 'reception'
                CHECK (role IN ('owner', 'manager', 'reception')),
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (property_id) REFERENCES properties(id)
);

-- ─── Properties ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS properties (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  address     TEXT NOT NULL,
  city        TEXT NOT NULL,
  state       TEXT NOT NULL,
  pincode     TEXT,
  owner_id    TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Floors ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS floors (
  id          TEXT PRIMARY KEY,
  property_id TEXT NOT NULL,
  floor_number INTEGER NOT NULL,
  label       TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (property_id) REFERENCES properties(id)
);

-- ─── Rooms ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rooms (
  id          TEXT PRIMARY KEY,
  floor_id    TEXT NOT NULL,
  property_id TEXT NOT NULL,
  room_number TEXT NOT NULL,
  room_type   TEXT NOT NULL DEFAULT 'shared'
                CHECK (room_type IN ('shared', 'private', 'dormitory')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (floor_id) REFERENCES floors(id),
  FOREIGN KEY (property_id) REFERENCES properties(id)
);

-- ─── Beds ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS beds (
  id          TEXT PRIMARY KEY,
  room_id     TEXT NOT NULL,
  property_id TEXT NOT NULL,
  bed_label   TEXT NOT NULL,
  -- status: 'available' | 'occupied' | 'reserved' | 'cleaning'
  status      TEXT NOT NULL DEFAULT 'available'
                CHECK (status IN ('available', 'occupied', 'reserved', 'cleaning')),
  cleaning_started_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (room_id) REFERENCES rooms(id),
  FOREIGN KEY (property_id) REFERENCES properties(id)
);

-- ─── Residents ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS residents (
  id                  TEXT PRIMARY KEY,
  property_id         TEXT NOT NULL,
  bed_id              TEXT,
  full_name           TEXT NOT NULL,
  mobile              TEXT NOT NULL,
  -- Aadhaar stored only with consent; number is masked on retrieval
  aadhaar_number_encrypted TEXT,
  aadhaar_mobile      TEXT,
  aadhaar_photo_path  TEXT,
  id_consent_given    INTEGER NOT NULL DEFAULT 0,
  id_consent_at       TEXT,
  coming_from         TEXT,
  permanent_address   TEXT,
  purpose_of_visit    TEXT,
  emergency_contact_name   TEXT,
  emergency_contact_mobile TEXT,
  photo_path          TEXT,
  check_in_date       TEXT,
  expected_checkout   TEXT,
  actual_checkout     TEXT,
  -- status: 'active' | 'checked_out' | 'reserved'
  status              TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'checked_out', 'reserved')),
  rent_amount         REAL NOT NULL DEFAULT 0,
  deposit_amount      REAL NOT NULL DEFAULT 0,
  notes               TEXT,
  created_by          TEXT NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (property_id) REFERENCES properties(id),
  FOREIGN KEY (bed_id) REFERENCES beds(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

-- ─── Payment Ledger ───────────────────────────────────────
-- Each row = one payment event (full, partial, refund, deposit, etc.)
CREATE TABLE IF NOT EXISTS payments (
  id              TEXT PRIMARY KEY,
  property_id     TEXT NOT NULL,
  resident_id     TEXT NOT NULL,
  -- type: 'rent' | 'deposit' | 'refund' | 'extra_charge' | 'advance'
  payment_type    TEXT NOT NULL
                    CHECK (payment_type IN ('rent', 'deposit', 'refund', 'extra_charge', 'advance')),
  amount          REAL NOT NULL,
  -- direction: 'credit' (money in) | 'debit' (money out / refund)
  direction       TEXT NOT NULL DEFAULT 'credit'
                    CHECK (direction IN ('credit', 'debit')),
  -- mode: 'cash' | 'upi' | 'card' | 'bank_transfer'
  payment_mode    TEXT NOT NULL DEFAULT 'cash'
                    CHECK (payment_mode IN ('cash', 'upi', 'card', 'bank_transfer')),
  gateway_txn_id  TEXT,
  gateway_status  TEXT CHECK (gateway_status IN ('success', 'pending', 'failed', NULL)),
  billing_month   TEXT,          -- e.g. "2026-09" for month-based tracking
  due_date        TEXT,
  paid_at         TEXT NOT NULL DEFAULT (datetime('now')),
  -- approval flow for refunds
  requires_approval  INTEGER NOT NULL DEFAULT 0,
  approved_by        TEXT,
  approved_at        TEXT,
  approval_status    TEXT DEFAULT 'not_required'
                       CHECK (approval_status IN ('not_required', 'pending', 'approved', 'rejected')),
  notes           TEXT,
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (property_id) REFERENCES properties(id),
  FOREIGN KEY (resident_id) REFERENCES residents(id),
  FOREIGN KEY (created_by) REFERENCES users(id),
  FOREIGN KEY (approved_by) REFERENCES users(id)
);

-- ─── Expenses ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS expenses (
  id              TEXT PRIMARY KEY,
  property_id     TEXT NOT NULL,
  category        TEXT NOT NULL,
  description     TEXT,
  amount          REAL NOT NULL,
  expense_date    TEXT NOT NULL,
  payment_mode    TEXT NOT NULL DEFAULT 'cash'
                    CHECK (payment_mode IN ('cash', 'upi', 'card', 'bank_transfer')),
  receipt_path    TEXT,
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (property_id) REFERENCES properties(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

-- ─── Stay Extensions ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS stay_extensions (
  id              TEXT PRIMARY KEY,
  resident_id     TEXT NOT NULL,
  property_id     TEXT NOT NULL,
  old_checkout    TEXT NOT NULL,
  new_checkout    TEXT NOT NULL,
  old_rent        REAL,
  new_rent        REAL,
  notes           TEXT,
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (resident_id) REFERENCES residents(id),
  FOREIGN KEY (property_id) REFERENCES properties(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

-- ─── Audit Log ───────────────────────────────────────────
-- Every money-touching and sensitive action gets a row here
CREATE TABLE IF NOT EXISTS audit_logs (
  id              TEXT PRIMARY KEY,
  property_id     TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  user_role       TEXT NOT NULL,
  action          TEXT NOT NULL,   -- e.g. 'PAYMENT_CREATED', 'CHECKOUT', 'REFUND_APPROVED'
  entity_type     TEXT NOT NULL,   -- e.g. 'payment', 'resident', 'bed'
  entity_id       TEXT NOT NULL,
  before_state    TEXT,            -- JSON snapshot before change
  after_state     TEXT,            -- JSON snapshot after change
  ip_address      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (property_id) REFERENCES properties(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- ─── WhatsApp Notification Log ────────────────────────────
CREATE TABLE IF NOT EXISTS notification_log (
  id              TEXT PRIMARY KEY,
  property_id     TEXT NOT NULL,
  resident_id     TEXT,
  recipient_mobile TEXT NOT NULL,
  -- recipient_type: 'tenant' | 'owner' | 'staff'
  recipient_type  TEXT NOT NULL DEFAULT 'tenant',
  -- event: 'payment_due' | 'overdue' | 'checkin_confirm' |
  --        'checkout_confirm' | 'daily_summary' | 'refund_alert'
  event_type      TEXT NOT NULL,
  message_body    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'sent', 'delivered', 'failed')),
  provider_msg_id TEXT,
  sent_at         TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (property_id) REFERENCES properties(id),
  FOREIGN KEY (resident_id) REFERENCES residents(id)
);

-- ─── Indexes ─────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_beds_property ON beds(property_id);
CREATE INDEX IF NOT EXISTS idx_beds_status ON beds(status);
CREATE INDEX IF NOT EXISTS idx_residents_property ON residents(property_id);
CREATE INDEX IF NOT EXISTS idx_residents_status ON residents(status);
CREATE INDEX IF NOT EXISTS idx_payments_resident ON payments(resident_id);
CREATE INDEX IF NOT EXISTS idx_payments_property_date ON payments(property_id, paid_at);
CREATE INDEX IF NOT EXISTS idx_audit_property_date ON audit_logs(property_id, created_at);
CREATE INDEX IF NOT EXISTS idx_expenses_property_date ON expenses(property_id, expense_date);
