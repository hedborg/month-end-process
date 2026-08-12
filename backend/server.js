const express = require('express');
const path = require('path');
const pool = require('./db');

const app = express();
app.use(express.json());
app.use((req, _res, next) => { console.log(req.method, req.url); next(); });

// PUBLIC_DIR can be overridden; Docker mounts frontend at /app/public
const publicDir = process.env.PUBLIC_DIR || path.join(__dirname, '..', 'frontend');
app.use(express.static(publicDir));

app.use('/api', require('./routes/api'));

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
}

migrate()
  .then(() => app.listen(PORT, () => console.log(`month-end-process listening on :${PORT}`)))
  .catch((err) => { console.error('migration failed', err); process.exit(1); });
