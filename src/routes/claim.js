const { Router } = require('express');
const { supabase } = require('../lib/supabase');
const { loadClaimEvent, deliverTickets, sendInviteBulk } = require('../services/claim');
const { sendDigest } = require('../services/digest');
const { sendReminder } = require('../services/reminder');
const { normalizeAlias, validateAlias, isAliasAvailable, saveMemberAlias } = require('../services/alias');

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
/**
 * Scheduled campaign blast — mail 1 to every guest not yet invited.
 *
 * Same auth shape as the digest and reminder below: two path segments, the
 * unguessable secret (claim_flow.blast.secret) IS the credential, and the
 * recipient set is built server-side, so a leaked URL can at worst re-run a
 * send that the fired_at guard already refuses.
 *
 *   - blast.fired_at is stamped BEFORE any mail goes out and a second call
 *     409s unless {"force": true} — a scheduler that double-fires can't
 *     double-mail 1,800 people.
 *   - Suppressed (unsubscribed) addresses are filtered inside
 *     sendInviteBulk like every other send.
 */
router.post('/blast/:secret', async (req, res) => {
  try {
    const { data: events, error } = await supabase
      .from('events')
      .select('*')
      .not('claim_flow', 'is', null);
    if (error) return res.status(500).json({ error: error.message });

    const event = (events || []).find(
      e => e.claim_flow && e.claim_flow.blast && e.claim_flow.blast.secret === req.params.secret
    );
    if (!event) return res.status(404).json({ error: 'Not found' });
    const cfg = event.claim_flow;

    if (cfg.blast.fired_at && req.body?.force !== true) {
      return res.status(409).json({ error: 'Blast already fired at ' + cfg.blast.fired_at });
    }

    // Eligible = RSVP tier, has email, never invited, never claimed. Paginated.
    // RSVP only: guestlist (GA) rows on the same event already hold a direct
    // QR and must never get the early-access invite.
    const guests = [];
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data, error: qErr } = await supabase
        .from('guests')
        .select('id, name, email, group_id')
        .eq('event_id', event.id)
        .eq('tier', 'RSVP')
        .not('email', 'is', null)
        .is('claimed_at', null)
        .is('claim_sent_at', null)
        .order('created_at', { ascending: true })
        .range(from, from + PAGE - 1);
      if (qErr) return res.status(500).json({ error: qErr.message });
      guests.push(...(data || []));
      if (!data || data.length < PAGE) break;
    }

    // Stamp BEFORE sending so a crash can't be blind-re-fired into doubles.
    await supabase.from('events')
      .update({ claim_flow: { ...cfg, blast: { ...cfg.blast, fired_at: new Date().toISOString(), targets: guests.length } } })
      .eq('id', event.id);

    if (!guests.length) return res.json({ sent: 0, failed: 0, total: 0, message: 'nothing eligible' });

    const result = await sendInviteBulk({ guests, event, cfg });
    console.log('[blast]', event.slug, 'sent:', result.sent, 'failed:', result.failed, 'suppressed:', result.suppressed);
    res.json({
      sent: result.sent,
      failed: result.failed,
      suppressed: result.suppressed || 0,
      total: guests.length,
      expires_at: result.expires_at,
      aborted: result.aborted || null,
      failures: (result.failures || []).slice(0, 25),
    });
  } catch (e) {
    console.error('blast failed:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

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
 * Day-of reminder to everyone already holding QRs.
 *
 * Same shape as the digest above — two path segments, secret-as-auth, list
 * built server-side — with two differences that matter because this one goes
 * to guests rather than to three colleagues:
 *
 *   - `{ "to": "someone@example.com" }` sends ONE test copy and nothing else.
 *   - a real run stamps `reminder.sent_at` and refuses to run again, so a
 *     scheduler that double-fires can't mail 700 people twice. `force: true`
 *     overrides deliberately.
 */
router.post('/reminder/:secret', async (req, res) => {
  try {
    const r = await sendReminder(req.params.secret, {
      to: req.body?.to,
      force: req.body?.force === true,
    });
    if (!r.ok) return res.status(r.code || 500).json({ error: r.error });
    res.json(r);
  } catch (e) {
    console.error('reminder failed:', e.message);
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
    // The landing can carry its own palette (landing.brand) so the emails'
    // brand (claimBrand) and the page can diverge — e.g. green mails, dark page.
    brand: (cfg && cfg.landing && cfg.landing.brand) || (cfg && cfg.brand) || {},
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
    .select('id, event_id, name, email, claim_expires_at, claimed_at')
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

// Live alias availability for the confirm page. Token-gated so it is not a
// public enumeration surface; only answers on events with landing.ask_alias.
router.get('/:token/alias-check', async (req, res) => {
  try {
    const r = await resolve(req.params.token);
    if (r.status !== 'valid') return res.status(404).json({ error: 'invalid' });
    if (!(r.cfg && r.cfg.landing && r.cfg.landing.ask_alias)) {
      return res.status(404).json({ error: 'off' });
    }
    const alias = normalizeAlias(req.query.a);
    if (!alias) return res.json({ available: false, error: 'Escribe un nombre.' });
    const bad = validateAlias(alias);
    if (bad) return res.json({ available: false, error: bad });
    const available = await isAliasAvailable(alias, r.guest && r.guest.email);
    res.json({ available, alias });
  } catch (e) {
    console.error('alias-check failed:', e.message);
    res.status(500).json({ error: 'internal' });
  }
});

router.get('/:token', async (req, res) => {
  try {
    const r = await resolve(req.params.token);
    if (r.status === 'not_found') return res.status(404).json({ status: 'not_found' });

    // A used link from a guest with a saved clave is a returning member, not
    // an error — hand the page their clave so it can greet instead of reject.
    let alias = null;
    if (r.status === 'used' && r.guest.email) {
      try {
        const { memberAliasForEmail } = require('../services/alias');
        alias = await memberAliasForEmail(r.guest.email);
      } catch (e) { /* greeting only */ }
    }

    res.json(publicView(r.event, r.cfg, r.status, {
      first_name: (r.guest.name || '').trim().split(/\s+/)[0] || null,
      expires_at: r.guest.claim_expires_at || null,
      alias,
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

    // Optional card alias. Validated and availability-checked BEFORE the burn
    // so a taken name never costs the guest their one link. Only events with
    // landing.ask_alias read the field; everything else ignores the body.
    let alias = null;
    if (r.cfg && r.cfg.landing && r.cfg.landing.ask_alias && req.body && req.body.alias != null) {
      alias = normalizeAlias(req.body.alias);
      if (alias) {
        const bad = validateAlias(alias);
        if (bad) return res.status(422).json({ status: 'bad_alias', error: bad });
        if (!(await isAliasAvailable(alias, r.guest && r.guest.email))) {
          return res.status(409).json({ status: 'alias_taken', error: 'Ese nombre ya fue tomado. Elige otro.' });
        }
      }
    }

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
    // claim_flow.cap reached — checked inside the RPC, token NOT burned.
    if (outcome === 'cap_reached') {
      return res.status(409).json(publicView(r.event, r.cfg, 'cap_reached', { error: 'cap_reached' }));
    }
    if (outcome !== 'claimed') {
      console.error('claim_guest_access unexpected outcome:', outcome);
      return res.status(500).json({ status: 'error', error: 'Internal error' });
    }

    try {
      // Save the clave BEFORE the QR mail so the mail can greet by it.
      // Safe pre-delivery: a failed delivery releases the token, and the
      // ownership-aware check lets the retry reclaim the same clave.
      // Best-effort either way — a hiccup here never blocks the tickets.
      let aliasSaved = false;
      let effectiveAlias = null;
      if (alias) {
        try {
          const saved = await saveMemberAlias({ guestId: result.guest_id, alias });
          aliasSaved = saved.saved;
          effectiveAlias = saved.alias;
          if (aliasSaved && effectiveAlias) {
            await supabase.from('guests')
              .update({ notes: 'Alias: ' + effectiveAlias })
              .eq('id', result.guest_id);
          }
        } catch (e) {
          console.error('alias save failed:', e.message);
        }
      }

      const sent = await deliverTickets({
        guestId: result.guest_id,
        event: r.event,
        cfg: r.cfg,
        alias: effectiveAlias,
      });

      return res.json(publicView(r.event, r.cfg, 'claimed', {
        passes: sent.passes,
        alias_saved: aliasSaved,
        alias: effectiveAlias,
      }));
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
