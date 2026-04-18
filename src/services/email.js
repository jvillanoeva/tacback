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
 * Send a branded QR code email to a guest.
 */
async function sendGuestQrEmail({ guest, event, extraGuests = [] }) {
  if (!guest.email) {
    throw new Error('Guest has no email address');
  }

  // Upload QR for primary guest
  const qrUrl = await uploadQrImage(guest.qr_token, guest.id);

  // Upload QRs for extras
  const extraQrs = [];
  for (const ext of extraGuests) {
    const extQrUrl = await uploadQrImage(ext.qr_token, ext.id);
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

module.exports = { sendGuestQrEmail, sendStaffInviteEmail };
