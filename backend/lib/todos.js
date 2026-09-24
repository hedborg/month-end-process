// Personal to-dos — private to one user, not tied to any cycle.
//
// Every query in this file is scoped by owner_id, and owner_id always comes
// from the authenticated caller (session or MCP token), never from request
// input. That's the whole privacy model: there is no code path that reads
// or writes another user's to-dos, admins included. Someone else's to-do id
// behaves exactly like a nonexistent one (null / 404), so ids leak nothing.
//
// Both routes/api.js (web UI) and routes/mcp.js (Claude) go through here so
// the rule lives in one place.

const TODO_STATUSES = ['open', 'waiting', 'done', 'archived'];
const TODO_PRIORITIES = ['high', 'normal', 'low'];

// "Today" is the team's local date, not the server's (the container runs in
// UTC, which would still be yesterday for the first hour or two of a
// Stockholm morning).
const APP_TZ = process.env.APP_TZ || 'Europe/Stockholm';
const TODAY = `(now() AT TIME ZONE '${APP_TZ.replace(/'/g, '')}')::date`;

const TODO_SELECT = `
  SELECT td.id, td.title, td.notes, td.status, td.priority,
         to_char(td.due_date, 'YYYY-MM-DD') AS due_date,
         to_char(td.follow_up_date, 'YYYY-MM-DD') AS follow_up_date,
         td.linked_task_id, t.task_name AS linked_task_name, c.label AS linked_cycle_label,
         td.created_via, td.completed_at, td.created_at, td.updated_at
  FROM personal_todos td
  LEFT JOIN tasks t ON t.id = td.linked_task_id
  LEFT JOIN cycles c ON c.id = t.cycle_id
`;

const ORDER = `
  ORDER BY (td.status = 'done'), td.completed_at DESC NULLS LAST,
           COALESCE(td.due_date, td.follow_up_date) NULLS LAST,
           CASE td.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
           td.created_at
`;

// Named filters shared by the API and the MCP list tool. "Active" means
// open or waiting; done items are only returned by 'done' (last 14 days) or
// 'all', and archived ones never are.
const VIEWS = {
  active:   `td.status IN ('open', 'waiting')`,
  today:    `td.status IN ('open', 'waiting') AND (td.due_date <= ${TODAY} OR td.follow_up_date <= ${TODAY})`,
  overdue:  `td.status IN ('open', 'waiting') AND td.due_date < ${TODAY}`,
  upcoming: `td.status IN ('open', 'waiting') AND td.due_date > ${TODAY} AND td.due_date <= ${TODAY} + 7`,
  waiting:  `td.status = 'waiting'`,
  done:     `td.status = 'done' AND td.completed_at >= now() - interval '14 days'`,
  all:      `(td.status IN ('open', 'waiting') OR (td.status = 'done' AND td.completed_at >= now() - interval '14 days'))`,
};

async function listTodos(pool, ownerId, view = 'all') {
  const where = VIEWS[view];
  if (!where) throw new Error(`unknown view: ${view}`);
  const { rows } = await pool.query(
    `${TODO_SELECT} WHERE td.owner_id = $1 AND ${where} ${ORDER}`,
    [ownerId],
  );
  return rows;
}

async function getTodo(pool, ownerId, id) {
  const { rows } = await pool.query(`${TODO_SELECT} WHERE td.owner_id = $1 AND td.id = $2`, [ownerId, id]);
  return rows[0] || null;
}

// Returns an error string for bad input, or null. Shared by create/update.
function validate(fields) {
  if (fields.title !== undefined && !String(fields.title || '').trim()) return 'title is required';
  if (fields.status !== undefined && !TODO_STATUSES.includes(fields.status)) return `status must be one of ${TODO_STATUSES.join(', ')}`;
  if (fields.priority !== undefined && !TODO_PRIORITIES.includes(fields.priority)) return `priority must be one of ${TODO_PRIORITIES.join(', ')}`;
  for (const key of ['due_date', 'follow_up_date']) {
    const v = fields[key];
    if (v !== undefined && v !== null && v !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${key} must be YYYY-MM-DD`;
  }
  return null;
}

async function linkedTaskExists(pool, taskId) {
  if (taskId === undefined || taskId === null || taskId === '') return true;
  if (!Number.isInteger(taskId)) return false;
  const { rows } = await pool.query('SELECT 1 FROM tasks WHERE id = $1', [taskId]);
  return rows.length > 0;
}

// { ok: true, todo } | { ok: false, status, error }
async function createTodo(pool, ownerId, fields, createdVia) {
  const error = validate({ ...fields, title: fields.title ?? '' });
  if (error) return { ok: false, status: 400, error };
  if (!(await linkedTaskExists(pool, fields.linked_task_id))) return { ok: false, status: 400, error: 'linked_task_id not found' };

  const status = fields.status || 'open';
  const { rows } = await pool.query(
    `INSERT INTO personal_todos
       (owner_id, title, notes, status, priority, due_date, follow_up_date, linked_task_id, created_via, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $4 = 'done' THEN now() END)
     RETURNING id`,
    [ownerId, fields.title.trim(), fields.notes || null, status, fields.priority || 'normal',
      fields.due_date || null, fields.follow_up_date || null, fields.linked_task_id ?? null, createdVia],
  );
  return { ok: true, todo: await getTodo(pool, ownerId, rows[0].id) };
}

const UPDATABLE = ['title', 'notes', 'status', 'priority', 'due_date', 'follow_up_date', 'linked_task_id'];

// Only the fields present in `fields` are changed; '' or null clears a
// nullable field. completed_at follows status: set when it becomes done,
// cleared if it's reopened.
async function updateTodo(pool, ownerId, id, fields) {
  if (!Number.isInteger(id)) return { ok: false, status: 404, error: 'not found' };
  const error = validate(fields);
  if (error) return { ok: false, status: 400, error };
  if (!(await linkedTaskExists(pool, fields.linked_task_id))) return { ok: false, status: 400, error: 'linked_task_id not found' };

  const sets = [];
  const values = [];
  for (const key of UPDATABLE) {
    if (fields[key] === undefined) continue;
    let v = fields[key] === '' ? null : fields[key];
    if (key === 'title') v = String(v).trim();
    values.push(v);
    sets.push(`${key} = $${values.length}`);
  }
  if (fields.status !== undefined) {
    values.push(fields.status);
    sets.push(`completed_at = CASE WHEN $${values.length} = 'done' THEN COALESCE(completed_at, now()) END`);
  }
  if (!sets.length) return { ok: false, status: 400, error: 'No fields to update' };

  values.push(ownerId, id);
  const { rowCount } = await pool.query(
    `UPDATE personal_todos SET ${sets.join(', ')}, updated_at = now()
     WHERE owner_id = $${values.length - 1} AND id = $${values.length}`,
    values,
  );
  if (!rowCount) return { ok: false, status: 404, error: 'not found' };
  return { ok: true, todo: await getTodo(pool, ownerId, id) };
}

// The caller's open month-end work across every *open* cycle (month-ends
// overlap, so not just the latest one) — each row says which of their two
// possible roles on the task is still outstanding.
async function getMyOpenMepTasks(pool, userId) {
  const { rows } = await pool.query(
    `SELECT t.id, c.label AS cycle, t.task_name, t.due_date, t.dependency_text,
            t.booking_status, t.check_status, t.comment, t.url, t.powerbi_url,
            ur.name AS booking_responsible_name, uq.name AS quality_check_name,
            (t.booking_responsible_id = $1 AND t.booking_status NOT IN ('done', 'n_a')) AS booking_outstanding,
            (t.quality_check_id = $1 AND t.check_status NOT IN ('done', 'n_a')) AS check_outstanding
     FROM tasks t
     JOIN cycles c ON c.id = t.cycle_id
     LEFT JOIN users ur ON ur.id = t.booking_responsible_id
     LEFT JOIN users uq ON uq.id = t.quality_check_id
     WHERE c.status = 'open'
       AND ((t.booking_responsible_id = $1 AND t.booking_status NOT IN ('done', 'n_a'))
         OR (t.quality_check_id = $1 AND t.check_status NOT IN ('done', 'n_a')))
     ORDER BY c.year, c.month, t.sort_order`,
    [userId],
  );
  return rows;
}

async function getMyDay(pool, userId) {
  const [{ rows: [{ today }] }, mepTasks, dueTodos, waiting] = await Promise.all([
    pool.query(`SELECT to_char(${TODAY}, 'YYYY-MM-DD') AS today`),
    getMyOpenMepTasks(pool, userId),
    listTodos(pool, userId, 'today'),
    listTodos(pool, userId, 'waiting'),
  ]);
  return {
    today,
    mep_tasks: mepTasks,
    private_todos: {
      due_or_overdue: dueTodos,
      waiting_not_yet_due: waiting.filter((w) => !dueTodos.some((d) => d.id === w.id)),
    },
  };
}

module.exports = {
  TODO_STATUSES, TODO_PRIORITIES, listTodos, getTodo, createTodo, updateTodo, getMyDay,
};
