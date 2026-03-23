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

module.exports = { sendGuestQrEmail };
