-- ============================================
-- Colectivo v2 — Database Schema
-- Run this in your Supabase SQL Editor
-- ============================================

-- Events
CREATE TABLE events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug              TEXT UNIQUE NOT NULL,
  name              TEXT NOT NULL,
  subtitle          TEXT,
  date              TIMESTAMPTZ,
  date_label        TEXT,
  time_label        TEXT,
  venue             TEXT,
  city              TEXT,
  description       TEXT,
  banner_url        TEXT,
  dos               TEXT,
  donts             TEXT,
  restrictions      TEXT,
  map_url           TEXT,
  address           TEXT,
  layout_url        TEXT,
  contact_email     TEXT,
  contact_phone     TEXT,
  contact_instagram TEXT,
  sponsors          JSONB DEFAULT '[]'::jsonb,
  owner_id          UUID NOT NULL REFERENCES auth.users(id),
  published         BOOLEAN DEFAULT FALSE,
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now()
);

-- Event staff
CREATE TABLE event_staff (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id     UUID REFERENCES auth.users(id),
  email       TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('staff', 'door')),
  invited_at  TIMESTAMPTZ DEFAULT now(),
  accepted_at TIMESTAMPTZ,
  UNIQUE(event_id, email)
);

-- Guests (guestlist)
CREATE TABLE guests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  email         TEXT,
  phone         TEXT,
  notes         TEXT,
  added_by      UUID NOT NULL REFERENCES auth.users(id),
  checked_in    BOOLEAN DEFAULT FALSE,
  checked_in_at TIMESTAMPTZ,
  checked_in_by UUID REFERENCES auth.users(id),
  qr_token      TEXT UNIQUE NOT NULL,
  email_sent    BOOLEAN DEFAULT FALSE,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- Indexes
CREATE INDEX idx_events_slug ON events(slug);
CREATE INDEX idx_events_owner ON events(owner_id);
CREATE INDEX idx_guests_event ON guests(event_id);
CREATE INDEX idx_guests_qr ON guests(qr_token);
CREATE INDEX idx_staff_event ON event_staff(event_id);
CREATE INDEX idx_staff_user ON event_staff(user_id);

-- ============================================
-- Row Level Security
-- ============================================
-- Note: The backend uses the service_role key, so RLS
-- doesn't apply to server-side queries. These policies
-- protect against direct client-side access.

ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE guests ENABLE ROW LEVEL SECURITY;

-- Events: anyone can read published events
CREATE POLICY "Public can view published events"
  ON events FOR SELECT
  USING (published = true);

-- Events: owners can do everything
CREATE POLICY "Owners manage their events"
  ON events FOR ALL
  USING (auth.uid() = owner_id);

-- Staff: event owner can manage staff
CREATE POLICY "Owners manage event staff"
  ON event_staff FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM events WHERE events.id = event_staff.event_id AND events.owner_id = auth.uid()
    )
  );

-- Staff: staff can read their own records
CREATE POLICY "Staff can read own records"
  ON event_staff FOR SELECT
  USING (user_id = auth.uid());

-- Guests: owner and staff can manage
CREATE POLICY "Owner can manage guests"
  ON guests FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM events WHERE events.id = guests.event_id AND events.owner_id = auth.uid()
    )
  );

CREATE POLICY "Staff can manage guests"
  ON guests FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM event_staff
      WHERE event_staff.event_id = guests.event_id
        AND event_staff.user_id = auth.uid()
        AND event_staff.accepted_at IS NOT NULL
    )
  );
