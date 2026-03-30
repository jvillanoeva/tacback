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
    .select('name, email, phone, notes, tier, checked_in, checked_in_at, email_sent, created_at, group_id')
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

  const summarySheet = XLSX.utils.aoa_to_sheet(summaryData);
  summarySheet['!cols'] = [{ wch: 25 }, { wch: 15 }, { wch: 15 }, { wch: 15 }];
  XLSX.utils.book_append_sheet(wb, summarySheet, 'Resumen');

  // Sheet 2: Full guest list
  const guestRows = allGuests.map(g => ({
    'Nombre': g.name,
    'Email': g.email || '',
    'Teléfono': g.phone || '',
    'Categoría': g.tier || '',
    'Notas': g.notes || '',
    'Check-in': g.checked_in ? 'Sí' : 'No',
    'Hora check-in': g.checked_in_at ? new Date(g.checked_in_at).toLocaleString('es-MX') : '',
    'Email enviado': g.email_sent ? 'Sí' : 'No',
    'Fecha añadido': new Date(g.created_at).toLocaleString('es-MX'),
  }));

  const guestSheet = XLSX.utils.json_to_sheet(guestRows);
  guestSheet['!cols'] = [
    { wch: 30 }, { wch: 30 }, { wch: 15 }, { wch: 15 },
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
      'Hora': g.checked_in_at ? new Date(g.checked_in_at).toLocaleString('es-MX') : '',
    }));

  const checkinSheet = XLSX.utils.json_to_sheet(checkinRows);
  checkinSheet['!cols'] = [{ wch: 5 }, { wch: 30 }, { wch: 15 }, { wch: 20 }];
  XLSX.utils.book_append_sheet(wb, checkinSheet, 'Asistencia');

  // Generate buffer
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const filename = `${event.slug}-reporte.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buf);
});

module.exports = router;
