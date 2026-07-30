const { Resend } = require('resend');
const { supabase } = require('../lib/supabase');

/**
 * Hourly confirmation digest for the two-step claim flow.
 *
 * Exists because the people who need these numbers during a live send are the
 * client and the promoter, not whoever happens to have the dashboard open.
 * Recipients live in `events.claim_flow.digest.to` so they can be changed with
 * one update and no deploy.
 */

let resend;
function getResend() {
  if (!resend) resend = new Resend(process.env.RESEND_API_KEY);
  return resend;
}

const MIN_GAP_MINUTES = 4; // cheap abuse ceiling on an unauthenticated trigger

async function loadDigestEvent(secret) {
  if (!secret || secret.length < 24) return null;

  // The secret identifies the event; there is no other lookup key.
  const { data: events } = await supabase
    .from('events')
    .select('id, slug, name, claim_flow')
    .not('claim_flow', 'is', null);

  const event = (events || []).find(
    e => e.claim_flow && e.claim_flow.digest && e.claim_flow.digest.secret === secret
  );
  return event || null;
}

function row(label, value, accent) {
  return `<tr>
    <td style="padding:9px 0; font-size:14px; color:#cfcfcf;">${label}</td>
    <td align="right" style="padding:9px 0; font-size:19px; font-weight:800; color:${accent || '#ffffff'};">${value}</td>
  </tr>`;
}

function buildHtml({ event, cfg, s }) {
  const b = (cfg.brand) || {};
  const accent = b.accent || '#13FCC5';
  const accent2 = b.accent2 || '#E42175';
  const pct = s.pct == null ? '0' : s.pct;

  const alerta = s.caducan_3h > 50
    ? `<tr><td style="padding:14px 0 0;">
         <div style="border:1.5px solid ${accent2}; border-radius:10px; padding:12px 14px; font-size:13px; color:#fff; line-height:1.5;">
           <b>${s.caducan_3h} links caducan en las próximas 3 horas.</b><br>
           Con «Reenviar a no confirmados» se les da una ventana nueva de 24 h (el link anterior deja de servir).
         </div></td></tr>`
    : '';

  const estancado = (s.ultima_hora === 0 && s.pendientes_vivos > 0)
    ? `<tr><td style="padding:14px 0 0;">
         <div style="border:1.5px solid #555; border-radius:10px; padding:12px 14px; font-size:13px; color:#cfcfcf;">
           Sin confirmaciones nuevas en la última hora, con ${s.pendientes_vivos} links todavía vivos.
         </div></td></tr>`
    : '';

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#000;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#000;">
<tr><td align="center">
<table width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:#0a0a0a;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <tr><td style="padding:26px 26px 0;">
    <div style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#8a8a8a;font-weight:700;">${event.name}</div>
    <div style="font-size:12px;color:#6a6a6a;margin-top:6px;">Corte ${s.ahora_cdmx} CDMX</div>
  </td></tr>

  <tr><td align="center" style="padding:22px 26px 4px;">
    <div style="font-size:52px;font-weight:800;color:${accent};line-height:1;">${pct}%</div>
    <div style="font-size:13px;color:#cfcfcf;margin-top:8px;">
      <b style="color:#fff;">${s.confirmados}</b> de ${s.invitados} confirmaron
    </div>
  </td></tr>

  <tr><td style="padding:18px 26px 0;">
    <div style="height:2px;background:linear-gradient(90deg,${accent},${accent2});"></div>
  </td></tr>

  <tr><td style="padding:6px 26px 0;">
    <table width="100%" cellpadding="0" cellspacing="0">
      ${row('Confirmados en la última hora', s.ultima_hora, accent)}
      ${row('Pendientes (link vivo)', s.pendientes_vivos)}
      ${row('Caducados sin confirmar', s.caducados, s.caducados > 0 ? accent2 : '#ffffff')}
      ${row('Pases emitidos (QR)', s.pases_emitidos)}
      ${s.sin_invitar > 0 ? row('Sin invitar todavía', s.sin_invitar) : ''}
    </table>
  </td></tr>

  ${alerta}
  ${estancado}

  ${s.proximo_corte ? `<tr><td style="padding:16px 26px 0;">
    <div style="font-size:12px;color:#8a8a8a;">Próximo link en caducar: ${s.proximo_corte} CDMX</div>
  </td></tr>` : ''}

  <tr><td style="padding:22px 26px 0;">
    <a href="${cfg.digest && cfg.digest.dashboard_url ? cfg.digest.dashboard_url : '#'}"
       style="display:inline-block;background:${accent};color:#000;text-decoration:none;padding:12px 24px;border-radius:999px;font-size:13px;font-weight:800;letter-spacing:1px;">
      Ver lista completa
    </a>
  </td></tr>

  <tr><td align="center" style="padding:26px 26px 22px;">
    <span style="color:#2f2f2f;font-size:9px;letter-spacing:3px;text-transform:uppercase;">tac.colectivo.live</span>
  </td></tr>
</table></td></tr></table></body></html>`;
}

/**
 * Compute + send. Returns what happened so the caller (and the scheduled job)
 * can see it rather than guessing.
 */
async function sendDigest(secret) {
  const event = await loadDigestEvent(secret);
  if (!event) return { ok: false, code: 404, error: 'not found' };

  const cfg = event.claim_flow || {};
  const d = cfg.digest || {};
  if (d.enabled === false) return { ok: false, code: 422, error: 'digest disabled' };

  const to = (d.to || []).filter(Boolean);
  if (!to.length) return { ok: false, code: 422, error: 'no recipients configured' };

  // Don't let a stuck scheduler (or anyone who finds the URL) mail these people
  // on repeat.
  if (d.last_sent_at) {
    const mins = (Date.now() - new Date(d.last_sent_at).getTime()) / 60000;
    if (mins < MIN_GAP_MINUTES) {
      return { ok: false, code: 429, error: `enviado hace ${mins.toFixed(1)} min` };
    }
  }

  const { data: s, error } = await supabase
    .rpc('claim_digest_stats', { p_event_id: event.id });
  if (error) return { ok: false, code: 500, error: error.message };

  const { error: sendErr } = await getResend().emails.send({
    from: cfg.from || process.env.RESEND_FROM_EMAIL || 'Colectivo <noreply@tac.colectivo.live>',
    to,
    subject: `${d.subject || event.name} — ${s.confirmados}/${s.invitados} confirmados (${s.pct ?? 0}%)`,
    html: buildHtml({ event, cfg, s }),
  });
  if (sendErr) return { ok: false, code: 502, error: sendErr.message };

  await supabase
    .from('events')
    .update({ claim_flow: { ...cfg, digest: { ...d, last_sent_at: new Date().toISOString() } } })
    .eq('id', event.id);

  return { ok: true, sent_to: to, stats: s };
}

module.exports = { sendDigest };
