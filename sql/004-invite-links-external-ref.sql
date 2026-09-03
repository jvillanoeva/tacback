-- 004 · invite_links.external_ref — idempotency key for machine-created links
--
-- Bars' table sales (Phase T) mint one invite link per fully-paid table order:
-- POST /api/internal/invite-links with external_ref = the Bars order id. Stripe
-- retries webhooks, and an operator can hit "Reintentar" — both must land on the
-- SAME link, never a second one that splits a table's guest quota in two.
--
-- The unique index is partial so every link created by a human (external_ref
-- null) stays unconstrained; only the machine-created ones are deduped.
alter table public.invite_links add column if not exists external_ref text;

create unique index if not exists invite_links_external_ref_key
  on public.invite_links (external_ref)
  where external_ref is not null;

comment on column public.invite_links.external_ref is
  'Opaque id from the system that requested this link (Bars table_orders.id). Unique when set — the idempotency key for POST /api/internal/invite-links.';

-- created_by references auth.users and was NOT NULL because every link used to
-- come from a logged-in owner. A service-token caller has no user session, so
-- the column becomes nullable; a null now reads as "created by a machine", and
-- external_ref says which one.
alter table public.invite_links alter column created_by drop not null;
