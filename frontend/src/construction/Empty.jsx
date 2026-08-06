// Construction - the shared empty state.
//
// Loading and empty are distinct states on purpose. A spinner that resolves to
// "No projects yet" reads as working; an empty list that was actually a failed
// fetch reads as "the data is gone" and generates a support ticket.
import { ClipboardList } from 'lucide-react';

export default function Empty({ icon: Icon = ClipboardList, title, hint, action }) {
  return (
    <div style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--text-secondary)' }}>
      <Icon size={32} style={{ opacity: 0.4, marginBottom: 12 }} />
      <div style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>{title}</div>
      {hint && <p style={{ fontSize: '0.85rem', maxWidth: 420, margin: '0 auto 16px' }}>{hint}</p>}
      {action}
    </div>
  );
}
