-- 006 · guests: what actually happened to the QR email
--
-- `guests.email_sent` has always meant "Resend accepted it", never "it
-- arrived" — the same gap Bars had on its buyer emails. A guest whose QR
-- bounced is indistinguishable from one holding a valid pass until they are
-- standing at the door.
--
-- Resend's webhook knows only a message id, so we have to keep it. Bars owns
-- the webhook endpoint (it is the project with the Resend keys) and forwards
-- anything it does not recognise to POST /api/internal/email-events.
alter table public.guests add column if not exists email_message_id  text;
alter table public.guests add column if not exists email_status      text;
alter table public.guests add column if not exists email_status_at   timestamptz;

comment on column public.guests.email_message_id is
  'Resend message id for the QR email, so a later delivered/bounced webhook can find this guest.';
comment on column public.guests.email_status is
  'delivered | bounced | complained — from Resend. Null means nothing came back; email_sent alone only means Resend accepted it.';

create index if not exists guests_email_message_id_idx
  on public.guests (email_message_id)
  where email_message_id is not null;
