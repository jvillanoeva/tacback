const { Router } = require('express');
const crypto = require('crypto');
const multer = require('multer');
const { supabase } = require('../lib/supabase');
const { createQrToken } = require('../services/qr');
const { sendGuestQrEmail } = require('../services/email');
const { sendUndistributedForEvent } = require('../services/undistributed');
const { duplicateEvent } = require('../services/duplicate');

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
 * GET /api/internal/events
 *
 * Service-auth event list so headless agents (clau) can resolve "the Sunday
 * event" to a real id/slug instead of guessing which event is active. Returns
 * the 20 most recent events, newest first.
 *
 * Optional query: ?q=<substring> — case-insensitive filter on slug or name
 * (e.g. ?q=sunday or ?q=05-07-26).
 */
router.get('/events', requireServiceAuth, async (req, res) => {
  let query = supabase
    .from('events')
    .select('id, slug, name, date, date_label, venue, city, published, created_at')
    .order('created_at', { ascending: false })
    .limit(20);

  const q = String(req.query.q || '').trim();
  if (q) {
    const like = `%${q.replace(/[%_]/g, '')}%`;
    query = query.or(`slug.ilike.${like},name.ilike.${like}`);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ events: data || [] });
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
 * Body: { event_id | event_slug, name, email?, tier?, added_by?, plus? }
 * Target the event by id OR by slug (slug wins for callers that resolve events
 * via GET /api/internal/events — safer than guessing an id).
 * Returns 201 { ok, guest_id, email_sent, email_error } on insert.
 * Returns 409 if a guest with the same (event_id, email) already exists — the
 * caller treats this as "skipped".
 */
router.post('/guests', requireServiceAuth, async (req, res) => {
  const body = req.body || {};
  const event_slug = body.event_slug ? String(body.event_slug).trim() : null;
  const name = (body.name || '').trim();
  const email = body.email ? String(body.email).trim() : null;
  const tier = body.tier || null;
  const added_by = body.added_by || null;
  const plus = Math.min(parseInt(body.plus, 10) || 0, 50);   // +N companion passes

  if ((!body.event_id && !event_slug) || !name) {
    return res.status(400).json({ error: 'name and event_id or event_slug are required' });
  }

  // Resolve the event by slug or id (need its fields for the email template).
  const { data: event, error: evErr } = await supabase
    .from('events')
    .select('id, name, subtitle, date_label, time_label, venue, city, banner_url, logo_url, brand_color, promoter_name, email_instructions_es, email_instructions_en')
    .eq(event_slug ? 'slug' : 'id', event_slug || body.event_id)
    .single();
  if (evErr || !event) return res.status(404).json({ error: 'Event not found' });
  const event_id = event.id;

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

  // +N companions share a group_id with the primary — each is its own access
  // pass (own QR), but only the primary carries the email, so all the QRs ship in
  // a single email (no duplicate-email conflict for the companions).
  const groupId = plus > 0 ? crypto.randomUUID() : null;

  // Insert primary with a placeholder token, then set the real token bound to the id.
  const { data: guest, error: insErr } = await supabase
    .from('guests')
    .insert({
      event_id,
      name,
      email,
      tier,
      added_by,
      group_id: groupId,
      is_group_primary: true, // owns the +N group; delete cascades to its extras
      qr_token: createQrToken(undefined, event_id),
    })
    .select()
    .single();
  if (insErr) return res.status(500).json({ error: insErr.message });

  const finalToken = createQrToken(guest.id, event_id);
  await supabase.from('guests').update({ qr_token: finalToken }).eq('id', guest.id);
  guest.qr_token = finalToken;

  // Insert the +N companion passes (no email; same group_id).
  let extras = [];
  if (plus > 0) {
    const rows = [];
    for (let i = 1; i <= plus; i++) {
      rows.push({
        event_id,
        name: `${name} (+${i})`,
        email: null,
        tier,
        added_by,
        group_id: groupId,
        qr_token: createQrToken(`extra-${i}-${Date.now()}`, event_id),
      });
    }
    const { data: extData, error: extErr } = await supabase.from('guests').insert(rows).select();
    if (extErr) {
      console.error('[internal/guests] extras insert failed:', extErr.message);
    } else {
      extras = extData || [];
      for (const ext of extras) {
        const t = createQrToken(ext.id, event_id);
        await supabase.from('guests').update({ qr_token: t }).eq('id', ext.id);
        ext.qr_token = t;
      }
    }
  }

  // Send one email to the primary with all QRs (primary + companions).
  let email_sent = false;
  let email_error = null;
  if (email) {
    try {
      await sendGuestQrEmail({ guest, event, extraGuests: extras });
      await supabase.from('guests').update({ email_sent: true }).eq('id', guest.id);
      email_sent = true;
    } catch (e) {
      email_error = e.message;
      console.error(`[internal/guests] email failed for ${email}:`, e.message);
    }
  }

  res.status(201).json({
    ok: true,
    guest_id: guest.id,
    group_id: groupId,
    qr_count: 1 + extras.length,
    email_sent,
    email_error,
  });
});

/**
 * GET /api/internal/events/:slug/stats
 *
 * Service-auth guest stats for one event, so headless agents (clau) can answer
 * "cuántos accesos llevamos" without dashboard access. Returns totals and a
 * per-tier breakdown (tier null groups as "none").
 *
 * Response: { event: {id, slug, name, date_label},
 *             total, checked_in, email_sent,
 *             by_tier: { RSVP: {total, checked_in}, GA: {...}, ... } }
 */
router.get('/events/:slug/stats', requireServiceAuth, async (req, res) => {
  const { data: event, error: evErr } = await supabase
    .from('events')
    .select('id, slug, name, date_label')
    .eq('slug', req.params.slug)
    .single();
  if (evErr || !event) return res.status(404).json({ error: 'Event not found' });

  // Paginate past PostgREST's 1000-row default cap.
  const rows = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('guests')
      .select('tier, checked_in, email_sent')
      .eq('event_id', event.id)
      .range(from, from + PAGE - 1);
    if (error) return res.status(500).json({ error: error.message });
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }

  const by_tier = {};
  let checked_in = 0;
  let email_sent = 0;
  for (const g of rows) {
    const tier = g.tier || 'none';
    if (!by_tier[tier]) by_tier[tier] = { total: 0, checked_in: 0 };
    by_tier[tier].total++;
    if (g.checked_in) { by_tier[tier].checked_in++; checked_in++; }
    if (g.email_sent) email_sent++;
  }

  res.json({ event, total: rows.length, checked_in, email_sent, by_tier });
});

/**
 * POST /api/internal/events/:slug/duplicate
 *
 * Headless counterpart to POST /api/events/:slug/duplicate — lets clau clone
 * an event's settings onto a new date from WhatsApp. Same shared logic
 * (services/duplicate.js): copies settings only, never guests/staff/links/
 * door_token, and the copy ALWAYS starts unpublished. The new event's owner
 * is the source event's owner.
 *
 * Body: { date: "YYYY-MM-DD" (required), slug?, name? }
 */
router.post('/events/:slug/duplicate', requireServiceAuth, async (req, res) => {
  const { data: src, error: srcErr } = await supabase
    .from('events')
    .select('*')
    .eq('slug', req.params.slug)
    .single();
  if (srcErr || !src) return res.status(404).json({ error: 'Event not found' });

  const body = req.body || {};
  const result = await duplicateEvent(src, String(body.date || '').trim(), {
    slug: body.slug,
    name: body.name,
  });
  if (result.error) {
    return res.status(result.status).json({ error: result.error, slug: result.slug });
  }
  res.status(201).json(result.data);
});

// Flyer uploads: same constraints as the dashboard's /api/upload.
const BANNER_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const BANNER_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const bannerUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (BANNER_MIMES.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPEG, PNG, WebP, and GIF images are allowed'));
  },
});
function handleBannerUpload(req, res, next) {
  bannerUpload.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}

/**
 * POST /api/internal/events/:slug/banner
 *
 * Headless flyer upload: multipart form with an `image` field (≤5MB,
 * jpeg/png/webp/gif). Stores it in the event-images bucket and sets the
 * event's banner_url in one step. Returns { url, slug }.
 */
router.post('/events/:slug/banner', requireServiceAuth, handleBannerUpload, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image file provided (field: image)' });

  const { data: event, error: evErr } = await supabase
    .from('events')
    .select('id, slug')
    .eq('slug', req.params.slug)
    .single();
  if (evErr || !event) return res.status(404).json({ error: 'Event not found' });

  const ext = BANNER_EXT[req.file.mimetype] || 'bin';
  const hash = crypto.randomBytes(4).toString('hex');
  const filename = `internal/${event.slug}/${Date.now()}-${hash}.${ext}`;

  const { error: upErr } = await supabase.storage
    .from('event-images')
    .upload(filename, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
  if (upErr) return res.status(500).json({ error: 'Upload failed: ' + upErr.message });

  const { data: pub } = supabase.storage.from('event-images').getPublicUrl(filename);
  const url = pub.publicUrl;

  const { error: updErr } = await supabase
    .from('events')
    .update({ banner_url: url, updated_at: new Date().toISOString() })
    .eq('id', event.id);
  if (updErr) return res.status(500).json({ error: updErr.message });

  res.json({ url, slug: event.slug });
});

/**
 * POST /api/internal/events/:slug/publish
 *
 * Flip published on/off — nothing else. Deliberately NOT a general update
 * endpoint: the agent's write surface on events stays limited to
 * duplicate + banner + this switch.
 *
 * Body: { published: true|false } (defaults to true)
 * Refuses to publish an event that has no banner_url — the whole point of the
 * WhatsApp flow is that the flyer lands before the event goes live.
 */
router.post('/events/:slug/publish', requireServiceAuth, async (req, res) => {
  const published = req.body && req.body.published === false ? false : true;

  const { data: event, error: evErr } = await supabase
    .from('events')
    .select('id, slug, name, banner_url, published')
    .eq('slug', req.params.slug)
    .single();
  if (evErr || !event) return res.status(404).json({ error: 'Event not found' });

  if (published && !event.banner_url) {
    return res.status(422).json({ error: 'Event has no flyer (banner_url) — upload one before publishing' });
  }

  const { error } = await supabase
    .from('events')
    .update({ published, updated_at: new Date().toISOString() })
    .eq('id', event.id);
  if (error) return res.status(500).json({ error: error.message });

  res.json({ slug: event.slug, name: event.name, published });
});

/**
 * POST /api/internal/events/:slug/send-undistributed
 *
 * Headless counterpart to POST /api/events/:slug/invite-links/send-undistributed.
 * Emails each table's account manager the QRs they never handed out. Intended
 * for a scheduled trigger (e.g. event-day morning cron) carrying the service
 * token. Skips tables with no manager_email and tables already fully used, so
 * it's safe to run repeatedly.
 */
router.post('/events/:slug/send-undistributed', requireServiceAuth, async (req, res) => {
  const { data: event, error } = await supabase
    .from('events')
    .select('id, slug')
    .eq('slug', req.params.slug)
    .single();
  if (error || !event) return res.status(404).json({ error: 'Event not found' });

  try {
    const result = await sendUndistributedForEvent(event.id);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
