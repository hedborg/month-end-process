// Shared by the REST endpoint and the MCP tool so clone-forward logic
// only ever lives in one place.
async function cloneCycleForward(pool, sourceCycleId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: sourceRows } = await client.query(
      'SELECT year, month FROM cycles WHERE id = $1',
      [sourceCycleId],
    );
    if (!sourceRows.length) {
      await client.query('ROLLBACK');
      return { ok: false, status: 404, error: 'source cycle not found' };
    }

    let { year, month } = sourceRows[0];
    month += 1;
    if (month > 12) { month = 1; year += 1; }
    const label = `${year}-${String(month).padStart(2, '0')}`;

    const { rows: existing } = await client.query('SELECT id FROM cycles WHERE label = $1', [label]);
    if (existing.length) {
      await client.query('ROLLBACK');
      return { ok: false, status: 409, error: `Cycle ${label} already exists` };
    }

    const { rows: cycleRows } = await client.query(
      `INSERT INTO cycles (label, year, month, created_from_cycle_id)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [label, year, month, sourceCycleId],
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
      [newCycle.id, sourceCycleId],
    );

    await client.query('COMMIT');
    return { ok: true, cycle: newCycle };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { cloneCycleForward };
