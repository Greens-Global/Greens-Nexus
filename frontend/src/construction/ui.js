// Construction - the styles and status maps shared by more than one screen.
//
// Pulled out when the daily logs moved from the Project Dashboard onto their own
// Site Activity tab: both screens draw the same cards, rows and status chips,
// and two copies of a status map is how "Needs Info" ends up red on one screen
// and orange on the other.
//
// Statuses are soft labels (components/StatusLabel.jsx, Oct 14 2026): `color`
// is the one hue a label is mixed from. Orange means in progress / now and
// nothing else (style.css "Live accent"), so attention is red (overdue, late,
// sent back) or the warning yellow (at risk), never orange (11/03/2026).
//
// Constants only, no components - a module that exports both breaks fast refresh
// (react-refresh/only-export-components). The shared Empty state lives next door
// in Empty.jsx for exactly that reason.
import { emailToName } from '../lib/utils';

export const CARD = {
  backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)',
  borderRadius: 12, padding: 24, marginBottom: 24, boxShadow: 'var(--shadow-sm)',
};

export const ROW = {
  backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-color)',
  borderRadius: 8, padding: 20, display: 'flex', flexDirection: 'column', gap: 12,
};

export const TONE = {
  slate: '#64748b',
  gray: '#94a3b8',
  blue: '#2563eb',
  green: '#16a34a',
  yellow: '#ca8a04',
  red: '#dc2626',
};

// Only a draft or a bounced-back log can still be edited. submit_log freezes the
// rest server-side (409), so opening capture on one would dead-end.
export const editable = (l) => l.status === 'draft' || l.status === 'needs_info';

// A submitted log is ready for review the moment it lands (AI is off) - so
// "submitted" and the AI's "processed" both read In Review.
export const LOG_STATUS = {
  draft:      { label: 'Draft',     color: TONE.slate },
  submitted:  { label: 'In Review', color: TONE.blue },
  processed:  { label: 'In Review', color: TONE.blue },
  needs_info: { label: 'Sent Back', color: TONE.red },
  approved:   { label: 'Approved',  color: TONE.green },
};

export const REPORT_STATUS = {
  draft:      { label: 'Draft',      color: TONE.slate },
  in_review:  { label: 'In Review',  color: TONE.blue },
  approved:   { label: 'Approved',   color: TONE.green },
  published:  { label: 'Published',  color: TONE.green },
  superseded: { label: 'Superseded', color: TONE.gray },
};

export const PROJECT_STATUS = {
  active:   { label: 'Active',   color: TONE.green },
  on_hold:  { label: 'On Hold',  color: TONE.slate },
  complete: { label: 'Complete', color: TONE.blue },
  archived: { label: 'Archived', color: TONE.gray },
};

// The crew's own flags on a daily log (11/03/2026) - what a person said,
// counted whether or not any model ran.
export const LOG_TAGS = [
  { key: 'delay', label: 'Delay' },
  { key: 'safety', label: 'Safety' },
  { key: 'issue', label: 'Issue' },
  { key: 'weather', label: 'Weather' },
];
export const TAG_COLOR = { delay: TONE.yellow, safety: TONE.red, issue: TONE.yellow, weather: TONE.blue };
export const tagLabel = (k) => (LOG_TAGS.find((t) => t.key === k) || { label: k }).label;

// A person's name for an email - the server's names map first, never a raw
// address on screen when a name can be shown.
export function personName(email, names) {
  const em = String(email || '').toLowerCase();
  if (!em) return '';
  return (names && names[em]) || emailToName(em) || em;
}
