# 🏠 Sthappit / DormBook

**PG & Hostel Management System** — lightweight, WhatsApp-native, owner-first.

## Quick Start

```bash
# 1. Install dependencies
npm install   # also regenerates package-lock.json with twilio

# 2. Copy env file and fill in your credentials
cp .env.example .env

# 3. Initialise the database and seed demo data
npm run db:init
npm run db:seed

# 4. Start the server
npm start        # production
npm run dev      # development (auto-reload)
```

Open `http://localhost:3000`

**Demo accounts:**
| Email | Password | Role |
|---|---|---|
| raj@sunrisepg.com | owner123 | Owner |
| priya@sunrisepg.com | manager123 | Manager |
| amit@sunrisepg.com | reception123 | Reception |

---

## Architecture

```
sthappit/
├── src/
│   ├── server.js              # Express entry point
│   ├── routes/index.js        # All API routes
│   ├── controllers/
│   │   ├── authController.js
│   │   ├── bedsController.js
│   │   ├── checkinController.js
│   │   ├── paymentsController.js
│   │   ├── financeController.js
│   │   └── staffController.js
│   ├── middleware/
│   │   ├── auth.js            # JWT + RBAC
│   │   └── auditLog.js        # Audit trail
│   ├── services/
│   │   ├── whatsappService.js # WhatsApp via Twilio
│   │   └── scheduler.js       # Nightly cron jobs
│   └── db/
│       ├── schema.sql
│       ├── init.js
│       ├── connection.js
│       └── seed.js
├── public/
│   ├── index.html             # SPA shell
│   ├── css/app.css
│   └── js/app.js              # Full frontend SPA
└── data/                      # SQLite DB (auto-created)
```

## API Reference

### Auth
| Method | Endpoint | Access |
|---|---|---|
| POST | /api/auth/login | Public |
| GET  | /api/auth/me | All |
| POST | /api/auth/change-password | All |

### Dashboard
| GET | /api/dashboard | All |

### Beds
| GET | /api/beds | All |
| GET | /api/beds/available | All |
| POST | /api/beds | Manager+ |
| PUT | /api/beds/:id/status | Reception+ |

### Residents & Lifecycle
| GET | /api/residents | All |
| GET | /api/residents/:id | All |
| POST | /api/checkin | Reception+ |
| POST | /api/checkout/:id | Reception+ |
| POST | /api/residents/:id/extend | Manager+ |

### Payments
| POST | /api/payments | Reception+ |
| GET | /api/payments/resident/:id | All |
| GET | /api/payments/pending | Manager+ |
| GET | /api/payments/pending-approvals | Manager+ |
| POST | /api/payments/:id/approve | Manager+ |

### Finance (Manager+ only)
| GET | /api/finance/report | Manager+ |
| GET | /api/finance/export | Manager+ |
| GET | /api/finance/audit | Manager+ |
| POST | /api/expenses | Manager+ |
| GET | /api/expenses | Manager+ |

### Staff (Owner only)
| GET | /api/staff | Manager+ |
| POST | /api/staff | Owner |
| PUT | /api/staff/:id | Owner |
| DELETE | /api/staff/:id | Owner |

---

## Key Design Decisions

- **SQLite + better-sqlite3** — synchronous, zero-config, perfect for single-property pilot. Swap to PostgreSQL for multi-tenant SaaS by swapping the connection module.
- **Aadhaar privacy** — number is never stored raw. Only a `[Aadhaar Redacted]` placeholder is written to DB. API always returns `XXXX XXXX XXXX`.
- **Refund approval gate** — any deposit refund payment has `requires_approval=1` and `approval_status='pending'` until a Manager/Owner explicitly approves it.
- **Cleaning timer** — beds move to `cleaning` on checkout. They auto-revert to `available` after `CLEANING_AUTO_REVERT_MINUTES` (default 120), or you can set it to 0 to require manual confirmation.
- **Audit trail** — every money-touching action (payments, refunds, check-in, check-out, expenses) writes a row to `audit_logs` with user ID, role, before/after snapshots, and IP address.
- **WhatsApp** — messages are queued in `notification_log` and flushed every 5 minutes. Requires Twilio credentials in `.env`. Without them, messages are logged to console (dev mode).
- **Role-based UI** — Reception sees no revenue, expense, or net income figures anywhere. The frontend and backend both enforce this independently.
