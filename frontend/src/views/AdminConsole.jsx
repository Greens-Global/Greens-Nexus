// Admin - the one place admin-team UI settings live (Pranshu, Sep 9).
// Deliberately separate from the search-only "Nexus Access Manager"
// (roles/access grants, module id 'admin') - not touched here. The header's
// old AdminPanel drawer (Audit Logs) is gone (Sep 11) - see the Audit Logs
// tab below.
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
// Notifications (moved here whole, previously a Tasks → Manage tab), Act As
// and Audit Logs (Sep 11, moved whole out of the header dropdown), and HR's
// Company Setup / Work Sites / Sync M365. Explicitly OUT of scope (Pranshu,
// Sep 9): Branding (an individual employee's own choice, not an admin
// decision - stays in the header's account menu), shift presets, Asana sync,
// overtime rules, QA module toggle - left where they are. The placeholder
// "Other modules" grid (one card per module with no settings yet) was
// dropped (Pranshu, Sep 9) - it only ever said "no configurable options yet"
// for every module not listed above, which isn't useful information; a
// module gets a section here when it actually has one.
//
// Company Alert / "Send Alert" broadcast tool was dropped from here entirely
// (Pranshu, Sep 11) - unused. Workforce Analytics Policy (the old Policy tab
// under Employee Tracking) moved in as its replacement in the Company
// Settings list.
import { useState, useEffect, useCallback, lazy, Suspense } from 'react';
import {
  Settings2, ChevronDown, Tag, Shield, SlidersHorizontal,
  Headset, Bell, Mail, Building2, RefreshCw, Loader2, Timer,
  UserCog, Activity, DoorOpen, Signature, Check, Eye, X,
  Plus, Pencil, Trash2, Upload, Copy,
} from 'lucide-react';
import { api } from '../api';
import { useRole } from '../contexts/RoleContext';
import ModuleTabs from '../components/ModuleTabs';
import TicketDeskSettings from '../tickets/TicketDeskSettings';
import TicketNotifySettings from '../tickets/TicketNotifySettings';
import TicketTaxonomySettings from '../tickets/TicketTaxonomySettings';
import DailyBriefingSettings from '../components/DailyBriefingSettings';

// Borrowed components, lazy so their home module's chunk only loads once an
// admin actually opens that section.
const ManageTypesModal = lazy(() => import('./InventoryManagement').then(m => ({ default: m.ManageTypesModal })));
const CustomFieldsAdminModal = lazy(() => import('./InventoryManagement').then(m => ({ default: m.CustomFieldsAdminModal })));
const CompanySetupPage = lazy(() => import('./HR').then(m => ({ default: m.CompanySetupPage })));
// Roles & Access moved here whole (Pranshu, Sep 9) - was a People tab
// (HR.jsx's old 'hr-access' sub), now a top-level tab of Admin instead.
// `embedded` skips its own page header, since it gets one from the tab here.
const RolesAccess = lazy(() => import('./RolesAccess'));
// Audit Logs (Sep 11) - same tab-beside-Roles-&-Access treatment. The old
// header AdminPanel drawer that used to render this is gone; AuditLogs is
// named-exported from that file and embedded directly here now.
const AuditLogs = lazy(() => import('../components/AdminPanel').then(m => ({ default: m.AuditLogs })));
// Act As (Sep 11) - ActAsPicker is the search box + people list, shared with
// the header dropdown's fixed-overlay ActAsModal so both stay in lockstep;
// here it just renders inline instead of behind a modal.
const ActAsPicker = lazy(() => import('../components/ActAsModal').then(m => ({ default: m.ActAsPicker })));
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

// ── Daily Briefing ─────────────────────────────────────────────────────────
// Global-Admin only (see DailyBriefingSettings.jsx) - was "callable directly"
// via the API with no UI at all until now (Pranshu, Sep 20).
function DailyBriefingSection() {
  return (
    <Section icon={Mail} title="Daily Briefing" defaultOpen={false}
      sub="Turn the one-email-a-day digest on for everyone, or test it against a few recipients first.">
      <DailyBriefingSettings />
    </Section>
  );
}

// Workforce Analytics Policy moved OUT of here (Sep 19, Pranshu: "all
// companies have their different workforce analytics policy") - it's no
// longer one shared setting, so it lives on each company's own tab in
// Settings -> Company Setup instead. See HR.jsx's CompanySetupPage.

// ── Email Signature (Pranshu, Sep 16) ──────────────────────────────────────────
// Template + sign-off are a company-wide admin choice here, not a personal one
// (reverses the Sep 9 "Branding... stays in the header's account menu" note
// above for this specific piece - the underlying signature builder was
// designed around Neil's "consistent across the entire organisation" brief,
// and Pranshu decided the visual pick belongs with the rest of company
// branding). Name/role/e-mail still come from each person's own directory
// record automatically; preferred display name and phone override stay
// self-service in My Profile (header → account menu) since those genuinely
// are personal, just not the template.
// The little rectangle that actually shows a signature's markup is a stand-in
// for how it'll look pasted into an email - always white paper with dark
// text, on purpose, the same in light or dark Nexus (an email client never
// knows or cares what theme the admin's browser is in). Only the card CHROME
// around it (border, label, buttons, the zoom modal's frame) follows Nexus's
// own theme - that's the piece that was stuck hardcoded to white (Sep 19:
// "when i'm changing the mode of NEXUS to dark the template background
// should go black - but it is not").
function SignaturePaper({ html, height = 60, scale = 0.7 }) {
  return (
    <div style={{ background: '#fff', borderRadius: 4, overflow: 'hidden', height, pointerEvents: 'none' }}>
      <div style={{ transform: `scale(${scale})`, transformOrigin: 'top left', width: `${Math.round(100 / scale)}%` }}
        dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

function SignatureZoomModal({ title, html, onClose }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: 'var(--card)', borderRadius: 12, maxWidth: 560, width: '100%', maxHeight: '80vh', overflow: 'auto', boxShadow: 'var(--shadow-lg)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', borderBottom: '1px solid var(--line)' }}>
          <span style={{ fontSize: 13.5, fontWeight: 700, flex: 1, color: 'var(--ink)' }}>{title}</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}>
            <X size={18} />
          </button>
        </div>
        <div style={{ padding: 20, background: '#fff' }} dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </div>
  );
}

function EmailSignatureSection({ toastOk, toastErr }) {
  const [entities, setEntities] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [companyId, setCompanyId] = useState('');
  const [data, setData] = useState(null);       // { templates, template, recipientScope, senderOverrides }
  const [selectedTemplate, setSelectedTemplate] = useState('classic');
  const [selectedScope, setSelectedScope] = useState('all');
  const [overrides, setOverrides] = useState([]);   // [{ id, label, emails: [...], template }]
  const [companyPeople, setCompanyPeople] = useState([]);   // [{ email, name }] - this company's people, for the override picker
  const [previewBusy, setPreviewBusy] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [zoomTemplate, setZoomTemplate] = useState(null);   // { label, html } | null - full-size eye-icon preview
  const [manualSigs, setManualSigs] = useState([]);
  const [manualModal, setManualModal] = useState(null);     // 'new' | sig object | null

  const loadPreview = useCallback((id) => {
    if (!id) return;
    setPreviewBusy(true);
    api.getEntitySignatureTemplates(id)
      .then(d => {
        setData(d);
        setSelectedTemplate(d.template);
        setSelectedScope(d.recipientScope || 'all');
        setOverrides(d.senderOverrides || []);
      })
      .catch(() => {})
      .finally(() => setPreviewBusy(false));
  }, []);

  const loadCompanyPeople = useCallback((id) => {
    if (!id) return;
    api.getPeopleDirectory().then(rows => setCompanyPeople((rows || []).filter(p => p.company === id))).catch(() => {});
  }, []);

  const loadManualSigs = useCallback((id) => {
    if (!id) return;
    api.getManualSignatures(id).then(setManualSigs).catch(() => {});
  }, []);

  const load = useCallback(() => {
    if (loaded) return;
    setLoaded(true);
    api.getEntities().then(rows => {
      setEntities(rows || []);
      if (rows?.length) { setCompanyId(rows[0].id); loadPreview(rows[0].id); loadManualSigs(rows[0].id); loadCompanyPeople(rows[0].id); }
    }).catch(() => {});
  }, [loaded, loadPreview, loadManualSigs, loadCompanyPeople]);

  function pickCompany(id) {
    setCompanyId(id);
    setData(null);
    setManualSigs([]);
    setCompanyPeople([]);
    loadPreview(id);
    loadManualSigs(id);
    loadCompanyPeople(id);
  }

  function addOverride() {
    setOverrides(rows => [...rows, { id: '', label: '', emails: [], template: data?.templates?.[0]?.id || 'classic' }]);
  }
  function updateOverride(idx, patch) {
    setOverrides(rows => rows.map((r, i) => i === idx ? { ...r, ...patch } : r));
  }
  function removeOverride(idx) {
    setOverrides(rows => rows.filter((_, i) => i !== idx));
  }

  async function save() {
    if (!companyId || saveBusy) return;
    setSaveBusy(true);
    try {
      await api.updateEntity(companyId, {
        signature_template: selectedTemplate,
        signature_recipient_scope: selectedScope,
        signature_sender_overrides: overrides,
      });
      toastOk('Company signature settings updated - every employee at this company picks it up automatically.');
      loadPreview(companyId);      // re-normalizes overrides (ids assigned, empty groups dropped)
      loadManualSigs(companyId);   // manual signatures render with this template too
    } catch (e) { toastErr(e?.message || 'Could not save.'); }
    setSaveBusy(false);
  }

  async function deleteManualSig(sig) {
    if (!window.confirm(`Delete the "${sig.name}" signature?`)) return;
    try {
      await api.deleteManualSignature(companyId, sig.id);
      setManualSigs(rows => rows.filter(r => r.id !== sig.id));
      toastOk('Signature deleted.');
    } catch (e) { toastErr(e?.message || 'Could not delete.'); }
  }

  return (
    <Section icon={Signature} title="Email Signature" onToggle={load}
      sub="One visual template per company, applied to every employee's signature automatically - name/role/e-mail still come from their own directory record. Sign-off and LinkedIn are each employee's own choice, set from My Profile.">
      {entities.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--muted)' }}>{loaded ? 'No companies set up yet - add one under Company Setup first.' : 'Loading…'}</div>
      ) : (
        <>
          <div style={{ marginBottom: 14 }}>
            <label style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.05em', color: 'var(--muted)', textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>Company</label>
            <select className="form-input" style={{ width: '100%', maxWidth: 320 }} value={companyId} onChange={e => pickCompany(e.target.value)}>
              {entities.map(en => <option key={en.id} value={en.id}>{en.name}</option>)}
            </select>
          </div>
          {previewBusy && !data ? (
            <Loader2 size={18} style={{ animation: 'spin 1s linear infinite', color: 'var(--muted)' }} />
          ) : data && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10, marginBottom: 14 }}>
                {data.templates.map(t => {
                  const selected = t.id === selectedTemplate;
                  return (
                    <div key={t.id} role="button" tabIndex={0} onClick={() => setSelectedTemplate(t.id)}
                      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedTemplate(t.id); } }}
                      style={{
                        textAlign: 'left', cursor: 'pointer', padding: 10, borderRadius: 8,
                        border: selected ? '2px solid hsl(var(--color-green))' : '1px solid var(--line)',
                        background: 'var(--card)', position: 'relative',
                      }}>
                      <button type="button" title={`Preview ${t.label} full-size`}
                        onClick={e => { e.stopPropagation(); setZoomTemplate(t); }}
                        style={{
                          position: 'absolute', top: 6, right: 6, background: 'var(--card)',
                          border: '1px solid var(--line)', borderRadius: 6, cursor: 'pointer',
                          display: 'flex', padding: 4, color: 'var(--muted)', zIndex: 1,
                        }}>
                        <Eye size={13} />
                      </button>
                      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--ink)', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 4 }}>
                        {t.label}
                        {selected && <Check size={12} style={{ color: 'hsl(var(--color-green))' }} />}
                      </div>
                      <SignaturePaper html={t.html} />
                    </div>
                  );
                })}
              </div>

              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.05em', color: 'var(--muted)', textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>
                  Insert For
                </label>
                <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                  {[
                    ['all', 'All Recipients'],
                    ['internal', 'Internal Only'],
                    ['external', 'External Only'],
                  ].map(([value, label]) => (
                    <label key={value} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--ink)', cursor: 'pointer' }}>
                      <input type="radio" name="signatureRecipientScope" value={value}
                        checked={selectedScope === value} onChange={() => setSelectedScope(value)} />
                      {label}
                    </label>
                  ))}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>
                  Internal/external is decided by matching each recipient's domain against this company's email domains (Company Setup). Applies to every employee's Outlook add-in automatically.
                </div>
              </div>

              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.05em', color: 'var(--muted)', textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>
                  Sender Template Overrides
                </label>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 10 }}>
                  A handful of specific senders (the CEO, a shared sales inbox) get a different template than the company default above - everything else about their signature (name, role, phone, logo) still comes from their own record.
                </div>
                {overrides.map((grp, idx) => (
                  <div key={idx} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 10, padding: 10, border: '1px solid var(--line)', borderRadius: 8 }}>
                    <div style={{ flex: '0 0 150px' }}>
                      <input className="form-input" placeholder="Label (optional)" value={grp.label}
                        onChange={e => updateOverride(idx, { label: e.target.value })}
                        style={{ width: '100%', marginBottom: 6 }} />
                      <select className="form-input" style={{ width: '100%' }} value={grp.template}
                        onChange={e => updateOverride(idx, { template: e.target.value })}>
                        {(data.templates || []).map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                      </select>
                    </div>
                    <select multiple className="form-input" style={{ flex: 1, minHeight: 84 }}
                      value={grp.emails}
                      onChange={e => updateOverride(idx, { emails: Array.from(e.target.selectedOptions, o => o.value) })}>
                      {companyPeople.map(p => <option key={p.email} value={p.email}>{p.name} ({p.email})</option>)}
                    </select>
                    <button type="button" title="Remove this override" onClick={() => removeOverride(idx)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', padding: 6 }}>
                      <Trash2 size={15} />
                    </button>
                  </div>
                ))}
                <button type="button" className="secondary-btn" onClick={addOverride}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <Plus size={14} /> Add Override
                </button>
              </div>

              <button className="primary-btn" onClick={save} disabled={saveBusy}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, opacity: saveBusy ? 0.6 : 1 }}>
                {saveBusy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Check size={14} />} Save
              </button>

              <div style={{ marginTop: 22, marginBottom: 10 }}>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.05em', color: 'var(--muted)', textTransform: 'uppercase', marginBottom: 4 }}>
                  Manual Signatures
                </div>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                  For a sender email that isn't a Nexus employee - a shared inbox, an external contact, anyone without a directory record. Uses this company's template above.
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10 }}>
                {manualSigs.map(sig => (
                  <div key={sig.id} style={{ textAlign: 'left', padding: 10, borderRadius: 8, border: '1px solid var(--line)', background: 'var(--card)', position: 'relative' }}>
                    <div style={{ position: 'absolute', top: 6, right: 6, display: 'flex', gap: 4, zIndex: 1 }}>
                      <button type="button" title={`Preview ${sig.name} full-size`} onClick={() => setZoomTemplate({ label: sig.name, html: sig.html })}
                        style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 6, cursor: 'pointer', display: 'flex', padding: 4, color: 'var(--muted)' }}>
                        <Eye size={13} />
                      </button>
                      <button type="button" title="Edit" onClick={() => setManualModal(sig)}
                        style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 6, cursor: 'pointer', display: 'flex', padding: 4, color: 'var(--muted)' }}>
                        <Pencil size={13} />
                      </button>
                      <button type="button" title="Delete" onClick={() => deleteManualSig(sig)}
                        style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 6, cursor: 'pointer', display: 'flex', padding: 4, color: 'hsl(var(--color-red))' }}>
                        <Trash2 size={13} />
                      </button>
                    </div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--ink)', marginBottom: 6, paddingRight: 60, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {sig.name}
                    </div>
                    <SignaturePaper html={sig.html} />
                  </div>
                ))}
                <div role="button" tabIndex={0} onClick={() => setManualModal('new')}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setManualModal('new'); } }}
                  style={{
                    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4,
                    minHeight: 92, cursor: 'pointer', borderRadius: 8, border: '1.5px dashed var(--line)',
                    background: 'transparent', color: 'var(--muted)',
                  }}>
                  <Plus size={18} />
                  <span style={{ fontSize: 11.5, fontWeight: 600 }}>Add Signature</span>
                </div>
              </div>
            </>
          )}
        </>
      )}
      {zoomTemplate && (
        <SignatureZoomModal title={zoomTemplate.label} html={zoomTemplate.html} onClose={() => setZoomTemplate(null)} />
      )}
      {manualModal && (
        <ManualSignatureModal
          companyId={companyId}
          sig={manualModal === 'new' ? null : manualModal}
          onClose={() => setManualModal(null)}
          onSaved={updated => {
            setManualSigs(rows => {
              const exists = rows.some(r => r.id === updated.id);
              return exists ? rows.map(r => (r.id === updated.id ? updated : r)) : [...rows, updated];
            });
          }}
          toastOk={toastOk} toastErr={toastErr}
        />
      )}
    </Section>
  );
}

function ManualSignatureModal({ companyId, sig, onClose, onSaved, toastOk, toastErr }) {
  const [name, setName] = useState(sig?.name || '');
  const [title, setTitle] = useState(sig?.title || '');
  const [companyName, setCompanyName] = useState(sig?.companyName || '');
  const [address, setAddress] = useState(sig?.address || '');
  const [url, setUrl] = useState(sig?.url || '');
  const [customFields, setCustomFields] = useState(sig?.customFields?.length ? sig.customFields : []);
  const [row, setRow] = useState(sig || null);   // saved row (has an id/logoUrl/html once created)
  const [busy, setBusy] = useState(false);
  const [logoBusy, setLogoBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  function addField() { setCustomFields(f => [...f, { label: '', value: '' }]); }
  function setField(i, key, val) { setCustomFields(f => f.map((r, idx) => (idx === i ? { ...r, [key]: val } : r))); }
  function removeField(i) { setCustomFields(f => f.filter((_, idx) => idx !== i)); }

  async function save() {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const body = { name: name.trim(), title, company_name: companyName, address, url, custom_fields: customFields };
      const saved = row
        ? await api.updateManualSignature(companyId, row.id, body)
        : await api.createManualSignature(companyId, body);
      setRow(saved);
      onSaved(saved);
      toastOk('Signature saved.');
    } catch (e) { toastErr(e?.message || 'Could not save.'); }
    setBusy(false);
  }

  async function uploadLogo(file) {
    if (!file || !row) return;
    setLogoBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const updated = await api.uploadManualSignatureLogo(companyId, row.id, form);
      setRow(updated);
      onSaved(updated);
      toastOk('Logo uploaded.');
    } catch (e) { toastErr(e?.message || 'Could not upload logo.'); }
    setLogoBusy(false);
  }

  async function copySignature() {
    if (!row?.html) return;
    try {
      if (navigator.clipboard?.write && window.ClipboardItem) {
        const blob = new Blob([row.html], { type: 'text/html' });
        await navigator.clipboard.write([new ClipboardItem({ 'text/html': blob })]);
      } else {
        await navigator.clipboard.writeText(row.html);
      }
      setCopied(true); setTimeout(() => setCopied(false), 2000);
    } catch { toastErr('Could not copy - open the preview and copy manually.'); }
  }

  const inputStyle = { width: '100%' };
  const label = { fontSize: 11, fontWeight: 700, letterSpacing: '.05em', color: 'var(--muted)', textTransform: 'uppercase', display: 'block', marginBottom: 5 };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: 'var(--card)', borderRadius: 12, maxWidth: 480, width: '100%', maxHeight: '86vh', overflow: 'auto', boxShadow: 'var(--shadow-lg)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', borderBottom: '1px solid var(--line)' }}>
          <span style={{ fontSize: 13.5, fontWeight: 700, flex: 1, color: 'var(--ink)' }}>{row ? 'Edit Signature' : 'Add Signature'}</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}>
            <X size={18} />
          </button>
        </div>
        <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <label style={label}>Name</label>
            <input className="form-input" style={inputStyle} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Sales Inbox" />
          </div>
          <div>
            <label style={label}>Title</label>
            <input className="form-input" style={inputStyle} value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Sales Team" />
          </div>
          <div>
            <label style={label}>Company Name</label>
            <input className="form-input" style={inputStyle} value={companyName} onChange={e => setCompanyName(e.target.value)} />
          </div>
          <div>
            <label style={label}>Company Address</label>
            <input className="form-input" style={inputStyle} value={address} onChange={e => setAddress(e.target.value)} />
          </div>
          <div>
            <label style={label}>Company URL</label>
            <input className="form-input" style={inputStyle} value={url} onChange={e => setUrl(e.target.value)} placeholder="example.com" />
          </div>
          <div>
            <label style={label}>Company Logo</label>
            {row ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {row.logoUrl && <img src={row.logoUrl} alt="" style={{ height: 32, maxWidth: 120, objectFit: 'contain', borderRadius: 4, background: '#fff', border: '1px solid var(--line)' }} />}
                <label className="secondary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', opacity: logoBusy ? 0.6 : 1 }}>
                  {logoBusy ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Upload size={13} />}
                  {row.logoUrl ? 'Replace' : 'Upload'}
                  <input type="file" accept="image/*" style={{ display: 'none' }} disabled={logoBusy}
                    onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) uploadLogo(f); }} />
                </label>
              </div>
            ) : (
              <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>Save once first, then upload a logo.</div>
            )}
          </div>

          <div>
            <label style={label}>Custom Fields</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {customFields.map((f, i) => (
                <div key={i} style={{ display: 'flex', gap: 6 }}>
                  <input className="form-input" style={{ flex: 1 }} placeholder="Label" value={f.label} onChange={e => setField(i, 'label', e.target.value)} />
                  <input className="form-input" style={{ flex: 1 }} placeholder="Value" value={f.value} onChange={e => setField(i, 'value', e.target.value)} />
                  <button type="button" onClick={() => removeField(i)}
                    style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 6, cursor: 'pointer', color: 'hsl(var(--color-red))', display: 'flex', alignItems: 'center', padding: '0 8px' }}>
                    <X size={14} />
                  </button>
                </div>
              ))}
              <button type="button" className="secondary-btn" onClick={addField}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, alignSelf: 'flex-start' }}>
                <Plus size={13} /> Add Field
              </button>
            </div>
          </div>

          {row?.html && (
            <div>
              <label style={label}>Preview</label>
              <SignaturePaper html={row.html} height={90} scale={0.85} />
              <button className="secondary-btn" onClick={copySignature}
                style={{ marginTop: 8, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy Signature'}
              </button>
            </div>
          )}

          <button className="primary-btn" onClick={save} disabled={busy || !name.trim()}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, opacity: busy ? 0.6 : 1, alignSelf: 'flex-start' }}>
            {busy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Check size={14} />} Save
          </button>
        </div>
      </div>
    </div>
  );
}

// ── People: Company Setup, Work Sites, Sync M365 ──────────────────────────────
// M365 directory sync only now - Company Setup and Work Sites moved out to
// their own top-level "Company Setup" tab (Pranshu, Sep 18), since a company
// has too much on it (departments, per-company work sites, holiday calendar)
// to keep managing from a popup nested inside this accordion.
function M365SyncSection({ toastOk, toastErr }) {
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncLabel, setSyncLabel] = useState('');

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
    <Section icon={RefreshCw} title="M365 Sync" sub="Pull/push the M365 directory - originally on the People → Overview screen.">
      <button className="secondary-btn" onClick={runSync} disabled={syncBusy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        {syncBusy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <RefreshCw size={14} />}
        {syncBusy && syncLabel ? syncLabel : 'Sync M365'}
      </button>
    </Section>
  );
}

// ── Company Setup tab (Pranshu, Sep 18) - its own top-level tab, not an
// accordion popup: legal entities, and inside each one's full-screen editor,
// its departments, work sites, and (soon) holiday calendar.
function CompanySetupSection({ toastOk, toastErr }) {
  const [entities, setEntities] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [sites, setSites] = useState([]);
  const [loaded, setLoaded] = useState(false);

  const loadEntities = useCallback(() => api.getEntities().then(setEntities).catch(() => {}), []);
  const loadSites = useCallback(() => api.getWorkSites().then(setSites).catch(() => {}), []);

  useEffect(() => {
    if (loaded) return;
    setLoaded(true);
    loadEntities();
    loadSites();
    api.getEmployees().then(rows => {
      setEmployees((rows || []).filter(e => !['guest', 'external'].includes(e.identityType || 'internal')));
    }).catch(() => {});
  }, [loaded, loadEntities, loadSites]);

  return (
    <Suspense fallback={<div style={{ fontSize: 13, color: 'var(--muted)', padding: '24px 0' }}>Loading…</div>}>
      <CompanySetupPage entities={entities} employees={employees} sites={sites}
        onChangedEntities={loadEntities} onChangedSites={loadSites} toastOk={toastOk} toastErr={toastErr} />
    </Suspense>
  );
}

// ── Act As ───────────────────────────────────────────────────────────────────
// The people list shows straight away (Pranshu, Sep 11) - no accordion to
// open, no dropdown/modal to click through first, same as picking someone in
// a search box anywhere else in Nexus. Reuses useRole's startActAs/stopActAs,
// same as the header dropdown's own Act As entry point.
function ActAsSection() {
  const { actingAs, startActAs, stopActAs } = useRole();
  const [stopping, setStopping] = useState(false);

  async function handleExit() {
    setStopping(true);
    try { await stopActAs(); } finally { setStopping(false); }
  }

  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 12, background: 'var(--card)', padding: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <span style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--paper)', border: '1px solid var(--line)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
          <UserCog size={14} style={{ color: 'var(--ink)' }} />
        </span>
        <span>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--ink)' }}>Act As</div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>Temporarily see and act in Nexus as another employee, scoped to roles below your own.</div>
        </span>
      </div>

      {actingAs ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 14 }}>
          <span style={{ fontSize: 12.5, color: 'var(--ink)' }}>
            Currently acting as <strong>{actingAs.targetName}</strong> ({actingAs.targetEmail}).
          </span>
          <button className="secondary-btn" onClick={handleExit} disabled={stopping}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'hsl(var(--color-red))' }}>
            <DoorOpen size={14} /> {stopping ? 'Exiting…' : 'Exit Act As'}
          </button>
        </div>
      ) : (
        <div style={{ marginTop: 14 }}>
          <Suspense fallback={<div style={{ fontSize: 13, color: 'var(--muted)', padding: '12px 0' }}>Loading…</div>}>
            <ActAsPicker onStart={startActAs} autoFocus={false} />
          </Suspense>
        </div>
      )}
    </div>
  );
}

const TOP_TABS = [
  { key: 'settings', label: 'Company Settings', Icon: SlidersHorizontal },
  { key: 'company',  label: 'Company Setup',    Icon: Building2 },
  { key: 'access',   label: 'Roles & Access',   Icon: Shield },
  { key: 'actas',    label: 'Act As',           Icon: UserCog },
  { key: 'audit',    label: 'Audit Logs',       Icon: Activity },
];

export default function AdminConsole({ activeSub, onSubChange }) {
  const { can, myGrantedModules, actingAs } = useRole();
  const canActAs = (can?.('manager') ?? false) || !!myGrantedModules?.has?.('act-as');
  const [toast, setToast] = useState(null); // { msg, kind }
  const showToast = useCallback((msg, kind = 'success') => {
    setToast({ msg, kind });
    setTimeout(() => setToast(null), 3000);
  }, []);
  const toastOk = useCallback((msg) => showToast(msg, 'success'), [showToast]);
  const toastErr = useCallback((msg) => showToast(msg, 'error'), [showToast]);

  const visibleTabs = TOP_TABS.filter(({ key }) => key !== 'actas' || canActAs || actingAs);
  const topTab = visibleTabs.some(t => t.key === activeSub) ? activeSub : 'settings';
  const setTopTab = (id) => onSubChange ? onSubChange(id) : undefined;

  // Full-bleed, like every other module (HR, Item Management, Tickets) - no
  // maxWidth cap or extra padding of its own. .viewport (App.jsx) already
  // supplies the edge margin; a centered ~1100px column here just wasted the
  // rest of a wide monitor and forced a lot of scrolling on the bigger
  // embedded panels (Pranshu, Sep 9).
  return (
    <div style={{ fontFamily: 'Inter, sans-serif' }}>
      {/* Icon-chip page title (Work OS grammar), matching every other module's
          .view-header instead of a bespoke h1 (Pranshu, Sep 12). */}
      <div className="view-header" style={{ marginBottom: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
          <span style={{ width: 38, height: 38, borderRadius: 10, background: 'var(--wk-brand-tint)', color: 'var(--wk-brand)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Settings2 size={19} />
          </span>
          <div className="view-title-group">
            <h2 style={{ fontFamily: 'var(--wk-font)' }}>Settings</h2>
            <p>Company-wide settings and access control, all in one place - no code change required for any of it.</p>
          </div>
        </div>
      </div>

      {/* Tabs - desktop renders them centered in the top header; phones keep
          the in-page strip (ModuleTabs handles both) */}
      <ModuleTabs tabs={visibleTabs} active={topTab} onChange={setTopTab} />

      {topTab === 'company' ? (
        <CompanySetupSection toastOk={toastOk} toastErr={toastErr} />
      ) : topTab === 'access' ? (
        <Suspense fallback={<div style={{ fontSize: 13, color: 'var(--muted)', padding: '24px 0' }}>Loading…</div>}>
          <RolesAccess embedded />
        </Suspense>
      ) : topTab === 'audit' ? (
        <Suspense fallback={<div style={{ fontSize: 13, color: 'var(--muted)', padding: '24px 0' }}>Loading…</div>}>
          <AuditLogs />
        </Suspense>
      ) : topTab === 'actas' ? (
        <ActAsSection />
      ) : (
        <>
          <div style={{ fontSize: 10.5, fontWeight: 800, color: 'var(--muted)', letterSpacing: '.06em', marginBottom: 8 }}>
            COMPANY SETTINGS
          </div>
          <ItemSettingsSection toast={showToast} />
          <TicketSettingsSections />
          <DailyBriefingSection />
          <EmailSignatureSection toastOk={toastOk} toastErr={toastErr} />
          <M365SyncSection toastOk={toastOk} toastErr={toastErr} />
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
