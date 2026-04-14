const { Router } = require('express');
const crypto = require('crypto');
const { supabase } = require('../lib/supabase');
const { requireAuth, requireEventAccess } = require('../middleware/auth');
const { createQrToken } = require('../services/qr');
const { sendGuestQrEmail } = require('../services/email');

const router = Router({ mergeParams: true });

// --- Owner endpoints (manage invite links) ---

// List invite links for an event
router.get('/', requireAuth, requireEventAccess(['owner']), async (req, res) => {
  const { data, error } = await supabase
    .from('invite_links')
    .select('*')
    .eq('event_id', req.event.id)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// Create invite link
router.post('/', requireAuth, requireEventAccess(['owner']), async (req, res) => {
  const { label, tier, max_guests, auto_send_email } = req.body;

  if (!label) return res.status(400).json({ error: 'Label is required' });

  const token = crypto.randomBytes(16).toString('base64url');

  const { data, error } = await supabase
    .from('invite_links')
    .insert({
      event_id: req.event.id,
      token,
      label,
      tier: tier || null,
      max_guests: Math.min(parseInt(max_guests) || 20, 500),
      auto_send_email: auto_send_email !== false,
      created_by: req.user.id,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// Toggle active/inactive
router.patch('/:linkId', requireAuth, requireEventAccess(['owner']), async (req, res) => {
  const { active } = req.body;

  const { data, error } = await supabase
    .from('invite_links')
    .update({ active })
    .eq('id', req.params.linkId)
    .eq('event_id', req.event.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Delete invite link
router.delete('/:linkId', requireAuth, requireEventAccess(['owner']), async (req, res) => {
  const { error } = await supabase
    .from('invite_links')
    .delete()
    .eq('id', req.params.linkId)
    .eq('event_id', req.event.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// --- Public endpoints (no auth — token IS the access) ---

// Get invite link info (public)
router.get('/public/:token', async (req, res) => {
  const { data: link, error } = await supabase
    .from('invite_links')
    .select('id, event_id, label, tier, max_guests, used_count, active, auto_send_email')
    .eq('token', req.params.token)
    .single();

  if (error || !link) return res.status(404).json({ error: 'Invite link not found' });
  if (!link.active) return res.status(410).json({ error: 'This invite link has been deactivated' });

  // Get event info
  const { data: event } = await supabase
    .from('events')
    .select('name, slug, subtitle, date_label, time_label, venue, city, banner_url, logo_url, brand_color, tiers')
    .eq('id', link.event_id)
    .single();

  if (!event) return res.status(404).json({ error: 'Event not found' });

  res.json({
    link: {
      id: link.id,
      label: link.label,
      tier: link.tier,
      max_guests: link.max_guests,
      used_count: link.used_count,
      remaining: link.max_guests - link.used_count,
      auto_send_email: link.auto_send_email,
    },
    event,
  });
});

// Add guest via invite link (public, no auth) — supports +N extras
router.post('/public/:token/guest', async (req, res) => {
  const { name, email, plus } = req.body;
  const plusN = Math.min(parseInt(plus) || 0, 20);
  const totalQrs = 1 + plusN;

  if (!name) return res.status(400).json({ error: 'Guest name is required' });

  // Validate link
  const { data: link, error: linkErr } = await supabase
    .from('invite_links')
    .select('*')
    .eq('token', req.params.token)
    .single();

  if (linkErr || !link) return res.status(404).json({ error: 'Invite link not found' });
  if (!link.active) return res.status(410).json({ error: 'This invite link has been deactivated' });

  const remaining = link.max_guests - link.used_count;
  if (remaining <= 0) {
    return res.status(403).json({ error: 'No quedan invitaciones disponibles' });
  }
  if (totalQrs > remaining) {
    return res.status(403).json({ error: `Solo quedan ${remaining} QR${remaining > 1 ? 's' : ''} disponibles` });
  }

  // Generate group_id if there are extras
  const groupId = plusN > 0 ? require('crypto').randomUUID() : null;

  // Insert primary guest
  const { data: guest, error: guestErr } = await supabase
    .from('guests')
    .insert({
      event_id: link.event_id,
      name,
      email: email || null,
      tier: link.tier || null,
      added_by: link.created_by,
      invite_link_id: link.id,
      qr_token: createQrToken('placeholder', link.event_id),
      group_id: groupId,
    })
    .select()
    .single();

  if (guestErr) return res.status(500).json({ error: guestErr.message });

  // Update QR token with real guest ID
  const finalToken = createQrToken(guest.id, link.event_id);
  await supabase
    .from('guests')
    .update({ qr_token: finalToken })
    .eq('id', guest.id);
  guest.qr_token = finalToken;

  // Insert +N extras with same group_id
  const insertedExtras = [];
  if (plusN > 0) {
    const extras = [];
    for (let i = 1; i <= plusN; i++) {
      extras.push({
        event_id: link.event_id,
        name: `${name} (+${i})`,
        email: null,
        tier: link.tier || null,
        added_by: link.created_by,
        invite_link_id: link.id,
        qr_token: createQrToken(`extra-${i}-${Date.now()}`, link.event_id),
        group_id: groupId,
      });
    }

    const { data: extData, error: extErr } = await supabase
      .from('guests')
      .insert(extras)
      .select();

    if (!extErr && extData) {
      for (const ext of extData) {
        const extToken = createQrToken(ext.id, link.event_id);
        await supabase.from('guests').update({ qr_token: extToken }).eq('id', ext.id);
        ext.qr_token = extToken;
        insertedExtras.push(ext);
      }
    }
  }

  // Increment used_count by total QRs used
  await supabase
    .from('invite_links')
    .update({ used_count: link.used_count + totalQrs })
    .eq('id', link.id);

  // Send QR email if configured and guest has email
  if (link.auto_send_email && guest.email) {
    try {
      const { data: event } = await supabase
        .from('events')
        .select('name, subtitle, date_label, time_label, venue, city, banner_url, logo_url, brand_color, promoter_name, email_instructions_es, email_instructions_en')
        .eq('id', link.event_id)
        .single();

      await sendGuestQrEmail({ guest, event, extraGuests: insertedExtras });
      await supabase
        .from('guests')
        .update({ email_sent: true })
        .eq('id', guest.id);
      guest.email_sent = true;
    } catch (e) {
      console.error('Invite link email failed:', e.message);
    }
  }

  const newRemaining = remaining - totalQrs;
  res.status(201).json({
    success: true,
    guest: { name: guest.name, email: guest.email, tier: guest.tier },
    totalQrs,
    remaining: newRemaining,
  });
});

module.exports = router;
