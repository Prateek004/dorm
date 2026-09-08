'use strict';

require('dotenv').config();
const express     = require('express');
const cors        = require('cors');
const helmet      = require('helmet');
const morgan      = require('morgan');
const path        = require('path');
const rateLimit   = require('express-rate-limit');

const routes      = require('./routes/index');
const { startScheduler } = require('./services/scheduler');

const app  = express();

// Trust the first hop proxy (required on Vercel / behind load-balancers)
app.set("trust proxy", 1);

const PORT = parseInt(process.env.PORT || '3000', 10);

// ── Security & Parsing ────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'"],
      styleSrc:   ["'self'", "'unsafe-inline'"],
      imgSrc:     ["'self'", 'data:'],
    },
  },
}));

app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// ── Rate limiting ─────────────────────────────────────────
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10),
  max:      parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '200', 10),
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Too many requests, please try again later.' },
});
app.use('/api/', limiter);

// ── Static frontend ───────────────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── API Routes ────────────────────────────────────────────
app.use('/api', routes);

// ── SPA fallback (serves index.html for all non-API routes) ─
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    return res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  }
  return res.status(404).json({ error: 'Not found' });
});

// ── Global error handler ──────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[Server Error]', err);

  if (err.message?.includes('start_date and end_date required')) {
    return res.status(400).json({ error: err.message });
  }

  return res.status(500).json({
    error: process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : err.message,
  });
});

// ── Production safety guard ──────────────────────────────
if (process.env.NODE_ENV === 'production') {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret === 'change_this_secret_dev_only' || secret.length < 32) {
    console.error('❌ FATAL: JWT_SECRET is missing or too short for production. Set a strong secret (≥32 chars).');
    process.exit(1);
  }
}

// ── Start (only when run directly — not when imported by Vercel) ──
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n🏠 Sthappit / DormBook running on http://localhost:${PORT}`);
    console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`   API:         http://localhost:${PORT}/api`);
    console.log(`   Dashboard:   http://localhost:${PORT}\n`);

    // Background scheduler runs only in long-lived process (not Vercel serverless)
    startScheduler();
  });
}

module.exports = app;
