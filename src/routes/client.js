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

module.exports = router;
