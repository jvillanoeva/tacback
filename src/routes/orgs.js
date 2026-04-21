const { Router } = require('express');
const { supabase } = require('../lib/supabase');
const { requireAuth } = require('../middleware/auth');

const router = Router();

// ============================================================
// Public endpoints (no auth)
// ============================================================

// Public org page data: org info + upcoming/past events
router.get('/public/:slug', async (req, res) => {
  const { data: org, error } = await supabase
    .from('organizations')
    .select('*')
    .eq('slug', req.params.slug)
    .eq('published', true)
    .single();

  if (error || !org) return res.status(404).json({ error: 'Organization not found' });

  // Pull all published events for this org
  const { data: events } = await supabase
    .from('events')
    .select('id, slug, name, subtitle, date_label, time_label, venue, city, banner_url, published, date')
    .eq('organization_id', org.id)
    .eq('published', true)
    .order('date', { ascending: true, nullsFirst: false });

  // Split upcoming vs past based on event.date if present, else fall back to date_label heuristic
  const now = new Date();
  const upcoming = [];
  const past = [];
  (events || []).forEach(ev => {
    if (ev.date) {
      (new Date(ev.date) >= now ? upcoming : past).push(ev);
    } else {
      upcoming.push(ev); // unknown date — treat as upcoming
    }
  });

  res.json({ org, upcoming, past });
});

// ============================================================
// Authenticated endpoints
// ============================================================

// List orgs the user is a member of
router.get('/', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('organization_members')
    .select('role, organizations(*)')
    .eq('user_id', req.user.id);

  if (error) return res.status(500).json({ error: error.message });

  const orgs = (data || []).map(m => ({ ...m.organizations, my_role: m.role }));
  res.json(orgs);
});

// Get single org (must be member)
router.get('/:slug', requireAuth, async (req, res) => {
  const { data: org, error } = await supabase
    .from('organizations')
    .select('*')
    .eq('slug', req.params.slug)
    .single();

  if (error || !org) return res.status(404).json({ error: 'Organization not found' });

  // Check membership
  const { data: member } = await supabase
    .from('organization_members')
    .select('role')
    .eq('organization_id', org.id)
    .eq('user_id', req.user.id)
    .single();

  if (!member) return res.status(403).json({ error: 'Not a member of this organization' });

  // Members list
  const { data: members } = await supabase
    .from('organization_members')
    .select('role, user_id, created_at')
    .eq('organization_id', org.id);

  res.json({ ...org, my_role: member.role, members: members || [] });
});

// Create org
router.post('/', requireAuth, async (req, res) => {
  const { name, type, slug: rawSlug, ...rest } = req.body;

  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (!['venue', 'promoter'].includes(type)) {
    return res.status(400).json({ error: 'Type must be venue or promoter' });
  }

  const slug = (rawSlug || name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 60);

  if (!slug) return res.status(400).json({ error: 'Invalid slug' });

  const RESERVED = ['e', 'invite', 'login', 'dashboard', 'scan', 'evento', 'guestlist', 'event-editor', 'home', 'index', 'org', 'orgs', 'api', 'assets', 'auth', 'admin'];
  if (RESERVED.includes(slug)) {
    return res.status(400).json({ error: 'This slug is reserved, choose another' });
  }

  const { data: org, error } = await supabase
    .from('organizations')
    .insert({
      ...rest,
      name,
      type,
      slug,
      created_by: req.user.id,
    })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'Slug already taken' });
    return res.status(500).json({ error: error.message });
  }

  // Add creator as owner
  await supabase
    .from('organization_members')
    .insert({ organization_id: org.id, user_id: req.user.id, role: 'owner' });

  res.status(201).json(org);
});

// Update org (must be owner)
router.put('/:slug', requireAuth, async (req, res) => {
  const { id, slug, created_by, created_at, ...updates } = req.body;

  // Look up org and check role
  const { data: org } = await supabase
    .from('organizations')
    .select('id')
    .eq('slug', req.params.slug)
    .single();

  if (!org) return res.status(404).json({ error: 'Organization not found' });

  const { data: member } = await supabase
    .from('organization_members')
    .select('role')
    .eq('organization_id', org.id)
    .eq('user_id', req.user.id)
    .single();

  if (!member || member.role !== 'owner') {
    return res.status(403).json({ error: 'Only owners can edit' });
  }

  const { data, error } = await supabase
    .from('organizations')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', org.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Delete org (owner only)
router.delete('/:slug', requireAuth, async (req, res) => {
  const { data: org } = await supabase
    .from('organizations')
    .select('id')
    .eq('slug', req.params.slug)
    .single();
  if (!org) return res.status(404).json({ error: 'Organization not found' });

  const { data: member } = await supabase
    .from('organization_members')
    .select('role')
    .eq('organization_id', org.id)
    .eq('user_id', req.user.id)
    .single();
  if (!member || member.role !== 'owner') {
    return res.status(403).json({ error: 'Only owners can delete' });
  }

  const { error } = await supabase.from('organizations').delete().eq('id', org.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// Add member (owner only)
router.post('/:slug/members', requireAuth, async (req, res) => {
  const { email, role = 'manager' } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  const { data: org } = await supabase
    .from('organizations')
    .select('id, name')
    .eq('slug', req.params.slug)
    .single();
  if (!org) return res.status(404).json({ error: 'Organization not found' });

  const { data: myMembership } = await supabase
    .from('organization_members')
    .select('role')
    .eq('organization_id', org.id)
    .eq('user_id', req.user.id)
    .single();
  if (!myMembership || myMembership.role !== 'owner') {
    return res.status(403).json({ error: 'Only owners can add members' });
  }

  // Find target user by email in auth.users
  const { data: { users } = { users: [] } } = await supabase.auth.admin.listUsers({
    page: 1, perPage: 1000,
  });
  const targetUser = (users || []).find(u => u.email && u.email.toLowerCase() === email.toLowerCase());

  if (!targetUser) {
    return res.status(404).json({ error: 'No registered user with that email. Ask them to sign up first.' });
  }

  const { data, error } = await supabase
    .from('organization_members')
    .insert({ organization_id: org.id, user_id: targetUser.id, role })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'Already a member' });
    return res.status(500).json({ error: error.message });
  }
  res.status(201).json(data);
});

// Remove member (owner only)
router.delete('/:slug/members/:userId', requireAuth, async (req, res) => {
  const { data: org } = await supabase
    .from('organizations')
    .select('id')
    .eq('slug', req.params.slug)
    .single();
  if (!org) return res.status(404).json({ error: 'Organization not found' });

  const { data: myMembership } = await supabase
    .from('organization_members')
    .select('role')
    .eq('organization_id', org.id)
    .eq('user_id', req.user.id)
    .single();
  if (!myMembership || myMembership.role !== 'owner') {
    return res.status(403).json({ error: 'Only owners can remove members' });
  }

  const { error } = await supabase
    .from('organization_members')
    .delete()
    .eq('organization_id', org.id)
    .eq('user_id', req.params.userId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

module.exports = router;
