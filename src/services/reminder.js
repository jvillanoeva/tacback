const { Resend } = require('resend');
const { supabase } = require('../lib/supabase');

/**
 * Day-of reminder — one mail to everyone already holding QRs.
 *
 * Config lives in `events.claim_flow.reminder` (jsonb), same config-as-data
 * pattern as `invite`, `tickets` and `digest`: copy, artwork, subject and the
 * whole section list are DATA, so a wording change from the brand at 07:00 is
 * an UPDATE, not a deploy.
 */

const BATCH_SIZE = 100;      // Resend: up to 100 messages per batch call
const BATCH_PAUSE_MS = 300;  // keeps every 1s window at 4 calls or under
const MAX_CONSECUTIVE_BATCH_FAILURES = 3;
const PAGE = 1000;           // PostgREST caps a single select at 1000 rows

let resend;
function getResend() {
  if (!resend) resend = new Resend(process.env.RESEND_API_KEY);
  return resend;
}

async function loadReminderEvent(secret) {
  if (!secret || secret.length < 24) return null;
  const { data: events } = await supabase
    .from('events')
    .select('id, slug, name, claim_flow')
    .not('claim_flow', 'is', null);
  return (events || []).find(
    e => e.claim_flow && e.claim_flow.reminder && e.claim_flow.reminder.secret === secret
  ) || null;
}

function brand(cfg) {
  const b = (cfg && cfg.brand) || {};
  return {
    bg: b.bg || '#000000',
    panel: b.panel || '#0a0a0a',
    ink: b.ink || '#ffffff',
    muted: b.muted || '#b9b9b9',
    accent: b.accent || '#2fe6c4',
    accent2: b.accent2 || '#ff2d78',
    font: b.font || "'Helvetica Neue',Helvetica,Arial,sans-serif",
  };
}

function heading(c, text) {
  return `<tr><td style="padding:28px 28px 0;">
    <div style="font-size:11px; letter-spacing:3px; text-transform:uppercase; font-weight:800; color:${c.accent};">${text}</div>
  </td></tr>`;
}

function prose(c, html) {
  return `<tr><td style="padding:10px 28px 0;">
    <div style="font-size:14px; line-height:1.65; color:${c.muted};">${html}</div>
  </td></tr>`;
}

function bullets(c, items, kind) {
  const mark = kind === 'cross' ? '&times;' : '&#10003;';
  const colour = kind === 'cross' ? c.accent2 : c.accent;
  return `<tr><td style="padding:8px 28px 0;">
    <table width="100%" cellpadding="0" cellspacing="0">${(items || []).map(i => `
      <tr><td width="18" valign="top" style="padding:3px 0; font-size:13px; color:${colour}; font-weight:800;">${mark}</td>
          <td style="padding:3px 0; font-size:14px; line-height:1.5; color:${c.muted};">${i}</td></tr>`).join('')}
    </table></td></tr>`;
}

function renderSection(c, s) {
  if (!s) return '';
  const head = s.title ? heading(c, s.title) : '';
  if (s.type === 'check' || s.type === 'cross') return head + bullets(c, s.items, s.type);
  return head + prose(c, s.body || '');
}

function buildReminderHtml({ cfg, rem }) {
  const c = brand(cfg);

  const art = rem.art_url
    ? `<tr><td style="padding:0;"><img src="${rem.art_url}" alt="" width="560" style="width:100%; display:block; border:0;"></td></tr>`
    : '';

  const hero = (rem.eyebrow || rem.title) ? `
    <tr><td style="padding:32px 28px 0;">
      ${rem.eyebrow ? `<div style="font-size:12px; letter-spacing:4px; text-transform:uppercase; font-weight:800; color:${c.accent};">${rem.eyebrow}</div>` : ''}
      ${rem.title ? `<div style="margin-top:10px; font-size:26px; line-height:1.2; font-weight:800; color:${c.ink};">${rem.title}</div>` : ''}
    </td></tr>` : '';

  const callout = rem.callout ? `
    <tr><td style="padding:22px 28px 0;">
      <table width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="border:1.5px solid ${c.accent}; border-radius:12px; padding:16px 18px;">
          <div style="font-size:15px; line-height:1.6; font-weight:700; color:${c.ink}; text-align:center;">${rem.callout}</div>
        </td>
      </tr></table>
    </td></tr>` : '';

  const lead = rem.lead ? prose(c, rem.lead) : '';
  const body = (rem.sections || []).map(s => renderSection(c, s)).join('');
  const closing = rem.closing ? `
    <tr><td style="padding:26px 28px 0;">
      <div style="font-size:13px; line-height:1.6; color:#6f6f6f;">${rem.closing}</div>
    </td></tr>` : '';

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0; padding:0; background:${c.bg};">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:${c.bg};">
    <tr><td align="center" style="padding:0;">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px; width:100%; background:${c.panel}; font-family:${c.font}; color:${c.ink};">
        ${art}${hero}${callout}${lead}${body}${closing}
        <tr><td style="padding:30px 28px 0;">
          <div style="height:2px; background:linear-gradient(90deg, ${c.accent}, ${c.accent2});"></div>
        </td></tr>
        <tr><td align="center" style="padding:16px 24px 28px;">
          <span style="color:#3a3a3a; font-size:9px; letter-spacing:3px; text-transform:uppercase;">tac.colectivo.live</span>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

/** Everyone who confirmed and therefore holds QRs. Paged: the list is >1000. */
async function loadRecipients(eventId) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('guests')
      .select('id, name, email')
      .eq('event_id', eventId)
      .eq('is_group_primary', true)
      .not('email', 'is', null)
      .not('claimed_at', 'is', null)
      .order('created_at', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

async function sendReminder(secret, { to, force } = {}) {
  const event = await loadReminderEvent(secret);
  if (!event) return { ok: false, code: 404, error: 'not found' };

  const cfg = event.claim_flow || {};
  const rem = cfg.reminder || {};
  if (rem.enabled === false) return { ok: false, code: 422, error: 'reminder disabled' };
  if (!rem.subject) return { ok: false, code: 422, error: 'no subject configured' };

  const isTest = !!to;

  // One shot. A scheduler that fires twice, or anyone who finds the URL, must
  // not be able to mail several hundred guests the same reminder again.
  if (!isTest && rem.sent_at && !force) {
    return { ok: false, code: 409, error: `ya enviado ${rem.sent_at}` };
  }

  const recipients = isTest
    ? [{ id: 'test', name: 'Test', email: to }]
    : await loadRecipients(event.id);

  if (!recipients.length) return { ok: false, code: 422, error: 'no recipients' };

  const html = buildReminderHtml({ cfg, rem });
  const from = rem.from || cfg.from;
  if (!from) return { ok: false, code: 422, error: 'no from address configured' };

  const client = getResend();
  const failures = [];
  let sent = 0;
  let consecutiveBatchFailures = 0;
  let aborted = null;

  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    const slice = recipients.slice(i, i + BATCH_SIZE);
    const payloads = slice.map(g => ({ from, to: g.email, subject: rem.subject, html }));

    try {
      const { error } = await client.batch.send(payloads);
      if (error) throw error;
      sent += payloads.length;
      consecutiveBatchFailures = 0;
    } catch (batchErr) {
      consecutiveBatchFailures++;
      console.error('reminder batch failed:', batchErr.message);
      slice.forEach(g => failures.push({ email: g.email, error: batchErr.message }));

      if (consecutiveBatchFailures >= MAX_CONSECUTIVE_BATCH_FAILURES) {
        aborted = `detenido tras ${consecutiveBatchFailures} lotes fallidos: ${batchErr.message}`;
        for (const g of recipients.slice(i + slice.length)) {
          failures.push({ email: g.email, error: 'no enviado (envio detenido)' });
        }
        break;
      }
    }

    if (i + BATCH_SIZE < recipients.length) {
      await new Promise(r => setTimeout(r, BATCH_PAUSE_MS));
    }
  }

  // Only a real run burns the one-shot guard; a test must never close the door
  // on the actual send.
  if (!isTest && sent > 0) {
    const next = { ...cfg, reminder: { ...rem, sent_at: new Date().toISOString() } };
    await supabase.from('events').update({ claim_flow: next }).eq('id', event.id);
  }

  return {
    ok: true, code: 200, test: isTest,
    total: recipients.length, sent, failed: failures.length,
    aborted, failures: failures.slice(0, 25),
  };
}

module.exports = { sendReminder, buildReminderHtml, loadReminderEvent };
