const { Router } = require('express');
const { supabase } = require('../lib/supabase');
const { requireAuth } = require('../middleware/auth');

const router = Router({ mergeParams: true });

/**
 * Client-facing read-only dashboard.
 *
 * Separate from the operator API on purpose. The people who read this are the
 * brand and the promoter, not TAC users: they get aggregates and nothing else,
 * so no guest list, email or QR can escape through this surface even by
 * accident. Access is an explicit email allowlist on the event
 * (`claim_flow.dashboard.emails`) — not org membership, which would hand them
 * edit rights on the whole event.
 */
router.get('/:slug/overview', requireAuth, async (req, res) => {
  const { data: event, error } = await supabase
    .from('events')
    .select('id, slug, name, subtitle, date_label, venue, city, claim_flow')
    .eq('slug', req.params.slug)
    .single();

  if (error || !event) return res.status(404).json({ error: 'Evento no encontrado' });

  const cfg = event.claim_flow || {};
  const allow = ((cfg.dashboard && cfg.dashboard.emails) || []).map(e => String(e).toLowerCase());
  const who = String(req.user.email || '').toLowerCase();

  // 403, not 404: they authenticated fine, they're just not on the list.
  if (!allow.includes(who)) {
    return res.status(403).json({ error: 'Tu correo no tiene acceso a este panel' });
  }

  const { data: stats, error: rpcErr } = await supabase
    .rpc('client_dashboard', { p_event_id: event.id });
  if (rpcErr) return res.status(500).json({ error: rpcErr.message });

  res.json({
    evento: {
      nombre: event.name,
      subtitulo: event.subtitle,
      fecha: event.date_label,
      lugar: [event.venue, event.city].filter(Boolean).join(' · '),
    },
    marca: cfg.brand || {},
    stats,
    viewer: who,
  });
});

/**
 * Post-event attendance report: who came in and at what time.
 *
 * Unlike /overview this DOES return guest names, so it is not the "aggregates
 * only" surface described above. It still never returns emails, phones or QR
 * codes. Access: the event's dashboard allowlist, or someone who already has
 * list access in TAC (owner, org member, accepted `staff`). `door` staff are
 * excluded on purpose — they only ever get the scanner.
 */
router.get('/:slug/attendance', requireAuth, async (req, res) => {
  const { data: event, error } = await supabase
    .from('events')
    .select('id, slug, name, subtitle, date, date_label, time_label, venue, city, owner_id, organization_id, claim_flow')
    .eq('slug', req.params.slug)
    .single();

  if (error || !event) return res.status(404).json({ error: 'Evento no encontrado' });

  const cfg = event.claim_flow || {};
  const allow = ((cfg.dashboard && cfg.dashboard.emails) || []).map(e => String(e).toLowerCase());
  const who = String(req.user.email || '').toLowerCase();

  let ok = allow.includes(who) || event.owner_id === req.user.id;
  if (!ok && event.organization_id) {
    const { data: m } = await supabase.from('organization_members').select('role')
      .eq('organization_id', event.organization_id).eq('user_id', req.user.id).maybeSingle();
    ok = !!m;
  }
  if (!ok) {
    const { data: s } = await supabase.from('event_staff').select('role')
      .eq('event_id', event.id).eq('user_id', req.user.id)
      .not('accepted_at', 'is', null).maybeSingle();
    ok = !!(s && s.role === 'staff');
  }
  if (!ok) return res.status(403).json({ error: 'Tu correo no tiene acceso a este reporte' });

  // Paged: PostgREST caps a single select at 1000 rows.
  const rows = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error: gErr } = await supabase
      .from('guests')
      .select('name, email, notes, checked_in, checked_in_at')
      .eq('event_id', event.id)
      .order('created_at', { ascending: true })
      .range(from, from + PAGE - 1);
    if (gErr) return res.status(500).json({ error: gErr.message });
    rows.push(...data);
    if (data.length < PAGE) break;
  }

  // A scan before the event day is a door test, not an arrival.
  const dayStart = event.date ? new Date(event.date).getTime() : 0;
  const arrival = g => {
    if (!g.checked_in || !g.checked_in_at) return null;
    return new Date(g.checked_in_at).getTime() < dayStart ? null : g.checked_in_at;
  };
  const isTest = g => g.checked_in && g.checked_in_at && new Date(g.checked_in_at).getTime() < dayStart;
  // QRs from an anonymous batch that nobody was ever assigned to.
  const isAnon = g => !g.email && g.notes === 'anon-qr-batch';

  const named = rows.filter(g => !isAnon(g));
  const anon = rows.filter(isAnon);

  res.json({
    evento: {
      nombre: event.name,
      subtitulo: event.subtitle,
      fecha: event.date_label,
      hora: event.time_label,
      lugar: [event.venue, event.city].filter(Boolean).join(' · '),
    },
    invitados: named.map(g => ({ nombre: g.name, entrada: arrival(g) })),
    sin_nombre: {
      emitidos: anon.length,
      entradas: anon.map(arrival).filter(Boolean).sort(),
    },
    pruebas: rows.filter(isTest).length,
    viewer: who,
  });
});

module.exports = router;
