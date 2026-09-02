const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { requireBearerAuth } = require('@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js');
const { InvalidTokenError } = require('@modelcontextprotocol/sdk/server/auth/errors.js');
const { getOAuthProtectedResourceMetadataUrl } = require('@modelcontextprotocol/sdk/server/auth/router.js');
const z = require('zod');
const { findUserByToken } = require('../lib/apiTokens');
const { cloneCycleForward } = require('../lib/cycles');
const { getPivot } = require('../lib/pivot');

const STATUS_VALUES = ['not_started', 'in_progress', 'waiting', 'ready_to_be_booked', 'done', 'n_a'];
const STATUS_ENUM = z.enum(STATUS_VALUES);

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
    description: "List tasks in a cycle where the calling user (the token's owner) is Booking Responsible or Quality Check. Defaults to the most recent cycle.",
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
    description: 'List all tasks in a cycle, optionally filtered by booking status. Defaults to the most recent cycle.',
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
    description: 'Update a task\'s booking status, check status, comment, or finished date. Get the task_id from list_tasks or get_my_tasks first.',
    inputSchema: {
      task_id: z.number().int().describe('Task id, from list_tasks or get_my_tasks'),
      booking_status: STATUS_ENUM.optional(),
      check_status: STATUS_ENUM.optional(),
      comment: z.string().optional(),
      date_finished: z.string().optional().describe('ISO date, e.g. "2026-07-31"'),
    },
  }, async ({ task_id: taskId, booking_status: bookingStatus, check_status: checkStatus, comment, date_finished: dateFinished }) => {
    const fields = [];
    const values = [];
    if (bookingStatus) { values.push(bookingStatus); fields.push(`booking_status = $${values.length}`); }
    if (checkStatus) { values.push(checkStatus); fields.push(`check_status = $${values.length}`); }
    if (comment !== undefined) { values.push(comment); fields.push(`comment = $${values.length}`); }
    if (dateFinished) { values.push(dateFinished); fields.push(`date_finished = $${values.length}`); }

    if (!fields.length) return { content: [{ type: 'text', text: 'No fields to update.' }], isError: true };

    values.push(taskId);
    const { rows } = await pool.query(
      `UPDATE tasks SET ${fields.join(', ')}, updated_at = now() WHERE id = $${values.length}
       RETURNING id, task_name, booking_status, check_status, comment, date_finished`,
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
