const crypto = require('crypto');

/**
 * Unsubscribe tokens: HMAC-signed email, no DB lookup needed to verify.
 * Secret: UNSUB_SECRET (set one in Railway); falls back to the service key
 * so links work before that var exists — but rotating the service key then
 * kills old links, so set UNSUB_SECRET.
 */
function secret() {
  return process.env.UNSUB_SECRET || process.env.SUPABASE_SERVICE_KEY || '';
}

function sig(email) {
  return crypto.createHmac('sha256', secret()).update(email).digest('base64url').slice(0, 24);
}

/** email -> opaque payload for the URL */
function unsubToken(email) {
  const e = String(email || '').trim().toLowerCase();
  return Buffer.from(e).toString('base64url') + '.' + sig(e);
}

/** payload -> email, or null if tampered/malformed */
function verifyUnsubToken(payload) {
  const i = String(payload || '').lastIndexOf('.');
  if (i < 1) return null;
  let email;
  try {
    email = Buffer.from(payload.slice(0, i), 'base64url').toString('utf8');
  } catch {
    return null;
  }
  if (!email || !email.includes('@') || email.length > 320) return null;
  const expect = sig(email.trim().toLowerCase());
  const got = payload.slice(i + 1);
  if (expect.length !== got.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(got))) return null;
  return email.trim().toLowerCase();
}

const API_BASE = (process.env.PUBLIC_API_URL || 'https://api.colectivo.live').replace(/\/+$/, '');

function unsubUrlFor(email) {
  return API_BASE + '/api/unsub/' + unsubToken(email);
}

module.exports = { unsubToken, verifyUnsubToken, unsubUrlFor };
