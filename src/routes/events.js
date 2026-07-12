const { Router } = require('express');
const { supabase } = require('../lib/supabase');
const { requireAuth, requireEventAccess } = require('../middleware/auth');

const router = Router();

// Public: get published event by slug
router.get('/:slug/public', async (req, res) => {
  const { data, error } = await supabase
    .from('events')
    .select('*')
    .eq('slug', req.params.slug)
    .eq('published', true)
    .single();

  if (error || !data) return res.status(404).json({ error: 'Event not found' });
  res.json(data);
});

// Auth: list my events (as owner or staff)
router.get('/', requireAuth, async (req, res) => {
  const userId = req.user.id;

  // Events I own (directly)
  const { data: owned, error: ownedErr } = await supabase
    .from('events')
    .select('id, slug, name, subtitle, date, date_label, venue, city, published, banner_url, created_at, organization_id, organizations(id, slug, name, logo_url, type)')
    .eq('owner_id', userId)
    .order('created_at', { ascending: false });

  if (ownedErr) return res.status(500).json({ error: ownedErr.message });

  // Events I'm staff on
  const { data: staffEvents } = await supabase
    .from('event_staff')
    .select('event_id, role, events(id, slug, name, subtitle, date, date_label, venue, city, published, banner_url, created_at, organization_id, organizations(id, slug, name, logo_url, type))')
    .eq('user_id', userId)
    .not('accepted_at', 'is', null);

  const staffed = (staffEvents || []).map(s => ({
    ...s.events,
    staff_role: s.role,
  }));

  // Events I have access to via organization membership (org members can see/manage all org events)
  const { data: myOrgs } = await supabase
    .from('organization_members')
    .select('organization_id, role')
    .eq('user_id', userId);

  let viaOrg = [];
  if (myOrgs && myOrgs.length > 0) {
    const orgIds = myOrgs.map(m => m.organization_id);
    const { data: orgEvents } = await supabase
      .from('events')
      .select('id, slug, name, subtitle, date, date_label, venue, city, published, banner_url, created_at, organization_id, owner_id, organizations(id, slug, name, logo_url, type)')
      .in('organization_id', orgIds)
      .neq('owner_id', userId) // exclude events I already own (they're in `owned`)
      .order('created_at', { ascending: false });
    viaOrg = orgEvents || [];
  }

  res.json({
    owned: owned || [],
    staffed,
    viaOrg,
  });
});

// Auth: get full event detail (owner/staff)
router.get('/:slug', requireAuth, requireEventAccess(['owner', 'staff']), async (req, res) => {
  const { data, error } = await supabase
    .from('events')
    .select('*, organizations(id, slug, name, logo_url, type)')
    .eq('id', req.event.id)
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // Get guest counts
  const { count: totalGuests } = await supabase
    .from('guests')
    .select('*', { count: 'exact', head: true })
    .eq('event_id', req.event.id);

  const { count: checkedIn } = await supabase
    .from('guests')
    .select('*', { count: 'exact', head: true })
    .eq('event_id', req.event.id)
    .eq('checked_in', true);

  res.json({
    ...data,
    stats: {
      total_guests: totalGuests || 0,
      checked_in: checkedIn || 0,
    },
    user_role: req.eventRole,
  });
});

// Auth: create event
router.post('/', requireAuth, async (req, res) => {
  const { name, slug: rawSlug, ...rest } = req.body;

  if (!name) return res.status(400).json({ error: 'Event name is required' });

  // Sanitize slug
  const slug = (rawSlug || name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 60);

  if (!slug) return res.status(400).json({ error: 'Invalid slug' });

  const { data, error } = await supabase
    .from('events')
    .insert({
      ...rest,
      name,
      slug,
      owner_id: req.user.id,
    })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'An event with this slug already exists' });
    }
    return res.status(500).json({ error: error.message });
  }

  res.status(201).json(data);
});

// ---- Duplicate helpers ------------------------------------------------------

const ES_DAYS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const ES_MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

// "2026-07-12" → "Domingo 12 de julio de 2026" (parsed as a plain date, no TZ math)
function formatDateES(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${ES_DAYS[day]} ${d} de ${ES_MONTHS[m - 1]} de ${y}`;
}

// Trailing date patterns we rewrite when deriving the copy's slug/name:
// slug "...-05-07-26" and name "...: 05.07.26"
const SLUG_DATE_RE = /-\d{2}-\d{2}-\d{2}$/;
const NAME_DATE_RE = /\d{2}\.\d{2}\.\d{2}$/;

// Everything a copy inherits. Explicitly NOT copied: id, slug, name, date,
// date_label (derived from the new date), published (starts false),
// door_token (per-event door secret), ra_event_id, owner_id, created_at,
// updated_at, imported_at.
const DUPLICATE_FIELDS = [
  'subtitle', 'time_label', 'venue', 'city', 'description', 'banner_url',
  'dos', 'donts', 'restrictions', 'map_url', 'address', 'layout_url',
  'contact_email', 'contact_phone', 'contact_instagram', 'sponsors',
  'tiers', 'brand_color', 'logo_url', 'promoter_name',
  'email_instructions_es', 'email_instructions_en', 'organization_id',
  'rsvp_promo',
];

/**
 * POST /api/events/:slug/duplicate  (owner only)
 *
 * Clone an event's settings onto a new date. Guests, staff, and invite links
 * are NOT copied; the copy starts unpublished so it's never live with a stale
 * flyer.
 *
 * Body: { date: "YYYY-MM-DD" (required), slug?, name? }
 * Defaults: if the source slug/name end in a date (SS pattern
 * "sunday-sunday-cdmx-DD-MM-YY" / "…: DD.MM.YY"), the date part is rewritten;
 * otherwise "-DD-MM-YY" / " DD.MM.YY" is appended.
 */
router.post('/:slug/duplicate', requireAuth, requireEventAccess(['owner']), async (req, res) => {
  const ymd = String((req.body && req.body.date) || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
    return res.status(400).json({ error: 'date is required (YYYY-MM-DD)' });
  }

  const { data: src, error: srcErr } = await supabase
    .from('events')
    .select('*')
    .eq('id', req.event.id)
    .single();
  if (srcErr || !src) return res.status(404).json({ error: 'Event not found' });

  const [y, m, d] = ymd.split('-');
  const ddmmyy = `${d}-${m}-${y.slice(2)}`;             // 12-07-26
  const dotted = ddmmyy.replace(/-/g, '.');             // 12.07.26

  let slug = (req.body.slug || '').trim().toLowerCase();
  if (!slug) {
    slug = SLUG_DATE_RE.test(src.slug)
      ? src.slug.replace(SLUG_DATE_RE, `-${ddmmyy}`)
      : `${src.slug}-${ddmmyy}`.substring(0, 60);
  }
  let name = (req.body.name || '').trim();
  if (!name) {
    name = NAME_DATE_RE.test(src.name)
      ? src.name.replace(NAME_DATE_RE, dotted)
      : `${src.name} ${dotted}`;
  }

  const copy = { slug, name, owner_id: req.user.id, published: false };
  for (const f of DUPLICATE_FIELDS) copy[f] = src[f];
  copy.date = `${ymd}T00:00:00-06:00`;   // matches the editor's convention (CDMX)
  copy.date_label = formatDateES(ymd);

  const { data, error } = await supabase
    .from('events')
    .insert(copy)
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'An event with this slug already exists', slug });
    }
    return res.status(500).json({ error: error.message });
  }

  res.status(201).json({
    ...data,
    duplicated_from: src.slug,
    notes: src.rsvp_promo ? ['rsvp_promo was copied — review its dates/pricing'] : [],
  });
});

// Auth: update event (owner only)
router.put('/:slug', requireAuth, requireEventAccess(['owner']), async (req, res) => {
  const { id, owner_id, created_at, slug, ...updates } = req.body;

  const { data, error } = await supabase
    .from('events')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', req.event.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Auth: hard-delete an event (owner only). FK cascades drop guests,
// event_staff, and invite_links along with the event row.
router.delete('/:slug', requireAuth, requireEventAccess(['owner']), async (req, res) => {
  const { error } = await supabase
    .from('events')
    .delete()
    .eq('id', req.event.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, message: 'Event deleted' });
});

module.exports = router;
