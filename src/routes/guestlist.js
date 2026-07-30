const { Router } = require('express');
const { supabase } = require('../lib/supabase');
const { requireAuth, requireEventAccess } = require('../middleware/auth');
const { createQrToken, generateQrBuffer } = require('../services/qr');
const { sendGuestQrEmail } = require('../services/email');
const { loadClaimEvent, sendInvite, sendInviteBulk } = require('../services/claim');
const { normalizeNfcId } = require('../lib/nfc');
const JSZip = require('jszip');

const router = Router({ mergeParams: true });

/**
 * Guard: on an event running the two-step claim flow, the direct-QR paths
 * would mail the codes immediately and skip the confirm step entirely —
 * silently breaking the whole mechanic (and, at 2000 recipients, unfixably).
 * Returns true when the caller must NOT use the direct path.
 */
async function claimFlowActive(eventId) {
  const { data } = await supabase
    .from('events').select('claim_flow').eq('id', eventId).single();
  return !!(data && data.claim_flow && data.claim_flow.enabled !== false);
}

const CLAIM_GUARD_MSG =
  'Este evento usa el flujo de confirmación en dos pasos. Usa "Enviar invitaciones" ' +
  '(el QR se manda solo cuando el invitado confirma), no el envío directo de QR.';

// List guests (owner or staff)
router.get('/', requireAuth, requireEventAccess(['owner', 'staff', 'door']), async (req, res) => {
  const { search, status } = req.query;

  let query = supabase
    .from('guests')
    .select('id, name, email, phone, notes, tier, checked_in, checked_in_at, email_sent, created_at, added_by, group_id, requested_by, industry, nfc_id')
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
  const { name, email, phone, notes, tier, send_email, plus, requested_by, industry, nfc_id } = req.body;
  const plusN = Math.min(parseInt(plus) || 0, 50);

  if (!name) return res.status(400).json({ error: 'Guest name is required' });

  // NFC UID is optional. Normalize on write so the door lookup (which also
  // normalizes the reader output) matches reliably. Only set on the primary
  // guest — +N extras share a group_id but each access pass is its own row,
  // and the demo card maps to one named guest, not a whole group.
  const normalizedNfc = nfc_id ? normalizeNfcId(nfc_id) : null;

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
      requested_by: requested_by || null,
      industry: industry || null,
      nfc_id: normalizedNfc || null,
      added_by: req.user.id,
      qr_token: createQrToken(undefined, req.event.id),
      group_id: groupId,
      is_group_primary: true, // owns the +N group; delete cascades to its extras
    })
    .select()
    .single();

  if (error) {
    // Surface a clean message if the per-event UID uniqueness constraint
    // rejected this insert — common cause is reusing a demo card.
    if (error.code === '23505' && /guests_event_nfc_id_unique/.test(error.message || '')) {
      return res.status(409).json({ error: 'Esa tarjeta NFC ya está asignada a otro invitado en este evento.' });
    }
    return res.status(500).json({ error: error.message });
  }

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
      requested_by: requested_by || null,
      industry: industry || null,
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

  // Send email with ALL QR codes (primary + extras).
  // Suppressed on claim-flow events — the QRs only go out after the guest
  // confirms, so mailing them here would bypass the mechanic.
  const claimActive = await claimFlowActive(req.event.id);
  if (send_email && guest.email && claimActive) {
    guest.claim_flow_notice = CLAIM_GUARD_MSG;
  } else if (send_email && guest.email) {
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

  const { randomUUID } = require('crypto');

  // Row IDs are generated HERE rather than by the database, so qr_token can be
  // signed before the insert. The old flow inserted first and then issued one
  // UPDATE per row to backfill the token — at 500 guests with +1 that was 1000
  // sequential round trips per batch, minutes of wall clock, and a timeout.
  const allRows = [];

  for (let i = 0; i < guestList.length; i++) {
    const g = guestList[i];
    const plusN = Math.min(parseInt(g.plus) || 0, 50);
    const groupId = plusN > 0 ? randomUUID() : null;

    const primaryId = randomUUID();
    allRows.push({
      id: primaryId,
      event_id: req.event.id,
      name: g.name,
      email: g.email || null,
      phone: g.phone || null,
      notes: g.notes || null,
      tier: g.tier || null,
      added_by: req.user.id,
      qr_token: createQrToken(primaryId, req.event.id),
      group_id: groupId,
      is_group_primary: true, // owns the +N group; delete cascades to its extras
    });

    for (let j = 1; j <= plusN; j++) {
      const extraId = randomUUID();
      allRows.push({
        id: extraId,
        event_id: req.event.id,
        name: `${g.name} (+${j})`,
        email: null,
        phone: null,
        notes: `Acceso extra de ${g.name}`,
        tier: g.tier || null,
        added_by: req.user.id,
        qr_token: createQrToken(extraId, req.event.id),
        group_id: groupId,
        // Must be set explicitly, not left to the column default: primaries and
        // extras go in as ONE insert, and PostgREST fills a key that's missing
        // from some rows with NULL rather than the default — which trips the
        // NOT NULL constraint and fails the whole batch.
        is_group_primary: false,
      });
    }
  }

  const { data: inserted, error } = await supabase
    .from('guests')
    .insert(allRows)
    .select('id, name, email, tier, group_id, qr_token, short_code');

  if (error) return res.status(500).json({ error: error.message });

  // Direct-QR sending is meaningless on a claim-flow event — the codes are
  // issued on confirmation, not at import. Report it instead of silently
  // mailing 2000 people their QRs and skipping the mechanic.
  if (send_emails && await claimFlowActive(req.event.id)) {
    return res.status(201).json({
      added: inserted.length,
      emails_sent: 0,
      notice: CLAIM_GUARD_MSG,
    });
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
  const { name, email, phone, notes, nfc_id } = req.body;

  // nfc_id semantics on PUT: undefined = leave alone, '' or null = clear,
  // otherwise = normalize and set.
  let nfcUpdate = {};
  if (nfc_id !== undefined) {
    const trimmed = String(nfc_id || '').trim();
    nfcUpdate = { nfc_id: trimmed ? normalizeNfcId(trimmed) : null };
  }

  const { data, error } = await supabase
    .from('guests')
    .update({
      ...(name !== undefined && { name }),
      ...(email !== undefined && { email }),
      ...(phone !== undefined && { phone }),
      ...(notes !== undefined && { notes }),
      ...nfcUpdate,
    })
    .eq('id', req.params.guestId)
    .eq('event_id', req.event.id)
    .select()
    .single();

  if (error) {
    if (error.code === '23505' && /guests_event_nfc_id_unique/.test(error.message || '')) {
      return res.status(409).json({ error: 'Esa tarjeta NFC ya está asignada a otro invitado en este evento.' });
    }
    return res.status(500).json({ error: error.message });
  }
  if (!data) return res.status(404).json({ error: 'Guest not found' });
  res.json(data);
});

// Delete guest (owner or staff)
// Deleting the primary of a +N group also removes its extras — enforced by the
// guests_cascade_group_delete trigger, so it holds for every delete path, not
// just this one. Counted here only so the UI can say how many passes went.
router.delete('/:guestId', requireAuth, requireEventAccess(['owner', 'staff']), async (req, res) => {
  const { data: target } = await supabase
    .from('guests')
    .select('id, group_id, is_group_primary')
    .eq('id', req.params.guestId)
    .eq('event_id', req.event.id)
    .maybeSingle();

  if (!target) return res.status(404).json({ error: 'Guest not found' });

  let removed = 1;
  if (target.group_id && target.is_group_primary) {
    const { count } = await supabase
      .from('guests')
      .select('id', { count: 'exact', head: true })
      .eq('group_id', target.group_id);
    removed = count || 1;
  }

  const { error } = await supabase
    .from('guests')
    .delete()
    .eq('id', req.params.guestId)
    .eq('event_id', req.event.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, removed });
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
  if (await claimFlowActive(req.event.id)) return res.status(422).json({ error: CLAIM_GUARD_MSG });

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
  if (await claimFlowActive(req.event.id)) return res.status(422).json({ error: CLAIM_GUARD_MSG });

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

// --- Two-step claim flow: send mail 1 ("fuiste seleccionado") -------------
// The QR mail is NOT sent here; it fires when the guest clicks the link.

// Send/re-send the confirm invite to one guest. Re-sending rotates the token,
// which kills any older link and restarts the TTL window — this is also the
// "reactivate an expired invite" path.
router.post('/:guestId/send-claim', requireAuth, requireEventAccess(['owner', 'staff']), async (req, res) => {
  const { data: guest, error: gErr } = await supabase
    .from('guests')
    .select('*')
    .eq('id', req.params.guestId)
    .eq('event_id', req.event.id)
    .single();

  if (gErr || !guest) return res.status(404).json({ error: 'Guest not found' });
  if (!guest.email) return res.status(400).json({ error: 'Guest has no email address' });

  try {
    const { event, cfg } = await loadClaimEvent(req.event.id);
    const out = await sendInvite({ guest, event, cfg });
    res.json({ success: true, expires_at: out.expires_at });
  } catch (e) {
    if (e.code === 'CLAIM_DISABLED') return res.status(422).json({ error: e.message });
    res.status(500).json({ error: 'Failed to send invite: ' + e.message });
  }
});

// Send the confirm invite to everyone who hasn't had one yet.
// Only primaries (a guest with an email); +N extras ride along on mail 2.
// `?resend=all` re-sends to everyone who still hasn't confirmed.
router.post('/send-claim-all', requireAuth, requireEventAccess(['owner', 'staff']), async (req, res) => {
  let event, cfg;
  try {
    ({ event, cfg } = await loadClaimEvent(req.event.id));
  } catch (e) {
    return res.status(422).json({ error: e.message });
  }

  const resendAll = req.query.resend === 'all' || req.body?.resend === 'all';

  // Page through — Supabase caps a single select at 1000 rows, and this list
  // is expected to be a couple of thousand.
  const guests = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let q = supabase
      .from('guests')
      .select('id, name, email, group_id')
      .eq('event_id', req.event.id)
      .not('email', 'is', null)
      .is('claimed_at', null)
      .order('created_at', { ascending: true })
      .range(from, from + PAGE - 1);

    if (!resendAll) q = q.is('claim_sent_at', null);

    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    guests.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }

  if (guests.length === 0) {
    return res.json({ sent: 0, failed: 0, total: 0, message: 'No hay invitados pendientes de enviar' });
  }

  try {
    const result = await sendInviteBulk({ guests, event, cfg });
    res.json({
      sent: result.sent,
      failed: result.failed,
      total: guests.length,
      expires_at: result.expires_at,
      failures: result.failures.slice(0, 25),
    });
  } catch (e) {
    console.error('send-claim-all failed:', e.message);
    res.status(500).json({ error: 'Failed to send invites: ' + e.message });
  }
});

// Claim-flow progress for the dashboard.
router.get('/claim-status', requireAuth, requireEventAccess(['owner', 'staff', 'door']), async (req, res) => {
  const { data, error } = await supabase
    .from('guests')
    .select('id, name, email, claim_sent_at, claim_expires_at, claimed_at, group_id')
    .eq('event_id', req.event.id)
    .not('email', 'is', null);

  if (error) return res.status(500).json({ error: error.message });

  const now = Date.now();
  const rows = data || [];
  const stats = {
    total: rows.length,
    invited: rows.filter(g => g.claim_sent_at).length,
    confirmed: rows.filter(g => g.claimed_at).length,
    pending: rows.filter(g => g.claim_sent_at && !g.claimed_at && (!g.claim_expires_at || new Date(g.claim_expires_at).getTime() > now)).length,
    expired: rows.filter(g => g.claim_sent_at && !g.claimed_at && g.claim_expires_at && new Date(g.claim_expires_at).getTime() <= now).length,
    not_invited: rows.filter(g => !g.claim_sent_at).length,
  };

  res.json({ stats, guests: rows });
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
    const buffer = await generateQrBuffer(g.short_code || g.qr_token);
    const fileName = i === 0
      ? `${safeName}-1.png`
      : `${safeName}-${i + 1}.png`;
    zip.file(fileName, buffer);
  }

  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });

  supabase.from('guest_activity').insert({
    event_id: req.event.id, guest_id: req.params.guestId, action: 'download_batch', source: 'guestlist', actor_id: req.user.id,
  }).then(() => {}, () => {});

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
    const buffer = await generateQrBuffer(g.short_code || g.qr_token);
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

// Log a per-guest activity event (download, etc.) — fire-and-forget from the UI.
router.post('/:guestId/activity', requireAuth, requireEventAccess(['owner', 'staff']), async (req, res) => {
  const { action, source } = req.body;
  if (!action) return res.status(400).json({ error: 'action is required' });
  const { error } = await supabase.from('guest_activity').insert({
    event_id: req.event.id,
    guest_id: req.params.guestId,
    action,
    source: source || null,
    actor_id: req.user.id,
  });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

module.exports = router;
