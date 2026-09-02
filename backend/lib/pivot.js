// Shared by the REST endpoint and the MCP tool. Builds the tasks x months
// pivot: each task grouped across cycles by lineage (cloned_from_task_id),
// not by name, so it survives renames and clone chains of any length.
async function getPivot(pool, months) {
  const { rows: recentCycles } = await pool.query(
    'SELECT * FROM cycles ORDER BY year DESC, month DESC LIMIT $1',
    [months],
  );
  const cycles = recentCycles.reverse(); // oldest -> newest, left to right

  if (!cycles.length) return { cycles: [], rows: [] };

  const cycleIds = cycles.map((c) => c.id);

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

  return { cycles, rows };
}

module.exports = { getPivot };
