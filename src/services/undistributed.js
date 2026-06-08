const { supabase } = require('../lib/supabase');
const { createQrToken } = require('./qr');
const { sendManagerQrBundle } = require('./email');

/**
 * Undistributed-QR fallback.
 *
 * For one event, find every table (invite_link) whose account manager has an
 * email AND still has unused quota (used_count < max_guests). For each, generate
 * the remaining passes as guest rows with signed QR tokens, email the whole
 * batch to the manager in ONE message, mark them sent, and consume the quota.
 *
 * Idempotent-ish: once a table's used_count reaches max_guests it is skipped on
 * re-run. Tables with no manager_email are skipped (nothing to send to) — so it
 * is safe to run before manager emails are filled in.
 *
 * @param {string} eventId
 * @returns {Promise<{event:string, tables:object[], tables_processed:number, passes_sent:number}>}
 */
async function sendUndistributedForEvent(eventId) {
  const { data: event, error: evErr } = await supabase
    .from('events')
    .select('id, slug, name, brand_color, banner_url')
    .eq('id', eventId)
    .single();
  if (evErr || !event) throw new Error('Event not found');

  const { data: links, error: lErr } = await supabase
    .from('invite_links')
    .select('*')
    .eq('event_id', eventId)
    .eq('active', true)
    .not('manager_email', 'is', null);
  if (lErr) throw new Error(lErr.message);

  const tables = [];
  let passesSent = 0;

  for (const link of links || []) {
    const remaining = link.max_guests - link.used_count;
    if (remaining <= 0) continue;

    // Generate the remaining passes as guest rows under this link.
    const created = [];
    for (let n = 1; n <= remaining; n++) {
      const { data: g, error: gErr } = await supabase
        .from('guests')
        .insert({
          event_id: eventId,
          name: `${link.label} · Pase ${link.used_count + n}`,
          tier: link.tier || null,
          added_by: link.created_by,
          invite_link_id: link.id,
          qr_token: createQrToken('placeholder', eventId),
        })
        .select()
        .single();
      if (gErr || !g) continue;
      const tok = createQrToken(g.id, eventId);
      await supabase.from('guests').update({ qr_token: tok }).eq('id', g.id);
      g.qr_token = tok;
      created.push(g);
    }

    if (!created.length) {
      tables.push({ table: link.label, error: 'no passes generated' });
      continue;
    }

    try {
      await sendManagerQrBundle({
        managerEmail: link.manager_email,
        managerName: link.manager_name,
        tableLabel: link.label,
        event,
        guests: created,
      });
      await supabase.from('guests').update({ email_sent: true }).in('id', created.map(g => g.id));
      await supabase.from('invite_links').update({ used_count: link.max_guests }).eq('id', link.id);
      passesSent += created.length;
      tables.push({ table: link.label, to: link.manager_email, passes: created.length });
    } catch (e) {
      // Roll back the just-created rows so a retry doesn't double them.
      await supabase.from('guests').delete().in('id', created.map(g => g.id));
      tables.push({ table: link.label, error: e.message });
    }
  }

  return { event: event.slug, tables, tables_processed: tables.length, passes_sent: passesSent };
}

module.exports = { sendUndistributedForEvent };
