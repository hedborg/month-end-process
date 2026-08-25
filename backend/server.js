const express = require('express');
const path = require('path');
const session = require('express-session');
const pgSessionStore = require('connect-pg-simple')(session);
const pool = require('./db');
const { router: authRouter, requireAuth } = require('./routes/auth');

const app = express();
app.use(express.json());
app.use((req, _res, next) => { console.log(req.method, req.url); next(); });

if (!process.env.SESSION_SECRET) {
  console.warn('WARNING: SESSION_SECRET is not set — using an insecure default. Set it in production.');
}

app.use(session({
  store: new pgSessionStore({ pool, createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'dev-only-insecure-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true', // flip to true once served over HTTPS
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  },
}));

// PUBLIC_DIR can be overridden; Docker mounts frontend at /app/public
const publicDir = process.env.PUBLIC_DIR || path.join(__dirname, '..', 'frontend');
app.use(express.static(publicDir));

app.use('/api', authRouter); // /api/login, /api/logout, /api/session — no auth required
app.use('/api', requireAuth, require('./routes/api')); // everything else requires a session

const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Migrations — run on every startup, idempotent
// ---------------------------------------------------------------------------
async function migrate() {
  // M1: task lineage, so the overview report can match a task across months
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS cloned_from_task_id INT REFERENCES tasks(id)`);

  // Backfill lineage for cycles that were cloned before this column existed,
  // matching by task_name within the same clone relationship.
  await pool.query(`
    UPDATE tasks t
    SET cloned_from_task_id = src.id
    FROM cycles c, tasks src
    WHERE t.cycle_id = c.id
      AND c.created_from_cycle_id IS NOT NULL
      AND src.cycle_id = c.created_from_cycle_id
      AND src.task_name = t.task_name
      AND t.cloned_from_task_id IS NULL
  `);

  // M2: add the "ready_to_be_booked" status, between in_progress/waiting and done
  await pool.query(`ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_booking_status_check`);
  await pool.query(`
    ALTER TABLE tasks ADD CONSTRAINT tasks_booking_status_check
      CHECK (booking_status IN ('not_started', 'in_progress', 'waiting', 'ready_to_be_booked', 'done', 'n_a'))
  `);
  await pool.query(`ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_check_status_check`);
  await pool.query(`
    ALTER TABLE tasks ADD CONSTRAINT tasks_check_status_check
      CHECK (check_status IN ('not_started', 'in_progress', 'waiting', 'ready_to_be_booked', 'done', 'n_a'))
  `);

  // M3: password-based login. name becomes the login identifier, so it must be unique.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT`);
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE users ADD CONSTRAINT users_name_key UNIQUE (name);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `);
}

migrate()
  .then(() => app.listen(PORT, () => console.log(`month-end-process listening on :${PORT}`)))
  .catch((err) => { console.error('migration failed', err); process.exit(1); });
