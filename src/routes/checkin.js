const { Router } = require('express');
const { supabase } = require('../lib/supabase');
const { requireAuth } = require('../middleware/auth');
const { verifyQrToken } = require('../services/qr');

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
    .select('id, name, email, notes, checked_in, checked_in_at, event_id')
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
      guest: { name: guest.name, notes: guest.notes, checked_in_at: guest.checked_in_at },
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
    guest: { name: guest.name, notes: guest.notes },
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

module.exports = router;
