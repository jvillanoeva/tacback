-- 003 · RSVP door promo (Sunday Sunday 05.07.26 — generic mechanism)
--
-- events.rsvp_promo (jsonb, nullable) scopes the whole feature: promo logic in
-- the check-in routes runs ONLY when this is set AND guest.tier = 'RSVP'.
-- Null → every other event and guest behaves byte-identically to before.
--
-- Shape:
-- {
--   "free_slots": 100,          -- first N RSVP gate check-ins are free
--   "price_after": 200,         -- price for slot N+1.. before cutoff
--   "full_price": 400,          -- full cover (shown on expired QR / manual after cutoff)
--   "cutoff": "16:00",          -- local (America/Mexico_City) HH:MM; QR rejected at/after
--   "email": { ... }            -- optional green-template fields (see email.js)
-- }

alter table public.events add column if not exists rsvp_promo jsonb;

-- Settlement truth, written once at first gate scan. promo_slot is the guest's
-- position in the RSVP check-in order (1-based); promo_price the MXN amount
-- assigned at that moment (0 = gratis).
alter table public.guests add column if not exists promo_price integer;
alter table public.guests add column if not exists promo_slot  integer;

-- Atomic gate check-in + slot assignment for RSVP guests.
--
-- The Node API's normal gate claim (UPDATE ... IS NULL) is atomic per guest,
-- but slot numbering needs "count then write" across rows — racy from the API.
-- This function serializes RSVP check-ins per event with an advisory xact lock
-- so two simultaneous scans can never both take slot free_slots (#100).
--
-- Returns: { claimed: bool, slot: int, price: int }
--   claimed=false → another scan already checked this guest in (caller re-reads
--   the stored promo_price/promo_slot for the "ya escaneado" display).
create or replace function public.rsvp_gate_checkin(
  p_guest_id   uuid,
  p_event_id   uuid,
  p_free_slots int,
  p_price_after int,
  p_scanned_by uuid default null
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_slot  int;
  v_price int;
begin
  perform pg_advisory_xact_lock(hashtext('rsvp_slot:' || p_event_id::text));

  update public.guests
     set gate_scanned_at = now(),
         gate_scanned_by = p_scanned_by,
         checked_in      = true,
         checked_in_at   = now(),
         checked_in_by   = p_scanned_by
   where id = p_guest_id
     and event_id = p_event_id
     and gate_scanned_at is null;

  if not found then
    return jsonb_build_object('claimed', false);
  end if;

  select count(*) into v_slot
    from public.guests
   where event_id = p_event_id
     and tier = 'RSVP'
     and gate_scanned_at is not null;

  v_price := case when v_slot <= p_free_slots then 0 else p_price_after end;

  update public.guests
     set promo_price = v_price,
         promo_slot  = v_slot
   where id = p_guest_id;

  return jsonb_build_object('claimed', true, 'slot', v_slot, 'price', v_price);
end
$$;

-- Only the API (service role) may call this — not anon/authenticated via
-- PostgREST, which would let anyone with the publishable key burn slots.
revoke execute on function public.rsvp_gate_checkin(uuid, uuid, int, int, uuid)
  from public, anon, authenticated;
