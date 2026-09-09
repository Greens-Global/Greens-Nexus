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
// In scope for this pass: Roles & Access (moved here whole, previously a
// People tab), Item Types + Custom Fields, Ticket Desk + Notification
// settings, Ticket SLA & Types (Sep 9 - was Tier 2 in the audit: no UI
// existed, SLA_TARGET_HOURS/TICKET_TYPE_META/TYPE_FIELDS were hardcoded
// constants requiring a code deploy to change; now backed by
// backend/ticket_taxonomy.py + a NexusSetting row, see tickets/ticketConfig.js
// for how the saved override reaches every ticket screen), Task
// Notifications (moved here whole, previously a Tasks → Manage tab), the
// "Send Alert" broadcast tool, and HR's Company Setup / Work Sites / Sync
// M365. Explicitly OUT of scope (Pranshu, Sep 9): Branding (an individual
// employee's own choice, not an admin decision - stays in the header
// AdminPanel drawer), shift presets, Asana sync, overtime rules, QA module
// toggle - left where they are.
import { useState, useCallback, lazy, Suspense } from 'react';
import {
  Settings2, Wrench, ChevronDown, Tag, Shield, SlidersHorizontal,
  Headset, Bell, Megaphone, Building2, MapPin, RefreshCw, Loader2, Timer,
} from 'lucide-react';
import { api } from '../api';
import { MODULES } from '../contexts/RoleContext';
import TicketDeskSettings from '../tickets/TicketDeskSettings';
import TicketNotifySettings from '../tickets/TicketNotifySettings';
import TicketTaxonomySettings from '../tickets/TicketTaxonomySettings';

// Borrowed components, lazy so their home module's chunk only loads once an
// admin actually opens that section.
const ManageTypesModal = lazy(() => import('./InventoryManagement').then(m => ({ default: m.ManageTypesModal })));
const CustomFieldsAdminModal = lazy(() => import('./InventoryManagement').then(m => ({ default: m.CustomFieldsAdminModal })));
const SendAlertModal = lazy(() => import('./InventoryManagement').then(m => ({ default: m.SendAlertModal })));
const EntitiesModal = lazy(() => import('./HR').then(m => ({ default: m.EntitiesModal })));
const WorkSitesModal = lazy(() => import('./HR').then(m => ({ default: m.WorkSitesModal })));
// Roles & Access moved here whole (Pranshu, Sep 9) - was a People tab
// (HR.jsx's old 'hr-access' sub), now a top-level tab of Admin instead.
// `embedded` skips its own page header, since it gets one from the tab here.
const RolesAccess = lazy(() => import('./RolesAccess'));
// TaskNotifySettings needs TasksContext (task lookups for its delivery log's
// "open task" link) - wrapped in its own TasksProvider here, same trick
// Support.jsx uses for its Tasks-borrowed composers, since Admin has no
// TasksProvider ancestor of its own.
const TaskNotifySettingsWrapped = lazy(async () => {
  const [{ TasksProvider }, { default: TaskNotifySettings }] = await Promise.all([
    import('../tasks/TasksContext'),
    import('../tasks/TaskNotifySettings'),
  ]);
  return { default: () => <TasksProvider><TaskNotifySettings /></TasksProvider> };
});

// Modules that already have a real settings section built below, so their
// generic placeholder card is dropped to avoid showing the same control twice.
const BUILT_MODULE_IDS = new Set(['inventory', 'tickets', 'hr', 'tasks']);
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

// Branding (accent color) is NOT here - Pranshu, Sep 9: it's an individual
// employee's own choice, not an admin-team decision, so it stays in the
// header's AdminPanel drawer where it originally lived (components/AdminPanel.jsx).

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
      <Section icon={Timer} title="Ticket SLA & Types" defaultOpen={false}
        sub="SLA target hours per priority, and each type's intake questions - previously hardcoded, no UI existed until now.">
        <TicketTaxonomySettings />
      </Section>
      <Section icon={Bell} title="Task Notifications" defaultOpen={false}
        sub="Shared mailbox, reminder cadence, and reply handling for task emails - originally under Tasks → Manage.">
        <Suspense fallback={<div style={{ fontSize: 13, color: 'var(--muted)', padding: '12px 0' }}>Loading…</div>}>
          <TaskNotifySettingsWrapped />
        </Suspense>
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

const TOP_TABS = [
  ['settings', 'Company Settings', SlidersHorizontal],
  ['access',   'Roles & Access',   Shield],
];

export default function AdminConsole({ activeSub, onSubChange }) {
  const modules = MODULES.filter(m => !EXCLUDED.has(m.id));
  const [toast, setToast] = useState(null); // { msg, kind }
  const showToast = useCallback((msg, kind = 'success') => {
    setToast({ msg, kind });
    setTimeout(() => setToast(null), 3000);
  }, []);
  const toastOk = useCallback((msg) => showToast(msg, 'success'), [showToast]);
  const toastErr = useCallback((msg) => showToast(msg, 'error'), [showToast]);

  const topTab = activeSub === 'access' ? 'access' : 'settings';
  const setTopTab = (id) => onSubChange ? onSubChange(id) : undefined;

  // Full-bleed, like every other module (HR, Item Management, Tickets) - no
  // maxWidth cap or extra padding of its own. .viewport (App.jsx) already
  // supplies the edge margin; a centered ~1100px column here just wasted the
  // rest of a wide monitor and forced a lot of scrolling on the bigger
  // embedded panels (Pranshu, Sep 9).
  return (
    <div style={{ fontFamily: 'Inter, sans-serif' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
        <div style={{ width: 38, height: 38, borderRadius: 10, background: 'var(--paper)', border: '1px solid var(--line)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
          <Settings2 size={18} style={{ color: 'var(--ink)' }} />
        </div>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--ink)', margin: 0 }}>Admin</h1>
      </div>
      <div style={{ fontSize: 13.5, color: 'var(--muted)', marginBottom: 20, maxWidth: 640, lineHeight: 1.5 }}>
        Company-wide settings and access control, all in one place - no code change required for any of it.
      </div>

      <div className="scroll-tabs" style={{ display: 'flex', gap: 6, marginBottom: 22, borderBottom: '1px solid var(--line)', paddingBottom: 1 }}>
        {TOP_TABS.map(([id, label, Icon]) => (
          <button key={id} onClick={() => setTopTab(id)}
            style={{ background: 'none', border: 'none', padding: '9px 14px', fontFamily: 'Inter,sans-serif', fontWeight: 600, fontSize: 13.5, cursor: 'pointer', color: topTab === id ? 'var(--ink)' : 'var(--muted)', position: 'relative', display: 'flex', alignItems: 'center', gap: 7, whiteSpace: 'nowrap' }}>
            <Icon size={15} /> {label}
            {topTab === id && <span style={{ position: 'absolute', left: 0, right: 0, bottom: -1, height: 2.5, background: 'var(--ink)', borderRadius: '4px 4px 0 0' }} />}
          </button>
        ))}
      </div>

      {topTab === 'access' ? (
        <Suspense fallback={<div style={{ fontSize: 13, color: 'var(--muted)', padding: '24px 0' }}>Loading…</div>}>
          <RolesAccess embedded />
        </Suspense>
      ) : (
        <>
          <div style={{ fontSize: 10.5, fontWeight: 800, color: 'var(--muted)', letterSpacing: '.06em', marginBottom: 8 }}>
            COMPANY SETTINGS
          </div>
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
        </>
      )}

      {toast && (
        <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', background: toast.kind === 'error' ? 'hsl(var(--color-red))' : 'hsl(var(--color-green))', color: '#fff', borderRadius: 10, padding: '10px 18px', fontSize: 13, fontWeight: 600, zIndex: 1300, boxShadow: 'var(--shadow-lg)', maxWidth: '90vw' }}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
