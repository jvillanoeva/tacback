const { Router } = require('express');
const { supabase } = require('../lib/supabase');
const { requireAuth } = require('../middleware/auth');
const { verifyQrToken } = require('../services/qr');
const { normalizeNfcId } = require('../lib/nfc');

const router = Router();

// Verify QR and check in guest — optimized for speed
router.post('/', requireAuth, async (req, res) => {
  const { token } = req.body;

  if (!token) return res.status(400).json({ error: 'QR token is required' });

  // Decode signed token
  try {
    verifyQrToken(token);
  } catch (err) {
    return res.json({ status: 'invalid', message: 'Código QR inválido' });
  }

  // Single query: get guest + event in one shot
  const { data: guest, error } = await supabase
    .from('guests')
    .select('id, name, email, notes, tier, checked_in, checked_in_at, event_id')
    .eq('qr_token', token)
    .single();

  if (error || !guest) {
    return res.json({ status: 'invalid', message: 'Acceso no encontrado' });
  }

  // Parallel: check event access + (if not already checked in) prepare for check-in
  const [eventResult, staffResult] = await Promise.all([
    supabase.from('events').select('id, name, owner_id').eq('id', guest.event_id).single(),
    supabase.from('event_staff').select('role').eq('event_id', guest.event_id).eq('user_id', req.user.id).not('accepted_at', 'is', null).single(),
  ]);

  const event = eventResult.data;
  if (!event) return res.json({ status: 'invalid', message: 'Evento no encontrado' });

  const isOwner = event.owner_id === req.user.id;
  const isStaff = !!staffResult.data;
  if (!isOwner && !isStaff) {
    return res.status(403).json({ error: 'No tienes acceso a este evento' });
  }

  // Already checked in?
  if (guest.checked_in) {
    return res.json({
      status: 'already_checked_in',
      message: 'Ya registrado',
      guest: { name: guest.name, tier: guest.tier, notes: guest.notes, checked_in_at: guest.checked_in_at },
    });
  }

  // Check in + get counts in parallel
  const [updateResult, totalResult, checkedResult] = await Promise.all([
    supabase.from('guests').update({
      checked_in: true,
      checked_in_at: new Date().toISOString(),
      checked_in_by: req.user.id,
    }).eq('id', guest.id),
    supabase.from('guests').select('*', { count: 'exact', head: true }).eq('event_id', event.id),
    supabase.from('guests').select('*', { count: 'exact', head: true }).eq('event_id', event.id).eq('checked_in', true),
  ]);

  if (updateResult.error) {
    return res.status(500).json({ error: 'Error al registrar entrada' });
  }

  res.json({
    status: 'success',
    message: '¡Acceso confirmado!',
    guest: { name: guest.name, tier: guest.tier, notes: guest.notes },
    event: { name: event.name },
    stats: {
      checked_in: (checkedResult.count || 0) + 1, // +1 because the count query may race with update
      total: totalResult.count || 0,
    },
  });
});

// Manual check-in by guest ID (no QR needed)
router.post('/manual', requireAuth, async (req, res) => {
  const { guest_id } = req.body;
  if (!guest_id) return res.status(400).json({ error: 'guest_id is required' });

  const { data: guest, error: gErr } = await supabase
    .from('guests')
    .select('id, name, notes, checked_in, event_id')
    .eq('id', guest_id)
    .single();

  if (gErr || !guest) return res.status(404).json({ error: 'Guest not found' });

  // Verify access
  const [eventResult, staffResult] = await Promise.all([
    supabase.from('events').select('id, owner_id').eq('id', guest.event_id).single(),
    supabase.from('event_staff').select('role').eq('event_id', guest.event_id).eq('user_id', req.user.id).not('accepted_at', 'is', null).single(),
  ]);

  const event = eventResult.data;
  if (!event) return res.status(404).json({ error: 'Event not found' });

  const isOwner = event.owner_id === req.user.id;
  const isStaff = !!staffResult.data;
  if (!isOwner && !isStaff) {
    return res.status(403).json({ error: 'No access' });
  }

  if (guest.checked_in) {
    return res.json({ status: 'already_checked_in', message: 'Ya registrado' });
  }

  const { error: uErr } = await supabase
    .from('guests')
    .update({
      checked_in: true,
      checked_in_at: new Date().toISOString(),
      checked_in_by: req.user.id,
    })
    .eq('id', guest.id);

  if (uErr) return res.status(500).json({ error: 'Check-in failed' });

  res.json({ status: 'success', message: '¡Entrada registrada!', guest: { name: guest.name } });
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

module.exports = router;
