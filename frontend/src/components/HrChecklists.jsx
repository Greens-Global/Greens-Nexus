// Onboarding / offboarding / leave checklists (HR roadmap Section C:
// "Onboarding checklist per hire ... each with owner + due date").
//
//   ChecklistSection   - the Checklist tab on a People profile (HR)
//   MyChecklistSteps   - the steps the signed-in person owns, on My HR. A
//                        manager, IT or the new hire ticks their own steps here
//                        without People access; renders nothing when empty.
//   ChecklistSettings  - People > Checklists: who owns each role per company,
//                        and the template rows every new checklist is built from
//
// The server (backend/hr_checklists.py) resolves owners and due dates and
// ticks steps it can see for itself (a finished provisioning run, a signed
// envelope, a status change) - this file only shows and edits them.
import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  ListChecks, CheckCircle2, Circle, MinusCircle, AlertTriangle, CalendarDays,
  Pencil, X, ChevronDown, ChevronRight, Sparkles, Play, RotateCcw, Plus,
  Trash2, ArrowUp, ArrowDown, Save, Ban, UserPlus, UserMinus, PauseCircle,
  Check, UserCog, Users, Laptop, Banknote, Package, Landmark,
} from 'lucide-react';
import { api } from '../api';
import { formatDate } from '../lib/datetime';
import { dialog } from '../ui/dialog';
import { usePeopleDirectory } from '../lib/queries';
import { SkeletonBlocks, Spinner } from './AsyncState';
import PersonSearchSelect from './PersonSearchSelect';

// Work OS tokens (style.css --wk-*), so the light themes and dark mode come
// for free. Status colors carry meaning only: red = late, orange = due soon,
// green = done, brand = the current phase.
const STEP_META = {
  open:    { label: 'Open',    bg: 'var(--wk-blue-bg)',   fg: 'var(--wk-blue)' },
  overdue: { label: 'Overdue', bg: 'var(--wk-red-bg)',    fg: 'var(--wk-red)' },
  done:    { label: 'Done',    bg: 'var(--wk-green-bg)',  fg: 'var(--wk-green)' },
  na:      { label: 'N/A',     bg: 'var(--wk-hover)',     fg: 'var(--wk-dim)' },
};
const LIST_META = {
  open:      { label: 'In Progress', bg: 'var(--wk-blue-bg)',  fg: 'var(--wk-blue)' },
  done:      { label: 'Complete',    bg: 'var(--wk-green-bg)', fg: 'var(--wk-green)' },
  cancelled: { label: 'Cancelled',   bg: 'var(--wk-hover)',    fg: 'var(--wk-dim)' },
};
const KIND_LOOK = {
  onboarding:  { Icon: UserPlus,    chip: 'dk-chip--green',  anchor: 'Starts',      verb: 'start date' },
  offboarding: { Icon: UserMinus,   chip: 'dk-chip--orange', anchor: 'Last day',    verb: 'exit date' },
  inactive:    { Icon: PauseCircle, chip: 'dk-chip--purple', anchor: 'Leave from',  verb: 'leave start' },
};
const ANCHOR_LABEL = { onboarding: 'Start Date', offboarding: 'Exit Date', inactive: 'Leave Starts' };
const KIND_BLURB = {
  onboarding: 'From offer accepted to the 90-day check-in.',
  offboarding: 'From notice received to final pay and access removed.',
  inactive: 'Leave of absence, suspension or garden leave.',
};
const EXIT_LABEL = {
  resignation: 'Resignation', resignation_no_notice: 'Resignation Without Notice', termination: 'Termination',
  end_of_contract: 'End Of Contract', retirement: 'Retirement', death: 'Death Of An Employee',
};

const FONT = 'var(--wk-font)';
const pill = (m) => (
  <span style={{ padding: '2px 8px', borderRadius: 5, fontSize: 11, fontWeight: 600, background: m.bg, color: m.fg, whiteSpace: 'nowrap', lineHeight: 1.5 }}>{m.label}</span>
);
const capLabel = { fontSize: 12, fontWeight: 500, color: 'var(--wk-dim)' };
const inputStyle = { padding: '7px 10px', borderRadius: 6, border: '1px solid var(--wk-line)', background: 'var(--wk-card)', color: 'var(--wk-ink)', fontSize: 13, fontFamily: FONT };
const card = { background: 'var(--wk-card)', border: '1px solid var(--wk-line2)', borderRadius: 'var(--wk-r)', boxShadow: 'var(--wk-shadow)' };
const ghostBtn = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderRadius: 6, border: '1px solid var(--wk-line)', background: 'var(--wk-card)', color: 'var(--wk-ink)', fontSize: 12.5, fontWeight: 600, fontFamily: FONT, cursor: 'pointer' };

// Whole days from today to an ISO date (local calendar, not UTC).
function daysFromToday(iso) {
  if (!iso) return null;
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const t = new Date(); t.setHours(0, 0, 0, 0);
  return Math.round((new Date(y, m - 1, d) - t) / 86400000);
}
function relDue(days) {
  if (days === null) return '';
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return '1 day late';
  return days < 0 ? `${-days} days late` : `in ${days} days`;
}
function initials(name) {
  const p = (name || '').replace(/@.*/, '').split(/[\s.]+/).filter(Boolean);
  return ((p[0]?.[0] || '') + (p[1]?.[0] || '')).toUpperCase() || '?';
}
const isClosed = s => s.status === 'done' || s.status === 'na';
function ownerText(s) {
  if (s.ownerEmail) return s.ownerName || s.ownerEmail;
  return null;
}

function ProgressBar({ done, total, segments }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <div role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Checklist progress"
        style={{ flex: 1, display: 'flex', gap: 3, height: 8, minWidth: 80 }}>
        {(segments && segments.length ? segments : [{ done, total }]).map((g, i) => (
          <div key={i} style={{ flex: Math.max(g.total, 1), background: 'var(--wk-line2)', borderRadius: 4, overflow: 'hidden' }}>
            <div style={{ width: `${g.total ? (g.done / g.total) * 100 : 0}%`, height: '100%', background: 'var(--wk-green)', transition: 'width .3s cubic-bezier(.16,1,.3,1)' }} />
          </div>
        ))}
      </div>
      <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--wk-dim)', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{done} of {total} Done</span>
    </div>
  );
}

function Avatar({ name, empty }) {
  return (
    <span aria-hidden="true" style={{ width: 22, height: 22, borderRadius: '50%', flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 9.5, fontWeight: 700,
      background: empty ? 'transparent' : 'var(--wk-brand-tint)', color: empty ? 'var(--wk-orange)' : 'var(--wk-brand)', border: empty ? '1.5px dashed var(--wk-orange)' : 'none' }}>
      {empty ? '?' : initials(name)}
    </span>
  );
}

// --- One step --------------------------------------------------------------

function StepRow({ step, canEdit, canAct, people, onChanged, toastErr }) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState('');      // '' | 'owner' | 'date'
  const [due, setDue] = useState(step.dueDate || '');
  const closed = isClosed(step);
  const days = daysFromToday(step.dueDate);
  const late = step.overdue;
  const soon = !closed && !late && days !== null && days <= 2;

  async function patch(body, okMsg) {
    setBusy(true);
    try {
      const r = await api.updateChecklistItem(step.id, body);
      onChanged(r.item, r.checklistStatus, okMsg);
    } catch (e) { toastErr(e?.message || 'Could not update this step.'); }
    setBusy(false);
  }
  const toggle = () => patch({ status: closed ? 'open' : 'done' });
  async function markNa() {
    const why = await dialog.prompt(`Why does "${step.title}" not apply?`, { title: 'Mark As N/A', required: true, placeholder: 'e.g. No background check for this role' });
    if (why) patch({ status: 'na', note: why });
  }
  async function editNote() {
    const note = await dialog.prompt('Note on this step', { title: 'Add A Note', defaultValue: step.note || '', multiline: true });
    if (note !== null) patch({ note });
  }

  const dueColor = late ? 'var(--wk-red)' : soon ? 'var(--wk-orange)' : 'var(--wk-dim)';
  return (
    <div style={{ borderRadius: 8, background: open ? 'var(--wk-hover)' : 'transparent', transition: 'background .15s', opacity: busy ? 0.6 : 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px', minHeight: 44 }}>
        <button onClick={toggle} disabled={busy || !canAct} aria-label={closed ? 'Mark as open' : 'Mark as done'}
          title={canAct ? (closed ? 'Mark as open again' : 'Mark as done') : 'Only HR or the owner can tick this'}
          style={{ background: 'none', border: 'none', padding: 0, cursor: canAct ? 'pointer' : 'default', flexShrink: 0, display: 'inline-flex',
            color: step.status === 'done' ? 'var(--wk-green)' : late ? 'var(--wk-red)' : 'var(--wk-faint)' }}>
          {step.status === 'done' ? <CheckCircle2 size={20} strokeWidth={2.2} /> : step.status === 'na' ? <MinusCircle size={20} /> : <Circle size={20} />}
        </button>
        <button onClick={() => setOpen(o => !o)} aria-expanded={open}
          style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', background: 'none', border: 'none', padding: 0, textAlign: 'left', cursor: 'pointer', fontFamily: FONT, color: 'inherit' }}>
          <span style={{ flex: '1 1 220px', minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13.5, fontWeight: closed ? 500 : 600, color: closed ? 'var(--wk-faint)' : 'var(--wk-ink)', textDecoration: step.status === 'done' ? 'line-through' : 'none', textDecorationColor: 'var(--wk-line)' }}>
              {step.title}
            </span>
            {late && pill(STEP_META.overdue)}
            {step.status === 'na' && pill(STEP_META.na)}
            {step.signal && !closed && (
              <span title={`Nexus marks this done by itself when: ${step.signalLabel}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, fontWeight: 600, color: 'var(--wk-brand)' }}>
                <Sparkles size={11} /> Auto-Ticks
              </span>
            )}
            {step.status === 'done' && step.doneBy === 'Nexus' && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, fontWeight: 600, color: 'var(--wk-green)' }}><Sparkles size={11} /> Done by Nexus</span>
            )}
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, flex: '0 1 190px', minWidth: 0, fontSize: 12.5, color: 'var(--wk-dim)' }}>
            <Avatar name={step.ownerName || step.ownerEmail} empty={!step.ownerEmail} />
            <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {ownerText(step) || <span style={{ color: 'var(--wk-orange)', fontWeight: 600 }}>Unassigned</span>}
              <span style={{ color: 'var(--wk-faint)' }}> · {step.ownerRoleLabel}</span>
            </span>
          </span>
          <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', flex: '0 0 auto', minWidth: 96, fontSize: 12, lineHeight: 1.35 }}>
            {step.dueDate ? (
              <>
                <span style={{ color: closed ? 'var(--wk-faint)' : dueColor, fontWeight: late || soon ? 700 : 500, fontVariantNumeric: 'tabular-nums' }}>Due {formatDate(step.dueDate)}</span>
                {!closed && <span style={{ color: dueColor, fontSize: 11 }}>{relDue(days)}</span>}
              </>
            ) : <span style={{ color: 'var(--wk-faint)' }}>No due date</span>}
          </span>
          <ChevronDown size={15} aria-hidden="true" style={{ color: 'var(--wk-faint)', flexShrink: 0, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .2s' }} />
        </button>
      </div>

      {open && (
        <div style={{ padding: '0 12px 12px 42px', display: 'grid', gap: 10 }}>
          {step.hint && <div style={{ fontSize: 12.5, color: 'var(--wk-dim)', lineHeight: 1.55, maxWidth: '70ch' }}>{step.hint}</div>}
          {step.signal && <div style={{ fontSize: 12, color: 'var(--wk-brand)', display: 'flex', gap: 6, alignItems: 'center' }}><Sparkles size={12} /> Nexus marks this done by itself when: {step.signalLabel.charAt(0).toLowerCase() + step.signalLabel.slice(1)}</div>}
          {step.note && <div style={{ fontSize: 12.5, color: 'var(--wk-ink)', padding: '8px 10px', background: 'var(--wk-card)', border: '1px solid var(--wk-line2)', borderRadius: 6, whiteSpace: 'pre-wrap', maxWidth: '70ch' }}>{step.note}</div>}
          {closed && step.doneAt && (
            <div style={{ fontSize: 12, color: 'var(--wk-dim)' }}>
              {step.status === 'na' ? 'Marked N/A' : 'Done'} {step.doneBy === 'Nexus' ? 'by Nexus' : step.doneBy ? `by ${step.doneBy}` : ''} on {formatDate(step.doneAt)}
            </div>
          )}
          {canAct && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {!closed && <button onClick={markNa} disabled={busy} style={ghostBtn}><Ban size={13} /> Mark N/A</button>}
              <button onClick={editNote} disabled={busy} style={ghostBtn}><Pencil size={13} /> {step.note ? 'Edit Note' : 'Add Note'}</button>
              {canEdit && !closed && <button onClick={() => setMode(m => m === 'owner' ? '' : 'owner')} style={{ ...ghostBtn, borderColor: mode === 'owner' ? 'var(--wk-brand)' : 'var(--wk-line)' }}><UserCog size={13} /> Change Owner</button>}
              {canEdit && !closed && <button onClick={() => { setDue(step.dueDate || ''); setMode(m => m === 'date' ? '' : 'date'); }} style={{ ...ghostBtn, borderColor: mode === 'date' ? 'var(--wk-brand)' : 'var(--wk-line)' }}><CalendarDays size={13} /> Change Date</button>}
            </div>
          )}
          {mode === 'owner' && canEdit && (
            <div style={{ maxWidth: 360 }}>
              <PersonSearchSelect placeholder={ownerText(step) ? `${ownerText(step)} - type to change` : 'Pick who owns this step'}
                groups={[{ label: 'Nexus People', people }]}
                onPick={email => { setMode(''); patch({ owner_email: email }, 'Owner changed.'); }} />
            </div>
          )}
          {mode === 'date' && canEdit && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input type="date" value={due} onChange={e => setDue(e.target.value)} aria-label="New due date" style={inputStyle} />
              <button className="primary-btn" disabled={busy} onClick={() => { setMode(''); patch({ due_date: due }, 'Due date changed.'); }} style={{ fontSize: 12.5 }}>Save Date</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// --- One phase on the journey ----------------------------------------------

function PhaseBlock({ phase, isLast, state, defaultOpen, renderStep }) {
  const [open, setOpen] = useState(defaultOpen);
  const done = phase.steps.filter(isClosed).length;
  const late = phase.steps.filter(s => s.overdue).length;
  const node = state === 'done'
    ? { bg: 'var(--wk-green)', fg: '#fff', icon: <Check size={12} strokeWidth={3} /> }
    : state === 'current'
      ? { bg: 'var(--wk-brand)', fg: '#fff', icon: null }
      : { bg: 'var(--wk-card)', fg: 'var(--wk-faint)', icon: null };
  return (
    <div style={{ display: 'flex', gap: 12 }}>
      {/* Journey rail: a node per phase, joined by a line. */}
      <div aria-hidden="true" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 22, flexShrink: 0 }}>
        <span style={{ width: 22, height: 22, borderRadius: '50%', marginTop: 9, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: node.bg, color: node.fg,
          border: state === 'upcoming' ? '2px solid var(--wk-line)' : 'none', boxShadow: state === 'current' ? '0 0 0 4px var(--wk-brand-tint)' : 'none' }}>
          {node.icon}
        </span>
        {!isLast && <span style={{ flex: 1, width: 2, background: state === 'done' ? 'var(--wk-green)' : 'var(--wk-line2)', marginTop: 4, minHeight: 16 }} />}
      </div>
      <div style={{ flex: 1, minWidth: 0, paddingBottom: isLast ? 0 : 14 }}>
        <button onClick={() => setOpen(o => !o)} aria-expanded={open}
          style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '8px 4px', background: 'none', border: 'none', cursor: 'pointer', fontFamily: FONT, textAlign: 'left', color: 'var(--wk-ink)' }}>
          <span style={{ fontSize: 14.5, fontWeight: 700, color: state === 'upcoming' ? 'var(--wk-dim)' : 'var(--wk-ink)' }}>{phase.name}</span>
          <span style={{ fontSize: 12, fontWeight: 600, color: done === phase.steps.length ? 'var(--wk-green)' : 'var(--wk-faint)', fontVariantNumeric: 'tabular-nums' }}>
            {done}/{phase.steps.length}
          </span>
          {late > 0 && pill({ label: `${late} Overdue`, ...STEP_META.overdue })}
          {state === 'current' && <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--wk-brand)' }}>Current</span>}
          <span style={{ flex: 1 }} />
          {open ? <ChevronDown size={16} color="var(--wk-faint)" /> : <ChevronRight size={16} color="var(--wk-faint)" />}
        </button>
        {open && <div style={{ display: 'grid', gap: 2 }}>{phase.steps.map(renderStep)}</div>}
      </div>
    </div>
  );
}

// --- One checklist ---------------------------------------------------------

function Stat({ label, value, tone }) {
  const color = tone === 'red' ? 'var(--wk-red)' : tone === 'orange' ? 'var(--wk-orange)' : tone === 'green' ? 'var(--wk-green)' : 'var(--wk-ink)';
  return (
    <div style={{ display: 'grid', gap: 1, minWidth: 70 }}>
      <span style={{ fontSize: 20, fontWeight: 700, color: value ? color : 'var(--wk-faint)', fontVariantNumeric: 'tabular-nums', lineHeight: 1.2 }}>{value}</span>
      <span style={{ fontSize: 12, color: 'var(--wk-dim)' }}>{label}</span>
    </div>
  );
}

function ChecklistCard({ cl, canEdit, myEmail = '', people, onReplace, toastOk, toastErr, defaultOpen }) {
  const [open, setOpen] = useState(defaultOpen);
  const [filter, setFilter] = useState('all');
  const look = KIND_LOOK[cl.kind] || KIND_LOOK.onboarding;
  const lm = LIST_META[cl.status] || LIST_META.open;
  const me = (myEmail || '').toLowerCase();

  const phasesAll = useMemo(() => {
    const out = [];
    cl.items.forEach(s => {
      let g = out.find(p => p.name === (s.phase || 'Steps'));
      if (!g) { g = { name: s.phase || 'Steps', steps: [] }; out.push(g); }
      g.steps.push(s);
    });
    return out;
  }, [cl.items]);
  const currentIdx = phasesAll.findIndex(p => p.steps.some(s => !isClosed(s)));
  const match = s => filter === 'all' ? true : filter === 'open' ? !isClosed(s) : filter === 'overdue' ? s.overdue : (me && s.ownerEmail === me && !isClosed(s));
  const phases = phasesAll.map(p => ({ ...p, steps: p.steps.filter(match) })).filter(p => p.steps.length);
  const weekDue = cl.items.filter(s => { const d = daysFromToday(s.dueDate); return !isClosed(s) && !s.overdue && d !== null && d <= 7; }).length;
  const mine = me ? cl.items.filter(s => s.ownerEmail === me && !isClosed(s)).length : 0;
  const anchorDays = daysFromToday(cl.anchorDate);

  function onStepChanged(item, checklistStatus, okMsg) {
    const items = cl.items.map(s => s.id === item.id ? item : s);
    const done = items.filter(isClosed).length;
    onReplace({ ...cl, items, done, overdue: items.filter(s => s.overdue).length, status: checklistStatus });
    if (okMsg) toastOk(okMsg);
    if (checklistStatus === 'done' && cl.status !== 'done') toastOk(`${cl.kindLabel} checklist complete.`);
  }
  async function cancel() {
    if (!await dialog.confirm(`Cancel this ${cl.kindLabel.toLowerCase()} checklist? Its steps are kept as history and nobody is reminded any more.`,
      { title: 'Cancel Checklist', confirmText: 'Cancel Checklist', cancelText: 'Keep It', danger: true })) return;
    try { onReplace(await api.cancelChecklist(cl.id)); toastOk('Checklist cancelled.'); }
    catch (e) { toastErr(e?.message || 'Could not cancel the checklist.'); }
  }
  async function reopen() {
    try { onReplace(await api.reopenChecklist(cl.id)); toastOk('Checklist reopened.'); }
    catch (e) { toastErr(e?.message || 'Could not reopen the checklist.'); }
  }

  const filters = [['all', 'All Steps'], ['open', 'Needs Action'], ['overdue', `Overdue${cl.overdue ? ` (${cl.overdue})` : ''}`], ...(me ? [['mine', `Mine${mine ? ` (${mine})` : ''}`]] : [])];
  return (
    <section style={{ ...card, marginBottom: 16, overflow: 'hidden' }}>
      {/* Summary: what this is, where it stands, what needs attention. */}
      <div style={{ padding: '16px 18px', borderBottom: open ? '1px solid var(--wk-line2)' : 'none' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span className={`dk-chip ${look.chip}`} style={{ width: 36, height: 36 }}><look.Icon /></span>
          <div style={{ flex: '1 1 200px', minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--wk-ink)', fontFamily: FONT }}>{cl.kindLabel}</h3>
              {pill(lm)}
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--wk-dim)', marginTop: 2 }}>
              {cl.anchorDate
                ? <>{look.anchor} {formatDate(cl.anchorDate)}{cl.status === 'open' && anchorDays !== null ? ` · ${anchorDays === 0 ? 'today' : anchorDays > 0 ? `in ${anchorDays} days` : `${-anchorDays} days ago`}` : ''}</>
                : <span style={{ color: 'var(--wk-orange)', fontWeight: 600 }}>{ANCHOR_LABEL[cl.kind]} not set yet</span>}
              {cl.exitType ? ` · ${EXIT_LABEL[cl.exitType] || cl.exitType}` : ''}
            </div>
          </div>
          {canEdit && cl.status === 'open' && <button onClick={cancel} style={ghostBtn}><X size={13} /> Cancel</button>}
          {canEdit && cl.status === 'cancelled' && <button onClick={reopen} style={ghostBtn}><RotateCcw size={13} /> Reopen</button>}
          <button onClick={() => setOpen(o => !o)} aria-expanded={open} aria-label={open ? 'Collapse checklist' : 'Expand checklist'}
            style={{ ...ghostBtn, padding: 6 }}>{open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</button>
        </div>
        <div style={{ marginTop: 14 }}>
          <ProgressBar done={cl.done} total={cl.total} segments={phasesAll.map(p => ({ done: p.steps.filter(isClosed).length, total: p.steps.length }))} />
        </div>
        {cl.status === 'open' && (
          <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap', marginTop: 14 }}>
            <Stat label="Overdue" value={cl.overdue} tone="red" />
            <Stat label="Due This Week" value={weekDue} tone="orange" />
            <Stat label="Steps Left" value={cl.total - cl.done} />
            {me && <Stat label="Yours" value={mine} />}
          </div>
        )}
        {cl.kind === 'onboarding' && !cl.anchorDate && cl.status === 'open' && (
          <div style={{ marginTop: 12, fontSize: 12.5, color: 'var(--wk-orange)', display: 'flex', gap: 6, alignItems: 'center' }}>
            <AlertTriangle size={13} /> Add a start date to the profile - most due dates count from it.
          </div>
        )}
      </div>

      {open && (
        <div style={{ padding: '12px 18px 16px' }}>
          <div className="scroll-tabs" role="tablist" aria-label="Filter steps"
            style={{ display: 'inline-flex', gap: 2, padding: 3, borderRadius: 8, background: 'var(--wk-hover)', marginBottom: 12, maxWidth: '100%' }}>
            {filters.map(([k, l]) => (
              <button key={k} role="tab" aria-selected={filter === k} onClick={() => setFilter(k)}
                style={{ padding: '5px 12px', borderRadius: 6, fontSize: 12.5, fontWeight: 600, fontFamily: FONT, cursor: 'pointer', whiteSpace: 'nowrap', border: 'none',
                  background: filter === k ? 'var(--wk-card)' : 'transparent', color: filter === k ? 'var(--wk-ink)' : 'var(--wk-dim)',
                  boxShadow: filter === k ? '0 1px 3px rgba(29,33,57,.12)' : 'none' }}>
                {l}
              </button>
            ))}
          </div>
          {!phases.length && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '18px 4px', color: 'var(--wk-dim)', fontSize: 13 }}>
              <span className="dk-chip dk-chip--green"><Check /></span>
              {filter === 'overdue' ? 'Nothing is overdue.' : filter === 'mine' ? 'Nothing waiting on you here.' : 'Every step is done.'}
            </div>
          )}
          {phases.map((p, i) => {
            const idx = phasesAll.findIndex(x => x.name === p.name);
            const state = phasesAll[idx].steps.every(isClosed) ? 'done' : idx === currentIdx ? 'current' : 'upcoming';
            return (
              <PhaseBlock key={`${filter}:${p.name}`} phase={p} isLast={i === phases.length - 1} state={state}
                defaultOpen={filter !== 'all' || state === 'current' || (state === 'upcoming' && idx === currentIdx + 1) || p.steps.some(s => s.overdue)}
                renderStep={s => (
                  <StepRow key={s.id} step={s} canEdit={canEdit && cl.status !== 'cancelled'} people={people}
                    canAct={cl.status !== 'cancelled' && (canEdit || (!!me && s.ownerEmail === me))}
                    onChanged={onStepChanged} toastErr={toastErr} />
                )} />
            );
          })}
        </div>
      )}
    </section>
  );
}

function StartForm({ employee, meta, onStarted, onClose, toastErr }) {
  const [kind, setKind] = useState('onboarding');
  const [date, setDate] = useState(employee.startDate || '');
  const [exitType, setExitType] = useState('');
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try { onStarted(await api.startChecklist(employee.id, { kind, anchor_date: date, exit_type: exitType })); }
    catch (e) { toastErr(e?.message || 'Could not start the checklist.'); }
    setBusy(false);
  }
  const needDate = kind !== 'onboarding';
  const ready = (!needDate || date) && (kind !== 'offboarding' || exitType);
  const kinds = meta?.kinds || [{ value: 'onboarding', label: 'Onboarding' }, { value: 'offboarding', label: 'Offboarding' }, { value: 'inactive', label: 'Leave Or Suspension' }];
  return (
    <section style={{ ...card, padding: 18, marginBottom: 16, display: 'grid', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, fontFamily: FONT, flex: 1 }}>Start A Checklist</h3>
        <button onClick={onClose} aria-label="Close" style={{ ...ghostBtn, padding: 6 }}><X size={14} /></button>
      </div>
      <div role="radiogroup" aria-label="Checklist kind" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10 }}>
        {kinds.map(k => {
          const look = KIND_LOOK[k.value] || KIND_LOOK.onboarding;
          const on = kind === k.value;
          return (
            <button key={k.value} role="radio" aria-checked={on}
              onClick={() => { setKind(k.value); setDate(k.value === 'onboarding' ? (employee.startDate || '') : ''); }}
              style={{ display: 'flex', gap: 10, alignItems: 'flex-start', textAlign: 'left', padding: 12, borderRadius: 8, cursor: 'pointer', fontFamily: FONT,
                background: on ? 'var(--wk-brand-tint)' : 'var(--wk-card)', border: `1.5px solid ${on ? 'var(--wk-brand)' : 'var(--wk-line2)'}`, transition: 'border-color .15s, background .15s' }}>
              <span className={`dk-chip ${look.chip}`}><look.Icon /></span>
              <span style={{ display: 'grid', gap: 2 }}>
                <span style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--wk-ink)' }}>{k.label}</span>
                <span style={{ fontSize: 12, color: 'var(--wk-dim)', lineHeight: 1.45 }}>{KIND_BLURB[k.value]}</span>
              </span>
            </button>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={{ display: 'grid', gap: 5 }}>
          <span style={capLabel}>{ANCHOR_LABEL[kind]}</span>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} disabled={kind === 'onboarding'} style={inputStyle}
            title={kind === 'onboarding' ? 'Onboarding counts from the start date on the profile - change it there' : ''} />
        </label>
        {kind === 'offboarding' && (
          <label style={{ display: 'grid', gap: 5 }}>
            <span style={capLabel}>Exit Type</span>
            <select value={exitType} onChange={e => setExitType(e.target.value)} style={inputStyle}>
              <option value="">Pick one</option>
              {(meta?.exitTypes || []).map(t => <option key={t.value} value={t.value}>{EXIT_LABEL[t.value] || t.label}</option>)}
            </select>
          </label>
        )}
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--wk-dim)', lineHeight: 1.55, maxWidth: '70ch' }}>
        {kind === 'onboarding' && (employee.startDate ? 'Steps count from the start date on the profile and move with it when it changes.' : 'No start date on the profile yet - steps will get their dates once it is added.')}
        {kind === 'offboarding' && 'Start it the day notice is received. Steps already past their date are due today. This changes nothing in Microsoft 365 - Left still happens from Change Status.'}
        {kind === 'inactive' && 'Inactive itself changes nothing in Microsoft 365, so the access steps are listed for IT.'}
      </div>
      <div>
        <button className="primary-btn" onClick={go} disabled={!ready || busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {busy ? <Spinner size={13} /> : <Play size={13} />} Start Checklist
        </button>
      </div>
    </section>
  );
}

export function ChecklistSection({ employee, canEdit = false, myEmail = '', toastOk, toastErr }) {
  const [lists, setLists] = useState(null);   // null = loading, false = failed
  const [meta, setMeta] = useState(null);
  const [starting, setStarting] = useState(false);
  const { data: dir = [] } = usePeopleDirectory();
  const people = useMemo(() => dir.map(p => ({ email: (p.email || '').toLowerCase(), name: p.name || p.email })), [dir]);

  const load = useCallback(() => {
    api.getEmployeeChecklists(employee.id)
      .then(r => setLists(r.checklists || []))
      .catch(() => setLists(false));
  }, [employee.id]);
  useEffect(load, [load]);
  useEffect(() => { api.getChecklistMeta().then(setMeta).catch(() => setMeta(null)); }, []);

  const replace = (next) => setLists(prev => (prev || []).map(c => c.id === next.id ? next : c));

  if (lists === null) return <SkeletonBlocks count={2} height={110} />;
  if (lists === false) {
    return (
      <div style={{ ...card, padding: 18, display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'var(--wk-dim)' }}>
        <span className="dk-chip dk-chip--red"><AlertTriangle /></span>
        <span style={{ flex: 1 }}>Could not load the checklists.</span>
        <button onClick={load} style={ghostBtn}><RotateCcw size={13} /> Retry</button>
      </div>
    );
  }
  const openLists = lists.filter(c => c.status === 'open');
  const pastLists = lists.filter(c => c.status !== 'open');
  return (
    <div style={{ fontFamily: FONT }}>
      {(openLists.length > 0 || pastLists.length > 0) && canEdit && !starting && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
          <button onClick={() => setStarting(true)} style={ghostBtn}><Plus size={13} /> Start Checklist</button>
        </div>
      )}
      {starting && (
        <StartForm employee={employee} meta={meta} toastErr={toastErr} onClose={() => setStarting(false)}
          onStarted={cl => { setStarting(false); setLists(prev => [cl, ...(prev || [])]); toastOk(`${cl.kindLabel} checklist started - ${cl.total} steps.`); }} />
      )}
      {!lists.length && !starting && (
        <section style={{ ...card, padding: '32px 20px', textAlign: 'center', display: 'grid', justifyItems: 'center', gap: 8 }}>
          <span className="dk-chip dk-chip--brand" style={{ width: 40, height: 40 }}><ListChecks /></span>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--wk-ink)', marginTop: 4 }}>No checklist for {employee.firstName || 'this person'} yet</div>
          <div style={{ fontSize: 13, color: 'var(--wk-dim)', maxWidth: 420, lineHeight: 1.5 }}>
            Marking a candidate Hired starts onboarding automatically. Start one by hand for an existing employee, a leaver or a leave of absence.
          </div>
          {canEdit && (
            <button className="primary-btn" onClick={() => setStarting(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
              <Plus size={14} /> Start Checklist
            </button>
          )}
        </section>
      )}
      {openLists.map(c => (
        <ChecklistCard key={c.id} cl={c} canEdit={canEdit} myEmail={myEmail} people={people} onReplace={replace}
          toastOk={toastOk} toastErr={toastErr} defaultOpen />
      ))}
      {pastLists.length > 0 && (
        <>
          <div style={{ ...capLabel, margin: '20px 0 8px', fontWeight: 600 }}>Past Checklists</div>
          {pastLists.map(c => (
            <ChecklistCard key={c.id} cl={c} canEdit={canEdit} myEmail={myEmail} people={people} onReplace={replace}
              toastOk={toastOk} toastErr={toastErr} defaultOpen={false} />
          ))}
        </>
      )}
    </div>
  );
}

// --- Small progress chip (profile header, directory rows) ------------------

// p = one /hr/checklists/progress entry: { kind, kindLabel, done, total, overdue }.
export function ChecklistChip({ p, onClick, compact = false }) {
  if (!p) return null;
  const look = KIND_LOOK[p.kind] || KIND_LOOK.onboarding;
  const late = p.overdue > 0;
  const body = (
    <>
      <look.Icon size={12} aria-hidden="true" />
      {!compact && <span>{p.kindLabel}</span>}
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{p.done}/{p.total}</span>
      {late && <span style={{ color: 'var(--wk-red)' }}>· {p.overdue} late</span>}
    </>
  );
  const style = { display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px', borderRadius: 6, fontSize: 11.5, fontWeight: 600, whiteSpace: 'nowrap', fontFamily: FONT,
    background: late ? 'var(--wk-red-bg)' : 'var(--wk-brand-tint)', color: late ? 'var(--wk-red)' : 'var(--wk-brand)', border: 'none' };
  const label = `${p.kindLabel} checklist: ${p.done} of ${p.total} done${late ? `, ${p.overdue} overdue` : ''}`;
  return onClick
    ? <button type="button" onClick={e => { e.stopPropagation(); onClick(); }} title={`${label} - open the checklist`} aria-label={label} style={{ ...style, cursor: 'pointer' }}>{body}</button>
    : <span title={label} aria-label={label} style={style}>{body}</span>;
}

// --- People > Checklists > Overview -----------------------------------------

function BoardTile({ Icon, chip, label, value, sub, active, onClick }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active}
      style={{ ...card, display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', cursor: 'pointer', textAlign: 'left', fontFamily: FONT,
        borderColor: active ? 'var(--wk-brand)' : 'var(--wk-line2)', boxShadow: active ? '0 0 0 3px var(--wk-brand-tint)' : 'var(--wk-shadow)' }}>
      <span className={`dk-chip ${chip}`}><Icon /></span>
      <span style={{ display: 'grid', gap: 1, minWidth: 0 }}>
        <span style={{ fontSize: 24, fontWeight: 700, lineHeight: 1.1, color: 'var(--wk-ink)', fontVariantNumeric: 'tabular-nums' }}>{value}</span>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--wk-ink)' }}>{label}</span>
        {sub && <span style={{ fontSize: 11.5, color: 'var(--wk-dim)' }}>{sub}</span>}
      </span>
    </button>
  );
}

function anchorPhrase(r) {
  const d = daysFromToday(r.anchorDate);
  if (!r.anchorDate) return r.kind === 'onboarding' ? 'No start date yet' : 'No date';
  const when = d === 0 ? 'today' : d > 0 ? `in ${d} day${d === 1 ? '' : 's'}` : `${-d} day${d === -1 ? '' : 's'} ago`;
  const verb = r.kind === 'onboarding' ? (d >= 0 ? 'Starts' : 'Started') : r.kind === 'offboarding' ? (d >= 0 ? 'Leaves' : 'Left') : 'Leave from';
  return `${verb} ${formatDate(r.anchorDate)} · ${when}`;
}

export function ChecklistBoard({ entities = [], onOpen }) {
  const [rows, setRows] = useState(null);   // null = loading, false = failed
  const [kind, setKind] = useState('all');
  const [company, setCompany] = useState('');
  const [focus, setFocus] = useState('');   // '' | 'overdue' | 'mine' | 'unassigned'
  const load = useCallback(() => {
    api.getChecklistBoard().then(r => setRows(r.rows || [])).catch(() => setRows(false));
  }, []);
  useEffect(load, [load]);

  if (rows === null) return <SkeletonBlocks count={3} height={90} />;
  if (rows === false) {
    return (
      <div style={{ ...card, padding: 18, display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'var(--wk-dim)' }}>
        <span className="dk-chip dk-chip--red"><AlertTriangle /></span>
        <span style={{ flex: 1 }}>Could not load the checklists.</span>
        <button onClick={load} style={ghostBtn}><RotateCcw size={13} /> Retry</button>
      </div>
    );
  }
  const count = k => rows.filter(r => r.kind === k).length;
  const overdue = rows.reduce((n, r) => n + r.overdue, 0);
  const mine = rows.reduce((n, r) => n + r.mine, 0);
  const unassigned = rows.reduce((n, r) => n + r.unassigned, 0);
  const shown = rows.filter(r => (kind === 'all' || r.kind === kind) && (!company || r.company === company)
    && (focus === 'overdue' ? r.overdue > 0 : focus === 'mine' ? r.mine > 0 : focus === 'unassigned' ? r.unassigned > 0 : true));
  const companiesInUse = entities.filter(en => rows.some(r => r.company === en.id));
  const pickKind = k => { setKind(k === kind ? 'all' : k); setFocus(''); };
  const pickFocus = f => { setFocus(f === focus ? '' : f); setKind('all'); };

  return (
    <div style={{ fontFamily: FONT }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12, marginBottom: 16 }}>
        <BoardTile Icon={UserPlus} chip="dk-chip--green" label="Onboarding" value={count('onboarding')} sub="people joining" active={kind === 'onboarding'} onClick={() => pickKind('onboarding')} />
        <BoardTile Icon={UserMinus} chip="dk-chip--orange" label="Offboarding" value={count('offboarding')} sub="people leaving" active={kind === 'offboarding'} onClick={() => pickKind('offboarding')} />
        <BoardTile Icon={PauseCircle} chip="dk-chip--purple" label="On Leave" value={count('inactive')} sub="leave or suspension" active={kind === 'inactive'} onClick={() => pickKind('inactive')} />
        <BoardTile Icon={AlertTriangle} chip="dk-chip--red" label="Steps Overdue" value={overdue} sub={overdue ? 'across everyone' : 'nothing late'} active={focus === 'overdue'} onClick={() => pickFocus('overdue')} />
        <BoardTile Icon={UserCog} chip="dk-chip--brand" label="Waiting On You" value={mine} sub={unassigned ? `${unassigned} unassigned` : 'your steps'} active={focus === 'mine'} onClick={() => pickFocus('mine')} />
      </div>

      <section style={{ ...card, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '12px 16px', borderBottom: '1px solid var(--wk-line2)' }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: 'var(--wk-ink)', flex: '1 1 160px' }}>
            In Progress <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--wk-faint)' }}>{shown.length}</span>
          </h3>
          {(kind !== 'all' || focus) && (
            <button onClick={() => { setKind('all'); setFocus(''); }} style={ghostBtn}><X size={12} /> {focus === 'overdue' ? 'Overdue only' : focus === 'mine' ? 'Waiting on you' : KIND_LABEL_OF(kind)}</button>
          )}
          {unassigned > 0 && focus !== 'unassigned' && (
            <button onClick={() => pickFocus('unassigned')} style={{ ...ghostBtn, color: 'var(--wk-orange)', borderColor: 'var(--wk-orange)' }}>{unassigned} Unassigned Step{unassigned === 1 ? '' : 's'}</button>
          )}
          {companiesInUse.length > 1 && (
            <select value={company} onChange={e => setCompany(e.target.value)} aria-label="Company" style={{ ...inputStyle, padding: '6px 8px' }}>
              <option value="">All Companies</option>
              {companiesInUse.map(en => <option key={en.id} value={en.id}>{en.name}</option>)}
            </select>
          )}
        </div>

        {!rows.length ? (
          <div style={{ padding: '36px 20px', textAlign: 'center', display: 'grid', justifyItems: 'center', gap: 8 }}>
            <span className="dk-chip dk-chip--brand" style={{ width: 40, height: 40 }}><ListChecks /></span>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--wk-ink)' }}>No one is joining or leaving right now</div>
            <div style={{ fontSize: 13, color: 'var(--wk-dim)', maxWidth: 440, lineHeight: 1.5 }}>
              Mark a candidate Hired in Hiring to start an onboarding checklist, or change someone&apos;s status to Left or Inactive to start offboarding or leave.
            </div>
          </div>
        ) : !shown.length ? (
          <div style={{ padding: '24px 16px', display: 'flex', alignItems: 'center', gap: 10, color: 'var(--wk-dim)', fontSize: 13 }}>
            <span className="dk-chip dk-chip--green"><Check /></span> Nothing matches - {focus === 'overdue' ? 'nobody is behind.' : 'try another filter.'}
          </div>
        ) : shown.map(r => {
          const look = KIND_LOOK[r.kind] || KIND_LOOK.onboarding;
          const nextDays = daysFromToday(r.next?.dueDate);
          return (
            <button key={r.checklistId} type="button" onClick={() => onOpen?.(r.employeeId)}
              style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', padding: '12px 16px', background: 'none', border: 'none', borderBottom: '1px solid var(--wk-line2)', cursor: 'pointer', textAlign: 'left', fontFamily: FONT }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--wk-hover)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}>
              {/* Who */}
              <span style={{ display: 'flex', alignItems: 'center', gap: 10, flex: '1 1 220px', minWidth: 0 }}>
                <span style={{ width: 34, height: 34, borderRadius: '50%', flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, background: 'var(--wk-brand-tint)', color: 'var(--wk-brand)' }}>
                  {initials(r.name)}
                </span>
                <span style={{ minWidth: 0, display: 'grid', gap: 1 }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--wk-ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
                  <span style={{ fontSize: 12, color: 'var(--wk-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {[r.jobTitle, r.companyName].filter(Boolean).join(' · ') || '-'}
                  </span>
                </span>
              </span>
              {/* What and when */}
              <span style={{ display: 'grid', gap: 3, flex: '1 1 190px', minWidth: 0 }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600, color: 'var(--wk-ink)' }}>
                  <look.Icon size={13} style={{ color: `var(--wk-${r.kind === 'onboarding' ? 'green' : r.kind === 'offboarding' ? 'orange' : 'brand'})` }} />
                  {r.kindLabel}{r.exitType ? ` · ${EXIT_LABEL[r.exitType] || r.exitType}` : ''}
                </span>
                <span style={{ fontSize: 12, color: 'var(--wk-dim)' }}>{anchorPhrase(r)}</span>
              </span>
              {/* Progress */}
              <span style={{ flex: '1 1 150px', minWidth: 120 }}>
                <ProgressBar done={r.done} total={r.total} />
              </span>
              {/* Next step */}
              <span style={{ display: 'grid', gap: 2, flex: '1.4 1 240px', minWidth: 0 }}>
                {r.next ? (
                  <>
                    <span style={{ fontSize: 11.5, color: 'var(--wk-faint)', fontWeight: 600 }}>Next Step</span>
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--wk-ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.next.title}</span>
                    <span style={{ fontSize: 12, color: r.next.overdue ? 'var(--wk-red)' : 'var(--wk-dim)', fontWeight: r.next.overdue ? 600 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.next.ownerName || r.next.ownerEmail || <span style={{ color: 'var(--wk-orange)', fontWeight: 600 }}>Unassigned</span>} ({r.next.ownerRoleLabel})
                      {r.next.dueDate ? ` · ${relDue(nextDays)}` : ''}
                    </span>
                  </>
                ) : <span style={{ fontSize: 12.5, color: 'var(--wk-green)', fontWeight: 600 }}>All steps done</span>}
              </span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                {r.overdue > 0 && pill({ label: `${r.overdue} Overdue`, ...STEP_META.overdue })}
                {r.mine > 0 && pill({ label: `${r.mine} Yours`, bg: 'var(--wk-brand-tint)', fg: 'var(--wk-brand)' })}
                <ChevronRight size={15} color="var(--wk-faint)" aria-hidden="true" />
              </span>
            </button>
          );
        })}
      </section>
    </div>
  );
}
const KIND_LABEL_OF = k => ({ onboarding: 'Onboarding', offboarding: 'Offboarding', inactive: 'On Leave' }[k] || 'All');

// --- My HR: steps I own ----------------------------------------------------

export function MyChecklistSteps() {
  const [steps, setSteps] = useState(null);
  const [msg, setMsg] = useState('');
  // Wrapped so a failure (or an older API without the route) only hides the
  // card - My HR must never break because of it.
  const load = useCallback(() => {
    Promise.resolve().then(() => api.getMyChecklistSteps())
      .then(r => setSteps(r?.steps || [])).catch(() => setSteps([]));
  }, []);
  useEffect(load, [load]);
  if (!steps || !steps.length) return null;

  async function done(s) {
    try {
      await api.updateChecklistItem(s.id, { status: 'done' });
      setSteps(prev => prev.filter(x => x.id !== s.id));
      setMsg(`Done: ${s.title}`);
      setTimeout(() => setMsg(''), 3500);
    } catch (e) { setMsg(e?.message || 'Could not update this step.'); }
  }
  const late = steps.filter(s => s.overdue).length;
  const groups = [];
  steps.forEach(s => {
    let g = groups.find(x => x.key === s.checklistId);
    if (!g) { g = { key: s.checklistId, title: `${s.kindLabel}: ${s.employeeName}`, sub: s.employeeTitle, steps: [] }; groups.push(g); }
    g.steps.push(s);
  });
  return (
    <div className="dash-card" style={{ marginBottom: 16 }}>
      <div className="dash-card-head">
        <div>
          <div className="dash-card-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <ListChecks size={16} /> My Checklist Steps
            {late > 0 && pill({ label: `${late} Overdue`, ...STEP_META.overdue })}
          </div>
          <div className="dash-card-sub">Onboarding and offboarding steps assigned to you</div>
        </div>
      </div>
      {msg && <div style={{ fontSize: 12.5, fontWeight: 600, color: 'hsl(var(--color-green))', marginBottom: 8 }}>{msg}</div>}
      {groups.map(g => (
        <div key={g.key} style={{ marginTop: 6 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>
            {g.title} {g.sub && <span style={{ fontWeight: 400, color: 'var(--muted)' }}>· {g.sub}</span>}
          </div>
          {g.steps.map(s => (
            <div key={s.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
              <button onClick={() => done(s)} title="Mark as done" aria-label={`Mark ${s.title} as done`}
                style={{ background: 'none', border: 'none', padding: 2, cursor: 'pointer', color: 'var(--muted)', flexShrink: 0 }}>
                <Circle size={17} />
              </button>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>{s.title}</div>
                {s.hint && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2, lineHeight: 1.45 }}>{s.hint}</div>}
              </div>
              <span style={{ fontSize: 12, whiteSpace: 'nowrap', color: s.overdue ? 'hsl(var(--color-red))' : 'var(--muted)', fontWeight: s.overdue ? 700 : 400 }}>
                {s.dueDate ? formatDate(s.dueDate) : 'No date'}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// --- People > Checklists: owners + templates -------------------------------

const ROLE_LOOK = {
  hr:        { label: 'HR',        Icon: Users,    chip: 'dk-chip--brand',  hint: 'Used when a company has no HR contact in Company Setup.' },
  it:        { label: 'IT',        Icon: Laptop,   chip: 'dk-chip--blue',   hint: 'Provisioning, licenses, mailbox and sign-in steps.' },
  payroll:   { label: 'Payroll',   Icon: Banknote, chip: 'dk-chip--green',  hint: 'Tax forms, final pay and leave payout.' },
  equipment: { label: 'Equipment', Icon: Package,  chip: 'dk-chip--orange', hint: 'Laptops and phones in Item Management.' },
  finance:   { label: 'Finance',   Icon: Landmark, chip: 'dk-chip--purple', hint: 'Accounting, bank and vendor portals, company cards.' },
};
const OWNER_ROLES = ['hr', 'it', 'payroll', 'equipment', 'finance'];

// A sticky bar that appears only while there is something to save.
function SaveBar({ label, busy, onDiscard, onSave, saveText }) {
  return (
    <div role="status" style={{ position: 'sticky', bottom: 12, zIndex: 5, marginTop: 14, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
      padding: '10px 14px', borderRadius: 'var(--wk-r)', background: 'var(--wk-card)', color: 'var(--wk-ink)', border: '1.5px solid var(--wk-brand)', boxShadow: '0 10px 28px rgba(29,33,57,.18)' }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--wk-orange)', flexShrink: 0 }} aria-hidden="true" />
      <span style={{ fontSize: 13, fontWeight: 600, flex: 1, minWidth: 140 }}>{label}</span>
      <button onClick={onDiscard} disabled={busy} style={ghostBtn}>Discard</button>
      <button className="primary-btn" onClick={onSave} disabled={busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        {busy ? <Spinner size={13} /> : <Save size={13} />} {saveText}
      </button>
    </div>
  );
}

function OwnersCard({ entityId, people, toastOk, toastErr }) {
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState({});
  const [editing, setEditing] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.getChecklistOwners(entityId).then(r => { setData(r); setDraft(r.owners || {}); }).catch(() => setData(false));
  }, [entityId]);
  const nameOf = em => people.find(p => p.email === em)?.name || em;
  const dirty = data && JSON.stringify(Object.fromEntries(Object.entries(draft).filter(([, v]) => v))) !== JSON.stringify(Object.fromEntries(Object.entries(data.owners || {}).filter(([, v]) => v)));
  async function save() {
    setBusy(true);
    try { const r = await api.saveChecklistOwners(entityId, draft); setData(d => ({ ...d, ...r })); setDraft(r.owners || {}); toastOk('Checklist owners saved.'); }
    catch (e) { toastErr(e?.message || 'Could not save the owners.'); }
    setBusy(false);
  }
  if (data === null) return <SkeletonBlocks count={1} height={150} />;
  if (data === false) return <div style={{ ...card, padding: 18, fontSize: 13, color: 'var(--wk-dim)' }}>Could not load the owners.</div>;
  return (
    <section style={{ ...card, padding: 18, marginBottom: 18 }}>
      <div style={{ marginBottom: 14 }}>
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, fontFamily: FONT, color: 'var(--wk-ink)' }}>Who Owns Each Role</h3>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--wk-dim)', lineHeight: 1.5, maxWidth: '75ch' }}>
          Manager and Employee steps go to each person&apos;s reports-to and to the person. HR steps go to the company&apos;s HR contact{data.hrContact ? ` (${nameOf(data.hrContact)})` : ''} first.
          {entityId ? ' A role left blank here uses the default.' : ''}
        </p>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: 12 }}>
        {OWNER_ROLES.map(role => {
          const look = ROLE_LOOK[role];
          const own = draft[role];
          const inherited = !own && data.effective?.[role];
          const isEditing = editing === role;
          return (
            <div key={role} style={{ border: `1px solid ${isEditing ? 'var(--wk-brand)' : 'var(--wk-line2)'}`, borderRadius: 'var(--wk-r)', padding: 14, display: 'grid', gap: 10, alignContent: 'start', background: 'var(--wk-card)' }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                <span className={`dk-chip ${look.chip}`}><look.Icon /></span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--wk-ink)' }}>{look.label}</div>
                  <div style={{ fontSize: 12, color: 'var(--wk-dim)', lineHeight: 1.45 }}>{look.hint}</div>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 30 }}>
                <Avatar name={nameOf(own || inherited || '')} empty={!own && !inherited} />
                <span style={{ flex: 1, minWidth: 0, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {own ? <b style={{ fontWeight: 600, color: 'var(--wk-ink)' }}>{nameOf(own)}</b>
                    : inherited ? <span style={{ color: 'var(--wk-dim)' }}>{nameOf(inherited)} <span style={{ color: 'var(--wk-faint)' }}>(default)</span></span>
                      : <span style={{ color: 'var(--wk-orange)', fontWeight: 600 }}>Not set</span>}
                </span>
                {own && <button onClick={() => setDraft(d => ({ ...d, [role]: '' }))} aria-label={`Clear ${look.label} owner`} style={{ ...ghostBtn, padding: 5 }}><X size={12} /></button>}
                <button onClick={() => setEditing(isEditing ? '' : role)} style={ghostBtn}>{isEditing ? 'Close' : own ? 'Change' : 'Set'}</button>
              </div>
              {isEditing && (
                <PersonSearchSelect placeholder="Type a name or email" groups={[{ label: 'Nexus People', people }]}
                  onPick={em => { setDraft(d => ({ ...d, [role]: em })); setEditing(''); }} />
              )}
            </div>
          );
        })}
      </div>
      {dirty && <SaveBar label="Owner changes not saved yet" busy={busy} saveText="Save Owners" onDiscard={() => setDraft(data.owners || {})} onSave={save} />}
    </section>
  );
}

const TYPE_CHOICES = [['employee', 'Employees'], ['contractor', 'Contractors'], ['intern', 'Interns']];
const COUNTRY_CHOICES = [['US', 'US'], ['IN', 'India']];
const ANCHOR_NOUN = { onboarding: 'start', offboarding: 'last day', inactive: 'leave start' };

// "7 days before start", "3 business days after start", "No due date".
function timingText(r, kind) {
  if (r.anchor === 'none') return 'No due date';
  const n = Math.abs(Number(r.offset) || 0);
  const unit = r.bd ? (n === 1 ? 'business day' : 'business days') : (n === 1 ? 'day' : 'days');
  if (r.anchor === 'created') return n ? `${n} ${unit} after it starts` : 'When the checklist starts';
  const noun = r.anchor === 'X' ? ANCHOR_NOUN[kind === 'onboarding' ? 'offboarding' : kind] : 'start';
  if (!n) return `On the ${noun === 'start' ? 'start date' : noun}`;
  return `${n} ${unit} ${r.offset < 0 ? 'before' : 'after'} ${noun}`;
}
function appliesText(a, meta) {
  const bits = [];
  (a?.types || []).forEach(t => bits.push(TYPE_CHOICES.find(([v]) => v === t)?.[1] || t));
  (a?.countries || []).forEach(c => bits.push(c === 'IN' ? 'India' : `${c} only`));
  (a?.exit_types || []).forEach(t => bits.push(EXIT_LABEL[t] || meta?.exitTypes?.find(x => x.value === t)?.label || t));
  return bits;
}
function signalHint(signal, meta) {
  const name = (signal || '').split(':')[0];
  if (name === 'envelope') return `a ${(signal.split(':')[1] || 'matching').replace(/_/g, ' ').replace(/,/g, ' or ')} document is signed in Nexus Sign`;
  const l = meta?.signals?.find(x => x.value === name)?.label;
  return l ? l.charAt(0).toLowerCase() + l.slice(1) : '';
}
const tag = (text, tone) => (
  <span style={{ fontSize: 11.5, fontWeight: 600, padding: '2px 8px', borderRadius: 5, whiteSpace: 'nowrap',
    background: tone === 'brand' ? 'var(--wk-brand-tint)' : 'var(--wk-hover)', color: tone === 'brand' ? 'var(--wk-brand)' : 'var(--wk-dim)' }}>{text}</span>
);

function TemplateRowEditor({ r, i, total, kind, meta, set, move, remove, toggleIn, onDone }) {
  const roles = meta?.roles || [];
  const signals = meta?.signals || [];
  const field = (label, el) => <label style={{ display: 'grid', gap: 5 }}><span style={capLabel}>{label}</span>{el}</label>;
  return (
    <div style={{ display: 'grid', gap: 12, padding: 14, margin: '4px 0 8px', borderRadius: 'var(--wk-r)', border: '1px solid var(--wk-brand)', background: 'var(--wk-card)', boxShadow: '0 0 0 3px var(--wk-brand-tint)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        {field('Step', <input value={r.title} onChange={e => set(i, { title: e.target.value })} placeholder="Title Case, e.g. Laptop Shipped" style={{ ...inputStyle, fontWeight: 600 }} />)}
        {field('Owner', (
          <select value={r.owner} onChange={e => set(i, { owner: e.target.value })} style={inputStyle}>
            {roles.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        {field('Due', (
          <select value={r.anchor} onChange={e => set(i, { anchor: e.target.value })} style={inputStyle}>
            <option value="S">Counted From The Start Date</option>
            <option value="X">Counted From The Exit Date / Leave Start</option>
            <option value="created">Counted From The Day It Starts</option>
            <option value="none">No Due Date</option>
          </select>
        ))}
        {r.anchor !== 'none' && field('Days (minus = before)', <input type="number" value={r.offset} onChange={e => set(i, { offset: Number(e.target.value) || 0 })} style={{ ...inputStyle, width: 120 }} />)}
        {r.anchor !== 'none' && (
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--wk-ink)', paddingBottom: 8 }}>
            <input type="checkbox" checked={!!r.bd} onChange={e => set(i, { bd: e.target.checked })} /> Business days
          </label>
        )}
        <span style={{ fontSize: 12.5, color: 'var(--wk-brand)', fontWeight: 600, paddingBottom: 8 }}>{timingText(r, kind)}</span>
      </div>
      <div style={{ display: 'grid', gap: 6 }}>
        <span style={capLabel}>Who gets this step <span style={{ color: 'var(--wk-faint)' }}>(nothing ticked = everyone)</span></span>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 13 }}>
          {TYPE_CHOICES.map(([v, l]) => (
            <label key={v} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <input type="checkbox" checked={(r.applies?.types || []).includes(v)} onChange={() => toggleIn(i, 'types', v)} /> {l}
            </label>
          ))}
          {COUNTRY_CHOICES.map(([v, l]) => (
            <label key={v} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <input type="checkbox" checked={(r.applies?.countries || []).includes(v)} onChange={() => toggleIn(i, 'countries', v)} /> {l}
            </label>
          ))}
          {kind === 'offboarding' && (meta?.exitTypes || []).map(t => (
            <label key={t.value} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <input type="checkbox" checked={(r.applies?.exit_types || []).includes(t.value)} onChange={() => toggleIn(i, 'exit_types', t.value)} /> {EXIT_LABEL[t.value] || t.label}
            </label>
          ))}
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
        {field('How It Gets Marked Done', (
          <select value={r.signal} onChange={e => set(i, { signal: e.target.value })} style={inputStyle}>
            <option value="">By The Owner (they tick it)</option>
            {r.signal && !signals.some(s => s.value === r.signal) && <option value={r.signal}>Automatically, When: a {(r.signal.split(':')[1] || r.signal).replace(/_/g, ' ')} document is signed</option>}
            {signals.filter(s => s.value !== 'envelope').map(s => <option key={s.value} value={s.value}>Automatically, When: {s.label.charAt(0).toLowerCase() + s.label.slice(1)}</option>)}
          </select>
        ))}
        {field('How-To Hint (optional)', <input value={r.hint || ''} onChange={e => set(i, { hint: e.target.value })} placeholder="One sentence shown under the step" style={inputStyle} />)}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <button onClick={() => move(i, -1)} disabled={i === 0} style={ghostBtn}><ArrowUp size={13} /> Move Up</button>
        <button onClick={() => move(i, 1)} disabled={i === total - 1} style={ghostBtn}><ArrowDown size={13} /> Move Down</button>
        <button onClick={() => remove(i)} style={{ ...ghostBtn, color: 'var(--wk-red)', borderColor: 'var(--wk-red-bg)' }}><Trash2 size={13} /> Delete Step</button>
        <span style={{ flex: 1 }} />
        <button className="primary-btn" onClick={onDone} disabled={!r.title.trim()} style={{ fontSize: 12.5 }}>Done</button>
      </div>
    </div>
  );
}

// A checkbox that can also show "some selected" (a phase with part of its steps picked).
function TriCheck({ checked, indeterminate = false, onChange, label }) {
  return (
    <input type="checkbox" aria-label={label} checked={checked} onChange={onChange}
      ref={el => { if (el) el.indeterminate = indeterminate && !checked; }}
      style={{ width: 16, height: 16, margin: 0, cursor: 'pointer', accentColor: 'var(--wk-brand)', flexShrink: 0 }} />
  );
}

function TemplateEditor({ template, meta, entityId, onSaved, toastOk, toastErr }) {
  const [rows, setRows] = useState(template.items || []);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [editIdx, setEditIdx] = useState(-1);
  const [picked, setPicked] = useState(() => new Set());   // row indexes ticked for a bulk action
  const touch = () => { setDirty(true); };
  const set = (i, patch) => { setRows(r => r.map((x, j) => j === i ? { ...x, ...patch } : x)); touch(); };
  const move = (i, d) => { setRows(r => { const n = [...r]; const t = n[i]; n[i] = n[i + d]; n[i + d] = t; return n; }); setEditIdx(i + d); setPicked(new Set()); touch(); };
  const remove = (i) => { setRows(x => x.filter((_, j) => j !== i)); setEditIdx(-1); setPicked(new Set()); touch(); };
  const toggleIn = (i, field, value) => {
    const cur = rows[i].applies?.[field] || [];
    const next = cur.includes(value) ? cur.filter(v => v !== value) : [...cur, value];
    set(i, { applies: { ...(rows[i].applies || {}), [field]: next } });
  };
  async function renamePhase(oldName) {
    const name = await dialog.prompt('Phase name', { title: 'Rename Phase', defaultValue: oldName, required: true });
    if (!name || !name.trim() || name.trim() === oldName) return;
    setRows(r => r.map(x => ((x.phase || 'Steps') === oldName ? { ...x, phase: name.trim() } : x)));
    touch();
  }
  async function addPhase() {
    const name = await dialog.prompt('What is the new phase called?', { title: 'Add A Phase', required: true, placeholder: 'e.g. Second Week' });
    if (name && name.trim()) addStep(name.trim());
  }
  const addStep = (phase) => {
    const blank = { key: '', phase, title: '', owner: 'hr', anchor: template.kind === 'onboarding' ? 'S' : 'X', offset: 0, bd: false, applies: {}, signal: '', hint: '' };
    const lastInPhase = rows.map(r => r.phase).lastIndexOf(phase);
    const at = lastInPhase === -1 ? rows.length : lastInPhase + 1;
    setRows(r => [...r.slice(0, at), blank, ...r.slice(at)]);
    setEditIdx(at); setPicked(new Set()); touch();
  };

  // --- Bulk actions on the ticked steps -----------------------------------
  const togglePick = (idxs, on) => setPicked(prev => {
    const n = new Set(prev);
    idxs.forEach(i => (on ? n.add(i) : n.delete(i)));
    return n;
  });
  const bulkOwner = (role) => {
    if (!role) return;
    setRows(r => r.map((x, j) => (picked.has(j) ? { ...x, owner: role } : x)));
    toastOk(`${picked.size} step${picked.size === 1 ? '' : 's'} now owned by ${meta?.roles?.find(o => o.value === role)?.label || role}. Save the template to keep it.`);
    setPicked(new Set()); touch();
  };
  async function bulkPhase(value) {
    if (!value) return;
    let phase = value;
    if (value === '__new__') {
      phase = (await dialog.prompt('What is the new phase called?', { title: 'Move To A New Phase', required: true }) || '').trim();
      if (!phase) return;
    }
    // Moved steps go to the end of their new phase, keeping their order.
    setRows(r => {
      const moving = r.filter((_, j) => picked.has(j)).map(x => ({ ...x, phase }));
      const rest = r.filter((_, j) => !picked.has(j));
      const at = rest.map(x => x.phase).lastIndexOf(phase);
      return at === -1 ? [...rest, ...moving] : [...rest.slice(0, at + 1), ...moving, ...rest.slice(at + 1)];
    });
    setPicked(new Set()); setEditIdx(-1); touch();
  }
  async function bulkDelete() {
    const n = picked.size;
    if (!await dialog.confirm(`Delete ${n} step${n === 1 ? '' : 's'} from this template? Checklists already started keep theirs.`,
      { title: 'Delete Steps', confirmText: `Delete ${n}`, danger: true })) return;
    setRows(r => r.filter((_, j) => !picked.has(j)));
    setPicked(new Set()); setEditIdx(-1); touch();
  }

  async function save() {
    if (rows.some(r => !r.title.trim())) { toastErr('Every step needs a title.'); return; }
    if (!rows.length) { toastErr('A template needs at least one step.'); return; }
    setBusy(true);
    try { onSaved(await api.saveChecklistTemplate(template.kind, entityId, { items: rows })); setDirty(false); setEditIdx(-1); setPicked(new Set()); toastOk('Template saved. New checklists use it; ones already started keep their steps.'); }
    catch (e) { toastErr(e?.message || 'Could not save the template.'); }
    setBusy(false);
  }
  async function reset() {
    const msg = entityId ? 'Go back to the default template for this company?' : 'Put the default template back to the steps Nexus shipped with?';
    if (!await dialog.confirm(msg, { title: 'Reset Template', confirmText: 'Reset', danger: true })) return;
    try { onSaved(await api.resetChecklistTemplate(template.kind, entityId)); toastOk('Template reset.'); }
    catch (e) { toastErr(e?.message || 'Could not reset the template.'); }
  }

  const phases = [];
  rows.forEach((r, i) => {
    const name = r.phase || 'Steps';
    let g = phases.find(p => p.name === name);
    if (!g) { g = { name, rows: [] }; phases.push(g); }
    g.rows.push({ r, i });
  });
  const allIdx = rows.map((_, i) => i);
  const roles = meta?.roles || [];
  const selStyle = { ...inputStyle, padding: '6px 8px', fontSize: 12.5 };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
        <TriCheck label="Select every step" checked={rows.length > 0 && picked.size === rows.length} indeterminate={picked.size > 0}
          onChange={e => togglePick(allIdx, e.target.checked)} />
        <span style={{ fontSize: 13, color: 'var(--wk-dim)', flex: 1, minWidth: 220, lineHeight: 1.5 }}>
          {template.inherited
            ? <>This company uses the <b style={{ color: 'var(--wk-ink)' }}>default</b> steps. Saving a change makes a copy just for this company.</>
            : <>{rows.length} steps in {phases.length} phases. Click a step to edit it, or tick several to change them together.</>}
        </span>
        <button onClick={reset} style={ghostBtn}><RotateCcw size={13} /> {entityId && !template.inherited ? 'Use Default' : 'Reset'}</button>
      </div>

      {/* Bulk action bar: only while something is ticked. */}
      {picked.size > 0 && (
        <div role="toolbar" aria-label="Selected steps" style={{ position: 'sticky', top: 8, zIndex: 6, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 14,
          padding: '9px 12px', borderRadius: 'var(--wk-r)', background: 'var(--wk-brand-tint)', border: '1px solid var(--wk-brand)', boxShadow: 'var(--wk-shadow)' }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--wk-brand)' }}>{picked.size} step{picked.size === 1 ? '' : 's'} selected</span>
          <span style={{ flex: 1 }} />
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--wk-ink)' }}>
            <UserCog size={14} /> Change Owner To
            <select value="" onChange={e => bulkOwner(e.target.value)} style={selStyle} aria-label="Change owner of selected steps">
              <option value="">Pick a role</option>
              {roles.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--wk-ink)' }}>
            Move To Phase
            <select value="" onChange={e => bulkPhase(e.target.value)} style={selStyle} aria-label="Move selected steps to a phase">
              <option value="">Pick a phase</option>
              {phases.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
              <option value="__new__">New Phase…</option>
            </select>
          </label>
          <button onClick={bulkDelete} style={{ ...ghostBtn, color: 'var(--wk-red)', borderColor: 'var(--wk-red)' }}><Trash2 size={13} /> Delete</button>
          <button onClick={() => setPicked(new Set())} style={ghostBtn}><X size={13} /> Clear</button>
        </div>
      )}

      {phases.map((p, pi) => {
        const idxs = p.rows.map(x => x.i);
        const nPicked = idxs.filter(i => picked.has(i)).length;
        return (
          <section key={p.name} aria-label={`Phase ${pi + 1}: ${p.name}`} style={{ marginBottom: 16 }}>
            {/* Phase header band: tinted and numbered, so it reads as a group, not a step. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '9px 12px', borderRadius: 'var(--wk-r)', background: 'var(--wk-brand-tint)' }}>
              <TriCheck label={`Select every step in ${p.name}`} checked={nPicked === idxs.length} indeterminate={nPicked > 0}
                onChange={e => togglePick(idxs, e.target.checked)} />
              <span style={{ fontSize: 11.5, fontWeight: 700, padding: '2px 8px', borderRadius: 5, background: 'var(--wk-brand)', color: '#fff', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                Phase {pi + 1}
              </span>
              <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--wk-ink)' }}>{p.name}</span>
              <button onClick={() => renamePhase(p.name)} aria-label={`Rename phase ${p.name}`} title="Rename this phase"
                style={{ background: 'none', border: 'none', padding: 3, cursor: 'pointer', color: 'var(--wk-brand)', display: 'inline-flex' }}>
                <Pencil size={13} />
              </button>
              <span style={{ fontSize: 12, color: 'var(--wk-dim)', fontWeight: 600 }}>{p.rows.length} step{p.rows.length === 1 ? '' : 's'}</span>
              <span style={{ flex: 1 }} />
              <button onClick={() => addStep(p.name)} style={{ ...ghostBtn, background: 'var(--wk-card)', borderColor: 'var(--wk-card)', color: 'var(--wk-brand)', padding: '4px 10px' }}><Plus size={13} /> Add Step</button>
            </div>
            {/* Its steps, indented under the band on a thin guide line. */}
            <div style={{ marginLeft: 19, paddingLeft: 14, borderLeft: '1px solid var(--wk-line)', marginTop: 4 }}>
              {p.rows.map(({ r, i }) => (editIdx === i ? (
                <TemplateRowEditor key={i} r={r} i={i} total={rows.length} kind={template.kind} meta={meta}
                  set={set} move={move} remove={remove} toggleIn={toggleIn} onDone={() => setEditIdx(-1)} />
              ) : (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, borderBottom: '1px solid var(--wk-line2)', background: picked.has(i) ? 'var(--wk-hover)' : 'transparent' }}>
                  <TriCheck label={`Select ${r.title || 'untitled step'}`} checked={picked.has(i)} onChange={e => togglePick([i], e.target.checked)} />
                  <button onClick={() => setEditIdx(i)}
                    style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '10px 6px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', fontFamily: FONT }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'var(--wk-hover)'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}>
                    <span style={{ flex: '1 1 260px', minWidth: 0, display: 'grid', gap: 2 }}>
                      <span style={{ fontSize: 13.5, fontWeight: 600, color: r.title ? 'var(--wk-ink)' : 'var(--wk-red)' }}>{r.title || 'Untitled Step'}</span>
                      {r.hint && <span style={{ fontSize: 12, color: 'var(--wk-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.hint}</span>}
                    </span>
                    <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                      {tag(roles.find(o => o.value === r.owner)?.label || ROLE_LOOK[r.owner]?.label || r.owner, 'brand')}
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--wk-dim)', whiteSpace: 'nowrap' }}><CalendarDays size={12} /> {timingText(r, template.kind)}</span>
                      {appliesText(r.applies, meta).map(t => <span key={t}>{tag(t)}</span>)}
                      {r.signal && <span title={`Nexus marks this done by itself${signalHint(r.signal, meta) ? ` when: ${signalHint(r.signal, meta)}` : ''}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11.5, fontWeight: 600, color: 'var(--wk-brand)' }}><Sparkles size={11} /> Auto-Ticks</span>}
                    </span>
                    <Pencil size={13} color="var(--wk-faint)" aria-hidden="true" />
                  </button>
                </div>
              )))}
            </div>
          </section>
        );
      })}
      <button onClick={addPhase} style={ghostBtn}><Plus size={13} /> Add A Phase</button>
      {dirty && <SaveBar label="Template changes not saved yet" busy={busy} saveText="Save Template"
        onDiscard={() => { setRows(template.items || []); setDirty(false); setEditIdx(-1); setPicked(new Set()); }} onSave={save} />}
    </div>
  );
}


export function ChecklistSettings({ entities = [], toastOk, toastErr }) {
  const [entityId, setEntityId] = useState('');
  const [loaded, setLoaded] = useState({ entityId: null, templates: null });
  const [kind, setKind] = useState('onboarding');
  const [meta, setMeta] = useState(null);
  const { data: dir = [] } = usePeopleDirectory();
  const people = useMemo(() => dir.map(p => ({ email: (p.email || '').toLowerCase(), name: p.name || p.email })), [dir]);
  useEffect(() => { api.getChecklistMeta().then(setMeta).catch(() => setMeta(null)); }, []);
  useEffect(() => {
    api.getChecklistTemplates(entityId)
      .then(r => setLoaded({ entityId, templates: r.templates || [] }))
      .catch(() => setLoaded({ entityId, templates: false }));
  }, [entityId]);
  const templates = loaded.entityId === entityId ? loaded.templates : null;
  const setTemplates = fn => setLoaded(l => ({ ...l, templates: fn(l.templates || []) }));
  const tpl = (templates || []).find(t => t.kind === kind);
  const kinds = meta?.kinds || [{ value: 'onboarding', label: 'Onboarding' }, { value: 'offboarding', label: 'Offboarding' }, { value: 'inactive', label: 'Leave Or Suspension' }];
  const companyName = entityId ? (entities.find(e => e.id === entityId)?.name || 'This company') : 'Every company';
  return (
    <div style={{ fontFamily: FONT }}>
      {/* What these settings apply to, stated once at the top. */}
      <section style={{ ...card, padding: '14px 18px', marginBottom: 18, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <span className="dk-chip dk-chip--brand"><ListChecks /></span>
        <div style={{ flex: '1 1 260px', minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--wk-ink)' }}>Checklist Settings For {companyName}</div>
          <div style={{ fontSize: 12.5, color: 'var(--wk-dim)', lineHeight: 1.5 }}>
            {entityId ? 'Anything this company does not set itself comes from the default.' : 'The default for every company. A company can override owners and steps.'}
          </div>
        </div>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={capLabel}>Company</span>
          <select value={entityId} onChange={e => setEntityId(e.target.value)} style={{ ...inputStyle, minWidth: 220 }}>
            <option value="">Default (Every Company)</option>
            {entities.map(en => <option key={en.id} value={en.id}>{en.name}</option>)}
          </select>
        </label>
      </section>

      <OwnersCard key={entityId || 'default'} entityId={entityId} people={people} toastOk={toastOk} toastErr={toastErr} />

      <section style={{ ...card, padding: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
          <div style={{ flex: '1 1 240px' }}>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--wk-ink)' }}>Checklist Templates</h3>
            <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--wk-dim)' }}>The steps every new checklist is built from.</p>
          </div>
          <div className="scroll-tabs" role="tablist" aria-label="Checklist kind"
            style={{ display: 'inline-flex', gap: 2, padding: 3, borderRadius: 8, background: 'var(--wk-hover)', maxWidth: '100%' }}>
            {kinds.map(k => {
              const look = KIND_LOOK[k.value] || KIND_LOOK.onboarding;
              const n = (templates || []).find(t => t.kind === k.value)?.items?.length;
              const on = kind === k.value;
              return (
                <button key={k.value} role="tab" aria-selected={on} onClick={() => setKind(k.value)}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 6, border: 'none', cursor: 'pointer', whiteSpace: 'nowrap', fontFamily: FONT, fontSize: 13, fontWeight: 600,
                    background: on ? 'var(--wk-card)' : 'transparent', color: on ? 'var(--wk-ink)' : 'var(--wk-dim)', boxShadow: on ? '0 1px 3px rgba(29,33,57,.12)' : 'none' }}>
                  <look.Icon size={14} /> {k.label}
                  {n != null && <span style={{ fontSize: 11.5, color: 'var(--wk-faint)', fontVariantNumeric: 'tabular-nums' }}>{n}</span>}
                </button>
              );
            })}
          </div>
        </div>
        {templates === null && <SkeletonBlocks count={3} height={56} />}
        {templates === false && <div style={{ fontSize: 13, color: 'var(--wk-dim)' }}>Could not load the templates.</div>}
        {tpl && (
          <TemplateEditor key={`${tpl.kind}:${entityId}:${tpl.updatedAt}:${tpl.entityId}`} template={tpl} meta={meta} entityId={entityId} toastOk={toastOk} toastErr={toastErr}
            onSaved={saved => setTemplates(prev => prev.map(t => t.kind === saved.kind ? saved : t))} />
        )}
      </section>
    </div>
  );
}
