// MCP task tools (create_task, update_task, list_people) against a real
// Postgres. Each run builds its own scratch schema from db/01-init.sql plus
// the startup migrations and drops it afterwards, so it's safe to point at
// the dev database. Connection comes from the usual DB_* env vars.
//
//   cd backend && DB_PORT=5433 npm test

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { getServer } = require('../routes/mcp');
const { migrate } = require('../lib/migrate');
const { cloneCycleForward } = require('../lib/cycles');

const schema = `mcp_test_${process.pid}_${Date.now()}`;
const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5433'),
  database: process.env.DB_NAME || 'monthend',
  user: process.env.DB_USER || 'monthend',
  password: process.env.DB_PASSWORD || 'monthend',
};

let admin;
let pool;
let users;

before(async () => {
  admin = new Pool(dbConfig);
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new Pool({ ...dbConfig, options: `-c search_path=${schema}` });
  await pool.query(fs.readFileSync(path.join(__dirname, '..', '..', 'db', '01-init.sql'), 'utf8'));
  await migrate(pool);

  const { rows } = await pool.query(`
    INSERT INTO users (name, active) VALUES
      ('Niklas Hedborg', true), ('Anna Berg', true), ('Anna Lind', true), ('Old Timer', false)
    RETURNING id, name`);
  users = Object.fromEntries(rows.map((u) => [u.name, u.id]));
  await pool.query(`
    INSERT INTO cycles (label, year, month, status) VALUES
      ('2026-08', 2026, 8, 'archived'), ('2026-09', 2026, 9, 'open'), ('2026-10', 2026, 10, 'locked')`);
  const { rows: [sep] } = await pool.query("SELECT id FROM cycles WHERE label = '2026-09'");
  await pool.query(
    "INSERT INTO tasks (cycle_id, sort_order, task_name) VALUES ($1, 10, 'Update FX Rates'), ($1, 20, 'Bank Reconciliation')",
    [sep.id],
  );
});

after(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});

// Calls a tool through a real MCP client/server pair, authenticated as
// `userName` the same way makeVerifier() would populate authInfo.
async function callTool(name, args, userName = 'Niklas Hedborg') {
  const server = getServer(pool);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const authInfo = { token: 't', clientId: 'test', scopes: [], extra: { userId: users[userName], name: userName } };
  const send = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) => send(message, { ...options, authInfo });

  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content[0].text;
    return result.isError ? { error: text } : { data: JSON.parse(text) };
  } finally {
    await client.close();
    await server.close();
  }
}

test('list_people returns active users only', async () => {
  const { data } = await callTool('list_people', {});
  assert.deepEqual(data, ['Anna Berg', 'Anna Lind', 'Niklas Hedborg']);
});

test('create_task: happy path in the default (most recent open) cycle', async () => {
  const { data, error } = await callTool('create_task', {
    task_name: 'AI Spend Overview Refresh',
    description: 'Refresh the AI spend artifact from Power BI',
    due_date: '15',
    dependency_text: 'Update FX Rates',
    booking_responsible: 'Niklas',
    quality_check: 'anna berg',
    url: 'https://example.com/ai-spend',
  });
  assert.equal(error, undefined);
  // Skips the locked 2026-10 cycle even though it's more recent.
  assert.equal(data.cycle, '2026-09');
  assert.equal(data.task.task_name, 'AI Spend Overview Refresh');
  assert.equal(data.task.due_date, '15');
  assert.equal(data.task.dependency_text, 'Update FX Rates');
  assert.equal(data.task.booking_responsible_name, 'Niklas Hedborg');
  assert.equal(data.task.quality_check_name, 'Anna Berg');
  assert.equal(data.task.booking_status, 'not_started');
  assert.equal(data.task.check_status, 'not_started');

  // Same shape as a list_tasks row, and appended at the bottom.
  const { data: listed } = await callTool('list_tasks', { cycle_label: '2026-09' });
  assert.deepEqual(listed.tasks.at(-1), data.task);
  assert.deepEqual(Object.keys(listed.tasks[0]).sort(), Object.keys(data.task).sort());
});

test('create_task: refuses a duplicate name in the same cycle', async () => {
  const { error } = await callTool('create_task', { task_name: 'update fx rates' });
  assert.match(error, /already has a task named/);
});

test('create_task: refuses a locked cycle', async () => {
  const { error } = await callTool('create_task', { cycle_label: '2026-10', task_name: 'Late addition' });
  assert.match(error, /2026-10 is locked/);
  const { rows } = await pool.query("SELECT 1 FROM tasks WHERE task_name = 'Late addition'");
  assert.equal(rows.length, 0);
});

test('create_task: unknown or ambiguous person is rejected with the valid names', async () => {
  const unknown = await callTool('create_task', { task_name: 'Ghost task', booking_responsible: 'Bob' });
  assert.match(unknown.error, /Unknown booking_responsible "Bob"/);
  assert.match(unknown.error, /Valid names: Anna Berg, Anna Lind, Niklas Hedborg\./);

  const ambiguous = await callTool('create_task', { task_name: 'Ghost task', quality_check: 'Anna' });
  assert.match(ambiguous.error, /Ambiguous quality_check "Anna" — matches Anna Berg, Anna Lind/);

  const inactive = await callTool('create_task', { task_name: 'Ghost task', booking_responsible: 'Old Timer' });
  assert.match(inactive.error, /Unknown booking_responsible/);

  const { rows } = await pool.query("SELECT 1 FROM tasks WHERE task_name = 'Ghost task'");
  assert.equal(rows.length, 0);
});

test('create_task: the new task is carried forward on clone', async () => {
  const { data } = await callTool('create_task', {
    cycle_label: '2026-09', task_name: 'Clone me', description: 'standing', due_date: '3',
    booking_responsible: 'Niklas', booking_status: 'done',
  });
  await callTool('update_task', { task_id: data.task.id, comment: 'this month only' });

  const { rows: [sep] } = await pool.query("SELECT id FROM cycles WHERE label = '2026-09'");
  await pool.query("DELETE FROM cycles WHERE label = '2026-10'"); // make room for the clone target
  const result = await cloneCycleForward(pool, sep.id);
  assert.equal(result.ok, true);

  const { data: next } = await callTool('list_tasks', { cycle_label: '2026-10' });
  const cloned = next.tasks.find((t) => t.task_name === 'Clone me');
  assert.equal(cloned.description, 'standing');
  assert.equal(cloned.due_date, '3');
  assert.equal(cloned.booking_responsible_name, 'Niklas Hedborg');
  assert.equal(cloned.booking_status, 'not_started');
  assert.equal(cloned.comment, null);
});

test('update_task: new fields — name, due date, dependency, people', async () => {
  const { data: created } = await callTool('create_task', { cycle_label: '2026-09', task_name: 'To edit' });
  const id = created.task.id;

  const { data } = await callTool('update_task', {
    task_id: id,
    task_name: 'Edited',
    due_date: '25th Prev Month',
    dependency_text: 'Bank Reconciliation',
    booking_responsible: 'Anna Lind',
    quality_check: 'Niklas',
  });
  assert.equal(data.task_name, 'Edited');
  assert.equal(data.due_date, '25th Prev Month');
  assert.equal(data.dependency_text, 'Bank Reconciliation');
  assert.equal(data.booking_responsible_name, 'Anna Lind');
  assert.equal(data.quality_check_name, 'Niklas Hedborg');

  // Empty string clears an assignee; untouched fields stay as they were.
  const { data: cleared } = await callTool('update_task', { task_id: id, quality_check: '' });
  assert.equal(cleared.quality_check_name, null);
  assert.equal(cleared.booking_responsible_name, 'Anna Lind');
  assert.equal(cleared.due_date, '25th Prev Month');

  const bad = await callTool('update_task', { task_id: id, booking_responsible: 'Nobody' });
  assert.match(bad.error, /Unknown booking_responsible "Nobody"/);
  const { rows } = await pool.query('SELECT booking_responsible_id FROM tasks WHERE id = $1', [id]);
  assert.equal(rows[0].booking_responsible_id, users['Anna Lind']);

  const empty = await callTool('update_task', { task_id: id, task_name: '  ' });
  assert.match(empty.error, /task_name cannot be empty/);
});
