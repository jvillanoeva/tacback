const { Router } = require('express');
const { supabase } = require('../lib/supabase');
const { verifyUnsubToken } = require('../lib/unsub');

const router = Router();

/**
 * Public unsubscribe. The click IS the measurement: every hit upserts a row
 * in email_suppressions (unique on lower(email)), and the send pipeline
 * (services/claim.js sendInviteBulk) excludes suppressed addresses.
 *
 * GET  /api/unsub/:payload  — link in the email footer; shows a tiny page.
 * POST /api/unsub/:payload  — RFC 8058 one-click (List-Unsubscribe-Post).
 */

async function suppress(email, source, req) {
  const { error } = await supabase
    .from('email_suppressions')
    .upsert(
      {
        email,
        source,
        user_agent: (req.get('user-agent') || '').slice(0, 300),
      },
      { onConflict: 'email', ignoreDuplicates: true }
    );
  if (error) throw new Error(error.message);
}

function page(title, body) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>${title}</title></head>
<body style="margin:0;background:#101410;color:#fff;font-family:Helvetica,Arial,sans-serif;
display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px;text-align:center;">
<div style="max-width:420px;">
  <div style="font-size:26px;font-weight:800;color:#75ff5a;margin-bottom:14px;">${title}</div>
  <div style="font-size:15px;line-height:1.6;color:#b9c4b5;">${body}</div>
</div></body></html>`;
}

router.get('/:payload', async (req, res) => {
  const email = verifyUnsubToken(req.params.payload);
  if (!email) return res.status(400).send(page('Link no válido', 'Este link de baja no es válido.'));
  try {
    await suppress(email, 'link', req);
  } catch (e) {
    console.error('unsub failed:', e.message);
    return res.status(500).send(page('Algo salió mal', 'Inténtalo de nuevo en un momento.'));
  }
  res.send(page('Listo', 'No volverás a recibir correos de nuestra parte.<br>Gracias por haber sido parte.'));
});

// RFC 8058 one-click (mail clients POST here without showing a page).
router.post('/:payload', async (req, res) => {
  const email = verifyUnsubToken(req.params.payload);
  if (!email) return res.status(400).json({ error: 'invalid token' });
  try {
    await suppress(email, 'one_click', req);
  } catch (e) {
    console.error('unsub one-click failed:', e.message);
    return res.status(500).json({ error: 'internal' });
  }
  res.json({ ok: true });
});

module.exports = router;
