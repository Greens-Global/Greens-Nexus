import { formatDate } from '../../lib/datetime';
import { REPORTS, entityText, periodOf, presetLabel, reportDef, resolveConfig } from './reportModel';
import { builderSummary, isBuilderConfig, isPublished } from './builderModel';

// What the Report Center lists (Oct 23, Neil, item 05), free of React for the
// tests: every standard report and screen the person's Reports menu holds,
// the statements the menu does not name, and the memorized and Report Builder
// reports they can see. See ReportCenter.jsx.

// Statements of REPORTS the menu does not list on their own, and where they belong.
const EXTRA_HOME = { pnl: 'grp-financial', budget: 'grp-budget' };

/** The menu's Reports group as catalogue rows: { key, label, group, groupKey }. */
export function standardEntries(groups) {
  const out = [];
  const walk = (items, group, prefix) => items.forEach((t) => {
    if (t.items) { walk(t.items, group, [...prefix, t.label]); return; }
    if (t.key === 'reports') return;
    out.push({ key: t.key, label: [...prefix, t.label].join(', '), group: group.label, groupKey: group.key });
  });
  groups.forEach((g) => (g.items ? walk(g.items, g, []) : null));
  const listed = new Set(out.map((e) => e.key));
  REPORTS.forEach((r) => {
    if (listed.has(`rpt-${r.key}`)) return;
    const home = groups.find((g) => g.key === (EXTRA_HOME[r.key] || 'grp-financial')) || groups.find((g) => g.key === 'grp-financial');
    if (home) out.push({ key: `rpt-${r.key}`, label: r.label, group: home.label, groupKey: home.key });
  });
  return out;
}

const describe = (config) => {
  const c = resolveConfig(config);
  const period = periodOf(c) === 'asof' ? (c.asofToday === false ? `As of ${formatDate(c.asof)}` : 'As of today') : c.preset === 'custom' ? `${formatDate(c.from)} - ${formatDate(c.to)}` : presetLabel(c.preset);
  return [reportDef(c.report).label, period, entityText(c, [])].join(' · ');
};

/**
 * Every row of the catalogue, in menu order: standard entries, then the
 * memorized and builder reports. `saved` = GET /accounting/saved-reports.
 * Row: { id, key (the sub it opens), label, type: standard | memorized | saved | published, group, groupKey, about?, saved? }
 * A person limited to certain entities gets a memorized report only when every
 * entity it names is one of theirs - anything else would open empty.
 */
export function catalogue(groups, saved, { entities = [], limited = false } = {}) {
  const std = standardEntries(groups).map((e) => ({ ...e, id: e.key, type: 'standard' }));
  const groupOfReport = (report) => {
    const hit = std.find((e) => e.key === `rpt-${report}`);
    return hit ? { group: hit.group, groupKey: hit.groupKey } : null;
  };
  const center = groups.find((g) => g.key === 'grp-center') || groups[0];
  const mine = new Set(entities.map((e) => e.code));
  const opens = (r) => !limited || !(r.config?.entities || []).some((code) => !mine.has(code));
  const kept = (saved || []).filter((r) => r && r.config && opens(r)).map((r) => {
    if (isBuilderConfig(r.config)) {
      return { id: r.id, key: 'report-builder', label: r.name, type: isPublished(r) ? 'published' : 'saved', group: center?.label || 'Report Center', groupKey: center?.key || 'grp-center', about: builderSummary(r.config, entities), saved: r };
    }
    const report = resolveConfig(r.config).report;
    const home = groupOfReport(report);
    if (!home) return null;
    return { id: r.id, key: `rpt-${report}`, label: r.name, type: 'memorized', ...home, about: describe(r.config), saved: r };
  }).filter(Boolean);
  const order = groups.map((g) => g.key);
  return [...std, ...kept].sort((a, b) => order.indexOf(a.groupKey) - order.indexOf(b.groupKey));
}
