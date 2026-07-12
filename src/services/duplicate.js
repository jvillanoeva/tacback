const { supabase } = require('../lib/supabase');

/**
 * Shared "duplicate event onto a new date" logic, used by both the dashboard
 * route (POST /api/events/:slug/duplicate) and the headless internal route
 * (POST /api/internal/events/:slug/duplicate) so the two can't drift.
 *
 * Copies settings only — never guests, staff, invite links, or door_token —
 * and the copy always starts unpublished.
 */

const ES_DAYS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const ES_MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

// "2026-07-12" → "Domingo 12 de julio de 2026" (parsed as a plain date, no TZ math)
function formatDateES(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${ES_DAYS[day]} ${d} de ${ES_MONTHS[m - 1]} de ${y}`;
}

// Trailing date patterns rewritten when deriving the copy's slug/name:
// slug "...-05-07-26" and name "...: 05.07.26"
const SLUG_DATE_RE = /-\d{2}-\d{2}-\d{2}$/;
const NAME_DATE_RE = /\d{2}\.\d{2}\.\d{2}$/;

// Everything a copy inherits. Explicitly NOT copied: id, slug, name, date,
// date_label (derived from the new date), published (starts false),
// door_token (per-event door secret), ra_event_id, owner_id, created_at,
// updated_at, imported_at.
const DUPLICATE_FIELDS = [
  'subtitle', 'time_label', 'venue', 'city', 'description', 'banner_url',
  'dos', 'donts', 'restrictions', 'map_url', 'address', 'layout_url',
  'contact_email', 'contact_phone', 'contact_instagram', 'sponsors',
  'tiers', 'brand_color', 'logo_url', 'promoter_name',
  'email_instructions_es', 'email_instructions_en', 'organization_id',
  'rsvp_promo',
];

/**
 * Duplicate `src` (a full events row) onto `ymd` ("YYYY-MM-DD").
 * overrides: { slug?, name?, owner_id? } — owner_id defaults to src.owner_id.
 *
 * Returns { data } on success or { error, status } on failure.
 */
async function duplicateEvent(src, ymd, overrides = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd || '')) {
    return { error: 'date is required (YYYY-MM-DD)', status: 400 };
  }

  const [y, m, d] = ymd.split('-');
  const ddmmyy = `${d}-${m}-${y.slice(2)}`;             // 12-07-26
  const dotted = ddmmyy.replace(/-/g, '.');             // 12.07.26

  let slug = (overrides.slug || '').trim().toLowerCase();
  if (!slug) {
    slug = SLUG_DATE_RE.test(src.slug)
      ? src.slug.replace(SLUG_DATE_RE, `-${ddmmyy}`)
      : `${src.slug}-${ddmmyy}`.substring(0, 60);
  }
  let name = (overrides.name || '').trim();
  if (!name) {
    name = NAME_DATE_RE.test(src.name)
      ? src.name.replace(NAME_DATE_RE, dotted)
      : `${src.name} ${dotted}`;
  }

  const copy = {
    slug,
    name,
    owner_id: overrides.owner_id || src.owner_id,
    published: false,
  };
  for (const f of DUPLICATE_FIELDS) copy[f] = src[f];
  copy.date = `${ymd}T00:00:00-06:00`;   // matches the editor's convention (CDMX)
  copy.date_label = formatDateES(ymd);

  const { data, error } = await supabase
    .from('events')
    .insert(copy)
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      return { error: 'An event with this slug already exists', status: 409, slug };
    }
    return { error: error.message, status: 500 };
  }

  return {
    data: {
      ...data,
      duplicated_from: src.slug,
      notes: src.rsvp_promo ? ['rsvp_promo was copied — review its dates/pricing'] : [],
    },
  };
}

module.exports = { duplicateEvent, formatDateES };
