const { Router } = require('express');
const { supabase } = require('../lib/supabase');
const { requireTerminal } = require('../middleware/terminal-auth');

const router = Router();

// Every loyalty endpoint is terminal-authenticated.
router.use(requireTerminal);

const MEMBER_PAGE_LIMIT = 1000;
const VALID_TAP_KINDS = ['bar', 'door', 'merch', 'wildcard'];

// Public-shaped member object returned to terminals.
function publicMember(m) {
  return {
    id: m.id,
    nfc_id: m.nfc_id,
    first_name: m.first_name,
    member_since: m.member_since,
    tier: m.tier,
    is_connector: m.is_connector,
    ra_buyer_id: m.ra_buyer_id,
    tac_user_id: m.tac_user_id,
    notes: m.notes,
    created_at: m.created_at,
    updated_at: m.updated_at,
  };
}

// ============================================
// POST /api/loyalty/taps
// Batch submit; idempotent on local_id.
// ============================================
router.post('/taps', async (req, res) => {
  const { taps } = req.body || {};
  if (!Array.isArray(taps)) {
    return res.status(400).json({ error: '`taps` must be an array' });
  }

  // Pre-resolve all referenced nfc_ids in a single query.
  const nfcIds = [...new Set(taps.map(t => t && t.nfc_id).filter(Boolean))];
  let memberByNfc = new Map();
  if (nfcIds.length > 0) {
    const { data: members, error } = await supabase
      .from('loyalty_members')
      .select('id, nfc_id')
      .in('nfc_id', nfcIds);
    if (error) return res.status(500).json({ error: error.message });
    memberByNfc = new Map((members || []).map(m => [m.nfc_id, m.id]));
  }

  const rejected = [];
  const toInsert = [];

  for (const t of taps) {
    if (!t || typeof t !== 'object') {
      rejected.push({ local_id: null, reason: 'malformed_tap' });
      continue;
    }
    const { local_id, nfc_id, event_id, amount_mxn, kind, tapped_at } = t;

    if (!local_id || !nfc_id || !kind || !tapped_at) {
      rejected.push({ local_id: local_id || null, reason: 'missing_fields' });
      continue;
    }
    if (!VALID_TAP_KINDS.includes(kind)) {
      rejected.push({ local_id, reason: 'invalid_kind' });
      continue;
    }

    const memberId = memberByNfc.get(nfc_id);
    if (!memberId) {
      rejected.push({ local_id, reason: 'unknown_member' });
      continue;
    }

    toInsert.push({
      local_id,
      member_id: memberId,
      terminal_id: req.terminal.id,
      event_id: event_id || null,
      amount_mxn: amount_mxn ?? null,
      kind,
      tapped_at,
    });
  }

  let accepted = 0;
  if (toInsert.length > 0) {
    // Idempotency: ON CONFLICT (local_id) DO NOTHING via upsert
    // with ignoreDuplicates so duplicate submissions succeed silently.
    const { data, error } = await supabase
      .from('loyalty_taps')
      .upsert(toInsert, { onConflict: 'local_id', ignoreDuplicates: true })
      .select('id');

    if (error) return res.status(500).json({ error: error.message });

    // `data` contains only newly-inserted rows when ignoreDuplicates is
    // true; treat duplicates as accepted (idempotent success).
    accepted = toInsert.length;
    void data;
  }

  res.json({ accepted, rejected });
});

// ============================================
// GET /api/loyalty/members?since=<ISO>
// Incremental member sync; capped at 1000.
// ============================================
router.get('/members', async (req, res) => {
  const since = req.query.since;

  let q = supabase
    .from('loyalty_members')
    .select('*')
    .order('updated_at', { ascending: true })
    .limit(MEMBER_PAGE_LIMIT);

  if (since) {
    const d = new Date(since);
    if (Number.isNaN(d.getTime())) {
      return res.status(400).json({ error: 'Invalid `since` timestamp' });
    }
    q = q.gte('updated_at', d.toISOString());
  }

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });

  const members = (data || []).map(publicMember);
  const next_cursor =
    members.length === MEMBER_PAGE_LIMIT
      ? members[members.length - 1].updated_at
      : null;

  res.json({ members, next_cursor });
});

// ============================================
// POST /api/loyalty/members
// Issue a new card.
// ============================================
router.post('/members', async (req, res) => {
  const {
    nfc_id,
    first_name,
    member_since,
    tac_user_id = null,
    tac_attendee_id = null, // accepted as alias; mapped to tac_user_id below
    ra_buyer_id = null,
    notes = null,
  } = req.body || {};

  if (!nfc_id || !first_name || !member_since) {
    return res
      .status(400)
      .json({ error: '`nfc_id`, `first_name`, and `member_since` are required' });
  }

  // The brief uses `tac_attendee_id` in the request payload but the
  // schema column is `tac_user_id` (see decisions in 002-loyalty.sql).
  const linkedUserId = tac_user_id || tac_attendee_id || null;

  const { data: member, error } = await supabase
    .from('loyalty_members')
    .insert({
      nfc_id,
      first_name,
      member_since,
      tac_user_id: linkedUserId,
      ra_buyer_id,
      notes,
    })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      return res
        .status(409)
        .json({ error: 'A member with this nfc_id already exists' });
    }
    return res.status(500).json({ error: error.message });
  }

  // Append initial tier-history row. Best-effort: if it fails the
  // member still exists and the cron will reconcile later.
  const { error: histErr } = await supabase
    .from('loyalty_tier_history')
    .insert({
      member_id: member.id,
      prev_tier: null,
      new_tier: 'habitue',
      prev_is_connector: null,
      new_is_connector: false,
      reason: 'card issued',
    });
  if (histErr) {
    console.warn('loyalty_tier_history insert failed:', histErr.message);
  }

  res.status(201).json(publicMember(member));
});

// ============================================
// GET /api/loyalty/members/:nfcId
// Cache-miss fallback for terminals.
// ============================================
router.get('/members/:nfcId', async (req, res) => {
  const { data, error } = await supabase
    .from('loyalty_members')
    .select('*')
    .eq('nfc_id', req.params.nfcId)
    .single();

  if (error || !data) {
    return res.status(404).json({ error: 'Member not found' });
  }
  res.json(publicMember(data));
});

module.exports = router;
