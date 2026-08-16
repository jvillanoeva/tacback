const { Router } = require('express');
const XLSX = require('xlsx');
const { supabase } = require('../lib/supabase');
const { requireAuth, requireEventAccess } = require('../middleware/auth');

const router = Router({ mergeParams: true });

// Download Excel report for an event
router.get('/', requireAuth, requireEventAccess(['owner', 'staff']), async (req, res) => {
  const event = req.event;

  // Fetch all guests
  const { data: guests, error } = await supabase
    .from('guests')
    .select('name, email, phone, notes, tier, requested_by, industry, checked_in, checked_in_at, email_sent, created_at, group_id')
    .eq('event_id', event.id)
    .order('created_at', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });

  const allGuests = guests || [];
  const total = allGuests.length;
  const checkedIn = allGuests.filter(g => g.checked_in).length;
  const pending = total - checkedIn;
  const emailsSent = allGuests.filter(g => g.email_sent).length;
  const attendanceRate = total > 0 ? Math.round((checkedIn / total) * 100) : 0;

  // Tier breakdown
  const tierMap = {};
  for (const g of allGuests) {
    const tier = g.tier || 'Sin categoría';
    if (!tierMap[tier]) tierMap[tier] = { total: 0, checked_in: 0 };
    tierMap[tier].total++;
    if (g.checked_in) tierMap[tier].checked_in++;
  }

  // Origin breakdown (guests.requested_by) — "de dónde vino cada invitado".
  // The field is free text, so fold case/accents/whitespace to keep "PR", "pr"
  // and "Pr " in one bucket, and label it with the most common spelling.
  const NO_SOURCE = 'Sin origen';
  const sourceBuckets = new Map();
  for (const g of allGuests) {
    const raw = (g.requested_by == null ? '' : String(g.requested_by)).trim().replace(/\s+/g, ' ');
    const label = raw === '' ? NO_SOURCE : raw;
    const key = raw === ''
      ? NO_SOURCE
      : raw.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (!sourceBuckets.has(key)) sourceBuckets.set(key, { total: 0, checked_in: 0, labels: new Map() });
    const b = sourceBuckets.get(key);
    b.total++;
    if (g.checked_in) b.checked_in++;
    b.labels.set(label, (b.labels.get(label) || 0) + 1);
  }
  const sourceRows = [...sourceBuckets.entries()]
    .map(([key, b]) => ({
      key,
      label: [...b.labels.entries()].sort((x, y) => y[1] - x[1])[0][0],
      total: b.total,
      checked_in: b.checked_in,
    }))
    .sort((a, b) => {
      if (a.key === NO_SOURCE) return 1;   // unattributed never leads the table
      if (b.key === NO_SOURCE) return -1;
      return b.total - a.total || a.label.localeCompare(b.label, 'es');
    });

  // --- Build workbook ---
  const wb = XLSX.utils.book_new();

  // Sheet 1: Summary
  const summaryData = [
    ['REPORTE DE EVENTO'],
    [],
    ['Evento', event.name],
    ['Fecha', event.date_label || ''],
    ['Venue', event.venue || ''],
    ['Ciudad', event.city || ''],
    [],
    ['RESUMEN'],
    ['Total invitados', total],
    ['Asistieron', checkedIn],
    ['No asistieron', pending],
    ['Tasa de asistencia', `${attendanceRate}%`],
    ['Emails enviados', emailsSent],
    [],
    ['DESGLOSE POR CATEGORÍA'],
    ['Categoría', 'Invitados', 'Asistieron', '% Asistencia'],
  ];

  for (const [tier, stats] of Object.entries(tierMap)) {
    const rate = stats.total > 0 ? Math.round((stats.checked_in / stats.total) * 100) : 0;
    summaryData.push([tier, stats.total, stats.checked_in, `${rate}%`]);
  }

  summaryData.push([]);
  summaryData.push(['DESGLOSE POR ORIGEN']);
  summaryData.push(['Origen', 'Invitados', 'Asistieron', '% Asistencia']);
  for (const s of sourceRows) {
    const rate = s.total > 0 ? Math.round((s.checked_in / s.total) * 100) : 0;
    summaryData.push([s.label, s.total, s.checked_in, `${rate}%`]);
  }

  const summarySheet = XLSX.utils.aoa_to_sheet(summaryData);
  summarySheet['!cols'] = [{ wch: 25 }, { wch: 15 }, { wch: 15 }, { wch: 15 }];
  XLSX.utils.book_append_sheet(wb, summarySheet, 'Resumen');

  // Sheet 2: Full guest list
  const guestRows = allGuests.map(g => ({
    'Nombre': g.name,
    'Email': g.email || '',
    'Teléfono': g.phone || '',
    'Categoría': g.tier || '',
    'Origen': g.requested_by || '',
    'Tipo de invitado': g.industry || '',
    'Notas': g.notes || '',
    'Check-in': g.checked_in ? 'Sí' : 'No',
    'Hora check-in': g.checked_in_at ? new Date(g.checked_in_at).toLocaleString('es-MX') : '',
    'Email enviado': g.email_sent ? 'Sí' : 'No',
    'Fecha añadido': new Date(g.created_at).toLocaleString('es-MX'),
  }));

  const guestSheet = XLSX.utils.json_to_sheet(guestRows);
  guestSheet['!cols'] = [
    { wch: 30 }, { wch: 30 }, { wch: 15 }, { wch: 15 }, { wch: 20 }, { wch: 18 },
    { wch: 25 }, { wch: 10 }, { wch: 20 }, { wch: 12 }, { wch: 20 },
  ];
  XLSX.utils.book_append_sheet(wb, guestSheet, 'Invitados');

  // Sheet 3: Check-ins only (for quick review)
  const checkinRows = allGuests
    .filter(g => g.checked_in)
    .sort((a, b) => new Date(a.checked_in_at) - new Date(b.checked_in_at))
    .map((g, i) => ({
      '#': i + 1,
      'Nombre': g.name,
      'Categoría': g.tier || '',
      'Origen': g.requested_by || '',
      'Hora': g.checked_in_at ? new Date(g.checked_in_at).toLocaleString('es-MX') : '',
    }));

  const checkinSheet = XLSX.utils.json_to_sheet(checkinRows);
  checkinSheet['!cols'] = [{ wch: 5 }, { wch: 30 }, { wch: 15 }, { wch: 20 }, { wch: 20 }];
  XLSX.utils.book_append_sheet(wb, checkinSheet, 'Asistencia');

  // Generate buffer
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const filename = `${event.slug}-reporte.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buf);
});

module.exports = router;
