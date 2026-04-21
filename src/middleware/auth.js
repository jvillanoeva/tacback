const { createClient } = require('@supabase/supabase-js');
const { supabase } = require('../lib/supabase');

/**
 * Verify Supabase JWT and attach user to request.
 * Uses Supabase's own getUser() to validate the token,
 * which supports both HS256 (legacy) and ECC (P-256) signing keys.
 * Expects: Authorization: Bearer <token>
 */
async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid authorization header' });
  }

  const token = header.split(' ')[1];

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    req.user = {
      id: user.id,
      email: user.email,
      role: user.role,
    };

    // Auto-accept pending staff invites for this user's email
    supabase
      .from('event_staff')
      .update({ user_id: user.id, accepted_at: new Date().toISOString() })
      .eq('email', user.email.toLowerCase())
      .is('user_id', null)
      .then(() => {})
      .catch(() => {});

    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Check if user is owner or staff for an event.
 * Requires :slug param in the route and requireAuth before it.
 * @param {string[]} allowedRoles - e.g. ['owner', 'staff', 'door']
 */
function requireEventAccess(allowedRoles = ['owner', 'staff', 'door']) {
  return async (req, res, next) => {
    const slug = req.params.slug;
    const userId = req.user.id;

    // Look up the event
    const { data: event, error } = await supabase
      .from('events')
      .select('id, owner_id, organization_id')
      .eq('slug', slug)
      .single();

    if (error || !event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    req.event = event;

    // Check if owner (direct event ownership)
    if (event.owner_id === userId && allowedRoles.includes('owner')) {
      req.eventRole = 'owner';
      return next();
    }

    // Check if member of the event's organization (treated as owner of the event)
    if (event.organization_id && allowedRoles.includes('owner')) {
      const { data: orgMember } = await supabase
        .from('organization_members')
        .select('role')
        .eq('organization_id', event.organization_id)
        .eq('user_id', userId)
        .single();
      if (orgMember) {
        req.eventRole = 'owner';
        return next();
      }
    }

    // Check if staff
    if (allowedRoles.some(r => r !== 'owner')) {
      const { data: staff } = await supabase
        .from('event_staff')
        .select('role')
        .eq('event_id', event.id)
        .eq('user_id', userId)
        .not('accepted_at', 'is', null)
        .single();

      if (staff && allowedRoles.includes(staff.role)) {
        req.eventRole = staff.role;
        return next();
      }
    }

    return res.status(403).json({ error: 'You do not have access to this event' });
  };
}

module.exports = { requireAuth, requireEventAccess };
