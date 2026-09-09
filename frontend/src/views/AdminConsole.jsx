// Admin - the one place admin-team UI settings live (Pranshu, Sep 9).
// Deliberately separate from the two existing admin surfaces: the header's
// AdminPanel modal (now just the audit log) and the search-only "Nexus
// Access Manager" (roles/access grants, module id 'admin') - neither is
// touched here.
//
// "Build out the module" (Sep 9) means: relocate every admin-only setting
// that's a UI click (not a code change) here, even when it was originally
// built inside its own module's screen. Reuses the EXACT existing
// components/handlers from their home files (named-exported, not
// reimplemented) so behavior can't drift between "here" and "there" - the
// only new code is the layout wiring. Lazy-imported the same way
// Support.jsx borrows Tasks' composers, so this module's chunk doesn't drag
// the whole Item Management / HR bundles in eagerly.
//
// In scope for this pass: Branding, Item Types + Custom Fields, Ticket Desk
// + Notification settings, the "Send Alert" broadcast tool, and HR's
// Company Setup / Work Sites / Sync M365. Explicitly OUT of scope (Pranshu,
// Sep 9): shift presets, Asana sync, overtime rules, QA module toggle -
// left where they are.
import { useState, useEffect, useCallback, lazy, Suspense } from 'react';
import {
  Settings2, Wrench, ChevronDown, Palette, Tag,
  Headset, Bell, Megaphone, Building2, MapPin, RefreshCw, Loader2, Check,
} from 'lucide-react';
import { api } from '../api';
import { MODULES } from '../contexts/RoleContext';
import { applyBrandAccent } from '../lib/brandAccent';
import TicketDeskSettings from '../tickets/TicketDeskSettings';
import TicketNotifySettings from '../tickets/TicketNotifySettings';

// Borrowed components, lazy so their home module's chunk only loads once an
// admin actually opens that section.
const ManageTypesModal = lazy(() => import('./InventoryManagement').then(m => ({ default: m.ManageTypesModal })));
const CustomFieldsAdminModal = lazy(() => import('./InventoryManagement').then(m => ({ default: m.CustomFieldsAdminModal })));
const SendAlertModal = lazy(() => import('./InventoryManagement').then(m => ({ default: m.SendAlertModal })));
const EntitiesModal = lazy(() => import('./HR').then(m => ({ default: m.EntitiesModal })));
const WorkSitesModal = lazy(() => import('./HR').then(m => ({ default: m.WorkSitesModal })));

// Modules that already have a real settings section built below, so their
// generic placeholder card is dropped to avoid showing the same control twice.
const BUILT_MODULE_IDS = new Set(['inventory', 'tickets', 'hr']);
// Modules that aren't a real "feature surface" to configure extras for.
const EXCLUDED = new Set(['admin-console', 'admin', 'hr_comp', ...BUILT_MODULE_IDS]);

function ModalFallback() {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <Loader2 size={22} style={{ color: '#fff', animation: 'spin 1s linear infinite' }} />
    </div>
  );
}

function Section({ icon: Icon, title, sub, children, defaultOpen = false, onToggle }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 12, background: 'var(--card)', marginBottom: 12, overflow: 'hidden' }}>
      <button
        onClick={() => { const next = !open; setOpen(next); if (next) onToggle?.(); }}
        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit' }}>
        <span style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--paper)', border: '1px solid var(--line)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
          <Icon size={14} style={{ color: 'var(--ink)' }} />
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--ink)' }}>{title}</div>
          {sub && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>{sub}</div>}
        </span>
        <ChevronDown size={15} style={{ color: 'var(--muted)', flexShrink: 0, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }} />
      </button>
      {open && <div style={{ padding: '0 18px 18px', borderTop: '1px solid var(--line)' }}><div style={{ paddingTop: 16 }}>{children}</div></div>}
    </div>
  );
}

// ── Branding ─────────────────────────────────────────────────────────────────
// Moved wholesale from AdminPanel.jsx, where it was defined but never
// rendered (the drawer only ever showed AuditLogs).
const ACCENT_OPTIONS = [
  { value: 'green', label: 'Green', swatch: 'hsl(var(--color-green))' },
  { value: 'blue',  label: 'Blue',  swatch: '#2b45e1' },
];

function BrandingSection() {
  const [accent, setAccent] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState('');

  useEffect(() => {
    api.getBrandingConfig().then(cfg => setAccent(cfg.accent)).catch(() => setError('Failed to load branding settings'));
  }, []);

  async function choose(next) {
    if (next === accent || saving) return;
    setSaving(true);
    setError('');
    try {
      await api.updateBrandingConfig(next);
      setAccent(next);
      await applyBrandAccent();
    } catch {
      setError("Couldn't save — check your permissions and try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 0 14px', lineHeight: 1.5 }}>
        The brand color used across the app - Time Clock, badges, and the login screen. Changes apply immediately for everyone.
      </p>
      {error && <div style={{ fontSize: 12.5, color: 'hsl(var(--color-red))', marginBottom: 12 }}>{error}</div>}
      {accent === null && !error ? (
        <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Loading…</div>
      ) : (
        <div style={{ display: 'flex', gap: 12 }}>
          {ACCENT_OPTIONS.map(o => (
            <button key={o.value} onClick={() => choose(o.value)} disabled={saving}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', borderRadius: 10,
                border: accent === o.value ? `2px solid ${o.swatch}` : '1px solid var(--line)',
                background: 'var(--card)', cursor: saving ? 'default' : 'pointer',
                fontFamily: 'Inter, sans-serif', fontSize: 13, fontWeight: 600, color: 'var(--ink)',
              }}>
              <span style={{ width: 18, height: 18, borderRadius: '50%', background: o.swatch, flexShrink: 0 }} />
              {o.label}
              {accent === o.value && (saving
                ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} />
                : <Check size={14} style={{ color: o.swatch }} />)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Item Management: types + custom fields ────────────────────────────────────
function ItemSettingsSection({ toast }) {
  const [itemTypes, setItemTypes]   = useState([]);
  const [typeCounts, setTypeCounts] = useState({});
  const [customFields, setCustomFields] = useState([]);
  const [typesOpen, setTypesOpen]   = useState(false);
  const [fieldsOpen, setFieldsOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const refreshTypes = useCallback(() => { api.getItemTypes().then(setItemTypes).catch(() => {}); }, []);
  const refreshFields = useCallback(() => { api.getItemCustomFields().then(setCustomFields).catch(() => {}); }, []);

  const load = useCallback(() => {
    if (loaded) return;
    setLoaded(true);
    refreshTypes();
    refreshFields();
    api.getItems().then(items => {
      const m = {};
      for (const i of (items || [])) { const t = i.itemType || 'Other'; m[t] = (m[t] || 0) + 1; }
      setTypeCounts(m);
    }).catch(() => {});
  }, [loaded, refreshTypes, refreshFields]);

  return (
    <Section icon={Tag} title="Item Types & Custom Fields" onToggle={load}
      sub="The item taxonomy everyone picks from company-wide - originally in Item Management's own toolbar.">
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <button className="secondary-btn" onClick={() => setTypesOpen(true)}>Manage Item Types</button>
        <button className="secondary-btn" onClick={() => setFieldsOpen(true)}>Manage Custom Fields</button>
      </div>
      {typesOpen && (
        <Suspense fallback={<ModalFallback />}>
          <ManageTypesModal types={itemTypes} counts={typeCounts} onClose={() => setTypesOpen(false)}
            onChanged={t => setItemTypes(Array.isArray(t) && t.length ? t : itemTypes)} toast={toast} />
        </Suspense>
      )}
      {fieldsOpen && (
        <Suspense fallback={<ModalFallback />}>
          <CustomFieldsAdminModal fields={customFields} onClose={() => setFieldsOpen(false)}
            onChanged={refreshFields} toast={toast} />
        </Suspense>
      )}
    </Section>
  );
}

// ── Tickets: Service Desk + Notifications ─────────────────────────────────────
// Both panels are self-contained (own data fetch, own role gate) - reused
// exactly as Tickets → Manage renders them, just also mounted here.
function TicketSettingsSections() {
  return (
    <>
      <Section icon={Headset} title="Service Desk & Escalation" defaultOpen={false}
        sub="Who owns incoming tickets and where escalations route - originally under Tickets → Manage.">
        <TicketDeskSettings />
      </Section>
      <Section icon={Bell} title="Ticket Email Notifications" defaultOpen={false}
        sub="Company-wide notification routing for the ticket desk - originally under Tickets → Manage.">
        <TicketNotifySettings />
      </Section>
    </>
  );
}

// ── Company Alert (Send Alert) ─────────────────────────────────────────────────
function CompanyAlertSection({ toast }) {
  const [open, setOpen] = useState(false);
  return (
    <Section icon={Megaphone} title="Company Alert" defaultOpen={false}
      sub="Broadcast a bell + email alert to selected people - originally in Item Management's toolbar.">
      <button className="secondary-btn" onClick={() => setOpen(true)}>Send Alert…</button>
      {open && (
        <Suspense fallback={<ModalFallback />}>
          <SendAlertModal onClose={() => setOpen(false)} toast={toast} />
        </Suspense>
      )}
    </Section>
  );
}

// ── People: Company Setup, Work Sites, Sync M365 ──────────────────────────────
function CompanySection({ toastOk, toastErr }) {
  const [entities, setEntities] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [sites, setSites] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [entitiesOpen, setEntitiesOpen] = useState(false);
  const [sitesOpen, setSitesOpen] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncLabel, setSyncLabel] = useState('');

  const loadEntities = useCallback(() => api.getEntities().then(setEntities).catch(() => {}), []);
  const loadSites = useCallback(() => api.getWorkSites().then(setSites).catch(() => {}), []);

  const load = useCallback(() => {
    if (loaded) return;
    setLoaded(true);
    loadEntities();
    loadSites();
    api.getEmployees().then(rows => {
      setEmployees((rows || []).filter(e => !['guest', 'external'].includes(e.identityType || 'internal')));
    }).catch(() => {});
  }, [loaded, loadEntities, loadSites]);

  // Same handler as HR.jsx's "Sync M365" button - kicks off the server-side
  // background job and polls its status.
  async function runSync() {
    if (syncBusy) return;
    setSyncBusy(true);
    setSyncLabel('Starting…');
    try {
      await api.syncM365TwoWay();
      let s = null;
      for (;;) {
        await new Promise(r => setTimeout(r, 2500));
        try { s = await api.syncM365TwoWayStatus(); } catch { continue; }
        if (s.phase === 'pull') setSyncLabel('Pulling directory…');
        else if (s.phase === 'push') setSyncLabel(`Pushing ${s.done}/${s.total}…`);
        else break;
      }
      if (s?.phase === 'failed') {
        toastErr(`M365 sync failed: ${s.errors?.[0]?.error || 'see server logs'}.`);
      } else {
        const bits = [];
        const p = s?.pull || {};
        if (p.created) bits.push(`${p.created} added`);
        bits.push(`${p.linked || 0} linked`, `${p.updated || 0} updated`);
        bits.push(`${s?.pushedOk || 0} pushed to M365`);
        try {
          setSyncLabel('Syncing photos…');
          const ph = await api.syncM365Photos();
          if (ph.updated) bits.push(`${ph.updated} photos`);
        } catch { /* photo pass is best-effort */ }
        toastOk(`M365 sync: ${bits.join(' · ')}.`);
      }
    } catch (err) { toastErr(err?.message || 'Sync failed.'); }
    setSyncBusy(false);
    setSyncLabel('');
  }

  return (
    <Section icon={Building2} title="Company Setup, Work Sites & M365 Sync" onToggle={load}
      sub="Legal entities, geofenced clock-in sites, and directory sync - originally on the People → Overview screen.">
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <button className="secondary-btn" onClick={() => setEntitiesOpen(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Building2 size={14} /> Company Setup
        </button>
        <button className="secondary-btn" onClick={() => setSitesOpen(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <MapPin size={14} /> Work Sites
        </button>
        <button className="secondary-btn" onClick={runSync} disabled={syncBusy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {syncBusy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <RefreshCw size={14} />}
          {syncBusy && syncLabel ? syncLabel : 'Sync M365'}
        </button>
      </div>
      {entitiesOpen && (
        <Suspense fallback={<ModalFallback />}>
          <EntitiesModal entities={entities} employees={employees} onClose={() => setEntitiesOpen(false)}
            onChanged={loadEntities} toastOk={toastOk} toastErr={toastErr} />
        </Suspense>
      )}
      {sitesOpen && (
        <Suspense fallback={<ModalFallback />}>
          <WorkSitesModal sites={sites} entities={entities} onClose={() => setSitesOpen(false)}
            onChanged={loadSites} toastOk={toastOk} toastErr={toastErr} />
        </Suspense>
      )}
    </Section>
  );
}

export default function AdminConsole() {
  const modules = MODULES.filter(m => !EXCLUDED.has(m.id));
  const [toast, setToast] = useState(null); // { msg, kind }
  const showToast = useCallback((msg, kind = 'success') => {
    setToast({ msg, kind });
    setTimeout(() => setToast(null), 3000);
  }, []);
  const toastOk = useCallback((msg) => showToast(msg, 'success'), [showToast]);
  const toastErr = useCallback((msg) => showToast(msg, 'error'), [showToast]);

  return (
    <div style={{ padding: '28px 32px 60px', fontFamily: 'Inter, sans-serif', maxWidth: 1100, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
        <div style={{ width: 38, height: 38, borderRadius: 10, background: 'var(--paper)', border: '1px solid var(--line)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
          <Settings2 size={18} style={{ color: 'var(--ink)' }} />
        </div>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--ink)', margin: 0 }}>Admin</h1>
      </div>
      <div style={{ fontSize: 13.5, color: 'var(--muted)', marginBottom: 24, maxWidth: 640, lineHeight: 1.5 }}>
        Company-wide settings the admin team controls with a click - no code change required. Each one below is the
        same control its home module already had; it just also lives here now so admins have one place to look.
      </div>

      <div style={{ fontSize: 10.5, fontWeight: 800, color: 'var(--muted)', letterSpacing: '.06em', marginBottom: 8 }}>
        COMPANY SETTINGS
      </div>
      <Section icon={Palette} title="Branding" defaultOpen sub="Accent color used across the app.">
        <BrandingSection />
      </Section>
      <ItemSettingsSection toast={showToast} />
      <TicketSettingsSections />
      <CompanyAlertSection toast={showToast} />
      <CompanySection toastOk={toastOk} toastErr={toastErr} />

      <div style={{ fontSize: 10.5, fontWeight: 800, color: 'var(--muted)', letterSpacing: '.06em', margin: '28px 0 8px' }}>
        OTHER MODULES
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>
        No admin-configurable settings promoted here yet.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
        {modules.map(m => (
          <div key={m.id} style={{ border: '1px solid var(--line)', borderRadius: 10, background: 'var(--card)', padding: '12px 14px' }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)', marginBottom: 3 }}>{m.label}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--muted)' }}>
              <Wrench size={11} /> No configurable options yet
            </div>
          </div>
        ))}
      </div>

      {toast && (
        <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', background: toast.kind === 'error' ? 'hsl(var(--color-red))' : 'hsl(var(--color-green))', color: '#fff', borderRadius: 10, padding: '10px 18px', fontSize: 13, fontWeight: 600, zIndex: 1300, boxShadow: 'var(--shadow-lg)', maxWidth: '90vw' }}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
