-- Nexus status page - Cloudflare D1 (SQLite). Safe to run again: every
-- statement is IF NOT EXISTS. Applied by .github/workflows/deploy-status.yml.

-- Where each component stands right now.
CREATE TABLE IF NOT EXISTS component_state (
  key          TEXT PRIMARY KEY,
  status       TEXT NOT NULL DEFAULT 'operational',
  fail_streak  INTEGER NOT NULL DEFAULT 0,
  ok_streak    INTEGER NOT NULL DEFAULT 0,
  since        TEXT NOT NULL,
  last_checked TEXT,
  last_status  TEXT,
  note         TEXT DEFAULT '',
  latency_ms   INTEGER
);

-- One row per component per Pacific day: the 90-day bars and uptime %.
CREATE TABLE IF NOT EXISTS daily (
  day      TEXT NOT NULL,
  key      TEXT NOT NULL,
  total    INTEGER NOT NULL DEFAULT 0,
  down     INTEGER NOT NULL DEFAULT 0,
  degraded INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, key)
);

-- Incidents: opened and resolved automatically for outages (auto = 1), or
-- posted by the team (an explanation, or scheduled maintenance).
CREATE TABLE IF NOT EXISTS incidents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  impact      TEXT NOT NULL DEFAULT 'major',     -- minor | major | maintenance
  status      TEXT NOT NULL DEFAULT 'investigating', -- investigating | identified | monitoring | resolved | scheduled
  components  TEXT NOT NULL DEFAULT '',          -- comma-separated component keys
  auto        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  resolved_at TEXT,
  starts_at   TEXT,                              -- maintenance window
  ends_at     TEXT
);
CREATE INDEX IF NOT EXISTS incidents_created ON incidents (created_at);

CREATE TABLE IF NOT EXISTS incident_updates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER NOT NULL,
  status      TEXT NOT NULL,
  message     TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS incident_updates_incident ON incident_updates (incident_id);
