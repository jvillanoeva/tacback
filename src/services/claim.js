const crypto = require('crypto');
const { supabase } = require('../lib/supabase');
const { sendClaimInviteEmail, sendClaimInviteBatch, sendClaimTicketsEmail } = require('./email');

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

const DEFAULT_CONFIRM_BASE = 'https://tac.colectivo.live/c/';

/**
 * Where the confirm link points.
 *
 * Deliberately does NOT read WEB_URL. That variable is a CORS allow-list
 * (index.js splits it on commas) and on Railway its first entry is the apex
 * `colectivo.live`, which serves no /c/ route — using it here mailed a few
 * thousand guests a 404. Per-event `confirm_base` wins; PUBLIC_WEB_URL is the
 * env escape hatch; otherwise the known-good host.
 */
function confirmUrlFor(cfg, token) {
  let base = cfg.confirm_base;

  if (!base && process.env.PUBLIC_WEB_URL) {
    base = `${process.env.PUBLIC_WEB_URL.replace(/\/+$/, '')}/c/`;
  }
  if (!base) {
    console.warn('[claim] no confirm_base on this event; defaulting to ' + DEFAULT_CONFIRM_BASE);
    base = DEFAULT_CONFIRM_BASE;
  }

  return `${base.replace(/\/+$/, '')}/${token}`;
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
 * Mail 1, bulk. Built for thousands of invitees:
 *   - all tokens minted in ONE round trip (claim_mint_tokens RPC)
 *   - all mails sent through Resend's batch endpoint, 100 per call
 * A 2000-guest blast is ~20 API calls / a few seconds, versus 2000 calls
 * over 7+ minutes the naive way (which times out the request).
 *
 * Tokens are written BEFORE any mail goes out, same invariant as sendInvite:
 * a live token with no email is recoverable, the reverse is not.
 */
async function sendInviteBulk({ guests, event, cfg, onProgress }) {
  const withEmail = (guests || []).filter(g => g.email);
  if (!withEmail.length) return { sent: 0, failed: 0, failures: [], minted: 0 };

  const ttlHours = Number(cfg.ttl_hours) > 0 ? Number(cfg.ttl_hours) : 24;
  const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000).toISOString();

  const minted = withEmail.map(g => ({ id: g.id, token: mintToken(), expires_at: expiresAt }));

  const { data: mintedCount, error: mintErr } = await supabase
    .rpc('claim_mint_tokens', { p_rows: minted });
  if (mintErr) throw new Error('Could not mint claim tokens: ' + mintErr.message);

  const byId = new Map(minted.map(m => [m.id, m.token]));
  const items = withEmail.map(g => ({
    guest: g,
    event,
    cfg,
    confirmUrl: confirmUrlFor(cfg, byId.get(g.id)),
  }));

  const result = await sendClaimInviteBatch(items, { onProgress });

  // Mark the ones that actually went out.
  const failedEmails = new Set(result.failures.map(f => f.email));
  const okIds = withEmail.filter(g => !failedEmails.has(g.email)).map(g => g.id);
  for (let i = 0; i < okIds.length; i += 500) {
    await supabase.from('guests').update({ email_sent: true }).in('id', okIds.slice(i, i + 500));
  }

  return { ...result, minted: mintedCount ?? minted.length, expires_at: expiresAt };
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
  sendInviteBulk,
  deliverTickets,
  confirmUrlFor,
  mintToken,
};
