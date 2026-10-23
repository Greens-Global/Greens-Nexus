// Settings panels that have no home module of their own (Oct 23 2026, phase 3
// of the Settings redesign, plan https://claude.ai/artifact/UGtPmeFBrfU6wXhd474erx):
// the Ticket Property Rules (an API with no screen until now), the unit
// word rules (the same UnitClasses the Facility Operations screen shows,
// loaded here on its own) and the app & website ratings (the same list the
// Workforce Analytics dashboard rates from). Everything else Settings shows
// is the component its module owns, borrowed by AdminConsole.jsx.
import { useCallback, useEffect, useState } from 'react';
import { useGroupDirty } from '../lib/groupDirty';
import { Check } from 'lucide-react';
import { api } from '../api';
import { useRole } from '../contexts/RoleContext';
import { ErrorBanner, SkeletonBlocks, Spinner } from '../components/AsyncState';
import { SERVICE_AREAS } from '../tickets/ticketMeta';
import UnitClasses from '../operations/UnitClasses';
import { RatingsList } from '../components/TimeInsights';

const LBL = { fontSize: 11, fontWeight: 700, letterSpacing: '.05em', color: 'var(--muted)', textTransform: 'uppercase', display: 'block', marginBottom: 6 };

// ── Tickets > Property Rules ─────────────────────────────────────────────────
// Which tickets must name a property: by service area (a fixed list,
// tickets/ticketMeta.js) and by help topic (typed, matched by name). Ticket
// supervisors and administrators save (routers/ticket_property.py).
export function TicketPropertyRulesPanel({ toastOk, toastErr }) {
  const { can } = useRole();
  const [rules, setRules] = useState(null);
  const [err, setErr] = useState('');
  const [areas, setAreas] = useState([]);
  const [topics, setTopics] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    setErr('');
    api.getTicketPropertyRulesFresh()
      .then((r) => { setRules(r); setAreas(r.requiredServiceAreas || []); setTopics((r.requiredTopics || []).join(', ')); })
      .catch((e) => setErr(e?.message || 'Could not load the property rules.'));
  }, []);
  useEffect(() => { load(); }, [load]);

  const toggle = (key) => setAreas((a) => (a.includes(key) ? a.filter((k) => k !== key) : [...a, key]));
  const dirty = !!rules && (JSON.stringify([...areas].sort()) !== JSON.stringify([...(rules.requiredServiceAreas || [])].sort())
    || topics.split(',').map((t) => t.trim()).filter(Boolean).join(', ') !== (rules.requiredTopics || []).join(', '));
  useGroupDirty(dirty);

  async function save() {
    setBusy(true);
    try {
      const r = await api.saveTicketPropertyRules({ requiredServiceAreas: areas, requiredTopics: topics.split(',').map((t) => t.trim()).filter(Boolean) });
      setRules(r); setAreas(r.requiredServiceAreas || []); setTopics((r.requiredTopics || []).join(', '));
      toastOk?.('Property rules saved.');
    } catch (e) { toastErr?.(e?.message || 'Could not save the property rules.'); }
    setBusy(false);
  }

  if (err) return <ErrorBanner message={err} onRetry={load} />;
  if (!rules) return <SkeletonBlocks count={2} height={44} borderRadius={10} />;
  // Administrators and ticket supervisors save; the server says no to anyone
  // else (the desk roles are its to know), so everyone below administrator
  // sees the controls and the note.
  const readOnly = false;
  const note = !can('administrator');
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <p style={{ margin: 0, fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 }}>
        A ticket in one of these service areas, or on one of these help topics, has to name the property it is about before it can be submitted. Suggest Property Links then proposes a property for older tickets, and a person approves each one.
      </p>
      <div>
        <span style={LBL}>Service Areas That Need a Property</span>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '6px 14px' }}>
          {SERVICE_AREAS.map((a) => (
            <label key={a.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13, cursor: readOnly ? 'default' : 'pointer' }}>
              <input type="checkbox" checked={areas.includes(a.key)} disabled={readOnly || busy} onChange={() => toggle(a.key)} /> {a.label}
            </label>
          ))}
        </div>
      </div>
      <div>
        <label style={LBL} htmlFor="ticket-property-topics">Help Topics That Need a Property</label>
        <input id="ticket-property-topics" className="form-input" value={topics} disabled={readOnly || busy} onChange={(e) => setTopics(e.target.value)}
          placeholder="e.g. Gate Access, Unit Repair - comma-separated, matched by name" style={{ width: '100%', fontSize: 12.5 }} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <button type="button" className="primary-btn" onClick={save} disabled={readOnly || busy || !dirty} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {busy ? <Spinner size={14} /> : <Check size={14} />} Save
        </button>
        {note && <span style={{ fontSize: 12, color: 'var(--muted)' }}>Only a ticket supervisor or an administrator can change these.</span>}
      </div>
    </div>
  );
}

// ── Operations > Unit Rules ──────────────────────────────────────────────────
// The same UnitClasses the Facility Operations Units tab shows, with its own
// load. Managers (level 3) or an Operations editor grant save, as the route
// requires.
export function UnitRulesPanel() {
  const { can } = useRole();
  const [rules, setRules] = useState(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => {
    setErr('');
    api.getOpsUnitClasses().then(setRules).catch((e) => setErr(e?.message || 'Could not load the unit rules.'));
  }, []);
  useEffect(() => { load(); }, [load]);
  if (err) return <ErrorBanner message={err} onRetry={load} />;
  if (!rules) return <SkeletonBlocks count={2} height={44} borderRadius={10} />;
  return <UnitClasses rules={rules} canEdit={can('manager')} onSaved={load} />;
}

// ── Workforce Analytics > App & Website Ratings ──────────────────────────────
// The ratings the dashboard's productive / neutral / unproductive split comes
// from - the same list the Activity tab's Rate button opens.
export function AppRatingsPanel() {
  return (
    <div>
      <p style={{ margin: '0 0 10px', fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 }}>
        Every application and website seen on a company computer, rated productive, neutral or unproductive. One rating for all of Nexus. Something not rated counts as neutral.
      </p>
      <RatingsList seed={[]} />
    </div>
  );
}
