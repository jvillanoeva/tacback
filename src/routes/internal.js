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
 * Body: { event_id | event_slug, name, email?, tier?, added_by?, plus?,
 *         requested_by?, industry?, phone?, notes? }
 * Target the event by id OR by slug (slug wins for callers that resolve events
 * via GET /api/internal/events — safer than guessing an id).
 *
 * `requested_by` is the ORIGIN of the guest ("de dónde viene") — the PR agency,
 * the artist, the partner, the promoter's own name. Free text on purpose: we
 * want to see the shape of the real answers before freezing a picker. clau asks
 * for it once per batch and passes the same value on every guest in that batch.
 * It is what powers the per-origin breakdown in the night report, so a guest
 * added without it lands in "Sin origen" and is invisible to the PR count.
 *
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

  // Attribution + contact fields. Trimmed to empty-as-null so an agent sending
  // "" (the LLM's usual stand-in for "didn't ask") doesn't create a distinct
  // blank origin bucket alongside real NULLs.
  const clean = (v) => {
    const s = v == null ? '' : String(v).trim().replace(/\s+/g, ' ');
    return s === '' ? null : s;
  };
  const requested_by = clean(body.requested_by);
  const industry = clean(body.industry);
  const phone = clean(body.phone);
  const notes = clean(body.notes);

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
      phone,
      notes,
      requested_by,
      industry,
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
        // Extras inherit the primary's origin — a PR guest's +1 is also a PR
        // guest, and the night report counts access passes, not invitations.
        requested_by,
        industry,
        notes: `Acceso extra de ${name}`,
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
    // Echoed back so the agent can confirm what it recorded in its reply, and
    // so a null here is a visible signal that the origin question was skipped.
    requested_by,
    industry,
  });
});

/**
 * GET /api/internal/events/:slug/stats
 *
 * Service-auth guest stats for one event, so headless agents (clau) can answer
 * "cuántos accesos llevamos" without dashboard access. Returns totals, a
 * per-tier breakdown (tier null groups as "none"), and a per-ORIGIN breakdown
 * built from guests.requested_by — the one SS actually asks for ("cuántos de
 * los de PR llegaron").
 *
 * Origins are free text, so they're grouped case- and whitespace-insensitively
 * ("PR", "pr ", "Pr" are one bucket) and reported under the spelling seen most
 * often. Guests with no origin group as "Sin origen".
 *
 * Response: { event: {id, slug, name, date_label},
 *             total, checked_in, email_sent,
 *             by_tier:   { RSVP: {total, checked_in}, GA: {...}, ... },
 *             by_source: { PR: {total, checked_in, rate}, ... } }
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
      .select('tier, checked_in, email_sent, requested_by')
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

  const by_source = groupBySource(rows);

  res.json({ event, total: rows.length, checked_in, email_sent, by_tier, by_source });
});

/**
 * Group guest rows by guests.requested_by (their origin).
 *
 * requested_by is deliberately free text — operators and clau type whatever the
 * promoter said. That means "PR", "pr" and "Pr " are the same origin spelled
 * three ways, and counting them raw would split one bucket into three and
 * understate PR's delivery. So we key on a folded form (lowercased, accent-
 * stripped, whitespace-collapsed) and label each bucket with whichever original
 * spelling appeared most, so the report reads the way people write.
 *
 * Returns a plain object ordered by total desc, with "Sin origen" — guests
 * added before the question existed, or when it was skipped — always last so it
 * never leads the report.
 */
function groupBySource(rows) {
  const NO_SOURCE = 'Sin origen';
  const buckets = new Map(); // key -> { total, checked_in, labels: Map<label, count> }

  for (const g of rows) {
    const raw = (g.requested_by == null ? '' : String(g.requested_by)).trim().replace(/\s+/g, ' ');
    const label = raw === '' ? NO_SOURCE : raw;
    const key = raw === ''
      ? NO_SOURCE
      : raw.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    if (!buckets.has(key)) buckets.set(key, { total: 0, checked_in: 0, labels: new Map() });
    const b = buckets.get(key);
    b.total++;
    if (g.checked_in) b.checked_in++;
    b.labels.set(label, (b.labels.get(label) || 0) + 1);
  }

  const entries = [...buckets.entries()].map(([key, b]) => {
    const label = [...b.labels.entries()].sort((x, y) => y[1] - x[1])[0][0];
    return {
      key,
      label,
      total: b.total,
      checked_in: b.checked_in,
      rate: b.total > 0 ? Math.round((b.checked_in / b.total) * 100) : 0,
    };
  });

  entries.sort((a, b) => {
    if (a.key === NO_SOURCE) return 1;
    if (b.key === NO_SOURCE) return -1;
    return b.total - a.total || a.label.localeCompare(b.label, 'es');
  });

  const out = {};
  for (const e of entries) {
    out[e.label] = { total: e.total, checked_in: e.checked_in, rate: e.rate };
  }
  return out;
}

/**
 * GET /api/internal/events/:slug/night-report.pdf
 *
 * The end-of-night report SS asks clau for on WhatsApp: how many people came,
 * and who they belonged to. Returns a PDF (application/pdf bytes) that clau can
 * forward straight into the chat as a document.
 *
 * Sections: headline totals → per-origin table (invitados / asistieron / % ) →
 * the attendee names grouped by origin. The per-origin table is the point: it's
 * what settles "the PR agency says they sent 80 people".
 *
 * Query:
 *   ?attended=1  (default) list only guests who actually checked in
 *   ?attended=0            list everyone, marking who showed
 *   ?names=0               skip the name listing, totals only (short PDF)
 *
 * pdfkit is require()d lazily inside the handler on purpose. Every other route
 * in this file must keep serving if the dependency is missing from a deploy —
 * a top-level require of an uninstalled module takes the whole API down at
 * boot, which is exactly how this server has been crash-looped before.
 */
router.get('/events/:slug/night-report.pdf', requireServiceAuth, async (req, res) => {
  let PDFDocument;
  try {
    PDFDocument = require('pdfkit');
  } catch (e) {
    return res.status(503).json({
      error: 'PDF generation unavailable: the pdfkit dependency is not installed on this deploy.',
    });
  }

  const { data: event, error: evErr } = await supabase
    .from('events')
    .select('id, slug, name, date_label, venue, city')
    .eq('slug', req.params.slug)
    .single();
  if (evErr || !event) return res.status(404).json({ error: 'Event not found' });

  // Paginate past PostgREST's 1000-row default cap.
  const rows = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('guests')
      .select('name, tier, requested_by, industry, checked_in, checked_in_at')
      .eq('event_id', event.id)
      .order('name', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) return res.status(500).json({ error: error.message });
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }

  const attendedOnly = req.query.attended !== '0';
  const withNames = req.query.names !== '0';

  const total = rows.length;
  const checkedIn = rows.filter(g => g.checked_in).length;
  const rate = total > 0 ? Math.round((checkedIn / total) * 100) : 0;
  const bySource = groupBySource(rows);

  // Build the same buckets again, this time carrying the guests, so the name
  // listing below uses identical grouping to the table above it.
  const labelOf = new Map(); // normalized key -> display label chosen by groupBySource
  for (const label of Object.keys(bySource)) {
    const k = label === 'Sin origen'
      ? 'Sin origen'
      : label.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    labelOf.set(k, label);
  }
  const guestsBySource = new Map(Object.keys(bySource).map(l => [l, []]));
  for (const g of rows) {
    const raw = (g.requested_by == null ? '' : String(g.requested_by)).trim().replace(/\s+/g, ' ');
    const k = raw === ''
      ? 'Sin origen'
      : raw.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const label = labelOf.get(k) || 'Sin origen';
    if (guestsBySource.has(label)) guestsBySource.get(label).push(g);
  }

  const doc = new PDFDocument({ size: 'LETTER', margin: 48, bufferPages: true });
  const chunks = [];
  doc.on('data', c => chunks.push(c));
  doc.on('end', () => {
    const buf = Buffer.concat(chunks);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${event.slug}-reporte-noche.pdf"`);
    res.send(buf);
  });
  doc.on('error', (e) => {
    console.error('[internal/night-report] pdf error:', e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  });

  const INK = '#111111';
  const MUTED = '#6b6b6b';
  const RULE = '#d8d8d8';
  const L = doc.page.margins.left;
  const R = doc.page.width - doc.page.margins.right;
  const W = R - L;

  // Door-local time. Without an explicit zone, toLocaleTimeString formats in the
  // SERVER's zone — Railway runs UTC, so a 1am check-in would print as 07:00 and
  // the report would be quietly wrong about when the room filled.
  const tz = String(req.query.tz || 'America/Mexico_City');
  const hhmm = (iso) => {
    try {
      return new Date(iso).toLocaleTimeString('es-MX', {
        hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz,
      });
    } catch (e) {
      return new Date(iso).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false });
    }
  };

  // pdfkit keeps the x/width of the last positioned text() call as the cursor
  // for the next unpositioned one. Every section heading below must start from
  // the margin, so reset explicitly instead of inheriting a column offset.
  const atMargin = () => { doc.x = L; };

  const hr = (gap = 8) => {
    doc.moveDown(gap / 12);
    doc.strokeColor(RULE).lineWidth(0.5)
      .moveTo(L, doc.y).lineTo(R, doc.y).stroke();
    doc.moveDown(0.5);
    atMargin();
  };

  // --- Header ---
  doc.fillColor(MUTED).font('Helvetica').fontSize(9)
    .text('REPORTE DE NOCHE', { characterSpacing: 1.5 });
  doc.moveDown(0.3);
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(20).text(event.name || event.slug);
  const sub = [event.date_label, event.venue, event.city].filter(Boolean).join('  ·  ');
  if (sub) {
    doc.moveDown(0.2);
    doc.fillColor(MUTED).font('Helvetica').fontSize(10).text(sub);
  }
  hr(14);

  // --- Headline numbers ---
  const statY = doc.y + 4;
  const cell = W / 3;
  const stat = (i, value, label) => {
    const x = L + i * cell;
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(26)
      .text(String(value), x, statY, { width: cell });
    doc.fillColor(MUTED).font('Helvetica').fontSize(9)
      .text(label.toUpperCase(), x, statY + 30, { width: cell, characterSpacing: 0.8 });
  };
  stat(0, total, 'Invitados');
  stat(1, checkedIn, 'Asistieron');
  stat(2, `${rate}%`, 'Asistencia');
  doc.y = statY + 52;
  hr(10);

  // --- Per-origin table: the reason this report exists ---
  atMargin();
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(11)
    .text('DESGLOSE POR ORIGEN', L, doc.y, { width: W, characterSpacing: 0.8 });
  doc.moveDown(0.6);

  const cols = [
    { w: W * 0.46, align: 'left' },   // origen
    { w: W * 0.18, align: 'right' },  // invitados
    { w: W * 0.18, align: 'right' },  // asistieron
    { w: W * 0.18, align: 'right' },  // %
  ];
  const tableRow = (cells, opts = {}) => {
    const y = doc.y;
    let x = L;
    doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(opts.head ? 8.5 : 10)
      .fillColor(opts.head ? MUTED : INK);
    cells.forEach((c, i) => {
      doc.text(String(c), x, y, {
        width: cols[i].w - 6,
        align: cols[i].align,
        characterSpacing: opts.head ? 0.6 : 0,
        lineBreak: false,
      });
      x += cols[i].w;
    });
    doc.y = y + (opts.head ? 14 : 16);
    atMargin();
  };

  tableRow(['ORIGEN', 'INVITADOS', 'ASISTIERON', '%'], { head: true });
  doc.strokeColor(RULE).lineWidth(0.5).moveTo(L, doc.y - 3).lineTo(R, doc.y - 3).stroke();

  for (const [label, s] of Object.entries(bySource)) {
    if (doc.y > doc.page.height - 90) { doc.addPage(); }
    tableRow([label, s.total, s.checked_in, `${s.rate}%`]);
  }
  doc.strokeColor(RULE).lineWidth(0.5).moveTo(L, doc.y - 3).lineTo(R, doc.y - 3).stroke();
  tableRow(['TOTAL', total, checkedIn, `${rate}%`], { bold: true });

  // --- Names grouped by origin ---
  if (withNames) {
    doc.moveDown(1);
    if (doc.y > doc.page.height - 140) doc.addPage();
    atMargin();
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(11)
      .text(attendedOnly ? 'INVITADOS QUE ASISTIERON' : 'LISTA COMPLETA', L, doc.y, { width: W, characterSpacing: 0.8 });
    doc.fillColor(MUTED).font('Helvetica').fontSize(8.5)
      .text(attendedOnly
        ? `Sólo quienes hicieron check-in en la puerta, agrupados por origen. Hora de acceso (${tz}).`
        : `Todos los invitados. La columna derecha muestra la hora de acceso (${tz}); un guion significa que no asistió.`,
        L, doc.y, { width: W });
    doc.moveDown(0.6);

    for (const [label, list] of guestsBySource.entries()) {
      const shown = attendedOnly ? list.filter(g => g.checked_in) : list;
      if (shown.length === 0) continue;

      if (doc.y > doc.page.height - 90) doc.addPage();
      doc.moveDown(0.4);
      atMargin();
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(9.5)
        .text(`${label}  (${shown.length})`, L, doc.y, { width: W });
      doc.moveDown(0.25);

      doc.font('Helvetica').fontSize(9.5).fillColor(INK);
      for (const g of shown) {
        if (doc.y > doc.page.height - 60) doc.addPage();
        // Attendance is shown as the access time rather than a checkmark glyph:
        // pdfkit's built-in Helvetica is WinAnsi-encoded and has no U+2713, so a
        // tick would render as garbage. The time is more useful anyway.
        const when = g.checked_in
          ? (g.checked_in_at ? hhmm(g.checked_in_at) : 'asistió')
          : '—';
        const y = doc.y;
        doc.fillColor(INK).text(g.name, L + 10, y, { width: W - 100, lineBreak: false });
        doc.fillColor(g.checked_in ? MUTED : RULE)
          .text(when, R - 80, y, { width: 80, align: 'right', lineBreak: false });
        doc.y = y + 13;
        atMargin();
      }
    }
  }

  // --- Footer on every page ---
  // The footer sits at page.height - 34, which is BELOW the bottom margin.
  // pdfkit treats a write past the bottom margin as an overflow and silently
  // appends a fresh page for it — which doubles the page count and puts every
  // footer on a blank page at the end. Zeroing the bottom margin for the write
  // (and restoring it after) keeps the footer on the page it belongs to.
  const stamp = new Date().toLocaleString('es-MX', { timeZone: tz });
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.fillColor(MUTED).font('Helvetica').fontSize(7.5)
      .text(
        `Generado ${stamp}  ·  TAC — colectivo.live  ·  Página ${i - range.start + 1} de ${range.count}`,
        L,
        doc.page.height - 34,
        { width: W, align: 'center', lineBreak: false }
      );
    doc.page.margins.bottom = bottom;
  }

  doc.end();
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
