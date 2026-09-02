const express = require('express');
const path = require('path');
const session = require('express-session');
const pgSessionStore = require('connect-pg-simple')(session);
const { mcpAuthRouter } = require('@modelcontextprotocol/sdk/server/auth/router.js');
const pool = require('./db');
const { router: authRouter, requireAuth } = require('./routes/auth');
const { mountMcp } = require('./routes/mcp');
const { createOAuthProvider } = require('./lib/oauth');

const app = express();
// Trust exactly one hop (Caddy, on the same private Docker network) so
// req.ip reflects the real client rather than the proxy's own address —
// matters for the login rate limiter, which keys on IP.
app.set('trust proxy', 1);
app.disable('x-powered-by'); // don't advertise the framework to anyone probing
app.use(express.json());
app.use((req, _res, next) => { console.log(req.method, req.url); next(); });

if (!process.env.SESSION_SECRET) {
  console.warn('WARNING: SESSION_SECRET is not set — using an insecure default. Set it in production.');
}

app.use(session({
  store: new pgSessionStore({ pool, createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'dev-only-insecure-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true', // flip to true once served over HTTPS
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  },
}));

// PUBLIC_DIR can be overridden; Docker mounts frontend at /app/public
const publicDir = process.env.PUBLIC_DIR || path.join(__dirname, '..', 'frontend');
app.use(express.static(publicDir));

app.use('/api', authRouter); // /api/login, /api/logout, /api/session — no auth required
app.use('/api', requireAuth, require('./routes/api')); // everything else requires a session

const PORT = process.env.PORT || 3000;
// The public HTTPS URL this app is reachable at — required for OAuth (the
// issuer identity clients discover, and where they're sent to authorize).
// Falls back to plain localhost for local dev, where the SDK's issuer check
// exempts localhost from the HTTPS requirement.
const publicUrl = new URL(process.env.PUBLIC_URL || `http://localhost:${PORT}`);
const mcpResourceUrl = new URL('/mcp', publicUrl);

// Turns this app into its own OAuth 2.0 authorization server (login +
// consent screen reusing the existing users table), so custom connectors —
// Claude web, Desktop, Cowork — can add /mcp by URL and do a normal browser
// sign-in instead of needing a copy-pasted personal token. Mounted at the
// app root per the SDK's requirement; installs /authorize, /token,
// /register, /revoke, and the /.well-known metadata endpoints.
const oauthProvider = createOAuthProvider(pool);
app.use(mcpAuthRouter({
  provider: oauthProvider,
  issuerUrl: publicUrl,
  resourceServerUrl: mcpResourceUrl,
  resourceName: 'Month-End Process',
}));

// Exempt icon lookups from the /mcp bearer-auth requirement: some MCP
// clients probe for a favicon relative to the connector URL itself
// (/mcp/favicon.ico) rather than the site root, and app.use('/mcp', ...)
// below matches that whole sub-path — without this it 401s and the client
// falls back to a generic default icon instead of ours.
app.get(['/mcp/favicon.ico', '/mcp/favicon.png', '/mcp/apple-touch-icon.png'], (req, res) => {
  res.sendFile(path.join(publicDir, path.basename(req.path)));
});

// /mcp — accepts either an OAuth access token (web/Desktop/Cowork, via the
// router above) or a static personal API token (Claude Code), see
// routes/mcp.js.
mountMcp(app, pool, { oauthProvider, mcpResourceUrl });

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
}

migrate()
  .then(() => app.listen(PORT, () => console.log(`month-end-process listening on :${PORT}`)))
  .catch((err) => { console.error('migration failed', err); process.exit(1); });
