#!/usr/bin/env node
/**
 * Import RA buyers → early-access RSVP guests, Sunday Sunday CDMX 25.10.26.
 *
 * Usage (from server/):
 *   node scripts/import-ra-251026.js --dry-run
 *   node scripts/import-ra-251026.js                 # inserts — only on Jorge's OK
 *   node scripts/import-ra-251026.js --file scripts/data/other.csv
 *
 * Input: RA attendees CSV in scripts/data/ (gitignored — guest PII).
 *
 * Rules (BRIEF-EARLY-ACCESS-251026.md §1.4):
 *   - marketing_opt_in == true only; email trimmed + lowercased; deduped.
 *   - excluded, in this order (each row counted once, under the first hit):
 *       suppressed  — in email_suppressions
 *       collided    — already has ANY row on the new event (a guestlist row
 *                     created beforehand wins)
 *       last_week   — had a row on 18.10.26 (they already got two emails)
 *   - inserts guests rows: tier 'RSVP', requested_by 'ra-early-access' (origin
 *     lives in requested_by — see GUEST-ORIGIN-TRACKING.md), email_sent false.
 *
 * Nothing claim-flow is minted here. claim_token / claim_sent_at /
 * claim_expires_at are written by the blast (sendInviteBulk →
 * claim_mint_tokens) at send time, which is also when the expiry is computed
 * from claim_flow.ttl_hours. Rows inserted here are exactly what the blast
 * selects: tier RSVP, email set, claim_sent_at null, claimed_at null.
 *
 * Idempotent: the new event's existing emails are re-read on every run, so a
 * re-run only inserts what is missing. Never deletes or updates anything.
 * DOES NOT SEND EMAILS.
 *
 * Env (server/.env): SUPABASE_URL, SUPABASE_SERVICE_KEY, and QR_SECRET — the
 * SAME value as Railway. qr_token is a JWT signed with it; a wrong secret
 * produces QRs the door rejects, so a real run refuses to start without it.
 *
 * --sets <file.json> (dry-run only): read the three exclusion lists from a
 * JSON file { suppressed: [], new_event: [], last_week: [] } instead of the
 * DB. For counting on a machine without prod credentials; never inserts.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const NEW_EVENT_ID = '0f31a590-fae2-41a5-bebb-2a0f01e96ed3';
const NEW_EVENT_SLUG = 'sunday-sunday-cdmx-25-10-26';
const LAST_WEEK_EVENT_ID = 'af2cb113-d286-4f59-89e6-c6a1ba31e22a';
const ORIGIN = 'ra-early-access';
const DEFAULT_FILE = path.join(__dirname, 'data', 'attendees_rows.pre-2026-10-22.csv');
const BATCH = 500;
const PAGE = 1000;

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

/** RFC 4180: quoted fields, "" escapes, commas/newlines inside quotes. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }

  const header = rows.shift().map(h => h.replace(/^﻿/, '').trim());
  return rows
    .filter(r => r.length > 1 || (r[0] || '').trim() !== '')
    .map(r => Object.fromEntries(header.map((h, j) => [h, r[j] == null ? '' : r[j]])));
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const norm = e => String(e || '').trim().toLowerCase();

/** Pure: CSV rows + exclusion sets → counts and the rows to insert. */
function plan(rows, sets) {
  const c = { csv_rows: rows.length, opt_out: 0, invalid_email: 0, duplicate: 0,
              eligible: 0, suppressed: 0, collided: 0, last_week: 0, to_insert: 0 };
  const seen = new Map(); // email → name
  for (const r of rows) {
    if (String(r.marketing_opt_in).trim().toLowerCase() !== 'true') { c.opt_out++; continue; }
    const email = norm(r.email);
    if (!EMAIL_RE.test(email)) { c.invalid_email++; continue; }
    if (seen.has(email)) { c.duplicate++; continue; }
    seen.set(email, String(r.name || '').trim().replace(/\s+/g, ' '));
  }
  c.eligible = seen.size;

  const out = [];
  for (const [email, name] of seen) {
    if (sets.suppressed.has(email)) { c.suppressed++; continue; }
    if (sets.newEvent.has(email)) { c.collided++; continue; }
    if (sets.lastWeek.has(email)) { c.last_week++; continue; }
    out.push({ email, name: name || email.split('@')[0] });
  }
  c.to_insert = out.length;
  return { counts: c, rows: out };
}

async function emailsOn(supabase, table, eventId) {
  const set = new Set();
  for (let from = 0; ; from += PAGE) {
    let q = supabase.from(table).select('email');
    if (eventId) q = q.eq('event_id', eventId);
    const { data, error } = await q.order('email').range(from, from + PAGE - 1);
    if (error) throw new Error(`${table} read failed: ${error.message}`);
    for (const r of data || []) if (r.email) set.add(norm(r.email));
    if (!data || data.length < PAGE) break;
  }
  return set;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = args['dry-run'] === 'true';
  const file = args.file ? path.resolve(args.file) : DEFAULT_FILE;

  if (args.sets && !dryRun) {
    console.error('--sets is for --dry-run only. A real run reads the exclusions live.');
    process.exit(1);
  }
  if (!dryRun && !process.env.QR_SECRET) {
    console.error('QR_SECRET missing — set it to the Railway value, or the QRs will not scan.');
    process.exit(1);
  }

  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  console.log(`CSV: ${path.basename(file)} — ${rows.length} rows`);

  let supabase = null;
  let event = null;
  let sets;
  if (args.sets) {
    const s = JSON.parse(fs.readFileSync(path.resolve(args.sets), 'utf8'));
    sets = {
      suppressed: new Set(s.suppressed.map(norm)),
      newEvent: new Set(s.new_event.map(norm)),
      lastWeek: new Set(s.last_week.map(norm)),
    };
    console.log(`Exclusions from ${path.basename(args.sets)} (offline)`);
  } else {
    ({ supabase } = require(path.join(__dirname, '..', 'src', 'lib', 'supabase')));
    const { data, error } = await supabase
      .from('events').select('id, slug, name, owner_id, claim_flow')
      .eq('id', NEW_EVENT_ID).single();
    if (error || !data || data.slug !== NEW_EVENT_SLUG) {
      console.error(`Event ${NEW_EVENT_ID} / ${NEW_EVENT_SLUG} not found`);
      process.exit(1);
    }
    event = data;
    if (!event.claim_flow || event.claim_flow.enabled === false) {
      console.warn('WARNING: claim_flow is not enabled on the event yet.');
    }
    sets = {
      suppressed: await emailsOn(supabase, 'email_suppressions', null),
      newEvent: await emailsOn(supabase, 'guests', NEW_EVENT_ID),
      lastWeek: await emailsOn(supabase, 'guests', LAST_WEEK_EVENT_ID),
    };
  }
  console.log(`  suppressions: ${sets.suppressed.size} · on new event: ${sets.newEvent.size} · on 18.10.26: ${sets.lastWeek.size}`);

  const { counts, rows: toInsert } = plan(rows, sets);
  console.log('Counts:', JSON.stringify(counts, null, 2));

  if (dryRun) {
    console.log('[dry-run] no writes performed.');
    return;
  }
  if (!toInsert.length) { console.log('Nothing to do.'); return; }

  // ids minted client-side so qr_token is signed for the real id in the same
  // insert — no placeholder token, no per-row follow-up update.
  const { createQrToken } = require(path.join(__dirname, '..', 'src', 'services', 'qr'));
  let inserted = 0;
  for (let i = 0; i < toInsert.length; i += BATCH) {
    const batch = toInsert.slice(i, i + BATCH).map(r => {
      const id = crypto.randomUUID();
      return {
        id,
        event_id: NEW_EVENT_ID,
        name: r.name,
        email: r.email,
        tier: 'RSVP',
        requested_by: ORIGIN,
        added_by: event.owner_id, // NOT NULL — attribute the import to the owner
        qr_token: createQrToken(id, NEW_EVENT_ID),
        checked_in: false,
        email_sent: false,
        is_group_primary: false,
      };
    });
    const { data, error } = await supabase.from('guests').insert(batch).select('id');
    if (error) {
      console.error(`Insert failed at batch ${i / BATCH} (${inserted} inserted so far):`, error.message);
      console.error('Re-running is safe: rows already inserted are skipped.');
      process.exit(1);
    }
    inserted += (data || []).length;
    console.log(`  inserted ${inserted}/${toInsert.length}`);
  }
  console.log(`Done. ${inserted} RSVP guests added to ${NEW_EVENT_SLUG} at ${new Date().toISOString()}. No emails sent.`);
}

main().catch(e => { console.error(e); process.exit(1); });
