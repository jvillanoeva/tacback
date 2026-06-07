const { Router } = require('express');
const crypto = require('crypto');
const { supabase } = require('../lib/supabase');
const { createQrToken } = require('../services/qr');
const { sendGuestQrEmail } = require('../services/email');

const router = Router();

/**
 * Service-token auth for headless callers (e.g. clau on Lola).
 * Expects: Authorization: Bearer <SERVICE_AUTH_TOKEN>
 * This is intentionally distinct from requireAuth, which validates a Supabase
 * USER token. Headless agents don't have a user session — they carry a shared
 * service token kept in the server env and on the caller (never in git).
 *
 * Fails closed: if SERVICE_AUTH_TOKEN isn't configured, the route returns 503
 * rather than allowing access.
 */
function requireServiceAuth(req, res, next) {
  const expected = process.env.SERVICE_AUTH_TOKEN;
  if (!expected) {
    return res.status(503).json({ error: 'Service auth not configured' });
  }
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Invalid service token' });
  }
  next();
}

/**
 * POST /api/internal/events/:slug/send-qr-all
 *
 * Sends the QR email to every guest on the event that hasn't received it yet
 * (email_sent = false and email present). This is the headless counterpart to
 * the user-authed POST /api/events/:slug/guests/send-all — same send logic,
 * same per-group extra handling — so clau can flush QRs right after it inserts
 * guests, instead of a human clicking "Send All QRs" in the dashboard.
 *
 * Optional body: { "guest_ids": ["<uuid>", ...] } — restrict the send to these
 * guests (still only those that are pending). Omit to send ALL pending guests.
 *
 * Idempotent: guests already marked email_sent = true are never re-sent.
 */
router.post('/events/:slug/send-qr-all', requireServiceAuth, async (req, res) => {
  const { slug } = req.params;
  const guestIds = Array.isArray(req.body && req.body.guest_ids)
    ? req.body.guest_ids
    : null;

  // Resolve the event by slug.
  const { data: event, error: evErr } = await supabase
    .from('events')
    .select('id, name, subtitle, date_label, time_label, venue, city, banner_url, logo_url, brand_color, promoter_name, email_instructions_es, email_instructions_en')
    .eq('slug', slug)
    .single();

  if (evErr || !event) return res.status(404).json({ error: 'Event not found' });

  // Guests still pending a QR (email present, not yet sent).
  let pendingQuery = supabase
    .from('guests')
    .select('*')
    .eq('event_id', event.id)
    .eq('email_sent', false)
    .not('email', 'is', null);
  if (guestIds) pendingQuery = pendingQuery.in('id', guestIds);

  const { data: guests, error: gErr } = await pendingQuery;
  if (gErr) return res.status(500).json({ error: gErr.message });

  if (!guests || guests.length === 0) {
    return res.json({ sent: 0, total: 0, message: 'No guests pending a QR' });
  }

  // All guests on the event, for group-extra lookups (+N share a group_id).
  const { data: allEventGuests } = await supabase
    .from('guests')
    .select('*')
    .eq('event_id', event.id);

  let sent = 0;
  const failures = [];
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
      failures.push({ guest_id: guest.id, email: guest.email, error: e.message });
      console.error(`[internal/send-qr-all] failed for ${guest.email}:`, e.message);
    }
  }

  res.json({ sent, total: guests.length, failures });
});

/**
 * POST /api/internal/guests
 *
 * Headless single-guest create + (optional) QR email — the endpoint clau's
 * agent_service.py (`_tac_add_via_internal_api`) already calls. Creates one
 * guest with a signed QR token; if an email is present, sends the QR and marks
 * email_sent. This is what makes clau send the QR at creation time instead of a
 * human clicking "Send All QRs".
 *
 * Body: { event_id, name, email?, tier?, added_by? }
 * Returns 201 { ok, guest_id, email_sent, email_error } on insert.
 * Returns 409 if a guest with the same (event_id, email) already exists — the
 * caller treats this as "skipped".
 */
router.post('/guests', requireServiceAuth, async (req, res) => {
  const body = req.body || {};
  const event_id = body.event_id;
  const name = (body.name || '').trim();
  const email = body.email ? String(body.email).trim() : null;
  const tier = body.tier || null;
  const added_by = body.added_by || null;

  if (!event_id || !name) {
    return res.status(400).json({ error: 'event_id and name are required' });
  }

  // Resolve the event (need its fields for the email template).
  const { data: event, error: evErr } = await supabase
    .from('events')
    .select('id, name, subtitle, date_label, time_label, venue, city, banner_url, logo_url, brand_color, promoter_name, email_instructions_es, email_instructions_en')
    .eq('id', event_id)
    .single();
  if (evErr || !event) return res.status(404).json({ error: 'Event not found' });

  // Dedup by (event_id, email) — matches the caller's 409 = skip contract.
  if (email) {
    const { data: existing } = await supabase
      .from('guests')
      .select('id')
      .eq('event_id', event_id)
      .ilike('email', email)
      .limit(1);
    if (existing && existing.length > 0) {
      return res.status(409).json({ error: 'Guest with this email already exists', guest_id: existing[0].id });
    }
  }

  // Insert with a placeholder token, then set the real token bound to the row id
  // (mirrors the user-authed guestlist POST).
  const { data: guest, error: insErr } = await supabase
    .from('guests')
    .insert({
      event_id,
      name,
      email,
      tier,
      added_by,
      qr_token: createQrToken(undefined, event_id),
    })
    .select()
    .single();
  if (insErr) return res.status(500).json({ error: insErr.message });

  const finalToken = createQrToken(guest.id, event_id);
  await supabase.from('guests').update({ qr_token: finalToken }).eq('id', guest.id);
  guest.qr_token = finalToken;

  // Send the QR email if we have an address.
  let email_sent = false;
  let email_error = null;
  if (email) {
    try {
      await sendGuestQrEmail({ guest, event, extraGuests: [] });
      await supabase.from('guests').update({ email_sent: true }).eq('id', guest.id);
      email_sent = true;
    } catch (e) {
      email_error = e.message;
      console.error(`[internal/guests] email failed for ${email}:`, e.message);
    }
  }

  res.status(201).json({ ok: true, guest_id: guest.id, email_sent, email_error });
});

module.exports = router;
