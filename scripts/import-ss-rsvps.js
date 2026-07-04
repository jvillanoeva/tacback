#!/usr/bin/env node
/**
 * Import Sunday Sunday RSVPs (Bodega → TAC guests, tier RSVP).
 *
 * Usage:
 *   node server/scripts/import-ss-rsvps.js --dry-run
 *   node server/scripts/import-ss-rsvps.js
 *   node server/scripts/import-ss-rsvps.js --event sunday-sunday-cdmx-05-07-26 --date 2026-07-05
 *
 * Reads public.ss_rsvps from the Bodega Supabase project (READ ONLY — this
 * script never writes to Bodega), normalizes + dedupes emails, and inserts
 * missing ones as TAC guests with tier 'RSVP', +0 extras, email_sent=false.
 *
 * Idempotent: emails already on the event (any tier) are skipped, so the
 * Sunday-morning delta run only adds new registrations and never causes
 * re-sends (the send route additionally respects email_sent).
 *
 * DOES NOT SEND EMAILS. Sending is a separate, explicit step.
 *
 * Env (server/.env via dotenv, same as src/index.js):
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY   — TAC (write)
 *   BODEGA_SUPABASE_URL                  — optional, defaults to the Bodega project
 *   BODEGA_SUPABASE_KEY                  — required: a key that can SELECT ss_rsvps
 */

require('dotenv').config();
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const { supabase: tac } = require(path.join(__dirname, '..', 'src', 'lib', 'supabase'));
const { createQrToken } = require(path.join(__dirname, '..', 'src', 'services', 'qr'));

const BODEGA_URL = process.env.BODEGA_SUPABASE_URL || 'https://vqwvfhoxjxkgowuouxkx.supabase.co';
const BODEGA_KEY = process.env.BODEGA_SUPABASE_KEY;

// Known-bad rows (2026-07-04 brief): TLD typo whose correct address registered
// separately. Only EXACT addresses go here — near-dupes across providers
// (e.g. lyxett@gmail + lyxett@hotmail) are kept: they may be two people.
const DROP_EXACT = new Set([
  'bruno.aguilar85@gmail.comg',
]);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      out[key] = val;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = args['dry-run'] === 'true';
  const eventSlug = args.event || 'sunday-sunday-cdmx-05-07-26';
  const eventDate = args.date || '2026-07-05';

  if (!BODEGA_KEY) {
    console.error('BODEGA_SUPABASE_KEY missing — need a key that can read public.ss_rsvps');
    process.exit(1);
  }

  // ── TAC event ─────────────────────────────────────────────────────────────
  const { data: event, error: evErr } = await tac
    .from('events').select('id, slug, name, owner_id, rsvp_promo').eq('slug', eventSlug).single();
  if (evErr || !event) {
    console.error(`Event not found: ${eventSlug}`);
    process.exit(1);
  }
  if (!event.rsvp_promo) {
    console.warn('WARNING: event has no rsvp_promo config — scanner will treat these as plain guests.');
  }

  // ── Bodega RSVPs (read only) ──────────────────────────────────────────────
  const bodega = createClient(BODEGA_URL, BODEGA_KEY);
  const rows = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await bodega
      .from('ss_rsvps')
      .select('email, created_at')
      .eq('event_date', eventDate)
      .order('created_at', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      console.error('Bodega read failed:', error.message);
      process.exit(1);
    }
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  console.log(`Bodega: ${rows.length} raw RSVP rows for ${eventDate}`);

  // ── Normalize + dedupe ────────────────────────────────────────────────────
  const seen = new Map(); // email → first created_at
  let dropped = 0;
  for (const r of rows) {
    const email = String(r.email || '').trim().toLowerCase();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { dropped++; continue; }
    if (DROP_EXACT.has(email)) { dropped++; continue; }
    if (!seen.has(email)) seen.set(email, r.created_at);
  }
  console.log(`Normalized: ${seen.size} unique emails (${dropped} dropped: invalid/blocklist, ${rows.length - dropped - seen.size} exact dupes)`);

  // ── Skip emails already on the event (any tier — avoids double QRs for
  //    people who RSVPd AND are on the regular list) ─────────────────────────
  const existing = new Set();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await tac
      .from('guests').select('email').eq('event_id', event.id).range(from, from + PAGE - 1);
    if (error) { console.error('TAC read failed:', error.message); process.exit(1); }
    for (const g of data || []) {
      if (g.email) existing.add(String(g.email).trim().toLowerCase());
    }
    if (!data || data.length < PAGE) break;
  }

  const toInsert = [...seen.keys()].filter(e => !existing.has(e));
  console.log(`Event "${event.name}": ${existing.size} guests already on list → ${toInsert.length} new RSVP guests to insert`);

  if (dryRun) {
    console.log('[dry-run] no writes performed. First 10 pending:', toInsert.slice(0, 10));
    return;
  }
  if (toInsert.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  // ── Insert (chunks), then re-issue qr_token bound to the real guest id ────
  let inserted = 0;
  const CHUNK = 200;
  for (let i = 0; i < toInsert.length; i += CHUNK) {
    // added_by is NOT NULL — attribute the import to the event owner.
    // short_code: DB default generates it (upper 16-hex from gen_random_uuid).
    // qr_token is NOT NULL: insert a placeholder JWT, then re-issue bound to
    // the real guest id below (same pattern as routes/guestlist.js).
    const chunk = toInsert.slice(i, i + CHUNK).map(email => ({
      event_id: event.id,
      name: email.split('@')[0], // RSVP is email-only; local part is the searchable name
      email,
      tier: 'RSVP',
      notes: null,
      added_by: event.owner_id,
      qr_token: createQrToken(`rsvp-${email}-${Date.now()}`, event.id),
      checked_in: false,
      email_sent: false,
    }));

    const { data: rows2, error: insErr } = await tac.from('guests').insert(chunk).select('id');
    if (insErr) {
      console.error(`Insert failed at chunk ${i / CHUNK}:`, insErr.message);
      process.exit(1);
    }
    for (const g of rows2 || []) {
      await tac.from('guests').update({ qr_token: createQrToken(g.id, event.id) }).eq('id', g.id);
    }
    inserted += rows2.length;
    console.log(`  inserted ${inserted}/${toInsert.length}`);
  }

  console.log(`Done. ${inserted} RSVP guests added to "${event.name}". No emails sent.`);
}

main().catch(e => { console.error(e); process.exit(1); });
