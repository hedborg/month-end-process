const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');

const router = express.Router();

const asyncHandler = (fn) => (req, res) => fn(req, res).catch((err) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

const STATUS_VALUES = ['not_started', 'in_progress', 'waiting', 'ready_to_be_booked', 'done', 'n_a'];

// Columns safe to send to the client — never password_hash.
const USER_COLUMNS = 'id, name, email, active, created_at, (password_hash IS NOT NULL) AS has_password';

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

router.get('/users', asyncHandler(async (_req, res) => {
  const { rows } = await pool.query(`SELECT ${USER_COLUMNS} FROM users ORDER BY name`);
  res.json(rows);
}));

router.post('/users', asyncHandler(async (req, res) => {
  const { name, email, password } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const passwordHash = password ? await bcrypt.hash(password, 12) : null;
  const { rows } = await pool.query(
    `INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING ${USER_COLUMNS}`,
    [name, email || null, passwordHash],
  );
  res.status(201).json(rows[0]);
}));

router.patch('/users/:id', asyncHandler(async (req, res) => {
  const { name, email, active, password } = req.body;
  const passwordHash = password ? await bcrypt.hash(password, 12) : null;
  const { rows } = await pool.query(
    `UPDATE users SET
       name = COALESCE($1, name),
       email = COALESCE($2, email),
       active = COALESCE($3, active),
       password_hash = COALESCE($4, password_hash)
     WHERE id = $5 RETURNING ${USER_COLUMNS}`,
    [name, email, active, passwordHash, req.params.id],
  );
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  res.json(rows[0]);
}));

// ---------------------------------------------------------------------------
// Cycles
// ---------------------------------------------------------------------------

router.get('/cycles', asyncHandler(async (_req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM cycles ORDER BY year DESC, month DESC, id DESC',
  );
  res.json(rows);
}));

router.post('/cycles', asyncHandler(async (req, res) => {
  const { label, year, month, notes } = req.body;
  if (!label || !year || !month) {
    return res.status(400).json({ error: 'label, year and month are required' });
  }
  const { rows } = await pool.query(
    'INSERT INTO cycles (label, year, month, notes) VALUES ($1, $2, $3, $4) RETURNING *',
    [label, year, month, notes || null],
  );
  res.status(201).json(rows[0]);
}));

router.patch('/cycles/:id', asyncHandler(async (req, res) => {
  const { label, status, notes } = req.body;
  if (status && !['open', 'locked', 'archived'].includes(status)) {
    return res.status(400).json({ error: 'invalid status' });
  }
  const { rows } = await pool.query(
    `UPDATE cycles SET
       label = COALESCE($1, label),
       status = COALESCE($2, status),
       notes = COALESCE($3, notes)
     WHERE id = $4 RETURNING *`,
    [label, status, notes, req.params.id],
  );
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  res.json(rows[0]);
}));

router.delete('/cycles/:id', asyncHandler(async (req, res) => {
  await pool.query('DELETE FROM cycles WHERE id = $1', [req.params.id]);
  res.status(204).end();
}));

// Clone every task from an existing cycle into the next calendar month,
// resetting progress and comments so the new month starts clean. Tasks that
// were N/A stay N/A — everything else resets to not_started.
router.post('/cycles/:id/clone', asyncHandler(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: sourceRows } = await client.query(
      'SELECT year, month FROM cycles WHERE id = $1',
      [req.params.id],
    );
    if (!sourceRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'source cycle not found' });
    }

    let { year, month } = sourceRows[0];
    month += 1;
    if (month > 12) { month = 1; year += 1; }
    const label = `${year}-${String(month).padStart(2, '0')}`;

    const { rows: existing } = await client.query('SELECT id FROM cycles WHERE label = $1', [label]);
    if (existing.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Cycle ${label} already exists` });
    }

    const { rows: cycleRows } = await client.query(
      `INSERT INTO cycles (label, year, month, created_from_cycle_id)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [label, year, month, req.params.id],
    );
    const newCycle = cycleRows[0];

    await client.query(
      `INSERT INTO tasks (
         cycle_id, sort_order, task_name, description, dependency_text, due_date,
         booking_responsible_id, quality_check_id, url, powerbi_url,
         booking_status, check_status, cloned_from_task_id
       )
       SELECT $1, sort_order, task_name, description, dependency_text, due_date,
              booking_responsible_id, quality_check_id, url, powerbi_url,
              CASE WHEN booking_status = 'n_a' THEN 'n_a' ELSE 'not_started' END,
              CASE WHEN check_status = 'n_a' THEN 'n_a' ELSE 'not_started' END,
              id
       FROM tasks WHERE cycle_id = $2
       ORDER BY sort_order`,
      [newCycle.id, req.params.id],
    );

    await client.query('COMMIT');
    res.status(201).json(newCycle);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

router.get('/cycles/:id/tasks', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT t.*,
            ur.name AS booking_responsible_name,
            uq.name AS quality_check_name
     FROM tasks t
     LEFT JOIN users ur ON ur.id = t.booking_responsible_id
     LEFT JOIN users uq ON uq.id = t.quality_check_id
     WHERE t.cycle_id = $1
     ORDER BY t.sort_order, t.id`,
    [req.params.id],
  );
  res.json(rows);
}));

router.get('/tasks/:id', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT t.*,
            ur.name AS booking_responsible_name,
            uq.name AS quality_check_name,
            c.label AS cycle_label
     FROM tasks t
     LEFT JOIN users ur ON ur.id = t.booking_responsible_id
     LEFT JOIN users uq ON uq.id = t.quality_check_id
     JOIN cycles c ON c.id = t.cycle_id
     WHERE t.id = $1`,
    [req.params.id],
  );
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  res.json(rows[0]);
}));

router.post('/cycles/:id/tasks', asyncHandler(async (req, res) => {
  const {
    task_name, description, dependency_text, due_date,
    booking_responsible_id, quality_check_id, url, powerbi_url,
  } = req.body;
  if (!task_name) return res.status(400).json({ error: 'task_name is required' });

  const { rows: maxRows } = await pool.query(
    'SELECT COALESCE(MAX(sort_order), 0) + 10 AS next_order FROM tasks WHERE cycle_id = $1',
    [req.params.id],
  );

  const { rows } = await pool.query(
    `INSERT INTO tasks (
       cycle_id, sort_order, task_name, description, dependency_text, due_date,
       booking_responsible_id, quality_check_id, url, powerbi_url
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [
      req.params.id, maxRows[0].next_order, task_name, description || null,
      dependency_text || null, due_date || null, booking_responsible_id || null,
      quality_check_id || null, url || null, powerbi_url || null,
    ],
  );
  res.status(201).json(rows[0]);
}));

router.patch('/tasks/:id', asyncHandler(async (req, res) => {
  const allowed = [
    'task_name', 'description', 'dependency_text', 'due_date',
    'booking_responsible_id', 'quality_check_id', 'url', 'powerbi_url',
    'booking_status', 'check_status', 'date_finished', 'comment', 'mg_comment',
    'sort_order',
  ];

  if (req.body.booking_status && !STATUS_VALUES.includes(req.body.booking_status)) {
    return res.status(400).json({ error: 'invalid booking_status' });
  }
  if (req.body.check_status && !STATUS_VALUES.includes(req.body.check_status)) {
    return res.status(400).json({ error: 'invalid check_status' });
  }

  const fields = Object.keys(req.body).filter((k) => allowed.includes(k));
  if (!fields.length) return res.status(400).json({ error: 'no valid fields to update' });

  const setClauses = fields.map((f, i) => `${f} = $${i + 1}`);
  const values = fields.map((f) => req.body[f]);

  const { rows } = await pool.query(
    `UPDATE tasks SET ${setClauses.join(', ')}, updated_at = now()
     WHERE id = $${fields.length + 1} RETURNING *`,
    [...values, req.params.id],
  );
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  res.json(rows[0]);
}));

router.delete('/tasks/:id', asyncHandler(async (req, res) => {
  await pool.query('DELETE FROM tasks WHERE id = $1', [req.params.id]);
  res.status(204).end();
}));

// Bulk reorder: body = { order: [taskId, taskId, ...] } in desired order
router.post('/cycles/:id/tasks/reorder', asyncHandler(async (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order) || !order.length) {
    return res.status(400).json({ error: 'order array is required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < order.length; i += 1) {
      await client.query(
        'UPDATE tasks SET sort_order = $1 WHERE id = $2 AND cycle_id = $3',
        [(i + 1) * 10, order[i], req.params.id],
      );
    }
    await client.query('COMMIT');
    res.status(204).end();
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// ---------------------------------------------------------------------------
// Overview report: tasks x last N months, booking status per cell
// ---------------------------------------------------------------------------

router.get('/report/pivot', asyncHandler(async (req, res) => {
  const months = parseInt(req.query.months, 10) || 6;

  const { rows: recentCycles } = await pool.query(
    'SELECT * FROM cycles ORDER BY year DESC, month DESC LIMIT $1',
    [months],
  );
  const cycles = recentCycles.reverse(); // oldest -> newest, left to right

  if (!cycles.length) return res.json({ cycles: [], rows: [] });

  const cycleIds = cycles.map((c) => c.id);

  // Walk cloned_from_task_id back to each task's original root, so the same
  // task is grouped together across months even if it's been cloned several
  // times over.
  const { rows: flat } = await pool.query(
    `WITH RECURSIVE lineage AS (
       SELECT id, id AS root_id FROM tasks WHERE cloned_from_task_id IS NULL
       UNION ALL
       SELECT t.id, l.root_id FROM tasks t JOIN lineage l ON t.cloned_from_task_id = l.id
     )
     SELECT t.id AS task_id, t.cycle_id, t.task_name, t.sort_order, t.dependency_text,
            t.booking_status, t.date_finished,
            t.booking_responsible_id, t.quality_check_id, l.root_id
     FROM tasks t
     JOIN lineage l ON l.id = t.id
     WHERE t.cycle_id = ANY($1)`,
    [cycleIds],
  );

  const byRoot = {};
  // Process newest -> oldest so task_name/sort_order/dependency_text reflect the most recent occurrence.
  for (const cycle of [...cycles].reverse()) {
    for (const r of flat.filter((x) => x.cycle_id === cycle.id)) {
      if (!byRoot[r.root_id]) {
        byRoot[r.root_id] = {
          root_id: r.root_id, task_name: r.task_name, sort_order: r.sort_order,
          dependency_text: r.dependency_text, cells: {},
        };
      }
      byRoot[r.root_id].cells[cycle.id] = {
        task_id: r.task_id,
        booking_status: r.booking_status,
        date_finished: r.date_finished,
        booking_responsible_id: r.booking_responsible_id,
        quality_check_id: r.quality_check_id,
      };
    }
  }

  const rows = Object.values(byRoot).sort((a, b) => a.sort_order - b.sort_order);

  res.json({ cycles, rows });
}));

module.exports = router;
