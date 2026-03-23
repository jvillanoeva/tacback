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
 * Send a branded QR code email to a guest.
 */
async function sendGuestQrEmail({ guest, event }) {
  if (!guest.email) {
    throw new Error('Guest has no email address');
  }

  const qrUrl = await uploadQrImage(guest.qr_token, guest.id);

  const color = event.brand_color || '#e74c3c';
  const bannerUrl = event.banner_url || '';
  const logoUrl = event.logo_url || '';
  const promoter = event.promoter_name || '';

  // Header: logo image if available, otherwise event name in text
  const headerHtml = logoUrl
    ? `<img src="${logoUrl}" alt="${event.name}" style="max-width:280px; max-height:80px; display:block; margin:0 auto;">`
    : `<h1 style="color:#ffffff; font-size:22px; font-weight:700; margin:0; letter-spacing:1px;">${event.name}</h1>`;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0; padding:0; background:#0a0a0a; font-family:'Helvetica Neue',Arial,sans-serif;">
  <div style="max-width:480px; margin:0 auto;">

    ${bannerUrl ? `
    <div style="width:100%; overflow:hidden;">
      <img src="${bannerUrl}" alt="${event.name}" style="width:100%; display:block; object-fit:cover; max-height:240px;">
    </div>
    ` : ''}

    <div style="padding:32px 24px;">

      <div style="text-align:center; margin-bottom:24px;">
        ${headerHtml}
        ${logoUrl ? `<h2 style="color:#ffffff; font-size:18px; font-weight:600; margin:12px 0 0;">${event.name}</h2>` : ''}
        ${event.subtitle ? `<p style="color:#999; font-size:14px; margin:4px 0 0;">${event.subtitle}</p>` : ''}
      </div>

      <div style="text-align:center; color:#888; font-size:13px; margin-bottom:24px; line-height:1.6;">
        ${event.date_label || ''}${event.time_label ? ' &middot; ' + event.time_label : ''}<br>
        ${event.venue || ''}${event.city ? ', ' + event.city : ''}
      </div>

      <div style="border:1px solid ${color}; border-radius:8px; padding:24px; text-align:center; margin-bottom:24px;">
        <div style="background:#ffffff; border-radius:6px; padding:16px; display:inline-block; margin-bottom:16px;">
          <img src="${qrUrl}" alt="QR Code" width="260" height="260" style="display:block;">
        </div>

        <div style="margin-bottom:8px;">
          <span style="color:#ffffff; font-size:18px; font-weight:700;">
            ${guest.name}
          </span>
        </div>
        ${guest.tier ? `<div style="margin-bottom:8px;"><span style="color:${color}; font-size:12px; text-transform:uppercase; letter-spacing:2px; font-weight:600;">${guest.tier}</span></div>` : ''}
        ${guest.notes ? `<div style="color:#888; font-size:13px;">${guest.notes}</div>` : ''}
      </div>

      <p style="color:#666; font-size:12px; text-align:center; margin:0 0 24px;">
        Presenta este código QR en la entrada
      </p>

      <div style="border-top:1px solid #222; padding-top:16px; text-align:center;">
        ${promoter ? `<p style="color:#555; font-size:11px; margin:0 0 4px;">Presentado por ${promoter}</p>` : ''}
        <p style="color:#333; font-size:10px; margin:0;">Powered by colectivo.live</p>
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

module.exports = { sendGuestQrEmail };
