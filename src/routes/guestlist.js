const { Router } = require('express');
const { supabase } = require('../lib/supabase');
const { requireAuth, requireEventAccess } = require('../middleware/auth');
const { createQrToken, generateQrBuffer } = require('../services/qr');
const { sendGuestQrEmail } = require('../services/email');
const JSZip = require('jszip');

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

// Add single guest (owner or staff) — supports +N extras
router.post('/', requireAuth, requireEventAccess(['owner', 'staff']), async (req, res) => {
  const { name, email, phone, notes, tier, send_email, plus } = req.body;
  const plusN = Math.min(parseInt(plus) || 0, 50);

  if (!name) return res.status(400).json({ error: 'Guest name is required' });

  // Generate a group ID if there are extras
  const groupId = plusN > 0 ? require('crypto').randomUUID() : null;

  // Insert primary guest
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
      qr_token: createQrToken(undefined, req.event.id),
      group_id: groupId,
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

  // Insert +N extras with same group_id
  const extras = [];
  for (let i = 1; i <= plusN; i++) {
    const extraRow = {
      event_id: req.event.id,
      name: `${name} (+${i})`,
      email: null,
      phone: null,
      notes: `Acceso extra de ${name}`,
      tier: tier || null,
      added_by: req.user.id,
      qr_token: createQrToken(`extra-${i}-${Date.now()}`, req.event.id),
      group_id: groupId,
    };
    extras.push(extraRow);
  }

  let insertedExtras = [];
  if (extras.length > 0) {
    const { data: extData, error: extErr } = await supabase
      .from('guests')
      .insert(extras)
      .select();

    if (extErr) {
      console.error('Error inserting extras:', extErr.message);
    } else {
      insertedExtras = extData;
      // Update QR tokens with real IDs
      for (const ext of insertedExtras) {
        const extToken = createQrToken(ext.id, req.event.id);
        await supabase.from('guests').update({ qr_token: extToken }).eq('id', ext.id);
        ext.qr_token = extToken;
      }
    }
  }

  // Send email with ALL QR codes (primary + extras)
  if (send_email && guest.email) {
    try {
      const { data: event } = await supabase
        .from('events')
        .select('name, subtitle, date_label, time_label, venue, city, banner_url, logo_url, brand_color, promoter_name, email_instructions_es, email_instructions_en')
        .eq('id', req.event.id)
        .single();

      const allGuests = [guest, ...insertedExtras];
      await sendGuestQrEmail({ guest, event, extraGuests: insertedExtras });
      await supabase
        .from('guests')
        .update({ email_sent: true })
        .eq('id', guest.id);
      guest.email_sent = true;
    } catch (emailErr) {
      console.error('Email send failed:', emailErr.message);
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

  // Build all rows including +N extras
  const allRows = [];
  const groupMap = []; // track which primary index maps to which extras

  for (let i = 0; i < guestList.length; i++) {
    const g = guestList[i];
    const plusN = Math.min(parseInt(g.plus) || 0, 50);
    const groupId = plusN > 0 ? require('crypto').randomUUID() : null;

    allRows.push({
      event_id: req.event.id,
      name: g.name,
      email: g.email || null,
      phone: g.phone || null,
      notes: g.notes || null,
      tier: g.tier || null,
      added_by: req.user.id,
      qr_token: createQrToken(g.name + Date.now() + i, req.event.id),
      group_id: groupId,
      _isPrimary: true,
      _groupId: groupId,
    });

    for (let j = 1; j <= plusN; j++) {
      allRows.push({
        event_id: req.event.id,
        name: `${g.name} (+${j})`,
        email: null,
        phone: null,
        notes: `Acceso extra de ${g.name}`,
        tier: g.tier || null,
        added_by: req.user.id,
        qr_token: createQrToken(`extra-${i}-${j}-${Date.now()}`, req.event.id),
        group_id: groupId,
        _isPrimary: false,
        _groupId: groupId,
      });
    }
  }

  // Strip internal fields before insert
  const dbRows = allRows.map(({ _isPrimary, _groupId, ...row }) => row);

  const { data: inserted, error } = await supabase
    .from('guests')
    .insert(dbRows)
    .select();

  if (error) return res.status(500).json({ error: error.message });

  // Update tokens with real guest IDs
  for (const guest of inserted) {
    const finalToken = createQrToken(guest.id, req.event.id);
    await supabase
      .from('guests')
      .update({ qr_token: finalToken })
      .eq('id', guest.id);
    guest.qr_token = finalToken;
  }

  // Send emails if requested — group extras with their primary
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
          // Find extras in same group
          const extraGuests = guest.group_id
            ? inserted.filter(g => g.group_id === guest.group_id && g.id !== guest.id)
            : [];

          await sendGuestQrEmail({ guest, event, extraGuests });
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
    // Find extras in same group
    let extraGuests = [];
    if (guest.group_id) {
      const { data: extras } = await supabase
        .from('guests')
        .select('*')
        .eq('group_id', guest.group_id)
        .neq('id', guest.id);
      extraGuests = extras || [];
    }

    await sendGuestQrEmail({ guest, event, extraGuests });
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

  // Fetch all guests for group lookups
  const { data: allEventGuests } = await supabase
    .from('guests')
    .select('*')
    .eq('event_id', req.event.id);

  const { data: event } = await supabase
    .from('events')
    .select('name, subtitle, date_label, time_label, venue, city, banner_url, logo_url, brand_color, promoter_name, email_instructions_es, email_instructions_en')
    .eq('id', req.event.id)
    .single();

  let sent = 0;
  for (const guest of guests) {
    try {
      const extraGuests = guest.group_id
        ? (allEventGuests || []).filter(g => g.group_id === guest.group_id && g.id !== guest.id)
        : [];

      await sendGuestQrEmail({ guest, event, extraGuests });
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

// Download a ZIP of all QR PNGs for a guest (and their group extras if any)
router.get('/:guestId/qrs.zip', requireAuth, requireEventAccess(['owner', 'staff']), async (req, res) => {
  const { data: guest, error: gErr } = await supabase
    .from('guests')
    .select('*')
    .eq('id', req.params.guestId)
    .eq('event_id', req.event.id)
    .single();

  if (gErr || !guest) return res.status(404).json({ error: 'Guest not found' });

  // Collect primary + extras (if grouped)
  let allGuests = [guest];
  if (guest.group_id) {
    const { data: extras } = await supabase
      .from('guests')
      .select('*')
      .eq('group_id', guest.group_id)
      .neq('id', guest.id);
    if (extras) allGuests = [guest, ...extras];
  }

  const zip = new JSZip();
  const safeName = (guest.name || 'guest').replace(/[^a-z0-9]+/gi, '-').toLowerCase();

  for (let i = 0; i < allGuests.length; i++) {
    const g = allGuests[i];
    const buffer = await generateQrBuffer(g.qr_token);
    const fileName = i === 0
      ? `${safeName}-1.png`
      : `${safeName}-${i + 1}.png`;
    zip.file(fileName, buffer);
  }

  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}-qrs.zip"`);
  res.send(zipBuffer);
});

// Download a ZIP of ALL QRs for the event
router.get('/qrs.zip', requireAuth, requireEventAccess(['owner', 'staff']), async (req, res) => {
  const { data: guests, error } = await supabase
    .from('guests')
    .select('*')
    .eq('event_id', req.event.id)
    .order('created_at', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  if (!guests || guests.length === 0) {
    return res.status(404).json({ error: 'No guests found' });
  }

  const zip = new JSZip();

  for (const g of guests) {
    const buffer = await generateQrBuffer(g.qr_token);
    const safeName = (g.name || 'guest').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    const tier = g.tier ? `${g.tier.toLowerCase()}-` : '';
    zip.file(`${tier}${safeName}-${g.id.slice(0, 8)}.png`, buffer);
  }

  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
  const eventSlug = req.params.slug;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${eventSlug}-qrs.zip"`);
  res.send(zipBuffer);
});

module.exports = router;
