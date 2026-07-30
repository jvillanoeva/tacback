const crypto = require('crypto');
const { supabase } = require('../lib/supabase');
const { sendClaimInviteEmail, sendClaimTicketsEmail } = require('./email');

/**
 * Two-step claim flow — shared logic between the operator-facing guestlist
 * routes (which send mail 1) and the public /api/claim routes (which burn the
 * token and send mail 2).
 *
 * Config lives in `events.claim_flow` (jsonb). Null/absent or
 * `{enabled:false}` means the event does not use this flow.
 */

const EVENT_FIELDS =
  'id, slug, name, subtitle, date_label, time_label, venue, city, banner_url, ' +
  'logo_url, brand_color, promoter_name, claim_flow';

/** Fetch an event with its claim config. Throws a tagged error when off. */
async function loadClaimEvent(eventId) {
  const { data: event, error } = await supabase
    .from('events')
    .select(EVENT_FIELDS)
    .eq('id', eventId)
    .single();

  if (error || !event) {
    const e = new Error('Event not found');
    e.code = 'EVENT_NOT_FOUND';
    throw e;
  }

  const cfg = event.claim_flow;
  if (!cfg || cfg.enabled === false) {
    const e = new Error('This event does not use the confirm-then-ticket flow');
    e.code = 'CLAIM_DISABLED';
    throw e;
  }

  return { event, cfg };
}

/** URL-safe, unguessable, 43 chars. */
function mintToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function confirmUrlFor(cfg, token) {
  const base = (cfg.confirm_base || `${process.env.WEB_URL || 'https://tac.colectivo.live'}/c/`)
    .replace(/\/+$/, '');
  return `${base}/${token}`;
}

/**
 * Mail 1. Mints a fresh single-use token (rotating any previous one, which
 * silently kills an older un-clicked link) and stamps the TTL window.
 *
 * Deliberately writes the token BEFORE sending: a token in the DB with no
 * email out is recoverable (resend); an email out with no token in the DB is
 * a guest holding a dead link.
 */
async function sendInvite({ guest, event, cfg }) {
  if (!guest.email) {
    const e = new Error('Guest has no email address');
    e.code = 'NO_EMAIL';
    throw e;
  }

  const ttlHours = Number(cfg.ttl_hours) > 0 ? Number(cfg.ttl_hours) : 24;
  const now = new Date();
  const expires = new Date(now.getTime() + ttlHours * 3600 * 1000);
  const token = mintToken();

  const { error: upErr } = await supabase
    .from('guests')
    .update({
      claim_token: token,
      claim_sent_at: now.toISOString(),
      claim_expires_at: expires.toISOString(),
      claimed_at: null,
    })
    .eq('id', guest.id);

  if (upErr) throw new Error('Could not stamp claim token: ' + upErr.message);

  await sendClaimInviteEmail({
    guest,
    event,
    cfg,
    confirmUrl: confirmUrlFor(cfg, token),
  });

  // email_sent tracks "mail 1 went out" for this flow; the guestlist UI reads
  // claimed_at to know whether the tickets themselves landed.
  await supabase.from('guests').update({ email_sent: true }).eq('id', guest.id);

  logActivity(event.id, guest.id, 'claim_invite_sent');

  return { token, expires_at: expires.toISOString() };
}

/**
 * Mail 2. Loads the guest's group so "+1 acompañante" renders as 2 QRs.
 * Called only after claim_guest_access() has already burned the token.
 */
async function deliverTickets({ guestId, event, cfg }) {
  const { data: guest, error } = await supabase
    .from('guests')
    .select('*')
    .eq('id', guestId)
    .single();

  if (error || !guest) throw new Error('Guest not found');

  let extraGuests = [];
  if (guest.group_id) {
    const { data: extras } = await supabase
      .from('guests')
      .select('*')
      .eq('group_id', guest.group_id)
      .neq('id', guest.id)
      .order('created_at', { ascending: true });
    extraGuests = extras || [];
  }

  await sendClaimTicketsEmail({ guest, event, cfg, extraGuests });
  logActivity(event.id, guest.id, 'claim_tickets_sent');

  return { passes: 1 + extraGuests.length };
}

/** Fire-and-forget audit trail; never blocks the guest-facing path. */
function logActivity(eventId, guestId, action) {
  supabase
    .from('guest_activity')
    .insert({ event_id: eventId, guest_id: guestId, action, source: 'claim' })
    .then(() => {}, () => {});
}

module.exports = {
  EVENT_FIELDS,
  loadClaimEvent,
  sendInvite,
  deliverTickets,
  confirmUrlFor,
  mintToken,
};
