import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, ChevronLeft, ChevronRight, Settings, X } from 'lucide-react';
import { api } from '../../api';
import { formatDate, formatDateTime } from '../../lib/datetime';
import { control, fitSelect } from './reportControls';
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
      {/* As wide as the period picked (item 02, round 3): "Q1" no longer holds the width of "Custom Months". */}
      <select value={period} onChange={(e) => onPeriod(e.target.value)} aria-label="Months" style={{ ...control, ...fitSelect(PERIODS.find((p) => p.key === period)?.label) }}>
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

const RECHECK_POLL_MS = 3000;
const RECHECK_GIVE_UP_MS = 10 * 60_000;

/** True when a finished check began at or after `since` (both the server's clock). */
export function checkFinishedSince(lastCheck, since) {
  return !!lastCheck?.startedAt && (!since || lastCheck.startedAt >= since);
}

/** "Last checked 10/27/2026 3:05 PM with 5 months: 33 lines Possibly Ended." */
export function lastCheckText(last) {
  if (!last?.at) return 'Not checked yet.';
  const flagged = ['mri', 'mre'].reduce((s, k) => s + (Number(last.result?.[k]?.possiblyEnded) || 0), 0);
  const failed = ['mri', 'mre'].some((k) => last.result?.[k]?.error);
  return `Last checked ${formatDateTime(last.at)} with ${last.months} ${last.months === 1 ? 'month' : 'months'}: ${flagged} ${flagged === 1 ? 'line' : 'lines'} Possibly Ended${failed ? ' (part of the ledger could not be read)' : ''}.`;
}

/**
 * 10/27 (Urmi: "possibly ended settings logic is not working"): saving a new
 * number of months (or Check Now) runs the check on the server right away;
 * this waits for that run to finish - a finished check newer than `since` -
 * then calls onDone, and the screen reloads its rows, so the flags, the
 * counts and the export follow without a reload or a Sync. Kept by the
 * screen, not the Settings button: the bar's More menu remounts the button.
 */
export function useStaleRecheck(onDone) {
  const [state, setState] = useState({ status: '', last: null });   // status: '' | 'running' | 'done' | 'slow'
  const timer = useRef(null);
  const doneRef = useRef(onDone);
  useEffect(() => { doneRef.current = onDone; }, [onDone]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const start = useCallback((since) => {
    clearTimeout(timer.current);
    const began = Date.now();
    setState((s) => ({ ...s, status: 'running' }));
    const again = () => {
      if (Date.now() - began > RECHECK_GIVE_UP_MS) { setState((s) => ({ ...s, status: 'slow' })); return; }
      timer.current = setTimeout(poll, RECHECK_POLL_MS);
    };
    const poll = () => {
      api.getRecurringStaleCheck()
        .then((d) => {
          if (!checkFinishedSince(d?.lastCheck, since)) { again(); return; }
          setState({ status: 'done', last: d.lastCheck });
          doneRef.current?.();
        })
        .catch(again);
    };
    timer.current = setTimeout(poll, RECHECK_POLL_MS);
  }, []);
  const dismiss = useCallback(() => setState((s) => ({ ...s, status: '' })), []);
  return { ...state, start, dismiss };
}

/** The screen's one line while a re-check runs (and if it takes too long). */
export function RecheckStatus({ recheck }) {
  if (recheck?.status === 'running') return <span role="status" style={{ color: 'var(--text-muted)' }}>Re-checking Possibly Ended...</span>;
  if (recheck?.status === 'slow') return <span role="status" style={{ color: '#92400e' }}>The Possibly Ended check is taking longer than usual; Sync later to see its flags.</span>;
  return null;
}

/** Settings for MRI and MRE (full access): Possibly Ended after N months, the Egnyte root of the vendor folders, Check Now. */
export function RecurringSettingsButton({ onChecked, recheck = null }) {
  const [open, setOpen] = useState(false);
  const own = useStaleRecheck(onChecked);
  return (
    <>
      <button type="button" className="secondary-btn" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-label="Settings" title="Possibly Ended check and vendor folders"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', height: 30, padding: '0 12px' }}><Settings size={14} /> <span className="acct-bar-label">Settings</span></button>
      {/* On the page, not inside the bar: from the bar's More menu (item 02) it
          would sit under the menu's layer and hide when the menu closes. */}
      {open && createPortal(<RecurringSettingsDialog onClose={() => setOpen(false)} recheck={recheck || own} />, document.body)}
    </>
  );
}

function RecurringSettingsDialog({ onClose, recheck }) {
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
      .then((d) => {
        setS(d);
        if (d?.recheck) {
          recheck.start(d.recheck.since);
          setDone(`Saved. Every MRI and MRE line is being re-checked with ${d.staleMonths} ${d.staleMonths === 1 ? 'month' : 'months'} now; the Possibly Ended flags on this screen update by themselves when it is done.`);
        } else setDone('Saved.');
      })
      .catch((e) => setError(e?.message || 'Could not save.'))
      .finally(() => setBusy(''));
  };
  const check = () => {
    setBusy('check');
    setError('');
    api.runRecurringStaleCheck()
      .then((d) => {
        recheck.start(d?.since);
        setDone('The check is running. The Possibly Ended flags on this screen update by themselves when it is done.');
      })
      .catch((e) => setError(e?.message || 'Could not run the check.'))
      .finally(() => setBusy(''));
  };
  const last = recheck.status === 'done' && recheck.last ? recheck.last : s?.lastCheck;
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
                  Once a day, and right away when a new number is saved, an active line with nothing posted for a while is flagged Possibly Ended: on MRE a monthly line after this many months in a row, a quarterly, semi-annual or annual one after one cycle and a month (4, 7 or 13 months); on MRI a source after this many months (at least one full cycle of its frequency). One accounting task is opened for it - assigned to the entity&apos;s accountants in Ask My Accountant&apos;s settings. The task closes itself when money posts again or the line is ended. Nothing about the line is changed.
                </div>
                <div data-testid="last-check" style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', marginTop: 4 }}>
                  {recheck.status === 'running' ? 'Checking now...' : lastCheckText(last)}
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
          <button type="button" className="secondary-btn" onClick={check} disabled={!!busy || recheck.status === 'running'} title="Run the daily Possibly Ended check now">{busy === 'check' || recheck.status === 'running' ? 'Checking...' : 'Check Now'}</button>
          <span style={{ flex: 1 }} />
          <button type="button" className="secondary-btn" onClick={onClose}>Close</button>
          <button type="button" className="primary-btn" onClick={save} disabled={!s || !!busy}>{busy === 'save' ? 'Saving...' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}
