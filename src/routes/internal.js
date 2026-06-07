const { Router } = require('express');
const crypto = require('crypto');
const { supabase } = require('../lib/supabase');
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

module.exports = router;
