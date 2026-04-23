const { Router } = require('express');
const { supabase } = require('../lib/supabase');
const { requireAuth } = require('../middleware/auth');

const router = Router();

/**
 * Sunday Sunday reporting routes.
 * Gated by organization_members — any member of the org can read/write
 * ss_* data for that org.
 *
 * All routes are mounted at /api/ss and take :orgSlug as the first path
 * parameter.
 */

// ─── helpers ────────────────────────────────────────────────────────────────

async function requireOrgMember(req, res, next) {
  const { orgSlug } = req.params;
  if (!orgSlug) return res.status(400).json({ error: 'Missing org slug' });

  const { data: org } = await supabase
    .from('organizations')
    .select('id, slug, name')
    .eq('slug', orgSlug)
    .single();
  if (!org) return res.status(404).json({ error: 'Organization not found' });

  const { data: member } = await supabase
    .from('organization_members')
    .select('role')
    .eq('organization_id', org.id)
    .eq('user_id', req.user.id)
    .single();
  if (!member) return res.status(403).json({ error: 'Not a member of this organization' });

  req.org = org;
  req.orgRole = member.role;
  next();
}

// ─── routes ─────────────────────────────────────────────────────────────────

// List events for an org — ordered by event_date desc
router.get('/:orgSlug/events', requireAuth, requireOrgMember, async (req, res) => {
  const { data, error } = await supabase
    .from('ss_events')
    .select(`
      id, event_date, source_event_name, scraped_at, settled_at, created_at,
      ss_summary (
        chips_activados, ventas_totales, ventas, recargas, propinas,
        saldo_circulacion, avg_venta_chip
      ),
      ss_settlement (
        door_count, nomina, cash_tips, cogs_override, notes
      )
    `)
    .eq('organization_id', req.org.id)
    .order('event_date', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// Get one event (+ summary + settlement + list of raw reports)
router.get('/:orgSlug/events/:eventDate', requireAuth, requireOrgMember, async (req, res) => {
  const { eventDate } = req.params;

  const { data: event, error } = await supabase
    .from('ss_events')
    .select(`
      *,
      ss_summary (*),
      ss_settlement (*)
    `)
    .eq('organization_id', req.org.id)
    .eq('event_date', eventDate)
    .single();

  if (error || !event) return res.status(404).json({ error: 'Event not found' });

  const { data: rawReports } = await supabase
    .from('ss_raw_reports')
    .select('id, report_type, scraped_at')
    .eq('ss_event_id', event.id)
    .order('report_type');

  res.json({ ...event, raw_reports: rawReports || [] });
});

// Upsert settlement for an event — marks settled_at when any field is saved
router.put('/:orgSlug/events/:eventDate/settlement', requireAuth, requireOrgMember, async (req, res) => {
  const { eventDate } = req.params;

  const { data: event } = await supabase
    .from('ss_events')
    .select('id')
    .eq('organization_id', req.org.id)
    .eq('event_date', eventDate)
    .single();
  if (!event) return res.status(404).json({ error: 'Event not found' });

  const allowed = [
    'door_count', 'ticket_count', 'ticket_revenue',
    'cover_count', 'cover_revenue',
    'nomina', 'cash_tips', 'cogs_override', 'other_costs', 'notes',
  ];
  const payload = { ss_event_id: event.id, settled_by: req.user.id };
  for (const k of allowed) {
    if (Object.prototype.hasOwnProperty.call(req.body, k)) payload[k] = req.body[k];
  }

  const { data: settlement, error: sErr } = await supabase
    .from('ss_settlement')
    .upsert(payload, { onConflict: 'ss_event_id' })
    .select()
    .single();
  if (sErr) return res.status(500).json({ error: sErr.message });

  // Mark settled_at on the parent event the first time settlement is saved
  await supabase
    .from('ss_events')
    .update({ settled_at: new Date().toISOString() })
    .eq('id', event.id);

  res.json(settlement);
});

// Trigger the Python scraper service.
// Body: { event_date?: 'YYYY-MM-DD' }  -- defaults to latest
//
// The scraper service is expected at SS_SCRAPER_URL, protected by SS_SCRAPER_SECRET
// (shared secret, sent as the X-Scraper-Secret header).
// Returns 202 with a job id for async mode, or 200 with the written event id for sync.
router.post('/:orgSlug/scrape', requireAuth, requireOrgMember, async (req, res) => {
  const { event_date } = req.body || {};

  const url = process.env.SS_SCRAPER_URL;
  const secret = process.env.SS_SCRAPER_SECRET;
  if (!url || !secret) {
    return res.status(503).json({ error: 'Scraper service not configured (SS_SCRAPER_URL / SS_SCRAPER_SECRET)' });
  }

  try {
    const upstream = await fetch(`${url.replace(/\/$/, '')}/scrape`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Scraper-Secret': secret,
      },
      body: JSON.stringify({
        organization_id: req.org.id,
        organization_slug: req.org.slug,
        event_date: event_date || null,
      }),
    });

    const text = await upstream.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text }; }

    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: body.error || body.raw || 'Scraper error', upstream_status: upstream.status });
    }

    return res.status(upstream.status === 202 ? 202 : 200).json(body);
  } catch (err) {
    return res.status(502).json({ error: `Scraper unreachable: ${err.message}` });
  }
});

module.exports = router;
