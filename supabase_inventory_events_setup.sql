-- Run once per Supabase project (dev first, then prod) in the SQL Editor.
-- Creates the inventory_events table the backend writes to after every status
-- change, and wires it into the Realtime publication so the frontend receives
-- instant INSERT events.

-- ── 1. Create table ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inventory_events (
    id             BIGSERIAL    PRIMARY KEY,
    request_id     TEXT         NOT NULL,
    status         TEXT         NOT NULL,
    affected_email TEXT         NOT NULL DEFAULT '',
    created_at     TIMESTAMPTZ  DEFAULT NOW()
);

-- ── 2. RLS: allow anon key to read so Realtime delivers events to the frontend ─
ALTER TABLE inventory_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_read_events" ON inventory_events;
CREATE POLICY "anon_read_events"
    ON inventory_events FOR SELECT TO anon USING (true);

-- ── 3. Add to Realtime publication ────────────────────────────────────────────
ALTER PUBLICATION supabase_realtime ADD TABLE inventory_events;

-- ── 4. Verify ─────────────────────────────────────────────────────────────────
SELECT schemaname, tablename
FROM pg_publication_tables
WHERE pubname = 'supabase_realtime'
  AND tablename = 'inventory_events';
-- Should return 1 row. If it does, Realtime is live for inventory_events.
