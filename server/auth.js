const crypto = require('crypto');

const SESSION_COOKIE_NAME = 'mysportsagent_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const LOGIN_WINDOW_MS = 1000 * 60 * 15;
const LOGIN_MAX_ATTEMPTS = 10;
const DEFAULT_PASSWORD = 'changeme';

function createAuth({ username, password, secureCookies }) {
  const sessions = new Map();
  const loginAttempts = new Map();

  function safeEqual(a, b) {
    const ha = crypto.createHash('sha256').update(String(a)).digest();
    const hb = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
  }

  function parseCookies(req) {
    const cookies = {};
    for (const part of (req.headers.cookie || '').split(';')) {
      const [rawKey, ...rest] = part.trim().split('=');
      if (!rawKey) continue;
      try {
        cookies[rawKey] = decodeURIComponent(rest.join('='));
      } catch {
        // Ignore malformed cookie values.
      }
    }
    return cookies;
  }

  function cookie(value, maxAgeSeconds) {
    return [
      `${SESSION_COOKIE_NAME}=${value}`,
      'HttpOnly',
      'Path=/',
      `Max-Age=${maxAgeSeconds}`,
      'SameSite=Lax',
      secureCookies ? 'Secure' : null
    ]
      .filter(Boolean)
      .join('; ');
  }

  function getSession(req) {
    const token = parseCookies(req)[SESSION_COOKIE_NAME];
    if (!token) return null;
    const session = sessions.get(token);
    if (!session) return null;
    if (Date.now() > session.expiresAt) {
      sessions.delete(token);
      return null;
    }
    return { token, ...session };
  }

  function isRateLimited(ip) {
    const now = Date.now();
    const entry = loginAttempts.get(ip);
    if (!entry || now - entry.start > LOGIN_WINDOW_MS) {
      loginAttempts.set(ip, { start: now, count: 1 });
      return false;
    }
    entry.count += 1;
    return entry.count > LOGIN_MAX_ATTEMPTS;
  }

  function login(req, res) {
    if (isRateLimited(req.ip)) {
      return res.status(429).json({ error: 'Too many login attempts. Try again in a few minutes.' });
    }
    const { username: u = '', password: p = '' } = req.body || {};
    const ok = safeEqual(u, username) & safeEqual(p, password);
    if (!ok) return res.status(401).json({ error: 'Invalid username or password.' });

    loginAttempts.delete(req.ip);
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { username, expiresAt: Date.now() + SESSION_TTL_MS });
    res.setHeader('Set-Cookie', cookie(token, Math.floor(SESSION_TTL_MS / 1000)));
    return res.json({ ok: true, username });
  }

  function logout(req, res) {
    sessions.delete(req.auth.token);
    res.setHeader('Set-Cookie', cookie('', 0));
    return res.json({ ok: true });
  }

  function me(req, res) {
    const session = getSession(req);
    if (!session) return res.status(401).json({ authenticated: false });
    return res.json({ authenticated: true, username: session.username });
  }

  function requireAuth(req, res, next) {
    const session = getSession(req);
    if (!session) return res.status(401).json({ error: 'Authentication required.' });
    req.auth = session;
    return next();
  }

  return { login, logout, me, requireAuth };
}

module.exports = { createAuth, DEFAULT_PASSWORD };
