import { useEffect, useState } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, Settings, X } from 'lucide-react';
import { api } from '../../api';
import { formatDate } from '../../lib/datetime';
import { control } from './reportControls';
import { EgnyteField } from './LoanDialogs';

// What MRI (LeasingTab) and MRE (MreTab) share (Oct 22): the period control,
// the frequencies, the Possibly Ended chip and the settings dialog - one copy,
// so the two screens stay the same.

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Period presets within the year (MRI, Oct 6; MRE, Oct 22 - Priyanka: "only
// yearly; add monthly, quarterly and custom like MRI").
export const PERIODS = [
  { key: 'year', label: 'Full Year' }, { key: 'ytd', label: 'Year-to-Date' }, { key: 'q1', label: 'Q1' }, { key: 'q2', label: 'Q2' }, { key: 'q3', label: 'Q3' }, { key: 'q4', label: 'Q4' },
  { key: 'month', label: 'This Month' }, { key: 'custom', label: 'Custom Months' },
];

/** [first month index, last month index] of a period within `year`. */
export function periodMonths(key, year, custom = [0, 11], today = new Date()) {
  const thisYear = today.getFullYear() === year;
  const m = today.getMonth();
  if (key === 'ytd') return [0, thisYear ? m : 11];
  if (/^q[1-4]$/.test(key)) { const q = Number(key[1]) - 1; return [q * 3, q * 3 + 2]; }
  if (key === 'month') return thisYear ? [m, m] : [11, 11];
  if (key === 'custom') return [Math.min(custom[0], custom[1]), Math.max(custom[0], custom[1])];
  return [0, 11];
}

/** "Q2 2026 (Apr - Jun)". */
export function periodText(period, year, span) {
  return `${PERIODS.find((p) => p.key === period)?.label || 'Full Year'} ${year} (${MONTHS[span[0]]}${span[1] !== span[0] ? ` - ${MONTHS[span[1]]}` : ''})`;
}

const arrow = { border: 'none', background: 'none', padding: 5, cursor: 'pointer', display: 'inline-flex', color: 'var(--text-muted)' };

/** The year arrows, the period pick and, for Custom Months, from / to. */
export function PeriodPicker({ year, onYear, period, onPeriod, custom, onCustom }) {
  return (
    <div role="group" aria-label="Period" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
      <button type="button" style={arrow} aria-label="Previous year" onClick={() => onYear(year - 1)}><ChevronLeft size={16} /></button>
      <strong style={{ fontSize: '0.86rem', minWidth: 40, textAlign: 'center' }}>{year}</strong>
      <button type="button" style={arrow} aria-label="Next year" disabled={year >= new Date().getFullYear() + 1} onClick={() => onYear(year + 1)}><ChevronRight size={16} /></button>
      <select value={period} onChange={(e) => onPeriod(e.target.value)} aria-label="Months" style={control}>
        {PERIODS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
      </select>
      {period === 'custom' && (
        <>
          <select value={custom[0]} onChange={(e) => onCustom([Number(e.target.value), Math.max(custom[1], Number(e.target.value))])} aria-label="From month" style={control}>{MONTHS.map((m, i) => <option key={m} value={i}>{m}</option>)}</select>
          <span style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>to</span>
          <select value={custom[1]} onChange={(e) => onCustom([Math.min(custom[0], Number(e.target.value)), Number(e.target.value)])} aria-label="To month" style={control}>{MONTHS.map((m, i) => <option key={m} value={i}>{m}</option>)}</select>
        </>
      )}
    </div>
  );
}

// Frequencies (MRE Oct 14; MRI Oct 22). '' / monthly is every line saved before.
export const FREQUENCY = { monthly: 'Monthly', quarterly: 'Quarterly', semi_annual: 'Semi-Annual', annual: 'Annual', custom: 'Custom' };
const STEP = { monthly: 1, quarterly: 3, semi_annual: 6, annual: 12 };
export const CUSTOM_MAX_MONTHS = 60;

/** How many months apart a line falls due (Custom: its period; none = monthly). The API's step_months / lease_step. */
export function stepMonths(line) {
  if (line?.frequency === 'custom') {
    const n = Math.floor(Number(line.frequencyMonths) || 0);
    return n >= 1 && n <= CUSTOM_MAX_MONTHS ? n : 1;
  }
  return STEP[line?.frequency] || 1;
}

/** "Monthly", "Semi-Annual", "Every 2 Months" (Custom). */
export function frequencyLabel(line) {
  if (line?.frequency === 'custom') {
    const n = stepMonths(line);
    return n === 1 ? 'Every Month' : `Every ${n} Months`;
  }
  return FREQUENCY[line?.frequency] || 'Monthly';
}

const monthText = (key) => (key ? `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}` : '');

/** The daily check's flag (Neil, Oct 21): nothing posted for N months - mark it inactive? */
export function PossiblyEndedChip({ flag, kind = 'mre' }) {
  if (!flag) return null;
  const tip = `Nothing has posted for this ${kind === 'mri' ? 'source' : 'line'} recently${flag.lastPaid ? ` - the last posting was in ${monthText(flag.lastPaid)}` : ' - nothing in the last twelve months'}. `
    + `If it has ended, ${kind === 'mri' ? 'set its Status to Ended' : 'edit it and press End Today'}. Flagged ${formatDate(flag.since)}${flag.taskId ? '; an accounting task was opened' : ''}.`;
  return (
    <span title={tip} aria-label={`Possibly Ended. ${tip}`} data-testid="possibly-ended"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 3, marginLeft: 6, padding: '0 7px', borderRadius: 999, fontSize: '0.66rem', fontWeight: 700, whiteSpace: 'nowrap', verticalAlign: 'middle', color: '#92400e', background: 'rgba(180,83,9,0.13)', border: '1px solid rgba(180,83,9,0.35)', flexShrink: 0 }}>
      <AlertTriangle size={10} /> Possibly Ended
    </span>
  );
}

const lbl = { fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' };

/** Settings for MRI and MRE (full access): Possibly Ended after N months, the Egnyte root of the vendor folders, Check Now. */
export function RecurringSettingsButton({ onChecked }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="secondary-btn" onClick={() => setOpen(true)} aria-haspopup="dialog" title="Possibly Ended check and vendor folders"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', height: 30, padding: '0 12px' }}><Settings size={14} /> Settings</button>
      {open && <RecurringSettingsDialog onClose={() => setOpen(false)} onChecked={onChecked} />}
    </>
  );
}

function RecurringSettingsDialog({ onClose, onChecked }) {
  const [s, setS] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  useEffect(() => {
    api.getRecurringSettings().then(setS).catch((e) => { setS({ staleMonths: 3, egnyteRoot: '' }); setError(e?.message || 'Could not read the settings.'); });
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const save = () => {
    setBusy('save');
    setError('');
    api.saveRecurringSettings({ staleMonths: Number(s.staleMonths) || 3, egnyteRoot: s.egnyteRoot || '' })
      .then((d) => { setS(d); setDone('Saved.'); })
      .catch((e) => setError(e?.message || 'Could not save.'))
      .finally(() => setBusy(''));
  };
  const check = () => {
    setBusy('check');
    setError('');
    api.runRecurringStaleCheck()
      .then((d) => {
        setDone(d?.started ? 'The check is running. It reads the ledger for every line and takes a few minutes; the Possibly Ended flags show when you reload.' : 'A check is already running.');
        onChecked?.();
      })
      .catch((e) => setError(e?.message || 'Could not run the check.'))
      .finally(() => setBusy(''));
  };
  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div className="modal-content" role="dialog" aria-modal="true" aria-label="MRI and MRE settings" onClick={(e) => e.stopPropagation()}
        style={{ width: '60vw', minWidth: 'min(420px, 100%)', maxWidth: '100%', minHeight: '60vh', maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}>
        <div className="modal-header">
          <h3 style={{ margin: 0 }}>MRI and MRE Settings</h3>
          <button type="button" onClick={onClose} aria-label="Close" style={arrow}><X size={18} /></button>
        </div>
        <div style={{ padding: '14px 24px 6px', display: 'grid', gap: 16, overflowY: 'auto', flex: 1, alignContent: 'start' }}>
          {!s ? <div style={{ fontSize: '0.84rem', color: 'var(--text-muted)' }}>Loading...</div> : (
            <>
              <div>
                <label style={lbl} htmlFor="rs-months">Possibly Ended After (Months)</label>
                <input id="rs-months" type="number" min={1} max={24} step={1} value={s.staleMonths} onChange={(e) => setS({ ...s, staleMonths: e.target.value })} style={{ ...control, width: 120 }} />
                <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 4 }}>
                  Once a day, an active MRI source or MRE line with nothing posted in this many months (at least one full cycle of its frequency) is flagged Possibly Ended, and one accounting task is opened for it - assigned to the entity&apos;s accountants in Ask My Accountant&apos;s settings. The task closes itself when money posts again or the line is ended. Nothing about the line is changed.
                </div>
              </div>
              <EgnyteField id="rs-root" labelText="Vendor Folders Root (Egnyte)" value={s.egnyteRoot || ''} onChange={(v) => setS({ ...s, egnyteRoot: v })} />
              <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: -10 }}>Find Folder on an MRE line looks for the vendor&apos;s folder under here first, then searches Egnyte for the vendor&apos;s name.</div>
            </>
          )}
          {error && <div style={{ border: '1px solid var(--bad-fg, #dc2626)', color: 'var(--bad-fg, #dc2626)', borderRadius: 8, padding: '8px 12px', fontSize: '0.84rem' }}>{error}</div>}
          {done && <div role="status" style={{ fontSize: '0.82rem', color: 'var(--ok-fg, #15803d)' }}>{done}</div>}
        </div>
        <div className="modal-footer" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button type="button" className="secondary-btn" onClick={check} disabled={!!busy} title="Run the daily Possibly Ended check now">{busy === 'check' ? 'Checking...' : 'Check Now'}</button>
          <span style={{ flex: 1 }} />
          <button type="button" className="secondary-btn" onClick={onClose}>Close</button>
          <button type="button" className="primary-btn" onClick={save} disabled={!s || !!busy}>{busy === 'save' ? 'Saving...' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}
