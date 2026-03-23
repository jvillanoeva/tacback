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
 * Send a QR code email to a guest.
 */
async function sendGuestQrEmail({ guest, event }) {
  if (!guest.email) {
    throw new Error('Guest has no email address');
  }

  // Upload QR to storage so it works in all email clients
  const qrUrl = await uploadQrImage(guest.qr_token, guest.id);

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0; padding:0; background:#0a0a0a; font-family:'Helvetica Neue',Arial,sans-serif;">
  <div style="max-width:480px; margin:0 auto; padding:40px 24px;">

    <div style="text-align:center; margin-bottom:32px;">
      <h1 style="color:#ffffff; font-size:14px; letter-spacing:3px; text-transform:uppercase; margin:0;">
        COLECTIVO
      </h1>
    </div>

    <div style="background:#111; border:1px solid #222; border-radius:12px; padding:32px; text-align:center;">

      <h2 style="color:#fff; font-size:20px; margin:0 0 4px;">
        ${event.name}
      </h2>
      ${event.subtitle ? `<p style="color:#888; font-size:14px; margin:0 0 16px;">${event.subtitle}</p>` : ''}

      <div style="color:#aaa; font-size:13px; margin-bottom:24px;">
        ${event.date_label || ''}${event.time_label ? ' &middot; ' + event.time_label : ''}<br>
        ${event.venue || ''}${event.city ? ', ' + event.city : ''}
      </div>

      <div style="background:#fff; border-radius:8px; padding:16px; display:inline-block; margin-bottom:24px;">
        <img src="${qrUrl}" alt="QR Code" width="280" height="280" style="display:block;">
      </div>

      <div style="margin-bottom:16px;">
        <span style="color:#fff; font-size:16px; font-weight:600;">
          ${guest.name}
        </span>
        ${guest.tier ? `<br><span style="color:#e74c3c; font-size:13px; text-transform:uppercase; letter-spacing:1px;">${guest.tier}</span>` : ''}
        ${guest.notes ? `<br><span style="color:#888; font-size:13px;">${guest.notes}</span>` : ''}
      </div>

      <p style="color:#666; font-size:12px; margin:0;">
        Presenta este código QR en la entrada
      </p>
    </div>

    <p style="color:#444; font-size:11px; text-align:center; margin-top:24px;">
      colectivo.live
    </p>
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
