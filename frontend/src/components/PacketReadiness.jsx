// Ready To Send (Oct 14): a packet's checklist - "nothing is ever silently
// missing" (Pranshu, after a hire on dev where the salary never printed and
// the company had no HR contact, and nothing said so). Each check comes from
// the server (hr_packet_docs.readiness) with the fix this screen offers:
//   entityField     - set the company's HR contact / signatory / address here
//   template        - open the template in Documents
//   signOnce        - the company signs once (the editor opens Sign Once)
//   addToForm       - add the variables nothing fills to the Details Form
//   checklistOwners - People > Checklists > Checklist Owners
import { useEffect, useState } from 'react';
import { CheckCircle, AlertTriangle, AlertCircle, ExternalLink, PenTool, Plus } from 'lucide-react';
import { api } from '../api';
import { setPendingOpen } from '../lib/pendingOpen';
import { Spinner } from './AsyncState';

const TONE = { ok: 'green', block: 'red', warn: 'orange' };
const btn = { fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' };

function EntityFix({ fix, onChanged, toastErr }) {
  const [people, setPeople] = useState(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const isPerson = fix.field !== 'physical_address';
  useEffect(() => {
    if (isPerson) api.getPeopleDirectory().then(r => setPeople(r || [])).catch(() => setPeople([]));
  }, [isPerson]);
  async function save() {
    setBusy(true);
    try { await api.updateEntity(fix.entityId, { [fix.field]: value.trim() }); onChanged?.(); }
    catch (e) { toastErr?.(e?.message || 'Could not save it.'); }
    setBusy(false);
  }
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      {isPerson ? (
        <select className="form-input" style={{ width: 220, fontSize: 12 }} value={value} onChange={e => setValue(e.target.value)}
          aria-label={fix.field === 'signatory_email' ? 'Authorized Signatory' : 'HR Contact'} disabled={people === null}>
          <option value="">{people === null ? 'Loading people...' : 'Pick a person...'}</option>
          {(people || []).map(p => {
            const email = p.workEmail || p.email || '';
            return email ? <option key={email} value={email}>{p.name || `${p.firstName || ''} ${p.lastName || ''}`.trim() || email}</option> : null;
          })}
        </select>
      ) : (
        <input className="form-input" style={{ width: 260, fontSize: 12 }} value={value} onChange={e => setValue(e.target.value)}
          placeholder="Company address" aria-label="Company address" />
      )}
      <button type="button" className="primary-btn" disabled={busy || !value.trim()} onClick={save} style={btn}>
        {busy ? <Spinner size={12} /> : <CheckCircle size={12} />} Set
      </button>
    </span>
  );
}

export default function PacketReadiness({ checks, meEmails = [], onChanged, onSignOnce, onAddToForm, toastErr }) {
  const openTemplate = (id) => {
    setPendingOpen('doc-template', id);
    window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'documents', sub: 'documents-templates' } }));
  };
  const me = new Set((meEmails || []).map(e => String(e || '').toLowerCase()));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {(checks || []).map(c => {
        const tone = TONE[c.ok ? 'ok' : c.severity] || 'orange';
        const Icon = c.ok ? CheckCircle : c.severity === 'warn' ? AlertTriangle : AlertCircle;
        const f = c.fix;
        return (
          <div key={c.key} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '8px 10px', borderRadius: 10,
            background: c.ok ? 'transparent' : `hsla(var(--color-${tone}),0.08)`, border: c.ok ? '1px solid transparent' : `1px solid hsla(var(--color-${tone}),0.25)` }}>
            <Icon size={15} style={{ color: `hsl(var(--color-${tone}))`, flexShrink: 0, marginTop: 1 }} />
            <div style={{ flex: '1 1 260px', minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 700 }}>{c.label}</div>
              {c.detail && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2, lineHeight: 1.45 }}>{c.detail}</div>}
              {f && (
                <div style={{ marginTop: 6 }}>
                  {f.kind === 'entityField' && <EntityFix fix={f} onChanged={onChanged} toastErr={toastErr} />}
                  {f.kind === 'template' && f.templateId && (
                    <button type="button" className="secondary-btn" onClick={() => openTemplate(f.templateId)} style={btn}><ExternalLink size={12} /> Open Template</button>
                  )}
                  {f.kind === 'signOnce' && (me.has(String(f.email || '').toLowerCase())
                    ? <button type="button" className="primary-btn" onClick={() => onSignOnce?.(f.step)} style={btn}><PenTool size={12} /> Sign Once</button>
                    : <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{f.email ? `Waiting for ${f.email} to open this packet and sign once.` : ''}</span>)}
                  {f.kind === 'addToForm' && (
                    <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
                      <button type="button" className="primary-btn" onClick={() => onAddToForm?.(f.variables || [])} style={btn}><Plus size={12} /> Add To Details Form</button>
                      {f.templateId && <button type="button" className="secondary-btn" onClick={() => openTemplate(f.templateId)} style={btn}><ExternalLink size={12} /> Open Template</button>}
                    </span>
                  )}
                  {f.kind === 'checklistOwners' && (
                    <button type="button" className="secondary-btn" style={btn}
                      onClick={() => window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'hr', sub: 'hr-checklists' } }))}>
                      <ExternalLink size={12} /> Set Checklist Owners
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
