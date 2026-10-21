const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { requireBearerAuth } = require('@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js');
const { InvalidTokenError } = require('@modelcontextprotocol/sdk/server/auth/errors.js');
const { getOAuthProtectedResourceMetadataUrl } = require('@modelcontextprotocol/sdk/server/auth/router.js');
const z = require('zod');
const { findUserByToken } = require('../lib/apiTokens');
const { cloneCycleForward } = require('../lib/cycles');
const { getPivot } = require('../lib/pivot');
const todos = require('../lib/todos');

const STATUS_VALUES = ['not_started', 'in_progress', 'waiting', 'ready_to_be_booked', 'done', 'n_a'];
const STATUS_ENUM = z.enum(STATUS_VALUES);

// description and comment are easy to conflate — both are free text on the
// same task — but they persist differently across a clone-forward, so
// every tool that reads or writes either one repeats this distinction
// rather than relying on the field name alone.
const FIELD_NOTE = "Note the difference between two similarly-named fields: 'description' is the "
  + "task's standing instructions (what to do and how) and is carried forward unchanged whenever "
  + "the cycle is cloned into next month; 'comment' is this month's log only (progress notes, "
  + "blockers, open questions) and is cleared blank on clone. Don't put this month's status update "
  + "in description, and don't put standing instructions in comment.";

const DESCRIPTION_FIELD = z.string().optional().describe(
  "The task's standing instructions — what should be done and how. Persists across months: "
  + 'carried forward unchanged when the cycle is cloned. Not for logging this month\'s progress — use comment for that.'
);
const COMMENT_FIELD = z.string().optional().describe(
  "This month's log only — progress notes, blockers, open questions. Cleared to blank on clone, "
  + "so nothing here carries forward. Not for standing instructions — use description for that."
);

// The task-definition fields below are, like description, carried forward
// unchanged on clone.
const DUE_DATE_FIELD = z.string().optional().describe(
  'Free text, same as the Due column — usually a working day of the month ("15"), sometimes a '
  + 'day.month ("15.3") or a phrase ("25th Prev Month", "N/A"). Stored as given, not parsed.'
);
const DEPENDENCY_FIELD = z.string().optional().describe(
  'Free text naming what this task waits on — normally the exact task_name of another task in the '
  + 'cycle (e.g. "Update FX Rates"). Informational only: it is shown in the checklist, not enforced.'
);
const personField = (role) => z.string().optional().describe(
  `${role}, by name as listed by list_people — a full name or an unambiguous first name (e.g. "Niklas"). `
  + 'Resolved to a user; an unknown or ambiguous name is rejected with the list of valid names.'
);

// Personal to-dos are visible only to their owner in the app, so the tools
// ask the model to respect that when it repeats them anywhere — e.g. a
// morning agenda posted to a team channel should carry mep_tasks only.
const PRIVATE_NOTE = 'Personal to-dos are private to this user: show them to the user directly, but never '
  + 'include them in anything shared with others (team channels, emails, shared docs) unless the user '
  + 'explicitly asks for a specific item to be shared.';

const TODO_FIELDS = {
  notes: z.string().optional().describe('Standing context for the to-do — links, who to ask, how to do it'),
  priority: z.enum(['high', 'normal', 'low']).optional(),
  due_date: z.string().optional().describe('YYYY-MM-DD'),
  follow_up_date: z.string().optional().describe('YYYY-MM-DD — for waiting items: when to chase'),
  linked_task_id: z.number().int().nullable().optional()
    .describe('Optional id of a related month-end task (from get_my_tasks / list_tasks)'),
};

// Accepts either a short-lived OAuth access token (Claude web/Desktop/
// Cowork, issued via lib/oauth.js) or a long-lived static personal API
// token (Claude Code, see lib/apiTokens.js) — both end up identifying the
// same kind of principal (a user id + name), so every MCP tool below only
// ever has to deal with one shape (extra.userId / extra.name).
function makeVerifier(pool, oauthProvider) {
  return {
    async verifyAccessToken(token) {
      try {
        return await oauthProvider.verifyAccessToken(token);
      } catch {
        // Not a valid OAuth token — fall back to the static token table.
      }
      const user = await findUserByToken(pool, token);
      if (!user) throw new InvalidTokenError('Invalid or revoked token');
      return {
        token,
        clientId: String(user.id),
        scopes: [],
        // These are personal tokens revoked manually (Users modal), not
        // short-lived OAuth grants — but the SDK's bearer-auth middleware
        // requires a numeric expiresAt regardless, so this is nominal.
        expiresAt: Math.floor(Date.now() / 1000) + 10 * 365 * 24 * 60 * 60,
        extra: { userId: user.id, name: user.name },
      };
    },
  };
}

async function resolveCycle(pool, label) {
  if (label) {
    const { rows } = await pool.query('SELECT * FROM cycles WHERE label = $1', [label]);
    return rows[0] || null;
  }
  const { rows } = await pool.query('SELECT * FROM cycles ORDER BY year DESC, month DESC LIMIT 1');
  return rows[0] || null;
}

// Where create_task puts a new task when no cycle is named: the most recent
// cycle that's still open, not just the most recent one — a freshly locked
// month shouldn't swallow tasks meant for the month still in progress.
async function resolveOpenCycle(pool, label) {
  if (label) return resolveCycle(pool, label);
  const { rows } = await pool.query(
    "SELECT * FROM cycles WHERE status = 'open' ORDER BY year DESC, month DESC LIMIT 1",
  );
  return rows[0] || null;
}

// Only active users can be newly assigned — a deactivated person keeps any
// task they're already on, but isn't offered (or accepted) for new ones.
async function listPeople(pool) {
  const { rows } = await pool.query('SELECT name FROM users WHERE active ORDER BY name');
  return rows.map((r) => r.name);
}

// Turns a person given by name into a user id, so Claude can say "Niklas"
// rather than having to know ids. A case-insensitive exact match on the full
// name wins; otherwise a unique first-name match ("Niklas" → "Niklas
// Hedborg"). Empty string means "unassign" (null). Anything unknown or
// ambiguous is an error that lists the valid names, so the model can retry.
async function resolvePerson(pool, name, field) {
  if (name === '') return { ok: true, id: null };
  const wanted = name.trim().toLowerCase();
  const { rows } = await pool.query('SELECT id, name FROM users WHERE active ORDER BY name');
  const valid = `Valid names: ${rows.map((u) => u.name).join(', ')}.`;

  const exact = rows.filter((u) => u.name.toLowerCase() === wanted);
  if (exact.length === 1) return { ok: true, id: exact[0].id };
  const byFirstName = rows.filter((u) => u.name.toLowerCase().startsWith(`${wanted} `));
  if (byFirstName.length === 1) return { ok: true, id: byFirstName[0].id };
  if (byFirstName.length > 1) {
    return {
      ok: false,
      error: `Ambiguous ${field} "${name}" — matches ${byFirstName.map((u) => u.name).join(', ')}. Use the full name. ${valid}`,
    };
  }
  return { ok: false, error: `Unknown ${field} "${name}". ${valid}` };
}

const TASK_SELECT = `
  SELECT t.id, t.task_name, t.description, t.dependency_text, t.due_date,
         t.booking_status, t.check_status, t.date_finished, t.comment,
         t.url, t.powerbi_url,
         ur.name AS booking_responsible_name, uq.name AS quality_check_name
  FROM tasks t
  LEFT JOIN users ur ON ur.id = t.booking_responsible_id
  LEFT JOIN users uq ON uq.id = t.quality_check_id
`;

function getServer(pool) {
  const server = new McpServer({ name: 'month-end-process', version: '1.0.0' });
  const asText = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
  const asError = (message) => ({ content: [{ type: 'text', text: message }], isError: true });

  server.registerTool('list_cycles', {
    description: 'List every month-end cycle (id, label like "2026-07", status).',
    inputSchema: {},
  }, async () => {
    const { rows } = await pool.query('SELECT id, label, year, month, status FROM cycles ORDER BY year DESC, month DESC');
    return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
  });

  server.registerTool('get_overview', {
    description: 'Pivot of every task against recent month-end cycles, with booking status per cell. Mirrors the Overview page.',
    inputSchema: { months: z.number().int().min(1).max(24).optional().describe('How many recent cycles to include, default 6') },
  }, async ({ months }) => {
    const pivot = await getPivot(pool, months || 6);
    return { content: [{ type: 'text', text: JSON.stringify(pivot, null, 2) }] };
  });

  server.registerTool('get_my_tasks', {
    description: "List tasks in a cycle where the calling user (the token's owner) is Booking Responsible or Quality Check. Defaults to the most recent cycle. " + FIELD_NOTE,
    inputSchema: { cycle_label: z.string().optional().describe('e.g. "2026-07" — defaults to the most recent cycle') },
  }, async ({ cycle_label: cycleLabel }, extra) => {
    const cycle = await resolveCycle(pool, cycleLabel);
    if (!cycle) return { content: [{ type: 'text', text: 'No matching cycle found.' }], isError: true };

    const userId = extra.authInfo.extra.userId;
    const { rows } = await pool.query(
      `${TASK_SELECT} WHERE t.cycle_id = $1 AND (t.booking_responsible_id = $2 OR t.quality_check_id = $2)
       ORDER BY t.sort_order`,
      [cycle.id, userId],
    );
    return { content: [{ type: 'text', text: JSON.stringify({ cycle: cycle.label, tasks: rows }, null, 2) }] };
  });

  server.registerTool('list_tasks', {
    description: 'List all tasks in a cycle, optionally filtered by booking status. Defaults to the most recent cycle. ' + FIELD_NOTE,
    inputSchema: {
      cycle_label: z.string().optional().describe('e.g. "2026-07" — defaults to the most recent cycle'),
      booking_status: STATUS_ENUM.optional(),
    },
  }, async ({ cycle_label: cycleLabel, booking_status: bookingStatus }) => {
    const cycle = await resolveCycle(pool, cycleLabel);
    if (!cycle) return { content: [{ type: 'text', text: 'No matching cycle found.' }], isError: true };

    const params = [cycle.id];
    let where = 'WHERE t.cycle_id = $1';
    if (bookingStatus) { params.push(bookingStatus); where += ` AND t.booking_status = $${params.length}`; }

    const { rows } = await pool.query(`${TASK_SELECT} ${where} ORDER BY t.sort_order`, params);
    return { content: [{ type: 'text', text: JSON.stringify({ cycle: cycle.label, tasks: rows }, null, 2) }] };
  });

  server.registerTool('list_people', {
    description: 'List the names that can be assigned as Booking Responsible or Quality Check on a task '
      + '(active users). Pass one of these to create_task / update_task.',
    inputSchema: {},
  }, async () => asText(await listPeople(pool)));

  server.registerTool('create_task', {
    description: 'Add a new task to a month-end cycle — the same as "Add task" in the checklist. Defaults to '
      + 'the most recent open cycle; refuses a locked cycle, and refuses a task_name that already exists in '
      + 'that cycle. The new task is a permanent part of the checklist: like every other task, it is '
      + 'carried forward into next month when the cycle is cloned (description, due date, dependency, '
      + 'people and links copied; statuses reset; comment cleared). People are given by name — call '
      + 'list_people for the valid names. Returns the created task in the same shape as list_tasks. '
      + FIELD_NOTE,
    inputSchema: {
      cycle_label: z.string().optional().describe('e.g. "2026-07" — defaults to the most recent open cycle'),
      task_name: z.string().describe('Short name as shown in the checklist, e.g. "AI Spend Overview Refresh"'),
      description: DESCRIPTION_FIELD,
      due_date: DUE_DATE_FIELD,
      dependency_text: DEPENDENCY_FIELD,
      booking_responsible: personField('Booking Responsible (does the work)'),
      quality_check: personField('Quality Check (reviews it)'),
      url: z.string().optional().describe('The task\'s reference URL (🔗 in the Links column)'),
      powerbi_url: z.string().optional().describe('The task\'s Power BI URL (📊 in the Links column)'),
      booking_status: STATUS_ENUM.optional().describe('Defaults to not_started'),
      check_status: STATUS_ENUM.optional().describe('Defaults to not_started'),
    },
  }, async (args) => {
    const taskName = args.task_name.trim();
    if (!taskName) return asError('task_name is required.');

    const cycle = await resolveOpenCycle(pool, args.cycle_label);
    if (!cycle) return asError(args.cycle_label ? 'No matching cycle found.' : 'No open cycle found.');
    if (cycle.status === 'locked') {
      return asError(`Cycle ${cycle.label} is locked — unlock it in the app before adding tasks to it.`);
    }

    // Guards against a retried call creating the same task twice; duplicate
    // names in one cycle would also muddle the overview, which follows a task
    // across months by name/lineage.
    const { rows: dupes } = await pool.query(
      'SELECT id FROM tasks WHERE cycle_id = $1 AND lower(task_name) = lower($2)',
      [cycle.id, taskName],
    );
    if (dupes.length) return asError(`Cycle ${cycle.label} already has a task named "${taskName}" (id ${dupes[0].id}).`);

    const people = {};
    for (const field of ['booking_responsible', 'quality_check']) {
      if (args[field] === undefined) continue;
      const person = await resolvePerson(pool, args[field], field);
      if (!person.ok) return asError(person.error);
      people[field] = person.id;
    }

    // Appended at the bottom, same as the UI's Add task (routes/api.js).
    const { rows } = await pool.query(
      `INSERT INTO tasks (
         cycle_id, sort_order, task_name, description, dependency_text, due_date,
         booking_responsible_id, quality_check_id, url, powerbi_url, booking_status, check_status
       ) VALUES (
         $1, (SELECT COALESCE(MAX(sort_order), 0) + 10 FROM tasks WHERE cycle_id = $1),
         $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
       ) RETURNING id`,
      [
        cycle.id, taskName, args.description || null, args.dependency_text || null, args.due_date || null,
        people.booking_responsible ?? null, people.quality_check ?? null, args.url || null,
        args.powerbi_url || null, args.booking_status || 'not_started', args.check_status || 'not_started',
      ],
    );
    const { rows: created } = await pool.query(`${TASK_SELECT} WHERE t.id = $1`, [rows[0].id]);
    return asText({ cycle: cycle.label, task: created[0] });
  });

  server.registerTool('update_task', {
    description: 'Update a task\'s name, description, due date, dependency, Booking Responsible, Quality Check, '
      + 'booking status, check status, comment, finished date, task URL, or Power BI URL. Only the fields you '
      + 'pass change. Get the task_id from list_tasks or get_my_tasks first. People are given by name (see '
      + 'list_people); pass an empty string to unassign. ' + FIELD_NOTE,
    inputSchema: {
      task_id: z.number().int().describe('Task id, from list_tasks or get_my_tasks'),
      task_name: z.string().optional().describe('Rename the task'),
      description: DESCRIPTION_FIELD,
      due_date: DUE_DATE_FIELD,
      dependency_text: DEPENDENCY_FIELD,
      booking_responsible: personField('Booking Responsible (does the work)'),
      quality_check: personField('Quality Check (reviews it)'),
      booking_status: STATUS_ENUM.optional(),
      check_status: STATUS_ENUM.optional(),
      comment: COMMENT_FIELD,
      date_finished: z.string().optional().describe('ISO date, e.g. "2026-07-31"'),
      url: z.string().optional().describe('The task\'s reference URL (🔗 in the Links column)'),
      powerbi_url: z.string().optional().describe('The task\'s Power BI URL (📊 in the Links column)'),
    },
  }, async ({
    task_id: taskId, task_name: taskName, description, due_date: dueDate, dependency_text: dependencyText,
    booking_responsible: bookingResponsible, quality_check: qualityCheck,
    booking_status: bookingStatus, check_status: checkStatus, comment, date_finished: dateFinished, url, powerbi_url: powerbiUrl,
  }) => {
    const fields = [];
    const values = [];
    const set = (column, value) => { values.push(value); fields.push(`${column} = $${values.length}`); };

    if (taskName !== undefined) {
      if (!taskName.trim()) return asError('task_name cannot be empty.');
      set('task_name', taskName.trim());
    }
    if (description !== undefined) set('description', description);
    if (dueDate !== undefined) set('due_date', dueDate || null);
    if (dependencyText !== undefined) set('dependency_text', dependencyText || null);
    for (const [field, column, name] of [
      ['booking_responsible', 'booking_responsible_id', bookingResponsible],
      ['quality_check', 'quality_check_id', qualityCheck],
    ]) {
      if (name === undefined) continue;
      const person = await resolvePerson(pool, name, field);
      if (!person.ok) return asError(person.error);
      set(column, person.id);
    }
    if (bookingStatus) set('booking_status', bookingStatus);
    if (checkStatus) set('check_status', checkStatus);
    if (comment !== undefined) set('comment', comment);
    if (dateFinished) set('date_finished', dateFinished);
    if (url !== undefined) set('url', url);
    if (powerbiUrl !== undefined) set('powerbi_url', powerbiUrl);

    if (!fields.length) return asError('No fields to update.');

    values.push(taskId);
    const { rows } = await pool.query(
      `UPDATE tasks SET ${fields.join(', ')}, updated_at = now() WHERE id = $${values.length} RETURNING id`,
      values,
    );
    if (!rows.length) return asError(`No task with id ${taskId}.`);
    const { rows: updated } = await pool.query(`${TASK_SELECT} WHERE t.id = $1`, [taskId]);
    return asText(updated[0]);
  });

  server.registerTool('clone_cycle', {
    description: 'Clone a cycle forward into the next calendar month, copying every task with progress reset to not_started (N/A tasks stay N/A). Defaults to cloning the most recent cycle.',
    inputSchema: { source_cycle_label: z.string().optional().describe('e.g. "2026-07" — defaults to the most recent cycle') },
  }, async ({ source_cycle_label: sourceCycleLabel }) => {
    const source = await resolveCycle(pool, sourceCycleLabel);
    if (!source) return { content: [{ type: 'text', text: 'No matching source cycle found.' }], isError: true };

    const result = await cloneCycleForward(pool, source.id);
    if (!result.ok) return { content: [{ type: 'text', text: result.error }], isError: true };
    return { content: [{ type: 'text', text: JSON.stringify(result.cycle, null, 2) }] };
  });

  // ---- Personal to-dos (see lib/todos.js) ----
  // Every tool below acts only on the calling user's own list; the owner is
  // always the token's user, never an input.

  const ownerOf = (extra) => extra.authInfo.extra.userId;

  server.registerTool('get_my_day', {
    description: "The calling user's day at a glance — the tool to use for \"what's in MEP today?\". Returns "
      + "(1) mep_tasks: their outstanding month-end tasks across every open cycle, with booking_outstanding / "
      + 'check_outstanding saying which of their roles on each task is still open; and (2) private_todos: their '
      + 'personal to-dos that are due, overdue or due for follow-up today, plus waiting items not yet due. '
      + PRIVATE_NOTE,
    inputSchema: {},
  }, async (_args, extra) => asText(await todos.getMyDay(pool, ownerOf(extra))));

  server.registerTool('list_my_todos', {
    description: "List the calling user's personal to-dos. view: 'all' (default — open, waiting, and done in the "
      + "last 14 days), 'active' (open + waiting), 'today' (due, overdue or follow-up due), 'overdue', "
      + "'upcoming' (due in the next 7 days), 'waiting', 'done' (last 14 days). " + PRIVATE_NOTE,
    inputSchema: { view: z.enum(['all', 'active', 'today', 'overdue', 'upcoming', 'waiting', 'done']).optional() },
  }, async ({ view }, extra) => asText(await todos.listTodos(pool, ownerOf(extra), view || 'all')));

  server.registerTool('add_todo', {
    description: "Add a to-do to the calling user's personal list. Resolve relative dates (\"Friday\", "
      + '"next week") to absolute YYYY-MM-DD before calling. ' + PRIVATE_NOTE,
    inputSchema: {
      title: z.string().describe('Short, actionable — e.g. "Chase Ops for the Striga PDF"'),
      ...TODO_FIELDS,
    },
  }, async (fields, extra) => {
    const result = await todos.createTodo(pool, ownerOf(extra), fields, 'mcp');
    return result.ok ? asText(result.todo) : asError(result.error);
  });

  server.registerTool('update_todo', {
    description: "Update one of the calling user's to-dos. Only the fields you pass change; pass an empty "
      + 'string to clear notes or a date, or null to unlink the task. To mark something done use complete_todo. ' + PRIVATE_NOTE,
    inputSchema: {
      todo_id: z.number().int().describe('From list_my_todos or get_my_day'),
      title: z.string().optional(),
      status: z.enum(['open', 'waiting', 'done']).optional()
        .describe("'waiting' = blocked on someone else; set follow_up_date for when to chase"),
      ...TODO_FIELDS,
    },
  }, async ({ todo_id: todoId, ...fields }, extra) => {
    const result = await todos.updateTodo(pool, ownerOf(extra), todoId, fields);
    return result.ok ? asText(result.todo) : asError(result.status === 404 ? `No to-do with id ${todoId}.` : result.error);
  });

  server.registerTool('complete_todo', {
    description: "Mark one of the calling user's to-dos as done.",
    inputSchema: { todo_id: z.number().int().describe('From list_my_todos or get_my_day') },
  }, async ({ todo_id: todoId }, extra) => {
    const result = await todos.updateTodo(pool, ownerOf(extra), todoId, { status: 'done' });
    return result.ok ? asText(result.todo) : asError(`No to-do with id ${todoId}.`);
  });

  server.registerTool('archive_todo', {
    description: "Remove one of the calling user's to-dos from their list (soft delete — recoverable in the "
      + 'database, but gone from every view). Confirm with the user before archiving anything they did not '
      + 'explicitly ask to remove.',
    inputSchema: { todo_id: z.number().int().describe('From list_my_todos or get_my_day') },
  }, async ({ todo_id: todoId }, extra) => {
    const result = await todos.updateTodo(pool, ownerOf(extra), todoId, { status: 'archived' });
    return result.ok ? asText({ archived: todoId }) : asError(`No to-do with id ${todoId}.`);
  });

  return server;
}

// Mounts the MCP endpoint on an existing Express app. Stateless mode: a
// fresh McpServer + transport per request, matching the SDK's own
// recommended pattern for simple API-style servers (no session tracking).
function mountMcp(app, pool, { oauthProvider, mcpResourceUrl }) {
  app.use('/mcp', requireBearerAuth({
    verifier: makeVerifier(pool, oauthProvider),
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpResourceUrl),
  }));

  app.post('/mcp', async (req, res) => {
    try {
      const server = getServer(pool);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => { transport.close(); server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('MCP request error', err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  });

  const methodNotAllowed = (_req, res) => {
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
  };
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);
}

module.exports = { mountMcp, getServer };
