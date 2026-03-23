const { Router } = require('express');
const { supabase } = require('../lib/supabase');
const { requireAuth, requireEventAccess } = require('../middleware/auth');
const { createQrToken } = require('../services/qr');
const { sendGuestQrEmail } = require('../services/email');

const router = Router({ mergeParams: true });

// List guests (owner or staff)
router.get('/', requireAuth, requireEventAccess(['owner', 'staff', 'door']), async (req, res) => {
  const { search, status } = req.query;

  let query = supabase
    .from('guests')
    .select('id, name, email, phone, notes, tier, checked_in, checked_in_at, email_sent, created_at, added_by')
    .eq('event_id', req.event.id)
    .order('created_at', { ascending: false });

  if (search) {
    query = query.or(`name.ilike.%${search}%,email.ilike.%${search}%`);
  }

  if (status === 'checked_in') query = query.eq('checked_in', true);
  if (status === 'pending') query = query.eq('checked_in', false);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  // Stats
  const total = data?.length || 0;
  const checkedIn = data?.filter(g => g.checked_in).length || 0;
  const emailsSent = data?.filter(g => g.email_sent).length || 0;

  res.json({
    guests: data || [],
    stats: { total, checked_in: checkedIn, emails_sent: emailsSent },
  });
});

// Add single guest (owner or staff)
router.post('/', requireAuth, requireEventAccess(['owner', 'staff']), async (req, res) => {
  const { name, email, phone, notes, tier, send_email } = req.body;

  if (!name) return res.status(400).json({ error: 'Guest name is required' });

  const qrToken = createQrToken(undefined, req.event.id);

  const { data: guest, error } = await supabase
    .from('guests')
    .insert({
      event_id: req.event.id,
      name,
      email: email || null,
      phone: phone || null,
      notes: notes || null,
      tier: tier || null,
      added_by: req.user.id,
      qr_token: qrToken,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // Update QR token with actual guest ID
  const finalToken = createQrToken(guest.id, req.event.id);
  await supabase
    .from('guests')
    .update({ qr_token: finalToken })
    .eq('id', guest.id);

  guest.qr_token = finalToken;

  // Send email if requested and email exists
  if (send_email && guest.email) {
    try {
      const { data: event } = await supabase
        .from('events')
        .select('name, subtitle, date_label, time_label, venue, city, banner_url, logo_url, brand_color, promoter_name, email_instructions_es, email_instructions_en')
        .eq('id', req.event.id)
        .single();

      await sendGuestQrEmail({ guest, event });
      await supabase
        .from('guests')
        .update({ email_sent: true })
        .eq('id', guest.id);
      guest.email_sent = true;
    } catch (emailErr) {
      console.error('Email send failed:', emailErr.message);
      // Don't fail the whole request
    }
  }

  res.status(201).json(guest);
});

// Bulk add guests (owner or staff)
router.post('/bulk', requireAuth, requireEventAccess(['owner', 'staff']), async (req, res) => {
  const { guests: guestList, send_emails } = req.body;

  if (!Array.isArray(guestList) || guestList.length === 0) {
    return res.status(400).json({ error: 'Provide an array of guests' });
  }

  if (guestList.length > 500) {
    return res.status(400).json({ error: 'Maximum 500 guests per batch' });
  }

  const rows = guestList.map(g => ({
    event_id: req.event.id,
    name: g.name,
    email: g.email || null,
    phone: g.phone || null,
    notes: g.notes || null,
    tier: g.tier || null,
    added_by: req.user.id,
    qr_token: createQrToken(g.name + Date.now(), req.event.id), // temp token
  }));

  const { data: inserted, error } = await supabase
    .from('guests')
    .insert(rows)
    .select();

  if (error) return res.status(500).json({ error: error.message });

  // Update tokens with real guest IDs
  for (const guest of inserted) {
    const finalToken = createQrToken(guest.id, req.event.id);
    await supabase
      .from('guests')
      .update({ qr_token: finalToken })
      .eq('id', guest.id);
  }

  // Send emails if requested
  let emailsSent = 0;
  if (send_emails) {
    const { data: event } = await supabase
      .from('events')
      .select('name, subtitle, date_label, time_label, venue, city, banner_url, logo_url, brand_color, promoter_name, email_instructions_es, email_instructions_en')
      .eq('id', req.event.id)
      .single();

    for (const guest of inserted) {
      if (guest.email) {
        try {
          guest.qr_token = createQrToken(guest.id, req.event.id);
          await sendGuestQrEmail({ guest, event });
          await supabase
            .from('guests')
            .update({ email_sent: true })
            .eq('id', guest.id);
          emailsSent++;
        } catch (e) {
          console.error(`Email failed for ${guest.email}:`, e.message);
        }
      }
    }
  }

  res.status(201).json({
    added: inserted.length,
    emails_sent: emailsSent,
  });
});

// Update guest (owner or staff)
router.put('/:guestId', requireAuth, requireEventAccess(['owner', 'staff']), async (req, res) => {
  const { name, email, phone, notes } = req.body;

  const { data, error } = await supabase
    .from('guests')
    .update({
      ...(name !== undefined && { name }),
      ...(email !== undefined && { email }),
      ...(phone !== undefined && { phone }),
      ...(notes !== undefined && { notes }),
    })
    .eq('id', req.params.guestId)
    .eq('event_id', req.event.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Guest not found' });
  res.json(data);
});

// Delete guest (owner or staff)
router.delete('/:guestId', requireAuth, requireEventAccess(['owner', 'staff']), async (req, res) => {
  const { error } = await supabase
    .from('guests')
    .delete()
    .eq('id', req.params.guestId)
    .eq('event_id', req.event.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// Send/resend QR email to a guest
router.post('/:guestId/send-qr', requireAuth, requireEventAccess(['owner', 'staff']), async (req, res) => {
  const { data: guest, error: gErr } = await supabase
    .from('guests')
    .select('*')
    .eq('id', req.params.guestId)
    .eq('event_id', req.event.id)
    .single();

  if (gErr || !guest) return res.status(404).json({ error: 'Guest not found' });
  if (!guest.email) return res.status(400).json({ error: 'Guest has no email address' });

  const { data: event } = await supabase
    .from('events')
    .select('name, subtitle, date_label, time_label, venue, city, banner_url, logo_url, brand_color, promoter_name, email_instructions_es, email_instructions_en')
    .eq('id', req.event.id)
    .single();

  try {
    await sendGuestQrEmail({ guest, event });
    await supabase
      .from('guests')
      .update({ email_sent: true })
      .eq('id', guest.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to send email: ' + e.message });
  }
});

// Send QR to all guests who haven't received it
router.post('/send-all', requireAuth, requireEventAccess(['owner', 'staff']), async (req, res) => {
  const { data: guests } = await supabase
    .from('guests')
    .select('*')
    .eq('event_id', req.event.id)
    .eq('email_sent', false)
    .not('email', 'is', null);

  if (!guests || guests.length === 0) {
    return res.json({ sent: 0, message: 'All guests have already been sent their QR' });
  }

  const { data: event } = await supabase
    .from('events')
    .select('name, subtitle, date_label, time_label, venue, city, banner_url, logo_url, brand_color, promoter_name, email_instructions_es, email_instructions_en')
    .eq('id', req.event.id)
    .single();

  let sent = 0;
  for (const guest of guests) {
    try {
      await sendGuestQrEmail({ guest, event });
      await supabase
        .from('guests')
        .update({ email_sent: true })
        .eq('id', guest.id);
      sent++;
    } catch (e) {
      console.error(`Email failed for ${guest.email}:`, e.message);
    }
  }

  res.json({ sent, total: guests.length });
});

module.exports = router;
