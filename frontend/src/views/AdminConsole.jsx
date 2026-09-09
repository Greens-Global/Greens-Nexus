// Admin - a shell for per-module admin-configurable extras (Pranshu, Sep 9).
// Deliberately separate from the two existing admin surfaces: the header's
// AdminPanel modal (Branding etc.) and the search-only "Nexus Access
// Manager" (roles/access grants, module id 'admin') - neither is touched
// here. This is where optional, module-by-module controls that don't belong
// on the module's own screen (because they're an admin decision, not a
// day-to-day one) get a home, added one at a time as they're built.
//
// Empty shell for now: one card per real module, each a placeholder until a
// concrete toggle exists for it. Grant-driven like Tasks/IT/Accounting/etc -
// IT Admin/Global Admin always see it (App.jsx VIEW_MIN_ROLES), anyone else
// only via an explicit Access Group grant (RolesAccess.jsx's GRANTABLE list
// already includes it since it isn't in that screen's exclude list).
import { Settings2, Wrench } from 'lucide-react';
import { MODULES } from '../contexts/RoleContext';

// Modules that aren't a real "feature surface" to configure extras for -
// this screen itself, the Access Manager (that's what RolesAccess is for),
// and the Compensation sub-scope (not its own screen).
const EXCLUDED = new Set(['admin-console', 'admin', 'hr_comp']);

export default function AdminConsole() {
  const modules = MODULES.filter(m => !EXCLUDED.has(m.id));

  return (
    <div style={{ padding: '28px 32px 60px', fontFamily: 'Inter, sans-serif', maxWidth: 1100, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
        <div style={{ width: 38, height: 38, borderRadius: 10, background: 'var(--paper)', border: '1px solid var(--line)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
          <Settings2 size={18} style={{ color: 'var(--ink)' }} />
        </div>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--ink)', margin: 0 }}>Admin</h1>
      </div>
      <div style={{ fontSize: 13.5, color: 'var(--muted)', marginBottom: 28, maxWidth: 640, lineHeight: 1.5 }}>
        Optional features and settings for each module, controlled by the admin team rather than day-to-day
        users. Controls land here module by module as they're built.
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
        {modules.map(m => (
          <div key={m.id} style={{ border: '1px solid var(--line)', borderRadius: 12, background: 'var(--card)', padding: '14px 16px' }}>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--ink)', marginBottom: 4 }}>{m.label}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)' }}>
              <Wrench size={12} /> No configurable options yet
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
