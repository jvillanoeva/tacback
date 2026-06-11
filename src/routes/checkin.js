const { Router } = require('express');
const crypto = require('crypto');
const { supabase } = require('../lib/supabase');
const { requireAuth } = require('../middleware/auth');
const { verifyQrToken } = require('../services/qr');
const { normalizeNfcId } = require('../lib/nfc');

const router = Router();

// Verify QR and check in guest — optimized for speed.
//
// Two-stage access (keineln): body { token, stage }.
//   stage = 'gate'  (default) — main gate at the venue. Anti-passback: a QR
//                    already scanned at the gate is rejected as 'already'.
//                    Sets gate_scanned_at AND checked_in (keeps existing
//                    dashboards/counts meaningful).
//   stage = 'table' — table door. Reveals the table + account manager so staff
//                     can confirm who owns the table. Independent anti-passback
//                     on table_scanned_at. Does NOT require a prior gate scan
//                     (operationally the two doors are staffed separately).
router.post('/', requireAuth, async (req, res) => {
  const { token, stage } = req.body;
  const scanStage = stage === 'table' ? 'table' : 'gate';

  if (!token) return res.status(400).json({ error: 'QR token is required' });

  // Resolve the scanned value: new short code first (fast, low-density QR),
  // then fall back to the legacy signed JWT so already-issued QRs keep working.
  const SEL = 'id, name, email, notes, tier, checked_in, checked_in_at, gate_scanned_at, table_scanned_at, invite_link_id, event_id';

  let { data: guest } = await supabase
    .from('guests')
    .select(SEL)
    .eq('short_code', token)
    .maybeSingle();

  if (!guest) {
    // Legacy path: only look up by qr_token if it's a validly signed JWT.
    let validJwt = true;
    try { verifyQrToken(token); } catch (err) { validJwt = false; }
    if (!validJwt) {
      return res.json({ status: 'invalid', message: 'Código QR inválido' });
    }
    const r = await supabase.from('guests').select(SEL).eq('qr_token', token).maybeSingle();
    guest = r.data;
  }

  if (!guest) {
    return res.json({ status: 'invalid', message: 'Acceso no encontrado' });
  }

  // Parallel: event (for access + name) + staff role + table (account manager)
  const [eventResult, staffResult, linkResult] = await Promise.all([
    supabase.from('events').select('id, name, owner_id, organization_id').eq('id', guest.event_id).single(),
    supabase.from('event_staff').select('role').eq('event_id', guest.event_id).eq('user_id', req.user.id).not('accepted_at', 'is', null).single(),
    guest.invite_link_id
      ? supabase.from('invite_links').select('label, manager_name').eq('id', guest.invite_link_id).single()
      : Promise.resolve({ data: null }),
  ]);

  const event = eventResult.data;
  if (!event) return res.json({ status: 'invalid', message: 'Evento no encontrado' });

  const isOwner = event.owner_id === req.user.id;
  const isStaff = !!staffResult.data;

  // Org members get default access — mirrors /nfc and /event/:id.
  let isOrgMember = false;
  if (!isOwner && !isStaff && event.organization_id) {
    const { data: om } = await supabase
      .from('organization_members')
      .select('role')
      .eq('organization_id', event.organization_id)
      .eq('user_id', req.user.id)
      .single();
    isOrgMember = !!om;
  }

  if (!isOwner && !isStaff && !isOrgMember) {
    return res.status(403).json({ error: 'No tienes acceso a este evento' });
  }

  const table = linkResult.data
    ? { label: linkResult.data.label, manager: linkResult.data.manager_name }
    : null;
  const guestPayload = { name: guest.name, tier: guest.tier, notes: guest.notes };

  // ── Stage 2: table door ──────────────────────────────────────────────────
  if (scanStage === 'table') {
    if (guest.table_scanned_at) {
      return res.json({
        status: 'already_checked_in', stage: 'table',
        message: 'Ya ingresó a la mesa', table,
        guest: { ...guestPayload, checked_in_at: guest.table_scanned_at },
      });
    }
    // Atomic: mark only if not already scanned at the table. If 0 rows change,
    // another scan won the race → treat as already used (no double entry).
    const { data: upd, error: uErr } = await supabase
      .from('guests')
      .update({ table_scanned_at: new Date().toISOString(), table_scanned_by: req.user.id })
      .eq('id', guest.id)
      .is('table_scanned_at', null)
      .select('id');
    if (uErr) return res.status(500).json({ error: 'Error al registrar en mesa' });
    if (!upd || upd.length === 0) {
      return res.json({
        status: 'already_checked_in', stage: 'table',
        message: 'Ya ingresó a la mesa', table, guest: guestPayload,
      });
    }

    return res.json({
      status: 'success', stage: 'table',
      message: table ? table.label : 'Acceso a mesa',
      table, guest: guestPayload,
    });
  }

  // ── Stage 1: main gate (default) — anti-passback ─────────────────────────
  if (guest.gate_scanned_at) {
    return res.json({
      status: 'already_checked_in', stage: 'gate',
      message: 'Ya ingresó por puerta principal', table,
      guest: { ...guestPayload, checked_in_at: guest.gate_scanned_at },
    });
  }

  const now = new Date().toISOString();
  // Atomic: claim the gate scan only if not already scanned. If 0 rows change,
  // a simultaneous scan beat us → reject as already used (no double entry).
  const { data: upd, error: updErr } = await supabase
    .from('guests')
    .update({
      gate_scanned_at: now,
      gate_scanned_by: req.user.id,
      checked_in: true,
      checked_in_at: now,
      checked_in_by: req.user.id,
    })
    .eq('id', guest.id)
    .is('gate_scanned_at', null)
    .select('id');

  if (updErr) {
    return res.status(500).json({ error: 'Error al registrar entrada' });
  }
  if (!upd || upd.length === 0) {
    return res.json({
      status: 'already_checked_in', stage: 'gate',
      message: 'Ya ingresó por puerta principal', table, guest: guestPayload,
    });
  }

  const [totalResult, checkedResult] = await Promise.all([
    supabase.from('guests').select('*', { count: 'exact', head: true }).eq('event_id', event.id),
    supabase.from('guests').select('*', { count: 'exact', head: true }).eq('event_id', event.id).eq('checked_in', true),
  ]);

  res.json({
    status: 'success', stage: 'gate',
    message: '¡Acceso confirmado!',
    guest: guestPayload,
    table,
    event: { name: event.name },
    stats: {
      checked_in: checkedResult.count || 0, // update already committed above
      total: totalResult.count || 0,
    },
  });
});

// Manual check-in by guest ID (no QR needed)
router.post('/manual', requireAuth, async (req, res) => {
  const { guest_id, stage } = req.body;
  const scanStage = stage === 'table' ? 'table' : 'gate';
  if (!guest_id) return res.status(400).json({ error: 'guest_id is required' });

  const { data: guest, error: gErr } = await supabase
    .from('guests')
    .select('id, name, notes, checked_in, gate_scanned_at, table_scanned_at, event_id')
    .eq('id', guest_id)
    .single();

  if (gErr || !guest) return res.status(404).json({ error: 'Guest not found' });

  // Verify access
  const [eventResult, staffResult] = await Promise.all([
    supabase.from('events').select('id, owner_id, organization_id').eq('id', guest.event_id).single(),
    supabase.from('event_staff').select('role').eq('event_id', guest.event_id).eq('user_id', req.user.id).not('accepted_at', 'is', null).single(),
  ]);

  const event = eventResult.data;
  if (!event) return res.status(404).json({ error: 'Event not found' });

  const isOwner = event.owner_id === req.user.id;
  const isStaff = !!staffResult.data;

  // Org members get default access — mirrors /nfc and /event/:id.
  let isOrgMember = false;
  if (!isOwner && !isStaff && event.organization_id) {
    const { data: om } = await supabase
      .from('organization_members')
      .select('role')
      .eq('organization_id', event.organization_id)
      .eq('user_id', req.user.id)
      .single();
    isOrgMember = !!om;
  }

  if (!isOwner && !isStaff && !isOrgMember) {
    return res.status(403).json({ error: 'No access' });
  }

  const now = new Date().toISOString();

  // Manual table-door check-in.
  if (scanStage === 'table') {
    if (guest.table_scanned_at) {
      return res.json({ status: 'already_checked_in', stage: 'table', message: 'Ya registrado en mesa' });
    }
    const { error: uErr } = await supabase
      .from('guests')
      .update({ table_scanned_at: now, table_scanned_by: req.user.id })
      .eq('id', guest.id);
    if (uErr) return res.status(500).json({ error: 'Check-in failed' });
    return res.json({ status: 'success', stage: 'table', message: '¡Mesa registrada!', guest: { name: guest.name } });
  }

  // Manual main-gate check-in (default) — also sets the legacy checked_in flag.
  if (guest.gate_scanned_at || guest.checked_in) {
    return res.json({ status: 'already_checked_in', stage: 'gate', message: 'Ya registrado' });
  }
  const { error: uErr } = await supabase
    .from('guests')
    .update({
      gate_scanned_at: now,
      gate_scanned_by: req.user.id,
      checked_in: true,
      checked_in_at: now,
      checked_in_by: req.user.id,
    })
    .eq('id', guest.id);

  if (uErr) return res.status(500).json({ error: 'Check-in failed' });

  res.json({ status: 'success', stage: 'gate', message: '¡Entrada registrada!', guest: { name: guest.name } });
});

// NFC card UID lookup — door access decision only.
// Body: { event_id, nfc_id }
// Returns: { status: 'allow' | 'already_used' | 'not_on_list', guest?, event? }
//
// This is a *lookup* endpoint, not a check-in action. On 'allow', the operator
// confirms (Allow/Deny prompt) and the existing POST /checkin/manual { guest_id }
// records the check-in — same state machine as QR, different lookup key.
//
// Auth mirrors the QR /checkin route's inline pattern (requireAuth + owner-on-event
// or accepted event_staff). NOT anon — anon would let anyone probe a guestlist
// or burn entries.
router.post('/nfc', requireAuth, async (req, res) => {
  const { event_id, nfc_id } = req.body;

  if (!event_id || !nfc_id) {
    return res.status(400).json({ error: 'event_id and nfc_id are required' });
  }

  const normalizedUid = normalizeNfcId(nfc_id);
  if (!normalizedUid) {
    return res.status(400).json({ error: 'nfc_id is empty after normalization' });
  }

  const [eventResult, staffResult] = await Promise.all([
    supabase.from('events').select('id, name, owner_id, organization_id').eq('id', event_id).single(),
    supabase.from('event_staff').select('role').eq('event_id', event_id).eq('user_id', req.user.id).not('accepted_at', 'is', null).single(),
  ]);

  const event = eventResult.data;
  if (!event) return res.status(404).json({ error: 'Event not found' });

  const isOwner = event.owner_id === req.user.id;
  const isStaff = !!staffResult.data;

  let isOrgMember = false;
  if (!isOwner && !isStaff && event.organization_id) {
    const { data: om } = await supabase
      .from('organization_members')
      .select('role')
      .eq('organization_id', event.organization_id)
      .eq('user_id', req.user.id)
      .single();
    isOrgMember = !!om;
  }

  if (!isOwner && !isStaff && !isOrgMember) {
    return res.status(403).json({ error: 'No tienes acceso a este evento' });
  }

  const { data: guest, error: guestErr } = await supabase
    .from('guests')
    .select('id, name, notes, tier, group_id, checked_in, checked_in_at')
    .eq('event_id', event_id)
    .eq('nfc_id', normalizedUid)
    .maybeSingle();

  if (guestErr) {
    return res.status(500).json({ error: 'Lookup failed' });
  }

  if (!guest) {
    return res.json({
      status: 'not_on_list',
      message: 'Tarjeta no está en la lista',
      event: { id: event.id, name: event.name },
    });
  }

  if (guest.checked_in) {
    return res.json({
      status: 'already_used',
      message: 'Ya registrada',
      guest: {
        id: guest.id,
        name: guest.name,
        tier: guest.tier,
        notes: guest.notes,
        checked_in_at: guest.checked_in_at,
      },
      event: { id: event.id, name: event.name },
    });
  }

  return res.json({
    status: 'allow',
    message: 'Tarjeta válida',
    guest: {
      id: guest.id,
      name: guest.name,
      tier: guest.tier,
      notes: guest.notes,
      group_id: guest.group_id,
    },
    event: { id: event.id, name: event.name },
  });
});

// Event display info for the door device — name + date for the idle screen.
// GET /api/checkin/event/:event_id
//
// The Pi already holds TAC_EVENT_ID; this lets the door's idle screen pull the
// event name/date from TAC (the single source of truth) instead of duplicating
// them as static strings in the Pi's .env, which would silently drift on rename.
//
// Keyed by event_id (UUID) and gated by the SAME inline door-access auth as
// POST /nfc above (owner / accepted event_staff / org member) — NOT anon, and
// NOT the slug-keyed events.js detail route (which excludes the door role).
router.get('/event/:event_id', requireAuth, async (req, res) => {
  const { event_id } = req.params;

  const [eventResult, staffResult] = await Promise.all([
    supabase
      .from('events')
      .select('id, name, subtitle, date_label, venue, city, owner_id, organization_id')
      .eq('id', event_id)
      .single(),
    supabase
      .from('event_staff')
      .select('role')
      .eq('event_id', event_id)
      .eq('user_id', req.user.id)
      .not('accepted_at', 'is', null)
      .single(),
  ]);

  const event = eventResult.data;
  if (!event) return res.status(404).json({ error: 'Event not found' });

  const isOwner = event.owner_id === req.user.id;
  const isStaff = !!staffResult.data;

  let isOrgMember = false;
  if (!isOwner && !isStaff && event.organization_id) {
    const { data: om } = await supabase
      .from('organization_members')
      .select('role')
      .eq('organization_id', event.organization_id)
      .eq('user_id', req.user.id)
      .single();
    isOrgMember = !!om;
  }

  if (!isOwner && !isStaff && !isOrgMember) {
    return res.status(403).json({ error: 'No tienes acceso a este evento' });
  }

  // Return display fields only — never the auth columns selected above.
  return res.json({
    id: event.id,
    name: event.name,
    subtitle: event.subtitle,
    date_label: event.date_label,
    venue: event.venue,
    city: event.city,
  });
});

// ── Public scanner (no login) ──────────────────────────────────────────────
// The scanner links carry a per-event "door key" (events.door_token). Anyone
// with the link can scan — no Supabase account needed — but only for this one
// event. Rotate events.door_token to revoke all links.
function doorTokenOk(eventDoorToken, provided) {
  if (!eventDoorToken || !provided) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(eventDoorToken));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const PUBLIC_GUEST_SEL = 'id, name, notes, tier, checked_in, gate_scanned_at, table_scanned_at, invite_link_id, event_id';

// Event header + counts for the scanner idle screen (door-key gated).
router.get('/public/info', async (req, res) => {
  const { slug, k } = req.query;
  const { data: event } = await supabase
    .from('events').select('id, name, date_label, venue, door_token').eq('slug', slug).single();
  if (!event || !doorTokenOk(event.door_token, k)) {
    return res.status(403).json({ error: 'Link de acceso inválido' });
  }
  const [totalRes, checkedRes] = await Promise.all([
    supabase.from('guests').select('*', { count: 'exact', head: true }).eq('event_id', event.id),
    supabase.from('guests').select('*', { count: 'exact', head: true }).eq('event_id', event.id).eq('checked_in', true),
  ]);
  res.json({
    name: event.name, date_label: event.date_label, venue: event.venue,
    stats: { checked_in: checkedRes.count || 0, total_guests: totalRes.count || 0 },
  });
});

// Public check-in. Body: { slug, k, token, stage }. Mirrors POST '/' but
// authenticated by the door key instead of a user session; *_by stays null.
router.post('/public', async (req, res) => {
  const { slug, k, token, stage } = req.body;
  const scanStage = stage === 'table' ? 'table' : 'gate';
  if (!slug || !k || !token) return res.status(400).json({ error: 'Faltan parámetros' });

  const { data: event } = await supabase
    .from('events').select('id, name, door_token').eq('slug', slug).single();
  if (!event || !doorTokenOk(event.door_token, k)) {
    return res.status(403).json({ error: 'Link de acceso inválido' });
  }

  // Resolve scanned value: short code first, then legacy JWT — scoped to event.
  let { data: guest } = await supabase
    .from('guests').select(PUBLIC_GUEST_SEL).eq('event_id', event.id).eq('short_code', token).maybeSingle();
  if (!guest) {
    try { verifyQrToken(token); } catch (e) { return res.json({ status: 'invalid', message: 'Código QR inválido' }); }
    const r = await supabase.from('guests').select(PUBLIC_GUEST_SEL).eq('event_id', event.id).eq('qr_token', token).maybeSingle();
    guest = r.data;
  }
  if (!guest) return res.json({ status: 'invalid', message: 'Acceso no encontrado' });

  let table = null;
  if (guest.invite_link_id) {
    const { data: link } = await supabase.from('invite_links').select('label, manager_name').eq('id', guest.invite_link_id).single();
    if (link) table = { label: link.label, manager: link.manager_name };
  }
  const guestPayload = { name: guest.name, tier: guest.tier, notes: guest.notes };
  const now = new Date().toISOString();

  if (scanStage === 'table') {
    if (guest.table_scanned_at) {
      return res.json({ status: 'already_checked_in', stage: 'table', message: 'Ya ingresó a la mesa', table, guest: guestPayload });
    }
    const { data: upd, error: uErr } = await supabase
      .from('guests').update({ table_scanned_at: now }).eq('id', guest.id).is('table_scanned_at', null).select('id');
    if (uErr) return res.status(500).json({ error: 'Error al registrar en mesa' });
    if (!upd || upd.length === 0) return res.json({ status: 'already_checked_in', stage: 'table', message: 'Ya ingresó a la mesa', table, guest: guestPayload });
    return res.json({ status: 'success', stage: 'table', message: table ? table.label : 'Acceso a mesa', table, guest: guestPayload });
  }

  if (guest.gate_scanned_at) {
    return res.json({ status: 'already_checked_in', stage: 'gate', message: 'Ya ingresó por puerta principal', table, guest: guestPayload });
  }
  const { data: upd, error: updErr } = await supabase
    .from('guests').update({ gate_scanned_at: now, checked_in: true, checked_in_at: now })
    .eq('id', guest.id).is('gate_scanned_at', null).select('id');
  if (updErr) return res.status(500).json({ error: 'Error al registrar entrada' });
  if (!upd || upd.length === 0) {
    return res.json({ status: 'already_checked_in', stage: 'gate', message: 'Ya ingresó por puerta principal', table, guest: guestPayload });
  }
  const [totalRes, checkedRes] = await Promise.all([
    supabase.from('guests').select('*', { count: 'exact', head: true }).eq('event_id', event.id),
    supabase.from('guests').select('*', { count: 'exact', head: true }).eq('event_id', event.id).eq('checked_in', true),
  ]);
  res.json({
    status: 'success', stage: 'gate', message: '¡Acceso confirmado!', guest: guestPayload, table,
    event: { name: event.name },
    stats: { checked_in: checkedRes.count || 0, total: totalRes.count || 0 },
  });
});

module.exports = router;
