// NFC UID normalization. Single source of truth used by both the check-in
// lookup and the guestlist write paths, so a typed UID and a Pi-read UID
// collapse to the same canonical string in the database.
//
// Uppercase + strip whitespace, colons, underscores, dashes.
function normalizeNfcId(raw) {
  return String(raw || '').toUpperCase().replace(/[\s:_-]/g, '');
}

module.exports = { normalizeNfcId };
