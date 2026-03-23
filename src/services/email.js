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
 * Convert plain text with * bullets to HTML.
 */
function formatInstructions(text) {
  if (!text) return '';
  return text.split('\n').map(line => {
    const trimmed = line.trim();
    if (!trimmed) return '<br>';
    if (trimmed.startsWith('* ') || trimmed.startsWith('- ')) {
      return `<div style="padding-left:16px; margin:3px 0; font-weight:300;">• ${trimmed.slice(2)}</div>`;
    }
    return `<div style="margin:8px 0; font-weight:700; font-size:14px; letter-spacing:0.5px;">${trimmed}</div>`;
  }).join('');
}

/**
 * Send a branded QR code email to a guest.
 */
async function sendGuestQrEmail({ guest, event }) {
  if (!guest.email) {
    throw new Error('Guest has no email address');
  }

  const qrUrl = await uploadQrImage(guest.qr_token, guest.id);

  const color = event.brand_color || '#e74c3c';
  const bannerUrl = event.banner_url || '';
  const instructionsEs = event.email_instructions_es || '';
  const instructionsEn = event.email_instructions_en || '';

  const hasInstructions = instructionsEs || instructionsEn;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0; padding:0; background:#000000; font-family:'HelveticaNeue-CondensedBold','Helvetica Neue',Helvetica,Arial,sans-serif;">
  <div style="max-width:520px; margin:0 auto; background:#0a0a0a;">

    ${bannerUrl ? `
    <div style="width:100%; overflow:hidden;">
      <img src="${bannerUrl}" alt="${event.name}" style="width:100%; display:block; object-fit:cover;">
    </div>
    ` : `
    <div style="padding:32px 24px 16px; text-align:center;">
      <h1 style="color:#fff; font-size:24px; margin:0; letter-spacing:1px;">${event.name}</h1>
    </div>
    `}

    <div style="padding:24px;">

      <!-- Guest info -->
      <div style="text-align:center; margin-bottom:20px;">
        <div style="color:#ffffff; font-size:20px; font-weight:700; letter-spacing:1px; text-transform:uppercase;">
          ${guest.name}
        </div>
        ${guest.tier ? `<div style="color:${color}; font-size:12px; text-transform:uppercase; letter-spacing:3px; margin-top:6px; font-weight:700;">${guest.tier}</div>` : ''}
      </div>

      ${hasInstructions ? `
      <!-- Instructions ES -->
      ${instructionsEs ? `
      <div style="border-top:1px solid #222; padding-top:20px; margin-bottom:20px;">
        <div style="color:#cccccc; font-size:13px; line-height:1.7; font-weight:300;">
          ${formatInstructions(instructionsEs)}
        </div>
      </div>
      ` : ''}

      <!-- Instructions EN -->
      ${instructionsEn ? `
      <div style="border-top:1px solid #222; padding-top:20px; margin-bottom:20px;">
        <div style="color:#888888; font-size:12px; line-height:1.7; font-weight:300;">
          ${formatInstructions(instructionsEn)}
        </div>
      </div>
      ` : ''}
      ` : `
      <div style="text-align:center; color:#666; font-size:13px; margin-bottom:24px;">
        Presenta este código QR en la entrada
      </div>
      `}

      <!-- QR Code -->
      <div style="text-align:center; margin-bottom:24px;">
        <div style="background:#ffffff; border-radius:4px; padding:16px; display:inline-block;">
          <img src="${qrUrl}" alt="QR Code" width="240" height="240" style="display:block;">
        </div>
      </div>

      <!-- Footer -->
      <div style="border-top:1px solid #1a1a1a; padding-top:16px; text-align:center;">
        <span style="color:#333; font-size:10px; letter-spacing:2px; text-transform:uppercase;">Powered by colectivo.live</span>
      </div>
    </div>
  </div>
</body>
</html>`;

  const { data, error } = await getResend().emails.send({
    from: process.env.RESEND_FROM_EMAIL || 'Colectivo <noreply@colectivo.live>',
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
  const webUrl = process.env.WEB_URL || 'https://www.colectivo.live';
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
    <p style="color:#333; font-size:10px; text-align:center; margin-top:24px; letter-spacing:2px; text-transform:uppercase;">Powered by colectivo.live</p>
  </div>
</body>
</html>`;

  const { data, error } = await getResend().emails.send({
    from: process.env.RESEND_FROM_EMAIL || 'Colectivo <noreply@colectivo.live>',
    to: email,
    subject: `🔑 Invitación — ${eventName}`,
    html,
  });

  if (error) throw error;
  return data;
}

module.exports = { sendGuestQrEmail, sendStaffInviteEmail };
