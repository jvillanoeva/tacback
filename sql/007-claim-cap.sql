-- 007 · claim_guest_access: hard cap on confirmations per event
--
-- `events.claim_flow.cap` (integer, optional). When set, a confirm click is
-- refused with status 'cap_reached' once the event already has `cap`
-- confirmed claim-flow guests (claim_token set + claimed_at set — the same
-- marker this function stamps). The token is NOT burned, so nothing is lost
-- if the cap is later raised.
--
-- Atomic: when a cap is configured, claims on that event serialize on a
-- per-event advisory lock, and the count runs after the lock is held (fresh
-- READ COMMITTED snapshot), so concurrent clicks cannot overshoot. Events
-- without a cap take exactly the old path — no extra lock, no count.
--
-- Lock order is always token lock -> event lock, so no deadlock.
--
-- Note: claim.js releases claimed_at when mail 2 fails, which frees the slot
-- again. That is the intended behaviour.
--
-- TODO (Phase 2): once guests.revoked_at exists, add `and revoked_at is null`
-- to the cap count — otherwise early-access confirmations superseded by a
-- guestlist row keep eating the cap.
create or replace function public.claim_guest_access(p_token text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  g       record;
  v_now   timestamptz := now();
  v_cap   integer;
  v_count integer;
begin
  if p_token is null or length(p_token) < 16 then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- Lock on the token itself, before reading, so two racing clicks queue up.
  perform pg_advisory_xact_lock(hashtextextended(p_token, 0));

  select id, event_id, name, email, group_id, claim_expires_at, claimed_at
    into g
    from public.guests
   where claim_token = p_token
   for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if g.claimed_at is not null then
    return jsonb_build_object(
      'status', 'already_claimed',
      'guest_id', g.id, 'event_id', g.event_id, 'claimed_at', g.claimed_at);
  end if;

  if g.claim_expires_at is not null and g.claim_expires_at <= v_now then
    return jsonb_build_object(
      'status', 'expired',
      'guest_id', g.id, 'event_id', g.event_id, 'expired_at', g.claim_expires_at);
  end if;

  select case when (e.claim_flow->>'cap') ~ '^\d+$'
              then (e.claim_flow->>'cap')::integer end
    into v_cap
    from public.events e
   where e.id = g.event_id;

  if v_cap is not null then
    perform pg_advisory_xact_lock(hashtextextended('claim_cap:' || g.event_id::text, 0));

    select count(*) into v_count
      from public.guests
     where event_id = g.event_id
       and claim_token is not null
       and claimed_at is not null;

    if v_count >= v_cap then
      return jsonb_build_object(
        'status', 'cap_reached',
        'guest_id', g.id, 'event_id', g.event_id, 'cap', v_cap);
    end if;
  end if;

  update public.guests set claimed_at = v_now where id = g.id;

  return jsonb_build_object(
    'status', 'claimed',
    'guest_id', g.id, 'event_id', g.event_id,
    'name', g.name, 'email', g.email, 'group_id', g.group_id);
end;
$function$;
