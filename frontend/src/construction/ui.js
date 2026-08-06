// Construction - the styles and status maps shared by more than one screen.
//
// Pulled out when the daily logs moved from the Project Dashboard onto their own
// Site Activity tab: both screens draw the same cards, rows and status chips,
// and two copies of a status map is how "Needs Info" ends up red on one screen
// and orange on the other.
//
// Constants only, no components - a module that exports both breaks fast refresh
// (react-refresh/only-export-components). The shared Empty state lives next door
// in Empty.jsx for exactly that reason.

export const CARD = {
  backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)',
  borderRadius: 12, padding: 24, marginBottom: 24, boxShadow: 'var(--shadow-sm)',
};

export const ROW = {
  backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-color)',
  borderRadius: 8, padding: 20, display: 'flex', flexDirection: 'column', gap: 12,
};

// Only a draft or a bounced-back log can still be edited. submit_log freezes the
// rest server-side (409), so opening capture on one would dead-end.
export const editable = (l) => l.status === 'draft' || l.status === 'needs_info';

export const LOG_STATUS = {
  draft:      { label: 'Draft',        bg: 'var(--border-color)',     fg: 'var(--text-secondary)' },
  submitted:  { label: 'Submitted',    bg: 'hsl(var(--color-blue))',  fg: '#fff' },
  processed:  { label: 'AI Processed', bg: 'hsl(var(--color-blue))',  fg: '#fff' },
  needs_info: { label: 'Needs Info',   bg: 'hsl(var(--color-red))',   fg: '#fff' },
  approved:   { label: 'Approved',     bg: 'hsl(var(--color-green))', fg: '#fff' },
};
