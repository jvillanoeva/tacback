const { Router } = require('express');
const { supabase } = require('../lib/supabase');
const { loadClaimEvent, deliverTickets } = require('../services/claim');
const { sendDigest } = require('../services/digest');

const router = Router();

/**
 * Hourly confirmation digest, mailed to the people running the campaign.
 *
 * Two path segments, so it can't collide with the single-segment /:token
 * routes below. Auth is the unguessable secret itself (43 random chars, held
 * in events.claim_flow.digest.secret): the recipient list lives server-side
 * and can't be influenced by the caller, and sends are rate-limited, so the
 * worst a leaked URL buys is a duplicate mail to a fixed set of addresses.
 */
router.post('/digest/:secret', async (req, res) => {
  try {
    const r = await sendDigest(req.params.secret);
    if (!r.ok) return res.status(r.code || 500).json({ error: r.error });
    res.json({ ok: true, sent_to: r.sent_to, stats: r.stats });
  } catch (e) {
    console.error('digest failed:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * Public, unauthenticated. Backs the /c/:token confirm page.
 *
 * GET  /api/claim/:token  — read-only. Reports state + branding/copy so the
 *                           page can render before anything is burned. Mail
 *                           security scanners that pre-fetch links only ever
 *                           reach this, never the POST, so the token survives.
 * POST /api/claim/:token  — burns the token (atomic RPC) and sends the QRs.
 */

/** Never leak guest PII or the event id to an unauthenticated caller. */
function publicView(event, cfg, status, extra = {}) {
  const landing = (cfg && cfg.landing) || {};
  return {
    status, // valid | used | expired | not_found | claimed
    event: {
      name: event.name,
      subtitle: event.subtitle || null,
      date_label: event.date_label || null,
      venue: event.venue || null,
      city: event.city || null,
      banner_url: cfg.art_url || event.banner_url || null,
    },
    brand: (cfg && cfg.brand) || {},
    landing,
    terms_url: (cfg && cfg.terms_url) || null,
    terms_label: (cfg && cfg.terms_label) || 'Términos y Condiciones',
    ...extra,
  };
}

/** Resolve a token to its guest + event without mutating anything. */
async function resolve(token) {
  if (!token || token.length < 16) return { status: 'not_found' };

  const { data: guest } = await supabase
    .from('guests')
    .select('id, event_id, name, claim_expires_at, claimed_at')
    .eq('claim_token', token)
    .maybeSingle();

  if (!guest) return { status: 'not_found' };

  let loaded;
  try {
    loaded = await loadClaimEvent(guest.event_id);
  } catch (e) {
    return { status: 'not_found' };
  }

  let status = 'valid';
  if (guest.claimed_at) status = 'used';
  else if (guest.claim_expires_at && new Date(guest.claim_expires_at) <= new Date()) status = 'expired';

  return { status, guest, event: loaded.event, cfg: loaded.cfg };
}

router.get('/:token', async (req, res) => {
  try {
    const r = await resolve(req.params.token);
    if (r.status === 'not_found') return res.status(404).json({ status: 'not_found' });

    res.json(publicView(r.event, r.cfg, r.status, {
      first_name: (r.guest.name || '').trim().split(/\s+/)[0] || null,
      expires_at: r.guest.claim_expires_at || null,
    }));
  } catch (e) {
    console.error('claim GET failed:', e.message);
    res.status(500).json({ status: 'error', error: 'Internal error' });
  }
});

router.post('/:token', async (req, res) => {
  const token = req.params.token;

  try {
    const r = await resolve(token);
    if (r.status === 'not_found') return res.status(404).json({ status: 'not_found' });

    // Atomic burn. Concurrent clicks (double-tap, duplicate tab) serialize on
    // an advisory lock inside the RPC, so exactly one of them gets 'claimed'
    // and only that one sends an email.
    const { data: result, error: rpcErr } = await supabase
      .rpc('claim_guest_access', { p_token: token });

    if (rpcErr) {
      console.error('claim_guest_access failed:', rpcErr.message);
      return res.status(500).json({ status: 'error', error: 'Internal error' });
    }

    const outcome = result && result.status;

    if (outcome === 'not_found') return res.status(404).json({ status: 'not_found' });
    if (outcome === 'expired') return res.status(410).json(publicView(r.event, r.cfg, 'expired'));
    if (outcome === 'already_claimed') return res.status(409).json(publicView(r.event, r.cfg, 'used'));

    try {
      const sent = await deliverTickets({
        guestId: result.guest_id,
        event: r.event,
        cfg: r.cfg,
      });
      return res.json(publicView(r.event, r.cfg, 'claimed', { passes: sent.passes }));
    } catch (mailErr) {
      // The token is burned but the guest has nothing. Give it back so they
      // can retry rather than stranding them with a dead link.
      console.error('claim ticket send failed, releasing token:', mailErr.message);
      await supabase.from('guests').update({ claimed_at: null }).eq('id', result.guest_id);
      return res.status(502).json({
        status: 'send_failed',
        error: 'No pudimos enviar tus accesos. Intenta de nuevo en un momento.',
      });
    }
  } catch (e) {
    console.error('claim POST failed:', e.message);
    res.status(500).json({ status: 'error', error: 'Internal error' });
  }
});

module.exports = router;
