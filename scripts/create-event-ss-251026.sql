-- Configure event: Sunday Sunday CDMX 25.10.26 (early-access campaign).
--
-- The row already exists (Jorge created it in the dashboard, flyer uploaded):
--   id   0f31a590-fae2-41a5-bebb-2a0f01e96ed3
--   slug sunday-sunday-cdmx-25-10-26
-- This script UPDATEs claim_flow + rsvp_promo on that row only. It does not
-- touch banner_url, name, date, date_label, slug or published, and it only
-- READS the source event (af2cb113-d286-4f59-89e6-c6a1ba31e22a, 18.10.26).
-- Guarded by `claim_flow is null`, so it can never run twice (a second run
-- updates 0 rows and would otherwise rotate the blast secret).
--
-- claim_flow — copied from the source event, then:
--   copy        "18 de octubre" -> "25 de octubre", "18.10.26" -> "25.10.26"
--               (invite html, tickets subject). No other copy touched.
--   enabled     true
--   cap         500  (enforced in claim_guest_access, sql/007)
--   ttl_hours   46
--   art_url     this row's banner_url (the new 25.10 flyer). This is the
--               top-level claim_flow.art_url — the key publicView (confirm
--               page banner) and claimArtUrl (mail art) actually read; the
--               source's art_url pointed at the dated 18.10 flyer.
--   blast       { secret: fresh random (generated here, never in git),
--                 fired_at: null }
--
-- ttl_hours arithmetic — links must expire Sun 25.10 12:00 CDMX ("Confirma
-- hasta el domingo al mediodía", as the approved invite copy says).
--   CDMX is UTC-6 all year (no DST since 2022).
--   Planned fire: Fri 24.10 14:00 CDMX = 2026-10-24 20:00 UTC.
--   Fri 14:00 -> Sat 14:00 = 24 h
--   Sat 14:00 -> Sun 12:00 = 22 h
--   ttl_hours              = 46  -> expires 2026-10-25 18:00 UTC = Sun 12:00 CDMX
--   sendInviteBulk stamps expiry once, at the start of the blast call, so a
--   late fire expires late by the same amount.
--
-- rsvp_promo — door promo ("offer A"): first 500 QR entries free until 17:00,
-- then $400. cutoff='17:00', free_slots=500, price_after=400, full_price=400.
-- rsvp_promo.email.date_pill -> '25.10.26'.
-- NOTE: the rsvp_promo.email template is DORMANT for this campaign. RSVP rows
-- receive their QR through the claim flow's tickets template (mail 2), and the
-- claim-flow guard blocks send-qr / send-all / create+send for RSVP rows. Its
-- copy ("HOY", "toda la noche") is last week's and is deliberately NOT
-- rewritten here.

update public.events tgt
   set claim_flow =
         replace(replace(src.claim_flow::text,
                         '18 de octubre', '25 de octubre'),
                         '18.10.26', '25.10.26')::jsonb
         || jsonb_build_object(
              'enabled',   true,
              'cap',       500,
              'ttl_hours', 46,
              'art_url',   tgt.banner_url,
              'blast',     jsonb_build_object(
                             'secret',   rtrim(translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/', '-_'), '='),
                             'fired_at', null)),
       rsvp_promo =
         jsonb_set(tgt.rsvp_promo, '{email,date_pill}', '"25.10.26"')
         || jsonb_build_object(
              'cutoff',      '17:00',
              'free_slots',  500,
              'price_after', 400,
              'full_price',  400),
       updated_at = now()
  from public.events src
 where src.id  = 'af2cb113-d286-4f59-89e6-c6a1ba31e22a'
   and tgt.id  = '0f31a590-fae2-41a5-bebb-2a0f01e96ed3'
   and tgt.slug = 'sunday-sunday-cdmx-25-10-26'
   and tgt.claim_flow is null
returning tgt.id;

-- Read-back (prints secret presence + length, not the secret itself):
select id, slug, published,
       claim_flow->'enabled'                          as enabled,
       claim_flow->'cap'                              as cap,
       claim_flow->'ttl_hours'                        as ttl_hours,
       claim_flow->>'art_url' = banner_url            as art_url_is_banner,
       length(claim_flow->'blast'->>'secret')         as secret_len,
       claim_flow->'blast'->'fired_at'                as fired_at,
       claim_flow->'invite'->>'subject'               as invite_subject,
       claim_flow->'tickets'->>'subject'              as tickets_subject,
       rsvp_promo->>'cutoff'                          as cutoff,
       rsvp_promo->'free_slots'                       as free_slots,
       rsvp_promo->'price_after'                      as price_after,
       rsvp_promo->'full_price'                       as full_price,
       rsvp_promo->'email'->>'date_pill'              as date_pill,
       position('18.10' in claim_flow::text || rsvp_promo::text) = 0
         and claim_flow::text || rsvp_promo::text !~* '18 de oct' as no_old_dates
  from public.events
 where id = '0f31a590-fae2-41a5-bebb-2a0f01e96ed3';
