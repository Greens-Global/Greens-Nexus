// The D1 side. Everything the monitor and the page need goes through these
// few calls, so tests can swap in an in-memory store with the same shape.

export function d1Store(db) {
  return {
    async loadStates() {
      const { results } = await db.prepare('SELECT * FROM component_state').all();
      const out = {};
      for (const r of results || []) {
        out[r.key] = {
          status: r.status, failStreak: r.fail_streak, okStreak: r.ok_streak, since: r.since,
          lastChecked: r.last_checked, lastStatus: r.last_status, note: r.note || '', latencyMs: r.latency_ms,
        };
      }
      return out;
    },

    async saveState(key, s) {
      await db.prepare(`INSERT INTO component_state (key, status, fail_streak, ok_streak, since, last_checked, last_status, note, latency_ms)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
        ON CONFLICT(key) DO UPDATE SET status = ?2, fail_streak = ?3, ok_streak = ?4, since = ?5,
          last_checked = ?6, last_status = ?7, note = ?8, latency_ms = ?9`)
        .bind(key, s.status, s.failStreak, s.okStreak, s.since, s.lastChecked, s.lastStatus, s.note || '', s.latencyMs ?? null)
        .run();
    },

    async recordDay(day, key, observed) {
      await db.prepare(`INSERT INTO daily (day, key, total, down, degraded) VALUES (?1, ?2, 1, ?3, ?4)
        ON CONFLICT(day, key) DO UPDATE SET total = total + 1, down = down + ?3, degraded = degraded + ?4`)
        .bind(day, key, observed === 'down' ? 1 : 0, observed === 'degraded' ? 1 : 0)
        .run();
    },

    async loadDays(firstDay) {
      const { results } = await db.prepare('SELECT * FROM daily WHERE day >= ?1').bind(firstDay).all();
      return results || [];
    },

    async openIncident(inc) {
      const row = await db.prepare(`INSERT INTO incidents (title, impact, status, components, auto, created_at, starts_at, ends_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) RETURNING id`)
        .bind(inc.title, inc.impact, inc.status, (inc.components || []).join(','), inc.auto ? 1 : 0, inc.createdAt,
          inc.startsAt || null, inc.endsAt || null)
        .first();
      return row.id;
    },

    async addUpdate(incidentId, status, message, at) {
      await db.prepare('INSERT INTO incident_updates (incident_id, status, message, created_at) VALUES (?1, ?2, ?3, ?4)')
        .bind(incidentId, status, message, at).run();
      await db.prepare(`UPDATE incidents SET status = ?2, resolved_at = CASE WHEN ?2 = 'resolved' THEN ?3 ELSE resolved_at END WHERE id = ?1`)
        .bind(incidentId, status, at).run();
    },

    async openAutoIncidentFor(key) {
      return db.prepare(`SELECT id FROM incidents WHERE auto = 1 AND status != 'resolved'
        AND (',' || components || ',') LIKE ?1 ORDER BY id DESC LIMIT 1`).bind(`%,${key},%`).first();
    },

    async getIncident(id) {
      return db.prepare('SELECT * FROM incidents WHERE id = ?1').bind(id).first();
    },

    async listIncidents(sinceIso) {
      const { results } = await db.prepare(`SELECT * FROM incidents WHERE created_at >= ?1 OR status != 'resolved'
        ORDER BY created_at DESC LIMIT 100`).bind(sinceIso).all();
      const incidents = results || [];
      if (!incidents.length) return [];
      const ids = incidents.map((i) => i.id);
      const { results: ups } = await db.prepare(
        `SELECT * FROM incident_updates WHERE incident_id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at DESC`,
      ).bind(...ids).all();
      return incidents.map((i) => ({ ...i, updates: (ups || []).filter((u) => u.incident_id === i.id) }));
    },

    // A maintenance window covering this moment, per component key.
    async maintenanceNow(nowIso) {
      const { results } = await db.prepare(`SELECT components FROM incidents WHERE impact = 'maintenance'
        AND status != 'resolved' AND starts_at <= ?1 AND (ends_at IS NULL OR ends_at >= ?1)`).bind(nowIso).all();
      const keys = new Set();
      for (const r of results || []) for (const k of String(r.components || '').split(',')) if (k) keys.add(k);
      return keys;
    },

    async pruneDays(beforeDay) {
      await db.prepare('DELETE FROM daily WHERE day < ?1').bind(beforeDay).run();
    },
  };
}
