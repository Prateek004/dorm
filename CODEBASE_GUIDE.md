# Sthappit / DormBook — Complete Codebase Guide
## For Software Engineers: What Every File Does, What Was Fixed, and How to Deploy

---

## Table of Contents
1. [Project Overview](#1-project-overview)
2. [Architecture at a Glance](#2-architecture-at-a-glance)
3. [File-by-File Reference](#3-file-by-file-reference)
4. [Database Schema](#4-database-schema)
5. [API Route Map](#5-api-route-map)
6. [Role & Permission System](#6-role--permission-system)
7. [All Issues Found & Fixed](#7-all-issues-found--fixed)
8. [Environment Variables Reference](#8-environment-variables-reference)
9. [Local Setup & Deployment](#9-local-setup--deployment)
10. [Known Limitations & Future Work](#10-known-limitations--future-work)

---

## 1. Project Overview

**Sthappit / DormBook** is a Node.js + Express backend with a vanilla-JS single-page frontend for managing PG accommodations (Paying Guest / hostels / dormitories).

**Tech stack:**
- Runtime: Node.js ≥18
- Framework: Express 4
- Database: SQLite via `better-sqlite3` (synchronous, embedded)
- Auth: JWT (jsonwebtoken) + bcryptjs
- Frontend: Plain HTML/CSS/JS (no build step)
- Deployment target: Vercel Serverless + local/VPS
- Optional: Twilio WhatsApp notifications

**What it manages:**
- Properties → Floors → Rooms → Beds hierarchy
- Resident check-in / check-out lifecycle
- Payment ledger (rent, deposit, refunds, extras)
- Expense tracking
- Staff/user management with role-based access
- Finance reports (CSV + Excel export)
- Audit trail for all money-touching operations
- WhatsApp notification queue (Twilio optional)

---

## 2. Architecture at a Glance

```
sthappit/
├── api/
│   └── index.js          ← Vercel serverless entry point
├── public/
│   ├── index.html        ← Single-page app shell
│   ├── css/app.css       ← All styles
│   └── js/app.js         ← All frontend JS (no framework)
├── src/
│   ├── server.js         ← Express app setup + middleware stack
│   ├── routes/
│   │   └── index.js      ← All API routes wired to controllers
│   ├── controllers/
│   │   ├── authController.js
│   │   ├── bedsController.js
│   │   ├── checkinController.js
│   │   ├── financeController.js
│   │   ├── paymentsController.js
│   │   └── staffController.js
│   ├── middleware/
│   │   ├── auth.js       ← JWT verify + role enforcement
│   │   └── auditLog.js   ← Audit trail writer + middleware factory
│   ├── db/
│   │   ├── connection.js ← Singleton DB getter
│   │   ├── init.js       ← Schema runner + directory creator
│   │   ├── schema.sql    ← All table definitions
│   │   └── seed.js       ← Demo data seeder (dev only)
│   └── services/
│       ├── scheduler.js      ← setInterval cron for WhatsApp queue
│       └── whatsappService.js← Queue writer + Twilio sender
├── .env.example          ← All required environment variables
├── .gitignore
├── package.json
├── vercel.json           ← Vercel deployment config
└── bundle_project.py     ← Creates sthappit.zip for GitHub push
```

**Request flow:**
```
Browser → Express (server.js)
  → helmet (security headers)
  → cors
  → rate limiter (/api/* only)
  → express.static (serves public/)
  → /api/* → routes/index.js
      → authenticate (JWT check)
      → requireRole (role guard)
      → sameProperty (cross-property guard)
      → auditMiddleware (intercepts response to log)
      → controller function
          → better-sqlite3 (synchronous DB calls)
          → scheduleWhatsApp (queues notification, non-blocking)
          → res.json(result)
```

---

## 3. File-by-File Reference

### `api/index.js` — Vercel Entry Point
**Purpose:** The ONLY file Vercel invokes. Sets `DB_PATH=/tmp/sthappit.db` before anything else loads (because Vercel's filesystem is read-only except `/tmp`), then imports and re-exports the Express app from `src/server.js`.

**Critical detail:** It DOES NOT call `app.listen()` — that is guarded by `require.main === module` in server.js, which is false when imported here.

**If you're not using Vercel:** Ignore this file. Run `node src/server.js` directly.

---

### `src/server.js` — Express Application
**Purpose:** Configures the entire Express app and exports it. Does NOT start the HTTP listener unless run directly.

**What it sets up (in order):**
1. `app.set('trust proxy', 1)` — Required for correct IP detection behind Vercel/load balancers. Without this, `req.ip` returns the proxy IP and rate limiting breaks.
2. `helmet()` — Sets secure HTTP headers (XSS protection, no-sniff, CSP, etc.)
3. `cors()` — Restricts origins to `CORS_ORIGIN` env var (or `*` in dev)
4. `express.json()` + `express.urlencoded()` — Body parsers, 2MB limit
5. `morgan` — HTTP request logger (combined format in prod, dev in local)
6. `rateLimit` — 200 requests per 15 minutes on all `/api/*` routes
7. `express.static` — Serves everything in `public/` (HTML, CSS, JS)
8. `/api` routes — Mounts the main router
9. `*` catch-all — Serves `index.html` for all non-API GET requests (SPA fallback)
10. Global error handler — Returns 500 JSON; hides stack traces in production

**Production guard added:** Checks `JWT_SECRET` length at startup; calls `process.exit(1)` if it's missing or too short in production.

---

### `src/routes/index.js` — API Route Definitions
**Purpose:** Maps every HTTP verb + URL path to a controller function, attaching the right middleware chain.

**Middleware applied per route:**
- `authenticate` — All protected routes
- `sameProperty` — Ensures user can only access their own property's data
- `requireRole(minRole)` — Enforces minimum role level
- `auditMiddleware(action, entityType)` — Auto-logs successful writes to `audit_logs`

**Full route list:**

| Method | Path | Auth | Min Role | Description |
|--------|------|------|----------|-------------|
| POST | `/api/auth/login` | None | — | Login, returns JWT |
| GET | `/api/auth/me` | JWT | reception | Get own user info |
| POST | `/api/auth/change-password` | JWT | reception | Change own password |
| GET | `/api/dashboard` | JWT | reception | Dashboard summary |
| GET | `/api/beds` | JWT | reception | Full bed map by floor/room |
| GET | `/api/beds/available` | JWT | reception | Available beds for check-in dropdown |
| POST | `/api/beds` | JWT | manager | Add a new bed |
| PUT | `/api/beds/:bedId/status` | JWT | reception | Change bed status (not to occupied) |
| GET | `/api/residents` | JWT | reception | List residents (filterable by status/search) |
| GET | `/api/residents/:id` | JWT | reception | Single resident + payment history |
| POST | `/api/checkin` | JWT | reception | Full check-in with bed assignment |
| POST | `/api/checkout/:residentId` | JWT | reception | Check-out + refund initiation |
| POST | `/api/residents/:id/extend` | JWT | manager | Extend stay / change rent |
| POST | `/api/payments` | JWT | reception | Record a payment |
| GET | `/api/payments/resident/:residentId` | JWT | reception | Full payment ledger |
| GET | `/api/payments/pending` | JWT | manager | Residents with outstanding dues |
| GET | `/api/payments/pending-approvals` | JWT | manager | Refunds awaiting approval |
| POST | `/api/payments/:paymentId/approve` | JWT | manager | Approve/reject a refund |
| GET | `/api/finance/report` | JWT | manager | P&L report (daily/weekly/monthly/yearly/custom) |
| GET | `/api/finance/export` | JWT | manager | Download report as CSV or Excel |
| GET | `/api/finance/audit` | JWT | manager | Paginated audit trail |
| POST | `/api/expenses` | JWT | manager | Record a property expense |
| GET | `/api/expenses` | JWT | manager | List expenses with date filter |
| GET | `/api/staff` | JWT | manager | List all staff |
| POST | `/api/staff` | JWT | owner | Add staff member |
| PUT | `/api/staff/:userId` | JWT | owner | Update staff details |
| DELETE | `/api/staff/:userId` | JWT | owner | Deactivate (soft-delete) staff |
| GET | `/api/health` | None | — | Health check, returns `{status:"ok"}` |

---

### `src/middleware/auth.js` — Authentication & Authorization
**Purpose:** JWT verification and role-based access control.

**Exports:**
- `authenticate(req, res, next)` — Reads `Authorization: Bearer <token>`, verifies JWT, then re-fetches the user from DB on every request (catches deactivated accounts mid-session). Attaches `req.user = { id, property_id, name, role }`.
- `requireRole(minRole)` — Returns middleware. Compares `req.user.role` against a weight map: `owner=3 > manager=2 > reception=1`. Passing `'manager'` allows owner AND manager.
- `sameProperty(req, res, next)` — Compares `req.params.propertyId` / `req.body.property_id` / `req.query.property_id` against `req.user.property_id`. Prevents cross-property data access. Attaches `req.property_id` for downstream use.
- `stripFinancialFields(user, data)` — Removes revenue/amount fields from objects when called for `reception` role responses.
- `maskAadhaar()` — Always returns `'XXXX XXXX XXXX'`. Called before any resident data leaves a controller.
- `ROLE_WEIGHT` — Exported for reference elsewhere.

**Production security:** `JWT_SECRET` now throws an `Error` if `NODE_ENV=production` and the secret is unset or is the placeholder value.

---

### `src/middleware/auditLog.js` — Audit Trail
**Purpose:** Records every money-touching and sensitive action to the `audit_logs` table.

**Two ways to use:**

1. **Direct call:** `writeAudit({ propertyId, userId, userRole, action, entityType, entityId, before, after, ip })` — used inside controllers when you need precise control of what's logged (e.g., check-in, check-out, bed status change).

2. **Route middleware factory:** `auditMiddleware('PAYMENT_CREATED', 'payment')` — wraps `res.json()` to intercept the successful response, extracts the entity ID from the response body, and writes the audit log automatically. Applied in routes where the controller ID comes back in the response.

**Audit actions logged:** `CHECKIN`, `CHECKOUT`, `STAY_EXTENDED`, `BED_STATUS_CHANGED`, `PAYMENT_CREATED`, `REFUND_APPROVED`, `REFUND_REJECTED`, `REFUND_DECISION`, `EXPENSE_CREATED`, `STAFF_ADDED`, `STAFF_UPDATED`, `STAFF_DEACTIVATED`.

---

### `src/controllers/authController.js` — Authentication
**Purpose:** Login, get-self, change-password.

- `login` — Validates email+password against bcrypt hash, issues JWT signed with `JWT_SECRET` (expires per `JWT_EXPIRES_IN`, default `8h`). Returns token + user object (no password_hash).
- `me` — Returns own user record (no password_hash).
- `changePassword` — Requires current password, enforces 8-char minimum, bcrypt-hashes new password.

---

### `src/controllers/bedsController.js` — Bed Management
**Purpose:** Manages the property's bed inventory.

- `getBedMap` — Returns full floor→room→bed hierarchy with occupancy. Auto-reverts `cleaning` beds to `available` if they've exceeded `CLEANING_AUTO_REVERT_MINUTES` (default 120 mins).
- `getAvailableBeds` — Returns only `available` beds with display labels like "Floor 1 - Room 101 - Bed A". Used by the check-in dropdown.
- `addBed` — Creates a room if it doesn't exist, then adds a bed. Validates floor belongs to the property. Prevents duplicate bed labels per room.
- `updateBedStatus` — Changes bed status to `available`, `reserved`, or `cleaning`. Cannot directly set `occupied` (must go through check-in). Cannot change an `occupied` bed (must go through check-out).

---

### `src/controllers/checkinController.js` — Resident Lifecycle
**Purpose:** Full check-in, check-out, list, get, and stay extension.

**`checkIn`** — The most complex function. Does all of:
1. Validates required fields, mobile format, rent amount, date formats, date ordering (checkout > checkin)
2. Verifies bed is `available` and belongs to the property
3. Stores Aadhaar as `[Aadhaar Redacted]` — never the raw number
4. **Runs a DB transaction:** inserts resident, optionally records deposit payment, optionally records advance rent payment, flips bed to `occupied`
5. Writes audit log
6. Queues WhatsApp confirmation to tenant (non-blocking)

**`checkOut`** — Does:
1. Validates `checkout_date` format
2. Verifies resident is `active`
3. **Runs a DB transaction:** updates resident to `checked_out`, records extra charges if any, records deposit refund with `approval_status='pending'` (refunds always need manager sign-off), flips bed to `cleaning`
4. Writes audit log
5. Queues WhatsApp checkout confirmation

**`listResidents`** — Returns residents with payment badge (`paid`/`partial`/`pending`) and pending rent amount computed on the fly. Search is capped at 100 chars. Aadhaar always masked.

**`extendStay`** — Logs the extension to `stay_extensions` table, updates resident's `expected_checkout` and optionally `rent_amount`.

---

### `src/controllers/paymentsController.js` — Payment Ledger
**Purpose:** Record payments, view ledgers, manage refund approvals.

- `createPayment` — Validates `billing_month` format (YYYY-MM), records a payment event. Sends WhatsApp receipt. Does NOT touch the bed status.
- `getResidentLedger` — Returns all payments for a resident plus computed totals (total credits, total debits, rent paid, pending dues).
- `getPendingDues` — Lists all active residents with `payment_status` of `'pending'` or `'partial'` for the current month. Returns total pending amount.
- `getPendingApprovals` — Lists all payments with `approval_status='pending'` and `payment_type='refund'`.
- `approveRefund` — Updates `approval_status` to `'approved'` or `'rejected'`. Only works on refund-type payments that are still `pending`.

---

### `src/controllers/financeController.js` — Finance & Reporting
**Purpose:** Dashboard, P&L reports, expense management, exports, audit log viewing.

- `getDashboard` — Single-query summary: bed stats, today's checkins/checkouts/collection, monthly income/expenses/net, pending dues count, refunds awaiting approval.
- `getReport` — Accepts `period` (daily/weekly/monthly/yearly/custom) and optional `start_date`/`end_date`. Validates date formats. Returns income breakdown by type, refunds, expenses by category, net profit, and a daily breakdown array.
- `createExpense` — Validates `expense_date` format, amount > 0.
- `exportReport` — Async function (wrapped in try/catch → `next(err)`). Supports `format=csv` or `format=excel`. CSV is plain text; Excel uses ExcelJS with two worksheets (Payments, Expenses).
- `getAuditLog` — Paginated (default 100, max 500 per request). Joins with `users` to show `user_name`. Integer params validated and clamped.

---

### `src/controllers/staffController.js` — Staff Management
**Purpose:** Owner-managed user accounts.

- `listStaff` — Returns all users for the property (no password hashes).
- `addStaff` — Validates email format, enforces 8-char password minimum, hashes password. Roles allowed: `manager` or `reception` (cannot create another `owner` via API).
- `updateStaff` — Cannot change your own role. Cannot modify another owner's account. Soft-activates/deactivates with `is_active`.
- `deactivateStaff` — Cannot deactivate yourself. Sets `is_active=0` (soft delete — records preserved).

---

### `src/db/connection.js` — DB Singleton
**Purpose:** Returns the same `better-sqlite3` Database instance on every call (singleton pattern). Calls `initDb()` on first access, which creates the database file and runs schema if tables don't exist. Sets `PRAGMA foreign_keys = ON` and `PRAGMA journal_mode = WAL` on every fresh connection.

**Why singleton:** `better-sqlite3` connections are synchronous and not thread-safe. One connection per process is the correct pattern.

---

### `src/db/init.js` — Schema Initializer
**Purpose:** Creates the `data/` directory if it doesn't exist, opens the DB file at `DB_PATH`, and executes `schema.sql` statement-by-statement. Can be run directly (`node src/db/init.js`) or imported.

**`DB_PATH` resolution order:**
1. `process.env.DB_PATH` (set to `/tmp/sthappit.db` by `api/index.js` on Vercel)
2. Falls back to `./data/sthappit.db`

---

### `src/db/schema.sql` — Database Schema
**Tables:** `users`, `properties`, `floors`, `rooms`, `beds`, `residents`, `payments`, `expenses`, `stay_extensions`, `audit_logs`, `notification_log`

**All primary keys are UUIDs (TEXT).** No auto-increment integers.

**Key constraints:**
- `beds.status` CHECK: `available | occupied | reserved | cleaning`
- `rooms.room_type` CHECK: `shared | private | dormitory`
- `payments.direction` CHECK: `credit | debit`
- `payments.payment_mode` CHECK: `cash | upi | card | bank_transfer`
- `payments.approval_status` CHECK: `not_required | pending | approved | rejected`
- `residents.status` CHECK: `active | checked_out | reserved`
- `users.role` CHECK: `owner | manager | reception`

**Indexes created:** `beds(property_id)`, `beds(status)`, `residents(property_id)`, `residents(status)`, `payments(resident_id)`, `payments(property_id, paid_at)`, `audit_logs(property_id, created_at)`, `expenses(property_id, expense_date)`

---

### `src/db/seed.js` — Demo Data Seeder
**Purpose:** Populates a fresh DB with one demo property, 3 users, 3 floors, 9 rooms, 18 beds, ~8 residents (some active, some checked out), payments, and expenses. Used for development and demos ONLY.

**Warning added:** Console warns `[SEED] DEMO credentials - CHANGE ALL PASSWORDS before going live!`

**How to run:** `npm run db:seed` — checks if `properties` table already has rows; skips if seeded.

**Demo credentials (CHANGE THESE):**
- `raj@sunrisepg.com` / `owner123` (Owner)
- `priya@sunrisepg.com` / `manager123` (Manager)
- `amit@sunrisepg.com` / `reception123` (Reception)

---

### `src/services/whatsappService.js` — WhatsApp Queue
**Purpose:** Writes notification jobs to `notification_log` table (non-blocking) and flushes them via Twilio when the scheduler runs.

**Two modes:**
- **With Twilio credentials:** Sends real WhatsApp messages via `twilio` SDK.
- **Without credentials (dev mode):** Logs message body to console, marks as `sent`. Twilio credentials are optional.

**Templates:** `checkin_confirm`, `checkout_confirm`, `payment_receipt`, `payment_due`, `overdue`, `daily_summary`, `refund_alert`

**Functions:**
- `scheduleWhatsApp(opts)` — Writes one row to `notification_log` with `status='pending'`. Called from controllers. Synchronous, never throws (errors logged).
- `sendPending()` — Async. Reads up to 50 `pending` rows, sends each, updates status to `delivered` or `failed`.
- `sendDailySummary(propertyId)` — Builds daily summary data from DB and queues it to all `owner` users.
- `sendOverdueReminders(propertyId)` — Finds active residents with unpaid rent and queues `overdue` messages.

---

### `src/services/scheduler.js` — Background Cron
**Purpose:** Runs the WhatsApp queue flush every 5 minutes, and triggers daily summary + overdue reminders at 21:00 IST (15:30 UTC).

**Important:** This only runs in long-lived processes. It does NOT run on Vercel (serverless functions are stateless/ephemeral). On Vercel, use Vercel Cron Jobs to hit `/api/health` or a dedicated `/api/cron` endpoint.

**Functions:** `startScheduler()`, `stopScheduler()`, `runNow()` (for testing)

---

### `public/index.html` — SPA Shell
**Purpose:** Single HTML file that loads the CSS and JS. Contains the login form (rendered first), then all other views are shown/hidden by JS. Demo credential hint was removed for production.

### `public/css/app.css` — Styles
**Purpose:** All styles for the single-page app. No external CSS frameworks.

### `public/js/app.js` — Frontend Application
**Purpose:** Complete frontend logic in a single IIFE. Manages all views (dashboard, beds, residents, check-in, payments, reports, staff), makes `fetch()` calls to `/api/*`, handles JWT storage in `localStorage`, and renders all UI dynamically.

**Key constant:** `const API = '/api'` — relative path, works on any deployment URL without hardcoding.

---

### `.env.example` — Environment Variable Reference
Every variable the application reads. Copy to `.env` and fill in values. Never commit `.env`.

### `.gitignore`
Covers: `node_modules/`, `.env*`, `data/` (but keeps `data/.gitkeep`), `*.db` / `*.db-shm` / `*.db-wal`, logs, OS files, `.vercel/`.

### `vercel.json` — Vercel Deployment Config
Tells Vercel to build `api/index.js` with `@vercel/node`, route ALL traffic (`/(.*)`) to that function, set `NODE_ENV=production`, and allow up to 30s execution with 512MB memory.

### `package.json` — Dependencies & Scripts
| Script | Command | Purpose |
|--------|---------|---------|
| `start` | `node src/server.js` | Production local start |
| `dev` | `nodemon src/server.js` | Development with auto-restart |
| `db:init` | `node src/db/init.js` | Create DB and run schema |
| `db:seed` | `node src/db/seed.js` | Populate demo data |
| `vercel-build` | `npm install && echo ...` | Tells Vercel to install deps (regenerates lock file) |

### `bundle_project.py` — Release Bundler
Walks the project directory, excludes `node_modules/`, `.git/`, `.env`, `*.db`, `__pycache__/`, and packages everything into `sthappit.zip`. Run with `python3 bundle_project.py`.

---

## 4. Database Schema

### Entity Relationships
```
properties (1) ──< floors (many)
floors (1) ──< rooms (many)
rooms (1) ──< beds (many)

properties (1) ──< users (many)       [staff]
properties (1) ──< residents (many)
properties (1) ──< payments (many)
properties (1) ──< expenses (many)
properties (1) ──< audit_logs (many)
properties (1) ──< notification_log (many)

residents (1) ──< payments (many)
residents (1) ──< stay_extensions (many)
beds (1) ──< residents (many)          [over time, one bed many residents]
```

### Payment Flow Logic
```
Check-in:
  deposit_amount > 0 → INSERT payment (type='deposit', direction='credit', approval_status='not_required')
  amount_paid > 0    → INSERT payment (type='rent',    direction='credit', approval_status='not_required')

Check-out:
  extra_charges > 0         → INSERT payment (type='extra_charge', direction='credit')
  deposit_refund_amount > 0 → INSERT payment (type='refund', direction='debit', approval_status='pending')

Manager approves refund:
  UPDATE payments SET approval_status='approved' WHERE id=?

Monthly rent payment:
  POST /api/payments → INSERT payment (type='rent', direction='credit')
```

---

## 5. API Route Map

Base URL: `https://your-domain.com/api`

All protected routes require: `Authorization: Bearer <jwt_token>`

### Authentication
```
POST /auth/login          { email, password } → { token, user }
GET  /auth/me             → user object
POST /auth/change-password { current_password, new_password }
```

### Dashboard
```
GET  /dashboard           → { beds, today, monthly, pending }
```

### Beds
```
GET  /beds                → { summary, floors: [ { rooms: [ { beds } ] } ] }
GET  /beds/available      → [ { id, display_label, bed_label, room_number, floor_label } ]
POST /beds                { floor_id, room_number, bed_label, room_type? }
PUT  /beds/:bedId/status  { status: 'available'|'reserved'|'cleaning' }
```

### Residents
```
GET  /residents           ?status=active|checked_out|all&search=name_or_mobile
GET  /residents/:id       → resident + payments[]
POST /checkin             { full_name, mobile, bed_id, check_in_date, expected_checkout,
                            rent_amount, deposit_amount, amount_paid, payment_mode,
                            id_consent_given:true, ... }
POST /checkout/:id        { checkout_date, extra_charges?, deposit_refund_amount?,
                            payment_mode?, notes? }
POST /residents/:id/extend { new_expected_checkout, new_rent_amount? }
```

### Payments
```
POST /payments            { resident_id, amount, payment_type, payment_mode,
                            billing_month:YYYY-MM, gateway_txn_id?, notes? }
GET  /payments/resident/:id      → { resident, ledger, payments[] }
GET  /payments/pending           → { count, total_pending, residents[] }
GET  /payments/pending-approvals → [ refund payments ]
POST /payments/:id/approve { decision: 'approved'|'rejected', notes? }
```

### Finance
```
GET  /finance/report  ?period=daily|weekly|monthly|yearly|custom&start_date=&end_date=
GET  /finance/export  ?format=csv|excel&period=...
GET  /finance/audit   ?limit=100&offset=0
POST /expenses        { category, amount, expense_date:YYYY-MM-DD, description?, payment_mode? }
GET  /expenses        ?start_date=&end_date=
```

### Staff
```
GET    /staff              → [ users (no password) ]
POST   /staff              { name, mobile, password, role:'manager'|'reception', email? }
PUT    /staff/:id          { name?, mobile?, role?, is_active? }
DELETE /staff/:id          → deactivates account
```

---

## 6. Role & Permission System

| Operation | reception | manager | owner |
|-----------|-----------|---------|-------|
| Login, change own password | ✅ | ✅ | ✅ |
| View dashboard | ✅ | ✅ | ✅ |
| View beds, available beds | ✅ | ✅ | ✅ |
| Update bed status | ✅ | ✅ | ✅ |
| Add new bed | ❌ | ✅ | ✅ |
| List/view residents | ✅ | ✅ | ✅ |
| Check-in resident | ✅ | ✅ | ✅ |
| Check-out resident | ✅ | ✅ | ✅ |
| Extend stay / change rent | ❌ | ✅ | ✅ |
| Record payment | ✅ | ✅ | ✅ |
| View payment ledger | ✅ | ✅ | ✅ |
| View pending dues | ❌ | ✅ | ✅ |
| Approve/reject refund | ❌ | ✅ | ✅ |
| Finance reports | ❌ | ✅ | ✅ |
| Export reports | ❌ | ✅ | ✅ |
| Audit log | ❌ | ✅ | ✅ |
| Record/list expenses | ❌ | ✅ | ✅ |
| List staff | ❌ | ✅ | ✅ |
| Add/update/deactivate staff | ❌ | ❌ | ✅ |

**Financial data restriction:** `reception` role users receive `[restricted]` instead of monetary values in certain responses (handled by `stripFinancialFields` in `auth.js`).

---

## 7. All Issues Found & Fixed

### CRITICAL (would cause production failures)

**C1 — `twilio` missing from `package.json`**
- `whatsappService.js` calls `require('twilio')` at runtime
- Was missing from dependencies → `npm ci` would fail on Vercel
- **Fixed:** Added `"twilio": "^5.3.3"` to dependencies
- **Action needed:** Run `npm install` locally to regenerate `package-lock.json`

**C2 — `package-lock.json` out of sync**
- Cannot regenerate in a sandboxed environment without network
- **Fixed:** `vercel-build` script updated to `npm install && echo ...` so Vercel regenerates the lock file on every deploy
- **Action needed:** Run `npm install` locally after cloning — this syncs your lock file

**C3 — `JWT_SECRET` silent weak fallback**
- `auth.js` and `authController.js` silently fell back to `'change_this_secret'` in production
- **Fixed:** Both files now throw `Error` if `NODE_ENV=production` and secret is missing/placeholder
- **Fixed:** `server.js` checks secret at startup and calls `process.exit(1)` before serving any traffic

### MEDIUM (security or correctness risks)

**M1 — Two dead dependencies wasting install size**
- `sql.js` (~3MB) and `@databases/sqlite` were listed but never `require()`d anywhere
- **Fixed:** Both removed from `package.json`

**M2 — Demo credentials exposed in login HTML**
- `public/index.html` showed `Demo: raj@sunrisepg.com / owner123` publicly
- **Fixed:** Comment replaced — hint removed from production build

**M3 — `seed.js` default passwords with no warning**
- Passwords `owner123/manager123/reception123` logged with no dev-only flag
- **Fixed:** Added `console.warn('[SEED] DEMO credentials - CHANGE ALL PASSWORDS before going live!')`

**M4 — `exportReport` async errors not caught**
- `async function exportReport` had no try/catch — unhandled promise rejections would crash/hang on Vercel
- **Fixed:** Wrapped full function body in `try { ... } catch (err) { return next(err); }`

**M5 — Pagination integers not validated (`getAuditLog`)**
- `parseInt(req.query.limit)` could produce `NaN` (no default guard) or allow unlimited rows
- **Fixed:** Validated and clamped: limit 1–500 (default 100), offset ≥0 (default 0)

### LOW (defensive hardening)

**L1 — Missing `CLEANING_AUTO_REVERT_MINUTES` in `.env.example`**
- `bedsController.js` reads this env var but it wasn't documented
- **Fixed:** Added to `.env.example` with explanation

**L2 — Missing `JWT_EXPIRES_IN` and `BCRYPT_ROUNDS` in `.env.example`**
- `authController.js` reads both; neither was in the env example
- **Fixed:** Added with sane defaults (`8h`, `12`)

**L3 — No `trust proxy` setting**
- Without this, `req.ip` returns the proxy IP on Vercel → rate limiter is ineffective
- **Fixed:** `app.set('trust proxy', 1)` added at top of `server.js`

**L4 — No mobile number format validation on check-in**
- Any string was accepted for `mobile` field
- **Fixed:** Strips non-digits, validates length 10–12 digits

**L5 — No date format validation on check-in / checkout / expenses**
- Invalid dates like `"tomorrow"` or `"2026/01/01"` would silently produce bad DB data
- **Fixed:** `YYYY-MM-DD` regex validation added at the top of each affected function. Check-in also validates `expected_checkout > check_in_date`.

**L6 — No `billing_month` format validation on payment creation**
- Any string was accepted; broken months would corrupt ledger queries
- **Fixed:** `YYYY-MM` regex validation added to `createPayment`

**L7 — No date validation on finance report query params**
- `start_date` / `end_date` passed straight to SQLite `BETWEEN` without format check
- **Fixed:** `YYYY-MM-DD` validation added before `getDateRange()` call

**L8 — Search string uncapped in `listResidents`**
- Unbounded query string could cause unnecessary DB work
- **Fixed:** Trimmed and capped to 100 characters

**L9 — No email format validation in `addStaff`**
- Invalid email strings would be stored silently
- **Fixed:** Basic RFC-style regex validation added

**L10 — `.gitignore` swallowed `data/.gitkeep`**
- `data/` rule excluded the `.gitkeep` file, meaning `git clone` wouldn't create the directory → DB init would fail
- **Fixed:** Added `!data/.gitkeep` negation

---

## 8. Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NODE_ENV` | Yes | `development` | Set to `production` on Vercel |
| `PORT` | No | `3000` | HTTP port (local only) |
| `DB_PATH` | No | `./data/sthappit.db` | SQLite file path. Auto-set to `/tmp/sthappit.db` on Vercel |
| `JWT_SECRET` | **YES — production** | *(throws if missing)* | Must be ≥32 chars. Generate: `openssl rand -base64 48` |
| `JWT_EXPIRES_IN` | No | `8h` | JWT token lifetime |
| `BCRYPT_ROUNDS` | No | `12` | Password hashing rounds (10–14 recommended) |
| `CORS_ORIGIN` | No | `*` | Allowed CORS origin(s) |
| `RATE_LIMIT_WINDOW_MS` | No | `900000` | Rate limit window (15 minutes) |
| `RATE_LIMIT_MAX_REQUESTS` | No | `200` | Max requests per window per IP |
| `CLEANING_AUTO_REVERT_MINUTES` | No | `120` | Minutes before cleaning bed reverts to available (0 = off) |
| `TWILIO_ACCOUNT_SID` | No | — | Twilio account SID (ACxxx...). Omit to run in dev/console mode |
| `TWILIO_AUTH_TOKEN` | No | — | Twilio auth token |
| `TWILIO_WHATSAPP_FROM` | No | `whatsapp:+14155238886` | Twilio WhatsApp sender number |

---

## 9. Local Setup & Deployment

### Local Development

```bash
# 1. Clone and enter project
git clone https://github.com/your-org/sthappit.git
cd sthappit

# 2. Install dependencies (also regenerates package-lock.json with twilio)
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env — at minimum set JWT_SECRET to something strong:
# openssl rand -base64 48

# 4. Initialize database schema
npm run db:init

# 5. (Optional) Load demo data
npm run db:seed

# 6. Start dev server with auto-reload
npm run dev

# Server runs at http://localhost:3000
# Login with seed credentials (CHANGE IN PRODUCTION):
#   raj@sunrisepg.com / owner123
```

### Vercel Deployment

```bash
# 1. Install Vercel CLI
npm i -g vercel

# 2. Deploy (first time — follow prompts)
vercel

# 3. Set environment variables in Vercel dashboard:
#    Project → Settings → Environment Variables
#    Required: JWT_SECRET (strong, ≥32 chars)
#    Optional: CORS_ORIGIN, TWILIO_*, etc.

# 4. Redeploy after setting env vars
vercel --prod
```

**Vercel important notes:**
- The SQLite database at `/tmp/sthappit.db` is **ephemeral** — it resets on every cold start. For persistent data on Vercel, migrate to Turso (libSQL), PlanetScale, or another external database.
- The WhatsApp scheduler (`setInterval`) does NOT run on Vercel. Use Vercel Cron Jobs to call `/api/health` to trigger a send cycle (requires adding a dedicated cron route).
- `package-lock.json` is regenerated by Vercel on each deploy because `vercel-build` runs `npm install`.

### Self-hosted / VPS Deployment

```bash
# Set NODE_ENV=production in your process manager (PM2, systemd, etc.)
# Example PM2:
pm2 start src/server.js --name sthappit --env production

# The scheduler WILL run on self-hosted — WhatsApp messages send automatically.
# SQLite data persists at DB_PATH across restarts.
```

---

## 10. Known Limitations & Future Work

### Current limitations

| Limitation | Impact | Recommended fix |
|------------|--------|-----------------|
| SQLite on Vercel is ephemeral | Data lost on cold start | Migrate to Turso (libSQL) — drop-in compatible with `better-sqlite3` API |
| No WhatsApp scheduler on Vercel | Daily summaries / overdue reminders won't fire | Add Vercel Cron Job or external cron service hitting `/api/cron` |
| Single property per deployment | Cannot serve multiple PG owners | Add multi-tenancy: each `property_id` is already isolated; add a property-selection screen |
| No file uploads implemented | `photo_path`, `aadhaar_photo_path`, `receipt_path` stored as strings only | Add Multer + cloud storage (S3, Cloudflare R2) |
| Aadhaar stored as placeholder | Full KYC compliance not met | Encrypt with AES-256-GCM before storing, decrypt only for authorized roles |
| No email notifications | Staff must use WhatsApp only | Add Nodemailer or Resend for email alerts |
| No refresh token | JWT expires after 8h, user must re-login | Implement refresh token in `auth_tokens` table |
| Frontend is vanilla JS | Hard to scale UI complexity | Migrate to React/Vue when features grow |
| No test suite | Regressions possible | Add Jest + supertest; DB can be in-memory for tests |
| CSV export has commas in data | May break CSV parsing if names/descriptions contain commas | Escape CSV fields properly or use `json2csv` (already in deps) |

### Security items for production hardening
- Enforce HTTPS at the infrastructure level (Vercel does this automatically)
- Add Content-Security-Policy nonce for inline scripts
- Consider adding Brute-force protection on `/api/auth/login` (beyond rate limiting — add per-email lockout)
- Rotate `JWT_SECRET` periodically and handle token invalidation

