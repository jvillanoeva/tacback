-- ============================================
-- Colectivo v2 — Loyalty (Sunday Card)
-- Run this in your Supabase SQL Editor
-- ============================================
--
-- Adds the Sunday Card data plane:
--   - loyalty_members      member registry (one row per issued card)
--   - loyalty_taps         every NFC tap from a terminal
--   - terminals            registered Pi-5 terminals (auth source)
--   - loyalty_tier_history append-only audit log written by the
--                          tier-eval cron (separate brief)
--
-- All four tables enable RLS with no policies for the `authenticated`
-- role: terminals talk to the API via the service-role key, which
-- bypasses RLS. End-user sessions never query these tables directly.
--
-- Forward-only migration; no down step (matches 001-schema.sql).

-- ============================================
-- loyalty_members
-- ============================================
CREATE TABLE loyalty_members (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nfc_id          TEXT UNIQUE NOT NULL,
  first_name      TEXT NOT NULL,
  member_since    DATE NOT NULL,
  tier            TEXT NOT NULL DEFAULT 'habitue'
                    CHECK (tier IN ('habitue', 'residente')),
  is_connector    BOOLEAN NOT NULL DEFAULT FALSE,
  ra_buyer_id     TEXT,
  tac_user_id     UUID REFERENCES auth.users(id),
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_loyalty_members_tac_user   ON loyalty_members(tac_user_id);
CREATE INDEX idx_loyalty_members_ra_buyer   ON loyalty_members(ra_buyer_id);
CREATE INDEX idx_loyalty_members_updated_at ON loyalty_members(updated_at);

-- Auto-bump updated_at on any column change
CREATE OR REPLACE FUNCTION loyalty_members_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_loyalty_members_updated_at
  BEFORE UPDATE ON loyalty_members
  FOR EACH ROW
  EXECUTE FUNCTION loyalty_members_set_updated_at();

-- ============================================
-- terminals
-- ============================================
CREATE TABLE terminals (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name               TEXT NOT NULL,
  station_kind       TEXT NOT NULL
                       CHECK (station_kind IN ('caja', 'taquilla', 'wildcard')),
  device_token_hash  TEXT UNIQUE NOT NULL,
  last_seen_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at         TIMESTAMPTZ
);

-- ============================================
-- loyalty_taps
-- ============================================
CREATE TABLE loyalty_taps (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  local_id     TEXT UNIQUE NOT NULL,
  member_id    UUID NOT NULL REFERENCES loyalty_members(id) ON DELETE CASCADE,
  terminal_id  UUID NOT NULL REFERENCES terminals(id),
  event_id     UUID REFERENCES events(id),
  amount_mxn   NUMERIC(10,2),
  kind         TEXT NOT NULL
                 CHECK (kind IN ('bar', 'door', 'merch', 'wildcard')),
  tapped_at    TIMESTAMPTZ NOT NULL,
  synced_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_loyalty_taps_member_tapped
  ON loyalty_taps(member_id, tapped_at DESC);
CREATE INDEX idx_loyalty_taps_event ON loyalty_taps(event_id);

-- ============================================
-- loyalty_tier_history (append-only; written by tier-eval cron)
-- ============================================
CREATE TABLE loyalty_tier_history (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id          UUID NOT NULL REFERENCES loyalty_members(id) ON DELETE CASCADE,
  prev_tier          TEXT,
  new_tier           TEXT NOT NULL,
  prev_is_connector  BOOLEAN,
  new_is_connector   BOOLEAN NOT NULL,
  reason             TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_loyalty_tier_history_member
  ON loyalty_tier_history(member_id, created_at DESC);

-- ============================================
-- Existing-table modifications
-- ============================================
-- Link a checked-in guest row to the loyalty profile when the holder
-- taps. Nullable: most guest rows pre-date the card, and many guests
-- never get a card.
ALTER TABLE guests
  ADD COLUMN IF NOT EXISTS member_id UUID REFERENCES loyalty_members(id);

CREATE INDEX IF NOT EXISTS idx_guests_member ON guests(member_id);

-- ============================================
-- Row Level Security
-- ============================================
-- All four loyalty tables are server-only. No policies are granted to
-- the `authenticated` role; the service-role key (used by the API)
-- bypasses RLS, so the backend can read/write freely while any direct
-- client-side query is denied.

ALTER TABLE loyalty_members      ENABLE ROW LEVEL SECURITY;
ALTER TABLE loyalty_taps         ENABLE ROW LEVEL SECURITY;
ALTER TABLE terminals            ENABLE ROW LEVEL SECURITY;
ALTER TABLE loyalty_tier_history ENABLE ROW LEVEL SECURITY;
