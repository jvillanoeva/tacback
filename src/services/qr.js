const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');

const QR_SECRET = () => process.env.QR_SECRET || 'colectivo-qr-default-secret';

/**
 * Generate a signed QR token for a guest.
 */
function createQrToken(guestId, eventId) {
  return jwt.sign(
    { gid: guestId, eid: eventId },
    QR_SECRET(),
    { expiresIn: '365d' }
  );
}

/**
 * Verify and decode a QR token.
 * Returns { gid, eid } or throws.
 */
function verifyQrToken(token) {
  return jwt.verify(token, QR_SECRET());
}

/**
 * Generate QR code as data URL (for embedding in email).
 */
async function generateQrDataUrl(token) {
  return QRCode.toDataURL(token, {
    width: 400,
    margin: 2,
    color: { dark: '#080808', light: '#ffffff' },
  });
}

/**
 * Generate QR code as PNG buffer (for email attachment).
 */
async function generateQrBuffer(token) {
  return QRCode.toBuffer(token, {
    width: 400,
    margin: 2,
    color: { dark: '#080808', light: '#ffffff' },
  });
}

module.exports = { createQrToken, verifyQrToken, generateQrDataUrl, generateQrBuffer };
