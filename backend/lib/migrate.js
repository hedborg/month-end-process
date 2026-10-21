// Schema migrations — run by server.js on every startup (and by the tests
// against a scratch schema), so every statement must be idempotent.

async function migrate(pool) {
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
    EXCEPTION
      WHEN duplicate_object THEN NULL; -- constraint already exists
      WHEN duplicate_table THEN NULL;  -- its backing index already exists (actual error Postgres raises here)
    END $$;
  `);

  // M4: personal API tokens for MCP access. Store only a SHA-256 hash (fast
  // to check, unlike bcrypt) since a 256-bit random token needs no
  // brute-force protection the way a human-chosen password does.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS api_token_hash TEXT`);
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE users ADD CONSTRAINT users_api_token_hash_key UNIQUE (api_token_hash);
    EXCEPTION
      WHEN duplicate_object THEN NULL;
      WHEN duplicate_table THEN NULL;
    END $$;
  `);

  // M5: OAuth 2.0 authorization server tables, for custom connectors
  // (Claude web/Desktop/Cowork) — see lib/oauth.js.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oauth_clients (
      client_id TEXT PRIMARY KEY,
      client_secret TEXT,
      client_secret_expires_at BIGINT,
      redirect_uris JSONB NOT NULL,
      client_name TEXT,
      token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
      grant_types JSONB,
      response_types JSONB,
      scope TEXT,
      client_id_issued_at BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oauth_auth_codes (
      code_hash TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      redirect_uri TEXT NOT NULL,
      code_challenge TEXT NOT NULL,
      scope TEXT,
      resource TEXT,
      expires_at TIMESTAMPTZ NOT NULL,
      used BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      token_hash TEXT PRIMARY KEY,
      token_type TEXT NOT NULL CHECK (token_type IN ('access', 'refresh')),
      client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      scope TEXT,
      paired_token_hash TEXT,
      expires_at TIMESTAMPTZ,
      revoked BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user ON oauth_tokens(user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_oauth_auth_codes_expires ON oauth_auth_codes(expires_at)`);

  // M6: admin role. Until now any logged-in user could set anyone's password
  // or mint anyone's API token (i.e. impersonate them) — those actions are now
  // gated on is_admin or on acting on your own account (see routes/api.js).
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false`);
  // Bootstrap the first admin — only while no admin exists at all, so a
  // later demotion made through the UI isn't undone on the next restart.
  const { rows: bootstrapped } = await pool.query(`
    UPDATE users SET is_admin = true
    WHERE (name = 'Niklas' OR name ILIKE 'Niklas %')
      AND NOT EXISTS (SELECT 1 FROM users WHERE is_admin)
    RETURNING name
  `);
  if (bootstrapped.length) console.log(`bootstrapped admin: ${bootstrapped.map((u) => u.name).join(', ')}`);
  const { rows: admins } = await pool.query('SELECT 1 FROM users WHERE is_admin AND active LIMIT 1');
  if (!admins.length) console.warn('WARNING: no active admin user — nobody can add users or reset passwords');

  // M7: personal to-dos — private per user, not tied to a cycle. See
  // lib/todos.js for the owner-scoping rule every query follows.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS personal_todos (
      id SERIAL PRIMARY KEY,
      owner_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'waiting', 'done', 'archived')),
      priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('high', 'normal', 'low')),
      due_date DATE,
      follow_up_date DATE,
      linked_task_id INT REFERENCES tasks(id) ON DELETE SET NULL,
      created_via TEXT NOT NULL DEFAULT 'web' CHECK (created_via IN ('web', 'mcp')),
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_personal_todos_owner ON personal_todos(owner_id, status)`);
}

module.exports = { migrate };
