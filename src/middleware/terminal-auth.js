const crypto = require('crypto');
const { supabase } = require('../lib/supabase');

/**
 * Hash a plaintext terminal token. The DB only ever stores the hash;
 * the plaintext is shown once at provisioning time and flashed onto
 * the terminal SD card.
 */
function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/**
 * Authenticate a Pi-5 terminal by its X-Terminal-Token header.
 * On success attaches `req.terminal = { id, name, station_kind }`
 * and best-effort updates `terminals.last_seen_at`.
 */
async function requireTerminal(req, res, next) {
  const token = req.header('X-Terminal-Token');
  if (!token) {
    return res.status(401).json({ error: 'Missing terminal token' });
  }

  const hash = sha256(token);
  const { data: terminal, error } = await supabase
    .from('terminals')
    .select('id, name, station_kind, revoked_at')
    .eq('device_token_hash', hash)
    .single();

  if (error || !terminal || terminal.revoked_at) {
    return res.status(401).json({ error: 'Invalid or revoked terminal' });
  }

  // Best-effort last_seen_at update; don't block the request on it.
  supabase
    .from('terminals')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', terminal.id)
    .then(() => {}, () => {});

  req.terminal = {
    id: terminal.id,
    name: terminal.name,
    station_kind: terminal.station_kind,
  };
  next();
}

module.exports = { requireTerminal, sha256 };
