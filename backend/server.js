const express = require('express');
const path = require('path');
const session = require('express-session');
const pgSessionStore = require('connect-pg-simple')(session);
const { mcpAuthRouter } = require('@modelcontextprotocol/sdk/server/auth/router.js');
const pool = require('./db');
const { router: authRouter, requireAuth } = require('./routes/auth');
const { mountMcp } = require('./routes/mcp');
const { createOAuthProvider } = require('./lib/oauth');
const { migrate } = require('./lib/migrate');

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

migrate(pool)
  .then(() => app.listen(PORT, () => console.log(`month-end-process listening on :${PORT}`)))
  .catch((err) => { console.error('migration failed', err); process.exit(1); });
