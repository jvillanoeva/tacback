const { Router } = require('express');
const { supabase } = require('../lib/supabase');
const { requireAuth } = require('../middleware/auth');
const { verifyQrToken } = require('../services/qr');

const router = Router();

// Verify QR and check in guest
router.post('/', requireAuth, async (req, res) => {
  const { token } = req.body;

  if (!token) return res.status(400).json({ error: 'QR token is required' });

  // Decode signed token
  let decoded;
  try {
    decoded = verifyQrToken(token);
  } catch (err) {
    return res.json({
      status: 'invalid',
      message: 'Código QR inválido',
    });
  }

  // Look up guest by token
  const { data: guest, error } = await supabase
    .from('guests')
    .select('id, name, email, notes, checked_in, checked_in_at, event_id')
    .eq('qr_token', token)
    .single();

  if (error || !guest) {
    return res.json({
      status: 'invalid',
      message: 'Acceso no encontrado',
    });
  }

  // Verify user has access to this event (owner, staff, or door)
  const { data: event } = await supabase
    .from('events')
    .select('id, name, owner_id')
    .eq('id', guest.event_id)
    .single();

  if (!event) {
    return res.json({ status: 'invalid', message: 'Evento no encontrado' });
  }

  const isOwner = event.owner_id === req.user.id;
  let isStaff = false;
  if (!isOwner) {
    const { data: staff } = await supabase
      .from('event_staff')
      .select('role')
      .eq('event_id', event.id)
      .eq('user_id', req.user.id)
      .not('accepted_at', 'is', null)
      .single();
    isStaff = !!staff;
  }

  if (!isOwner && !isStaff) {
    return res.status(403).json({ error: 'No tienes acceso a este evento' });
  }

  // Already checked in?
  if (guest.checked_in) {
    return res.json({
      status: 'already_checked_in',
      message: 'Ya registrado',
      guest: {
        name: guest.name,
        notes: guest.notes,
        checked_in_at: guest.checked_in_at,
      },
    });
  }

  // Check in
  const { error: updateErr } = await supabase
    .from('guests')
    .update({
      checked_in: true,
      checked_in_at: new Date().toISOString(),
      checked_in_by: req.user.id,
    })
    .eq('id', guest.id);

  if (updateErr) {
    return res.status(500).json({ error: 'Error al registrar entrada' });
  }

  // Get updated counts
  const { count: totalGuests } = await supabase
    .from('guests')
    .select('*', { count: 'exact', head: true })
    .eq('event_id', event.id);

  const { count: checkedInCount } = await supabase
    .from('guests')
    .select('*', { count: 'exact', head: true })
    .eq('event_id', event.id)
    .eq('checked_in', true);

  res.json({
    status: 'success',
    message: '¡Acceso confirmado!',
    guest: {
      name: guest.name,
      notes: guest.notes,
    },
    event: { name: event.name },
    stats: {
      checked_in: checkedInCount,
      total: totalGuests,
    },
  });
});

module.exports = router;
