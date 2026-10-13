// Business Intelligence - the data side of the board (Neil, Oct 13 2026).
// BiInsights.jsx renders; everything here is a pure function of the
// GET /dashboards/insights payload so it can be tested without a DOM.
//
// The payload is one block per module: { id, label, nav, stats: [{ key,
// label, value, tone, drill }], breakdown?, trend?, funnel?, table? }.
// `tone` is the server's alert level for that number (critical / warning /
// good / neutral) and `drill` says whether /insights/drilldown can answer
// "of what?" for it (see routers/dashboards.py DRILLABLE).
import {
  CheckSquare, Clock, Ticket, BookOpen, Package, FileText, Monitor, HardHat,
  Building2, Users, KeyRound, Landmark, Gauge,
} from 'lucide-react';

export const TONE_COLOR = { critical: 'red', warning: 'orange', good: 'green', neutral: 'blue' };
export const TONE_LABEL = { critical: 'Critical', warning: 'Warning', good: 'Good', neutral: 'Neutral' };
export const SEVERITY_RANK = { critical: 3, warning: 2, neutral: 1, good: 0 };

// Icon and chip color per module, matching the sidebar's own icons where the
// module has one. Unknown ids (a module added server-side later) fall back
// to the BI gauge, never to nothing.
export const MODULE_META = {
  tasks:            { Icon: CheckSquare, color: 'blue' },
  attendance:       { Icon: Clock,       color: 'green' },
  tickets:          { Icon: Ticket,      color: 'orange' },
  knowledge_base:   { Icon: BookOpen,    color: 'purple' },
  operations:       { Icon: Package,     color: 'orange' },
  documents:        { Icon: FileText,    color: 'blue' },
  it:               { Icon: Monitor,     color: 'blue' },
  construction:     { Icon: HardHat,     color: 'orange' },
  asset_management: { Icon: Building2,   color: 'green' },
  people:           { Icon: Users,       color: 'purple' },
  credential_vault: { Icon: KeyRound,    color: 'red' },
  accounting:       { Icon: Landmark,    color: 'green' },
};
export const moduleMeta = (id) => MODULE_META[id] || { Icon: Gauge, color: 'brand' };

const isCount = (s) => typeof s.value === 'number';

/** True when the stat passes the board's alert-level and search filters. */
export function matchesStat(stat, tone = 'all', query = '') {
  if (tone !== 'all' && stat.tone !== tone) return false;
  const q = (query || '').trim().toLowerCase();
  return !q || String(stat.label || '').toLowerCase().includes(q);
}

/**
 * Every critical or warning count above zero, across every module, worst
 * first then largest first - the rows the "Needs Attention" strip shows.
 * Rows carry their module so a click can drill into the right one.
 */
export function attentionRows(modules) {
  const rows = [];
  for (const mod of modules || []) {
    for (const s of mod.stats || []) {
      if ((s.tone === 'critical' || s.tone === 'warning') && isCount(s) && s.value > 0) {
        rows.push({ ...s, moduleId: mod.id, moduleLabel: mod.label, nav: mod.nav });
      }
    }
  }
  rows.sort((a, b) => (SEVERITY_RANK[b.tone] - SEVERITY_RANK[a.tone]) || (b.value - a.value) || a.label.localeCompare(b.label));
  return rows;
}

/** The module's worst alert level, for its header dot. */
export function worstTone(mod) {
  let best = 'good', rank = -1;
  for (const s of mod?.stats || []) {
    if (!isCount(s) || s.value <= 0) continue;   // a zero is never an alert
    const r = SEVERITY_RANK[s.tone] ?? 0;
    if (r > rank) { rank = r; best = s.tone; }
  }
  return rank < 0 ? 'good' : best;
}

/** How many of the module's counts are critical or warning and above zero. */
export function alertCount(mod) {
  return (mod?.stats || []).filter((s) => (s.tone === 'critical' || s.tone === 'warning') && isCount(s) && s.value > 0).length;
}

/**
 * The module as the board should show it under the current filters: its
 * matching stats, and whether the card has anything left to render at all.
 * A search for "overdue" keeps the Tasks card with one row and drops a card
 * with no match; the shapes (breakdown / trend / funnel) only show when no
 * filter is narrowing the card, since they are not per-stat.
 */
export function visibleModule(mod, tone = 'all', query = '') {
  const stats = (mod.stats || []).filter((s) => matchesStat(s, tone, query));
  const narrowed = tone !== 'all' || !!(query || '').trim();
  const shapes = !narrowed;
  const hasShape = !!(mod.breakdown?.length || mod.trend?.length || mod.funnel?.length || mod.table?.length);
  return { stats, shapes, visible: stats.length > 0 || (shapes && hasShape) };
}

// ── CSV ───────────────────────────────────────────────────────────────────
const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function csvText(rows) {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}
export function boardCsvRows(modules, tone = 'all', query = '') {
  const rows = [['Module', 'Metric', 'Value', 'Alert Level']];
  for (const mod of modules || []) {
    for (const s of (mod.stats || []).filter((x) => matchesStat(x, tone, query))) {
      rows.push([mod.label, s.label, s.value, TONE_LABEL[s.tone] || s.tone]);
    }
  }
  return rows;
}
export function cardCsvRows(mod) {
  const rows = [['Metric', 'Value', 'Alert Level']];
  for (const s of mod.stats || []) rows.push([s.label, s.value, TONE_LABEL[s.tone] || s.tone]);
  return rows;
}

// Hidden modules, per browser. A hidden card is a preference, not data, so
// localStorage is the right home. Only the shape is checked here; an id for
// a module that no longer exists simply hides nothing, and the Modules menu
// counts hidden ids against the live payload.
export const LS_HIDDEN = 'nexus:bi-hidden-modules';
export function loadHidden() {
  try {
    const v = JSON.parse(localStorage.getItem(LS_HIDDEN) || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch { return []; }
}
export function saveHidden(ids) {
  try { localStorage.setItem(LS_HIDDEN, JSON.stringify(ids)); } catch { /* private mode etc. - the choice just does not stick */ }
}
