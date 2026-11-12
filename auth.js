'use strict';
const crypto = require('node:crypto');
const { SECRET } = require('./db');

const b64u = (b) => Buffer.from(b).toString('base64url');

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64);
  return `s1$${salt.toString('hex')}$${h.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [v, saltHex, hashHex] = String(stored).split('$');
  if (v !== 's1') return false;
  const h = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
  const want = Buffer.from(hashHex, 'hex');
  return h.length === want.length && crypto.timingSafeEqual(h, want);
}

// JWT (HS256)
function signJwt(payload, ttlSec = 7 * 24 * 3600) {
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + ttlSec }));
  const sig = crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}
function verifyJwt(token) {
  try {
    const [h, b, s] = String(token).split('.');
    if (!h || !b || !s) return null;
    const want = crypto.createHmac('sha256', SECRET).update(`${h}.${b}`).digest();
    const got = Buffer.from(s, 'base64url');
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
    const p = JSON.parse(Buffer.from(b, 'base64url').toString());
    if (!p.exp || p.exp < Date.now() / 1000) return null;
    return p;
  } catch { return null; }
}

// بسيط: تحديد معدل المحاولات لكل IP
const hits = new Map();
function rateLimit(key, max = 20, windowMs = 15 * 60 * 1000) {
  const now = Date.now();
  const e = hits.get(key) || { n: 0, t: now };
  if (now - e.t > windowMs) { e.n = 0; e.t = now; }
  e.n++;
  hits.set(key, e);
  return e.n <= max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (now - v.t > 3600e3) hits.delete(k); }, 600e3).unref();

module.exports = { hashPassword, verifyPassword, signJwt, verifyJwt, rateLimit };
