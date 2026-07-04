const { Resend } = require('resend');
const { generateQrBuffer } = require('./qr');
const { supabase } = require('../lib/supabase');
const crypto = require('crypto');

let resend;
function getResend() {
  if (!resend) resend = new Resend(process.env.RESEND_API_KEY);
  return resend;
}

/**
 * Upload QR PNG to Supabase Storage and return a public URL.
 */
async function uploadQrImage(qrToken, guestId) {
  const buffer = await generateQrBuffer(qrToken);
  const hash = crypto.randomBytes(4).toString('hex');
  const path = `qr/${guestId}-${hash}.png`;

  const { error } = await supabase.storage
    .from('event-images')
    .upload(path, buffer, {
      contentType: 'image/png',
      upsert: true,
    });

  if (error) throw new Error('QR upload failed: ' + error.message);

  const { data } = supabase.storage
    .from('event-images')
    .getPublicUrl(path);

  return data.publicUrl;
}

/**
 * Convert plain text with * bullets to HTML (centered, mono style).
 */
function formatInstructions(text) {
  if (!text) return '';
  return text.split('\n').map(line => {
    const trimmed = line.trim();
    if (!trimmed) return '<div style="height:12px;"></div>';
    if (trimmed.startsWith('* ') || trimmed.startsWith('- ')) {
      return `<div style="margin:4px 0; font-size:13px; font-weight:400; color:#d0d0d0;">• ${trimmed.slice(2)}</div>`;
    }
    return `<div style="margin:12px 0 4px; font-weight:700; font-size:12px; letter-spacing:2px; text-transform:uppercase; color:#ffffff;">${trimmed}</div>`;
  }).join('');
}

/**
 * RSVP variant lookup. Callers pass `guest`/`event` objects with varying
 * column subsets (tier / rsvp_promo often missing), so this resolves both
 * from the DB by guest.id. Returns the event's rsvp_promo jsonb when the
 * guest is RSVP-tier on a promo event, else null → normal black template.
 */
async function getRsvpPromo(guest) {
  const { data: g } = await supabase
    .from('guests').select('tier, event_id').eq('id', guest.id).single();
  if (!g || g.tier !== 'RSVP') return null;
  const { data: ev } = await supabase
    .from('events').select('rsvp_promo').eq('id', g.event_id).single();
  return (ev && ev.rsvp_promo) || null;
}

/**
 * Green RSVP template — Sunday Sunday landing style (design ref 2026-07-04):
 * solid #3fe23f background, #1d1f1d ink, Helvetica, pill borders, QR on a
 * white rounded card (dark modules need a light quiet zone to scan).
 * Copy/labels come from event.rsvp_promo.email so the template stays generic.
 * RSVP guests never have extras (+0 by rule), so only the primary QR renders.
 */
async function sendRsvpGuestQrEmail({ guest, event, promo }) {
  const cfg = (promo && promo.email) || {};
  const GREEN = '#3fe23f';
  const INK = '#1d1f1d';
  const PILL = `border:1.5px solid ${INK}; border-radius:999px; display:inline-block;`;

  const qrUrl = await uploadQrImage(guest.short_code || guest.qr_token, guest.id);

  const pills = Array.isArray(cfg.pills) ? cfg.pills : [];
  const headline = (Array.isArray(cfg.headline) && cfg.headline.length ? cfg.headline : [event.name]).join('<br>');
  const datePill = cfg.date_pill || event.date_label || '';
  const sub = cfg.sub || [event.venue, event.city, event.time_label].filter(Boolean).join(' · ');

  const paragraphs = String(cfg.body_es || '')
    .split(/\n\s*\n/).map(s => s.trim()).filter(Boolean)
    .map((p, i) => `<p style="margin:0 0 12px; font-size:14px; line-height:1.6; ${i === 0 ? 'font-weight:700;' : 'font-weight:500;'}">${p}</p>`)
    .join('');
  const bullets = (Array.isArray(cfg.bullets) ? cfg.bullets : [])
    .map(b => `<p style="margin:0 0 8px; font-size:13px; font-weight:500; line-height:1.5;">&bull;&nbsp; ${b}</p>`)
    .join('');

  // Optional English section (body_en / bullets_en) — slightly smaller, same style.
  const paragraphsEn = String(cfg.body_en || '')
    .split(/\n\s*\n/).map(s => s.trim()).filter(Boolean)
    .map((p, i) => `<p style="margin:0 0 10px; font-size:13px; line-height:1.55; ${i === 0 ? 'font-weight:700;' : 'font-weight:500;'}">${p}</p>`)
    .join('');
  const bulletsEn = (Array.isArray(cfg.bullets_en) ? cfg.bullets_en : [])
    .map(b => `<p style="margin:0 0 8px; font-size:12px; font-weight:500; line-height:1.5;">&bull;&nbsp; ${b}</p>`)
    .join('');

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0; padding:0; background:${GREEN};">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:${GREEN};">
    <tr><td align="center" style="padding:0;">
      <table width="520" cellpadding="0" cellspacing="0" style="max-width:520px; width:100%; background:${GREEN}; font-family:'Helvetica Neue',Helvetica,Arial,sans-serif; color:${INK};">

        ${pills.length ? `
        <tr><td style="padding:24px 24px 0;">
          <table width="100%" cellpadding="0" cellspacing="0"><tr>
            <td align="left"><span style="${PILL} padding:5px 14px; font-weight:700; font-size:12px; letter-spacing:2px;">${pills[0]}</span></td>
            ${pills[1] ? `<td align="right"><span style="${PILL} padding:5px 14px; font-weight:700; font-size:12px; letter-spacing:2px;">${pills[1]}</span></td>` : ''}
          </tr></table>
        </td></tr>` : ''}

        <tr><td align="center" style="padding:30px 24px 0;">
          <div style="font-style:italic; font-weight:800; font-size:46px; line-height:.95; letter-spacing:-1px;">${headline}</div>
        </td></tr>

        ${datePill ? `
        <tr><td align="center" style="padding:20px 24px 0;">
          <span style="${PILL} padding:7px 22px; font-weight:800; font-size:16px; letter-spacing:3px;">${datePill}</span>
        </td></tr>` : ''}

        ${sub ? `
        <tr><td align="center" style="padding:10px 24px 0;">
          <div style="font-weight:600; font-size:13px; letter-spacing:1px;">${sub}</div>
        </td></tr>` : ''}

        ${paragraphs ? `
        <tr><td style="padding:26px 30px 0; text-align:left;">
          ${paragraphs}
        </td></tr>` : ''}

        ${bullets ? `
        <tr><td style="padding:4px 30px 0;">
          <table width="100%" cellpadding="0" cellspacing="0"><tr>
            <td style="border:1.5px solid ${INK}; border-radius:12px; padding:12px 16px 6px; text-align:left;">
              ${bullets}
            </td>
          </tr></table>
        </td></tr>` : ''}

        ${paragraphsEn ? `
        <tr><td style="padding:24px 30px 0; text-align:left;">
          ${paragraphsEn}
        </td></tr>` : ''}

        ${bulletsEn ? `
        <tr><td style="padding:4px 30px 0;">
          <table width="100%" cellpadding="0" cellspacing="0"><tr>
            <td style="border:1.5px solid ${INK}; border-radius:12px; padding:12px 16px 6px; text-align:left;">
              ${bulletsEn}
            </td>
          </tr></table>
        </td></tr>` : ''}

        <tr><td align="center" style="padding:26px 24px 6px;">
          <table cellpadding="0" cellspacing="0"><tr>
            <td align="center" style="background:#ffffff; border-radius:16px; padding:18px 18px 12px;">
              <a href="${qrUrl}" style="text-decoration:none;"><img src="${qrUrl}" alt="Codigo QR" width="200" height="200" style="display:block;"></a>
              <div style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif; color:${INK}; font-weight:800; font-size:12px; letter-spacing:1px; margin-top:8px; text-transform:uppercase;">${guest.name}${guest.tier ? ` &middot; ${guest.tier}` : ''}</div>
            </td>
          </tr></table>
        </td></tr>
        <tr><td align="center" style="padding:0 24px 8px;">
          <a href="${qrUrl}" style="color:${INK}; font-size:11px; font-weight:600; text-decoration:underline;">Si el QR no aparece, click aqui</a>
        </td></tr>

        <tr><td style="padding:22px 24px 24px;">
          <table width="100%" cellpadding="0" cellspacing="0"><tr>
            <td align="left" style="font-style:italic; font-weight:800; font-size:13px; color:${INK};">${(Array.isArray(cfg.headline) ? cfg.headline.join(' ') : event.name)}</td>
            <td align="right" style="font-style:italic; font-weight:800; font-size:13px; color:${INK};">${datePill}</td>
          </tr></table>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const { data, error } = await getResend().emails.send({
    from: process.env.RESEND_FROM_EMAIL || 'Colectivo <noreply@tac.colectivo.live>',
    to: guest.email,
    subject: cfg.subject || `Tu acceso — ${event.name}`,
    html,
  });

  if (error) throw error;
  return data;
}

/**
 * Send a branded QR code email to a guest.
 */
async function sendGuestQrEmail({ guest, event, extraGuests = [] }) {
  if (!guest.email) {
    throw new Error('Guest has no email address');
  }

  // RSVP-tier guests on an event with rsvp_promo get the green variant.
  // Everyone else (sponsors, comps, other events) keeps the template below.
  const rsvpPromo = await getRsvpPromo(guest);
  if (rsvpPromo) {
    return sendRsvpGuestQrEmail({ guest, event, promo: rsvpPromo });
  }

  // If this guest came in through a table's magic link, show who invited them
  // and to which table. Looked up here so every send path (initial, resend,
  // fallback) includes it without each caller passing it.
  let invite = null;
  if (guest.invite_link_id) {
    const { data: link } = await supabase
      .from('invite_links')
      .select('label, manager_name')
      .eq('id', guest.invite_link_id)
      .single();
    if (link) invite = { tableLabel: link.label, managerName: link.manager_name };
  }

  // Encode the short code (fast, low-density QR); fall back to the legacy JWT.
  const qrUrl = await uploadQrImage(guest.short_code || guest.qr_token, guest.id);

  // Upload QRs for extras
  const extraQrs = [];
  for (const ext of extraGuests) {
    const extQrUrl = await uploadQrImage(ext.short_code || ext.qr_token, ext.id);
    extraQrs.push({ name: ext.name, url: extQrUrl });
  }

  const totalAccess = 1 + extraGuests.length;
  const color = event.brand_color || '#e74c3c';
  const bannerUrl = event.banner_url || '';
  const instructionsEs = event.email_instructions_es || '';
  const instructionsEn = event.email_instructions_en || '';

  const hasInstructions = instructionsEs || instructionsEn;

  // Build extra QR blocks
  const extraQrHtml = extraQrs.map((eq, i) => `
      <tr><td align="center" style="padding:0 0 8px;">
        <div style="font-family:'IBM Plex Mono','SF Mono','Courier New',monospace; color:#aaaaaa; font-size:11px; text-transform:uppercase; letter-spacing:3px; margin-bottom:10px; font-weight:600;">
          Acceso ${i + 2} / ${totalAccess}
        </div>
        <div style="background:#ffffff; padding:12px; display:inline-block;">
          <a href="${eq.url}" style="text-decoration:none;"><img src="${eq.url}" alt="Codigo QR" width="180" height="180" style="display:block;"></a>
        </div>
      </td></tr>
      <tr><td align="center" style="padding:0 0 24px;">
        <a href="${eq.url}" style="color:#888; font-size:10px; text-decoration:underline; letter-spacing:1px;">Si el QR no aparece, click aqui</a>
      </td></tr>
  `).join('');

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;700&display=swap" rel="stylesheet">
</head>
<body style="margin:0; padding:0; background:#000000;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#000000;">
    <tr><td align="center" style="padding:0;">
      <table width="520" cellpadding="0" cellspacing="0" style="max-width:520px; width:100%; background:#0a0a0a; font-family:'IBM Plex Mono','SF Mono','Courier New',monospace;">

        <!-- Banner -->
        ${bannerUrl ? `
        <tr><td style="padding:0;">
          <img src="${bannerUrl}" alt="${event.name}" width="520" style="width:100%; display:block; object-fit:cover;">
        </td></tr>
        ` : `
        <tr><td align="center" style="padding:40px 24px 20px;">
          <div style="color:#fff; font-size:20px; font-weight:700; letter-spacing:2px; text-transform:uppercase;">${event.name}</div>
        </td></tr>
        `}

        <!-- Divider -->
        <tr><td style="padding:0 32px;">
          <div style="border-top:1px solid ${color}44; height:0;"></div>
        </td></tr>

        <!-- Guest name + tier -->
        <tr><td align="center" style="padding:28px 24px 8px;">
          <div style="color:#ffffff; font-size:18px; font-weight:700; letter-spacing:3px; text-transform:uppercase;">
            ${guest.name}
          </div>
          <div style="color:#ffffff; font-size:13px; text-transform:uppercase; letter-spacing:4px; margin-top:10px; font-weight:700;">
            ${totalAccess > 1 ? `${totalAccess} ACCESOS` : '1 ACCESO'}${guest.tier ? ` &middot; ${guest.tier}` : ''}
          </div>
        </td></tr>
        ${invite && (invite.tableLabel || invite.managerName) ? `
        <tr><td align="center" style="padding:0 24px 4px;">
          <div style="color:#cfcfcf; font-size:12px; letter-spacing:1px;">
            ${invite.tableLabel ? `Mesa: <span style="color:#ffffff; font-weight:700;">${invite.tableLabel}</span>` : ''}${invite.managerName ? `${invite.tableLabel ? ' &middot; ' : ''}Te invita: <span style="color:#ffffff; font-weight:700;">${invite.managerName}</span>` : ''}
          </div>
        </td></tr>` : ''}

        <!-- Primary QR Code -->
        <tr><td align="center" style="padding:24px 24px 8px;">
          ${totalAccess > 1 ? `<div style="color:#aaaaaa; font-size:11px; text-transform:uppercase; letter-spacing:3px; margin-bottom:10px; font-weight:600;">Acceso 1 / ${totalAccess}</div>` : ''}
          <div style="background:#ffffff; padding:14px; display:inline-block;">
            <a href="${qrUrl}" style="text-decoration:none;"><img src="${qrUrl}" alt="Codigo QR" width="200" height="200" style="display:block;"></a>
          </div>
        </td></tr>
        <tr><td align="center" style="padding:0 24px ${extraQrs.length > 0 ? '20' : '28'}px;">
          <a href="${qrUrl}" style="color:#888; font-size:10px; text-decoration:underline; letter-spacing:1px;">Si el QR no aparece, click aqui</a>
        </td></tr>

        <!-- Extra QR Codes -->
        ${extraQrHtml}

        <!-- Instructions -->
        ${hasInstructions ? `
        <tr><td style="padding:0 32px;">
          <div style="border-top:1px solid #1a1a1a; height:0;"></div>
        </td></tr>

        ${instructionsEs ? `
        <tr><td align="center" style="padding:24px 32px 0;">
          <div style="color:#e5e5e5; font-size:13px; line-height:1.9; text-align:center;">
            ${formatInstructions(instructionsEs)}
          </div>
        </td></tr>
        ` : ''}

        ${instructionsEn ? `
        <tr><td align="center" style="padding:${instructionsEs ? '16' : '24'}px 32px 0;">
          <div style="color:#bbbbbb; font-size:12px; line-height:1.9; text-align:center;">
            ${formatInstructions(instructionsEn)}
          </div>
        </td></tr>
        ` : ''}
        ` : `
        <tr><td align="center" style="padding:0 32px 8px;">
          <div style="color:#bbbbbb; font-size:13px; letter-spacing:1px;">
            Presenta ${totalAccess > 1 ? 'estos codigos QR' : 'este codigo QR'} en la entrada
          </div>
        </td></tr>
        `}

        <!-- Footer -->
        <tr><td style="padding:24px 32px 0;">
          <div style="border-top:1px solid #141414; height:0;"></div>
        </td></tr>
        <tr><td align="center" style="padding:16px 24px 24px;">
          <span style="color:#2a2a2a; font-size:9px; letter-spacing:3px; text-transform:uppercase;">tac.colectivo.live</span>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const { data, error } = await getResend().emails.send({
    from: process.env.RESEND_FROM_EMAIL || 'Colectivo <noreply@tac.colectivo.live>',
    to: guest.email,
    subject: `🎟️ Acceso — ${event.name}`,
    html,
  });

  if (error) throw error;
  return data;
}

/**
 * Send a staff invitation email.
 */
async function sendStaffInviteEmail({ email, role, eventName, eventSlug, hasAccount }) {
  const webUrl = process.env.WEB_URL || 'https://tac.colectivo.live';
  const roleLabel = role === 'door' ? 'Puerta' : 'Staff';
  const loginUrl = hasAccount
    ? `${webUrl}/login.html`
    : `${webUrl}/login.html`;

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0; padding:0; background:#000; font-family:'Helvetica Neue',Arial,sans-serif;">
  <div style="max-width:480px; margin:0 auto; padding:40px 24px;">
    <div style="text-align:center; margin-bottom:24px;">
      <h1 style="color:#fff; font-size:14px; letter-spacing:3px; text-transform:uppercase; margin:0;">COLECTIVO</h1>
    </div>
    <div style="background:#0a0a0a; border:1px solid #222; padding:32px; text-align:center;">
      <h2 style="color:#fff; font-size:18px; font-weight:700; margin:0 0 8px;">Te han invitado como ${roleLabel}</h2>
      <p style="color:#888; font-size:14px; margin:0 0 24px;">${eventName}</p>

      <div style="text-align:left; color:#ccc; font-size:13px; line-height:1.7; font-weight:300; margin-bottom:24px;">
        ${role === 'door'
          ? `<p>Podrás ver la lista de invitados y escanear códigos QR en la entrada.</p>`
          : `<p>Podrás ver la lista de invitados, agregar personas y escanear códigos QR.</p>`
        }
      </div>

      ${!hasAccount ? `
      <p style="color:#e74c3c; font-size:12px; margin-bottom:16px;">Necesitas crear una cuenta con este email (${email}) para acceder.</p>
      ` : ''}

      <a href="${loginUrl}" style="display:inline-block; background:#e74c3c; color:#fff; text-decoration:none; padding:12px 32px; font-size:14px; font-weight:600; letter-spacing:1px; text-transform:uppercase;">
        ${hasAccount ? 'Ir a Colectivo' : 'Crear cuenta'}
      </a>
    </div>
    <p style="color:#333; font-size:10px; text-align:center; margin-top:24px; letter-spacing:2px; text-transform:uppercase;">Powered by tac.colectivo.live</p>
  </div>
</body>
</html>`;

  const { data, error } = await getResend().emails.send({
    from: process.env.RESEND_FROM_EMAIL || 'Colectivo <noreply@tac.colectivo.live>',
    to: email,
    subject: `🔑 Invitación — ${eventName}`,
    html,
  });

  if (error) throw error;
  return data;
}

/**
 * Send a BUNDLE of QR codes to a table's account manager in one email.
 * Used by the "undistributed QR" fallback: on the cutoff (e.g. event-day
 * morning), any quota a manager never handed out is generated as passes and
 * emailed to the manager so they can distribute them physically.
 *
 * @param {object}   args
 * @param {string}   args.managerEmail
 * @param {string}   [args.managerName]
 * @param {string}   args.tableLabel   - e.g. "Mesa 7" / "Palco 35"
 * @param {object}   args.event        - needs name, brand_color?, banner_url?
 * @param {object[]} args.guests       - each needs { id, name, qr_token }
 */
async function sendManagerQrBundle({ managerEmail, managerName, tableLabel, event, guests = [] }) {
  if (!managerEmail) throw new Error('Manager has no email address');
  if (!guests.length) throw new Error('No QRs to send');

  // Upload every QR to storage so the email embeds a public image URL.
  const items = [];
  for (const g of guests) {
    const url = await uploadQrImage(g.short_code || g.qr_token, g.id);
    items.push({ name: g.name, url });
  }

  const color = event.brand_color || '#e74c3c';
  const bannerUrl = event.banner_url || '';

  const qrBlocks = items.map((it, i) => `
      <tr><td align="center" style="padding:0 0 8px;">
        <div style="color:#aaaaaa; font-size:11px; text-transform:uppercase; letter-spacing:3px; margin-bottom:10px; font-weight:600;">
          ${it.name} &middot; ${i + 1}/${items.length}
        </div>
        <div style="background:#ffffff; padding:12px; display:inline-block;">
          <a href="${it.url}" style="text-decoration:none;"><img src="${it.url}" alt="Codigo QR" width="190" height="190" style="display:block;"></a>
        </div>
      </td></tr>
      <tr><td align="center" style="padding:0 0 24px;">
        <a href="${it.url}" style="color:#888; font-size:10px; text-decoration:underline; letter-spacing:1px;">Si el QR no aparece, click aqui</a>
      </td></tr>
  `).join('');

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;700&display=swap" rel="stylesheet">
</head>
<body style="margin:0; padding:0; background:#000000;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#000000;">
    <tr><td align="center" style="padding:0;">
      <table width="520" cellpadding="0" cellspacing="0" style="max-width:520px; width:100%; background:#0a0a0a; font-family:'IBM Plex Mono','SF Mono','Courier New',monospace;">

        ${bannerUrl ? `
        <tr><td style="padding:0;">
          <img src="${bannerUrl}" alt="${event.name}" width="520" style="width:100%; display:block; object-fit:cover;">
        </td></tr>
        ` : `
        <tr><td align="center" style="padding:40px 24px 20px;">
          <div style="color:#fff; font-size:20px; font-weight:700; letter-spacing:2px; text-transform:uppercase;">${event.name}</div>
        </td></tr>
        `}

        <tr><td style="padding:0 32px;">
          <div style="border-top:1px solid ${color}44; height:0;"></div>
        </td></tr>

        <tr><td align="center" style="padding:28px 24px 4px;">
          <div style="color:#ffffff; font-size:18px; font-weight:700; letter-spacing:3px; text-transform:uppercase;">${tableLabel}</div>
          <div style="color:#bbbbbb; font-size:12px; letter-spacing:2px; margin-top:10px;">
            ${managerName ? `${managerName} &middot; ` : ''}${items.length} ${items.length === 1 ? 'PASE SIN ASIGNAR' : 'PASES SIN ASIGNAR'}
          </div>
        </td></tr>

        <tr><td align="center" style="padding:18px 32px 22px;">
          <div style="color:#999999; font-size:12px; line-height:1.8;">
            Estos son los accesos de tu mesa que aun no repartiste. Cada QR es un acceso individual &mdash; compartelos con tus invitados.
          </div>
        </td></tr>

        ${qrBlocks}

        <tr><td style="padding:8px 32px 0;">
          <div style="border-top:1px solid #141414; height:0;"></div>
        </td></tr>
        <tr><td align="center" style="padding:16px 24px 24px;">
          <span style="color:#2a2a2a; font-size:9px; letter-spacing:3px; text-transform:uppercase;">tac.colectivo.live</span>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const { data, error } = await getResend().emails.send({
    from: process.env.RESEND_FROM_EMAIL || 'Colectivo <noreply@tac.colectivo.live>',
    to: managerEmail,
    subject: `🎟️ Pases de ${tableLabel} — ${event.name}`,
    html,
  });

  if (error) throw error;
  return data;
}

module.exports = { sendGuestQrEmail, sendStaffInviteEmail, sendManagerQrBundle };
