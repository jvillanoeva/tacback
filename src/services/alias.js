const { supabase } = require('../lib/supabase');

/**
 * Card aliases — "escribe cómo quieres que te conozcamos". Unique across the
 * whole member namespace (loyalty_members), case-insensitive. No underscore
 * or % in the charset so PostgREST ilike needs no escaping.
 */

const RESERVED = [
  'sunday sunday', 'sundaysunday', 'sunday', 'staff', 'seguridad', 'admin',
  'memel', 'dorado', 'colectivo', 'tac', 'dj', 'barra', 'puerta',
];

const MAX_LEN = 16; // sized to the card print area

function normalizeAlias(v) {
  const s = String(v == null ? '' : v).trim().replace(/\s+/g, ' ');
  return s || null;
}

/** Returns an error string (Spanish, guest-facing) or null when valid. */
function validateAlias(a) {
  if (a.length < 2) return 'Muy corto: mínimo 2 caracteres.';
  if (a.length > MAX_LEN) return 'Muy largo: máximo ' + MAX_LEN + ' caracteres.';
  if (!/^[0-9A-Za-zÁÉÍÓÚÜÑáéíóúüñ .\-]+$/.test(a)) return 'Solo letras, números, espacios, punto y guion.';
  if (RESERVED.includes(a.toLowerCase())) return 'Ese nombre está reservado.';
  return null;
}

/**
 * Available = nobody has it, or the holder is the given email (your own
 * clave is always "available" to you — a re-claim must never be told their
 * name is taken by themselves).
 */
async function isAliasAvailable(a, forEmail) {
  const { data, error } = await supabase
    .from('loyalty_members')
    .select('id, email')
    .ilike('alias', a)
    .limit(1);
  if (error) throw new Error('alias lookup failed: ' + error.message);
  if (!data || data.length === 0) return true;
  const holder = (data[0].email || '').trim().toLowerCase();
  return !!forEmail && holder === String(forEmail).trim().toLowerCase();
}

/**
 * Attach an alias to the member identified by the guest's email, creating the
 * member row if needed. First alias wins — an existing alias is never
 * overwritten here. Returns true when the alias is now saved on the member,
 * false when it was lost to a race or the guest has no email.
 */
async function saveMemberAlias({ guestId, alias }) {
  const { data: guest } = await supabase
    .from('guests')
    .select('id, name, email')
    .eq('id', guestId)
    .single();
  if (!guest || !guest.email) return false;
  const email = guest.email.trim().toLowerCase();

  const { data: existing } = await supabase
    .from('loyalty_members')
    .select('id, alias')
    .ilike('email', email)
    .maybeSingle();

  try {
    if (existing) {
      if (existing.alias) return existing.alias.toLowerCase() === alias.toLowerCase();
      const { error } = await supabase
        .from('loyalty_members')
        .update({ alias, updated_at: new Date().toISOString() })
        .eq('id', existing.id);
      if (error) throw error;
    } else {
      const { error } = await supabase
        .from('loyalty_members')
        .insert({ email, alias, first_name: (guest.name || '').trim().split(/\s+/)[0] || null });
      if (error) throw error;
    }
  } catch (e) {
    // 23505 = unique violation: someone took the alias between check and save.
    if (e && (e.code === '23505' || /duplicate|unique/i.test(e.message || ''))) return false;
    throw e;
  }
  return true;
}

module.exports = { normalizeAlias, validateAlias, isAliasAvailable, saveMemberAlias, MAX_LEN };
