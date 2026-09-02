const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');

const router = express.Router();

// Simple in-memory rate limit: 5 failed attempts per IP+name locks that
// combination out for 15 minutes. Resets on process restart, which is fine
// at this scale — there's no cluster, no shared state to keep in sync.
const FAILURE_LIMIT = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const failureLog = new Map();

function rateLimitKey(req) {
  return `${req.ip}:${String(req.body.name || '').toLowerCase()}`;
}

function isLockedOut(key) {
  const entry = failureLog.get(key);
  if (!entry) return false;
  if (Date.now() - entry.firstFailureAt > LOCKOUT_MS) {
    failureLog.delete(key);
    return false;
  }
  return entry.count >= FAILURE_LIMIT;
}

function recordFailure(key) {
  const entry = failureLog.get(key);
  if (!entry || Date.now() - entry.firstFailureAt > LOCKOUT_MS) {
    failureLog.set(key, { count: 1, firstFailureAt: Date.now() });
  } else {
    entry.count += 1;
  }
}

// Core login check, shared by the JSON /login endpoint and the OAuth
// authorize page's login form — both check the same users table and the
// same rate limiter, they just render the result differently.
async function attemptLogin(req) {
  const { name, password } = req.body;
  if (!name || !password) return { ok: false, status: 400, error: 'name and password are required' };

  const key = rateLimitKey(req);
  if (isLockedOut(key)) {
    return { ok: false, status: 429, error: 'Too many failed attempts. Try again in 15 minutes.' };
  }

  try {
    const { rows } = await pool.query(
      'SELECT id, name, password_hash, active FROM users WHERE lower(name) = lower($1)',
      [name],
    );
    const user = rows[0];

    if (!user || !user.active || !user.password_hash) {
      recordFailure(key);
      return { ok: false, status: 401, error: 'Invalid name or password' };
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      recordFailure(key);
      return { ok: false, status: 401, error: 'Invalid name or password' };
    }

    failureLog.delete(key);
    return await new Promise((resolve) => {
      req.session.regenerate((err) => {
        if (err) { console.error(err); return resolve({ ok: false, status: 500, error: 'Login failed' }); }
        req.session.userId = user.id;
        resolve({ ok: true, user: { id: user.id, name: user.name } });
      });
    });
  } catch (err) {
    console.error(err);
    return { ok: false, status: 500, error: 'Login failed' };
  }
}

router.post('/login', async (req, res) => {
  const result = await attemptLogin(req);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json(result.user);
});

router.post('/logout', (req, res) => {
  if (!req.session) return res.status(204).end();
  req.session.destroy(() => res.status(204).end());
});

router.get('/session', async (req, res) => {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'not logged in' });
  const { rows } = await pool.query(
    'SELECT id, name FROM users WHERE id = $1 AND active = true',
    [req.session.userId],
  );
  if (!rows.length) return res.status(401).json({ error: 'not logged in' });
  res.json(rows[0]);
});

function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Login required' });
  next();
}

module.exports = { router, requireAuth, attemptLogin };
