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

  server.registerTool('update_task', {
    description: 'Update a task\'s description, booking status, check status, comment, finished date, task URL, or Power BI URL. Get the task_id from list_tasks or get_my_tasks first. ' + FIELD_NOTE,
    inputSchema: {
      task_id: z.number().int().describe('Task id, from list_tasks or get_my_tasks'),
      description: DESCRIPTION_FIELD,
      booking_status: STATUS_ENUM.optional(),
      check_status: STATUS_ENUM.optional(),
      comment: COMMENT_FIELD,
      date_finished: z.string().optional().describe('ISO date, e.g. "2026-07-31"'),
      url: z.string().optional().describe('The task\'s reference URL (🔗 in the Links column)'),
      powerbi_url: z.string().optional().describe('The task\'s Power BI URL (📊 in the Links column)'),
    },
  }, async ({ task_id: taskId, description, booking_status: bookingStatus, check_status: checkStatus, comment, date_finished: dateFinished, url, powerbi_url: powerbiUrl }) => {
    const fields = [];
    const values = [];
    if (description !== undefined) { values.push(description); fields.push(`description = $${values.length}`); }
    if (bookingStatus) { values.push(bookingStatus); fields.push(`booking_status = $${values.length}`); }
    if (checkStatus) { values.push(checkStatus); fields.push(`check_status = $${values.length}`); }
    if (comment !== undefined) { values.push(comment); fields.push(`comment = $${values.length}`); }
    if (dateFinished) { values.push(dateFinished); fields.push(`date_finished = $${values.length}`); }
    if (url !== undefined) { values.push(url); fields.push(`url = $${values.length}`); }
    if (powerbiUrl !== undefined) { values.push(powerbiUrl); fields.push(`powerbi_url = $${values.length}`); }

    if (!fields.length) return { content: [{ type: 'text', text: 'No fields to update.' }], isError: true };

    values.push(taskId);
    const { rows } = await pool.query(
      `UPDATE tasks SET ${fields.join(', ')}, updated_at = now() WHERE id = $${values.length}
       RETURNING id, task_name, description, booking_status, check_status, comment, date_finished, url, powerbi_url`,
      values,
    );
    if (!rows.length) return { content: [{ type: 'text', text: `No task with id ${taskId}.` }], isError: true };
    return { content: [{ type: 'text', text: JSON.stringify(rows[0], null, 2) }] };
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

  const asText = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
  const asError = (message) => ({ content: [{ type: 'text', text: message }], isError: true });
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

module.exports = { mountMcp };
