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
    .select('id, slug, name, subtitle, date_label, venue, city, published, banner_url, created_at, organization_id, organizations(id, slug, name, logo_url, type)')
    .eq('owner_id', userId)
    .order('created_at', { ascending: false });

  if (ownedErr) return res.status(500).json({ error: ownedErr.message });

  // Events I'm staff on
  const { data: staffEvents } = await supabase
    .from('event_staff')
    .select('event_id, role, events(id, slug, name, subtitle, date_label, venue, city, published, banner_url, created_at, organization_id, organizations(id, slug, name, logo_url, type))')
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
      .select('id, slug, name, subtitle, date_label, venue, city, published, banner_url, created_at, organization_id, owner_id, organizations(id, slug, name, logo_url, type)')
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

// Auth: delete (unpublish) event (owner only)
router.delete('/:slug', requireAuth, requireEventAccess(['owner']), async (req, res) => {
  const { error } = await supabase
    .from('events')
    .update({ published: false, updated_at: new Date().toISOString() })
    .eq('id', req.event.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, message: 'Event unpublished' });
});

module.exports = router;
