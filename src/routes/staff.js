const { Router } = require('express');
const { supabase } = require('../lib/supabase');
const { requireAuth, requireEventAccess } = require('../middleware/auth');
const { sendStaffInviteEmail } = require('../services/email');

const router = Router({ mergeParams: true });

// List staff for an event (owner only)
router.get('/', requireAuth, requireEventAccess(['owner']), async (req, res) => {
  const { data, error } = await supabase
    .from('event_staff')
    .select('id, email, role, invited_at, accepted_at, user_id')
    .eq('event_id', req.event.id)
    .order('invited_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// Invite staff (owner only)
router.post('/', requireAuth, requireEventAccess(['owner']), async (req, res) => {
  const { email, role = 'staff' } = req.body;

  if (!email) return res.status(400).json({ error: 'Email is required' });
  if (!['staff', 'door'].includes(role)) {
    return res.status(400).json({ error: 'Role must be "staff" or "door"' });
  }

  // Check if this email has a Supabase Auth account
  const { data: users } = await supabase.auth.admin.listUsers();
  const existingUser = (users?.users || []).find(
    u => u.email?.toLowerCase() === email.toLowerCase()
  );

  const { data, error } = await supabase
    .from('event_staff')
    .insert({
      event_id: req.event.id,
      email: email.toLowerCase(),
      role,
      user_id: existingUser?.id || null,
      accepted_at: existingUser ? new Date().toISOString() : null,
    })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'This person is already staff on this event' });
    }
    return res.status(500).json({ error: error.message });
  }

  // Send invitation email
  try {
    const { data: event } = await supabase
      .from('events')
      .select('name, slug')
      .eq('id', req.event.id)
      .single();

    await sendStaffInviteEmail({
      email: email.toLowerCase(),
      role,
      eventName: event.name,
      eventSlug: event.slug,
      hasAccount: !!existingUser,
    });
  } catch (emailErr) {
    console.error('Staff invite email failed:', emailErr.message);
  }

  res.status(201).json(data);
});

// Remove staff (owner only)
router.delete('/:staffId', requireAuth, requireEventAccess(['owner']), async (req, res) => {
  const { error } = await supabase
    .from('event_staff')
    .delete()
    .eq('id', req.params.staffId)
    .eq('event_id', req.event.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

module.exports = router;
