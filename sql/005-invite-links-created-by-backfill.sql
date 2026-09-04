-- 005 · backfill invite_links.created_by for machine-created links
--
-- 004 dropped the NOT NULL on `created_by` so a service token could insert a
-- link without a user session. What that missed is two routes away:
-- `guests.added_by` is `uuid NOT NULL REFERENCES auth.users`, and
-- POST /api/:eventSlug/invite/public/:token/guest copies it straight off
-- `invite_links.created_by`. So every link minted by Bars' table sales looked
-- healthy right up until a buyer typed their first guest's name and got
--
--   null value in column "added_by" of relation "guests" violates not-null
--
-- The column stays nullable — re-adding the constraint would be a second way
-- to fail on write, and both writers now set it. The endpoint stamps the
-- event's owner; the public route falls back to the same value.
--
-- Attribution is not lost by using the owner: who bought the table is on the
-- link itself, in `label` ("Mesa 4 · Jorge Villanueva"), `manager_email`, and
-- `external_ref` (the Bars order id).
update public.invite_links l
   set created_by = e.owner_id
  from public.events e
 where e.id = l.event_id
   and l.created_by is null;
