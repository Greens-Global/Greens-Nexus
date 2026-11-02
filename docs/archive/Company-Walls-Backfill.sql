-- ============================================================================
-- Company-walls backfill  (multi-company tenant isolation, Aug 2026)
-- ----------------------------------------------------------------------------
-- Stamps EXISTING rows with their HrEntity company, derived from the row's
-- owner / creator / requester email (joined to nexus_employees.company).
--
-- WHY: once the walls are armed, an untagged row (company = '') is
-- Global-Admin-only. Without this backfill, every task/ticket/requisition/
-- notification created before the walls existed would vanish for scoped users
-- the moment you arm. Run this on dev, verify, then prod, BEFORE arming.
--
-- SAFE: idempotent (only touches still-untagged rows), wrapped in a
-- transaction, and never overwrites a company already set. Rows it cannot
-- derive (no matching employee, or that person has no company) stay untagged
-- and become Global-Admin-only when armed - tag those by hand afterwards.
--
-- KB documents and e-sign documents need NO backfill: their wall derives the
-- company live from the owner's email at read time (no stored column).
-- Items have no person link, so they are left untagged on purpose (decide an
-- item -> company rule, or tag them per company, before relying on the wall).
--
-- Run:  psql "$DATABASE_URL" -f docs/Company-Walls-Backfill.sql
--   or paste into the Supabase SQL editor (dev first, then prod).
-- ============================================================================

BEGIN;

-- Tasks: creator first, then owner as a fallback.
UPDATE tasks t SET company_id = e.company
  FROM nexus_employees e
 WHERE COALESCE(t.company_id, '') = ''
   AND lower(t.created_by) = lower(e.work_email)
   AND COALESCE(e.company, '') <> '';

UPDATE tasks t SET company_id = e.company
  FROM nexus_employees e
 WHERE COALESCE(t.company_id, '') = ''
   AND lower(t.owner_email) = lower(e.work_email)
   AND COALESCE(e.company, '') <> '';

-- Tickets: from the requester (most are already stamped by company_for()).
UPDATE task_tickets tk SET company_id = e.company
  FROM nexus_employees e
 WHERE COALESCE(tk.company_id, '') = ''
   AND lower(tk.requester_email) = lower(e.work_email)
   AND COALESCE(e.company, '') <> '';

-- Requisitions: from the beneficiary employee.
UPDATE requisitions r SET company_id = e.company
  FROM nexus_employees e
 WHERE COALESCE(r.company_id, '') = ''
   AND lower(r.employee_email) = lower(e.work_email)
   AND COALESCE(e.company, '') <> '';

-- Notifications: broadcasts from the subject (requested_by), personal from recipient.
UPDATE nexus_notifications n SET company = e.company
  FROM nexus_employees e
 WHERE COALESCE(n.company, '') = ''
   AND lower(n.requested_by) = lower(e.work_email)
   AND COALESCE(e.company, '') <> '';

UPDATE nexus_notifications n SET company = e.company
  FROM nexus_employees e
 WHERE COALESCE(n.company, '') = ''
   AND lower(n.recipient) = lower(e.work_email)
   AND COALESCE(e.company, '') <> '';

COMMIT;

-- ---------------------------------------------------------------------------
-- Report: what is still untagged (= Global-Admin-only when armed). Review this
-- before arming; a high untagged count means people will lose access on arm.
-- ---------------------------------------------------------------------------
SELECT 'tasks'               AS table_name,
       count(*) FILTER (WHERE COALESCE(company_id, '') = '') AS untagged,
       count(*)                                              AS total
  FROM tasks
UNION ALL SELECT 'task_tickets',
       count(*) FILTER (WHERE COALESCE(company_id, '') = ''), count(*) FROM task_tickets
UNION ALL SELECT 'requisitions',
       count(*) FILTER (WHERE COALESCE(company_id, '') = ''), count(*) FROM requisitions
UNION ALL SELECT 'nexus_notifications',
       count(*) FILTER (WHERE COALESCE(company, '') = ''),    count(*) FROM nexus_notifications
UNION ALL SELECT 'items (no auto-source - tag by hand)',
       count(*) FILTER (WHERE COALESCE(company_id, '') = ''), count(*) FROM items
 ORDER BY table_name;
