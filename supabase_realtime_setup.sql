-- Run this once in Supabase Dashboard → SQL Editor
-- Enables Realtime broadcasts on the two tables the frontend subscribes to.
-- Without this the WAL listener has no publication entry and all users fall
-- back to the poll interval instead of receiving instant push events.

-- ── 1. Add tables to the realtime publication ─────────────────────────────────
ALTER PUBLICATION supabase_realtime ADD TABLE nexus_notifications;
ALTER PUBLICATION supabase_realtime ADD TABLE inventory_requests;

-- ── 2. RLS: allow the anon key to SELECT so Realtime events are delivered ─────
--   (the backend still controls all writes via Azure AD — anon key is read-only)

ALTER TABLE nexus_notifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_read_notifications" ON nexus_notifications;
CREATE POLICY "anon_read_notifications"
  ON nexus_notifications FOR SELECT TO anon USING (true);

ALTER TABLE inventory_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_read_inventory_requests" ON inventory_requests;
CREATE POLICY "anon_read_inventory_requests"
  ON inventory_requests FOR SELECT TO anon USING (true);

-- ── 3. Verify ─────────────────────────────────────────────────────────────────
SELECT schemaname, tablename
FROM pg_publication_tables
WHERE pubname = 'supabase_realtime'
  AND tablename IN ('nexus_notifications', 'inventory_requests');
-- Should return 2 rows. If it does, Realtime is live.
