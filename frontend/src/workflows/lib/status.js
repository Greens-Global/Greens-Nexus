// Status words and colors for workflows and runs (Oct 28 2026). Title Case
// labels drawn by components/StatusLabel.jsx - soft labels, color only where
// someone has to act (Needs Attention, Failed) or something is live.

export const WF_STATUS = {
  draft:           { label: 'Draft',           color: '#64748b' },
  active:          { label: 'Active',          color: '#16a34a' },
  paused:          { label: 'Paused',          color: '#d97706' },
  needs_attention: { label: 'Needs Attention', color: '#dc2626' },
  archived:        { label: 'Archived',        color: '#64748b' },
};

export const RUN_STATUS = {
  running:   { label: 'Running',   color: '#2563eb' },
  waiting:   { label: 'Waiting',   color: '#d97706' },
  succeeded: { label: 'Succeeded', color: '#16a34a' },
  failed:    { label: 'Failed',    color: '#dc2626' },
  skipped:   { label: 'Skipped',   color: '#64748b' },
  cancelled: { label: 'Cancelled', color: '#64748b' },
  test:      { label: 'Test',      color: '#7c3aed' },
  // Steps use the run words plus these: done (a real run's finished step), retry (waiting to try again).
  pending:   { label: 'Pending',   color: '#94a3b8' },
  planned:   { label: 'Planned',   color: '#7c3aed' },
  done:      { label: 'Done',      color: '#16a34a' },
  retry:     { label: 'Retrying',  color: '#d97706' },
};

const titleCase = (s) => String(s || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();

export const wfStatusMeta = (key) => WF_STATUS[key] || { label: titleCase(key) || 'Unknown', color: '#64748b' };
export const runStatusMeta = (key) => RUN_STATUS[key] || { label: titleCase(key) || 'Unknown', color: '#64748b' };
