// Onboarding / promotion / offboarding / leave checklists (HR roadmap Section C:
// "Onboarding checklist per hire ... each with owner + due date").
//
//   ChecklistSection   - the Checklist tab on a People profile (HR)
//   MyChecklistSteps   - the steps the signed-in person owns, on My HR. A
//                        manager, IT or the new hire ticks their own steps here
//                        without People access; renders nothing when empty.
//   ChecklistSettings  - who owns each role and the steps every new checklist
//                        is built from: the Checklist Library (Global Settings >
//                        Hiring) or one company (Company Settings > Checklists),
//                        with copy from / to other companies (Neil, Oct 19)
//   RoleChecklists     - Team > Role Checklists: a job role's own extra steps,
//                        kept by its department head (Neil, Oct 19)
//
// The server (backend/hr_checklists.py) resolves owners and due dates and
// ticks steps it can see for itself (a finished provisioning run, a signed
// envelope, a status change) - this file only shows and edits them.
import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  ListChecks, CheckCircle2, Circle, MinusCircle, AlertTriangle, CalendarDays,
  Pencil, X, ChevronDown, ChevronRight, Sparkles, Play, RotateCcw, Plus,
  Trash2, ArrowUp, ArrowDown, Save, Ban, UserPlus, UserMinus, PauseCircle,
  Check, UserCog, Users, Laptop, Banknote, TrendingUp, Copy,
} from 'lucide-react';
import { api } from '../api';
import { formatDate, formatDateTime, toDateInputValue } from '../lib/datetime';
import { dialog } from '../ui/dialog';
import { setPendingOpen } from '../lib/pendingOpen';
import { usePeopleDirectory, useEntities } from '../lib/queries';
import { SkeletonBlocks, Spinner } from './AsyncState';
import PersonSearchSelect from './PersonSearchSelect';
import { Modal, DateField, ChipMultiSelect } from '../tasks/components';
import { COUNTRIES, countryName } from '../lib/countries';

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
  promotion:   { Icon: TrendingUp,  chip: 'dk-chip--blue',   anchor: 'Effective',   verb: 'effective date' },
  offboarding: { Icon: UserMinus,   chip: 'dk-chip--orange', anchor: 'Last day',    verb: 'exit date' },
  inactive:    { Icon: PauseCircle, chip: 'dk-chip--purple', anchor: 'Leave from',  verb: 'leave start' },
};
const ANCHOR_LABEL = { onboarding: 'Start Date', promotion: 'Effective Date', offboarding: 'Exit Date', inactive: 'Leave Starts' };
const KIND_BLURB = {
  onboarding: 'From offer accepted to the 90-day check-in.',
  promotion: 'A new role: the letter, pay, access and training for it.',
  offboarding: 'From notice received to final pay and access removed.',
  inactive: 'Leave of absence, suspension or garden leave.',
};
const EXIT_LABEL = {
  resignation: 'Voluntary Resignation', resignation_no_notice: 'Job Abandonment', termination: 'Termination',
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
const lowerFirst = t => (t ? t.charAt(0).toLowerCase() + t.slice(1) : '');
// Template saves reach open checklists (Neil, Oct 22: "is it dynamic or is it fixed?").
const openUpdatedText = n => (n ? `${n} open checklist${n === 1 ? '' : 's'} updated - steps already done stay as they were.` : 'No open checklist needed a change.');
// The Task module may not be mounted yet: the note serves it on mount, the event once it is up.
function openTask(taskId) {
  setPendingOpen('task', taskId);
  window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'tasks', sub: 'mine' } }));
  setTimeout(() => window.dispatchEvent(new CustomEvent('nexus:open-task', { detail: { taskId } })), 0);
}
// A step's automatic conditions, joined by "|" (hr_checklists.SIG_SEP) - any one ticks it.
const sigList = s => (s || '').split('|').map(x => x.trim()).filter(Boolean);
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

function StepRow({ step, canEdit, canAct, people, roleOwners = [], onChanged, toastErr }) {
  const comments = step.comments || [];
  const conds = step.signals || (step.signal ? [{ value: step.signal, label: step.signalLabel || '' }] : []);
  const [busy, setBusy] = useState(false);
  // A step with comments stays open so the thread is in view (Pranshu, Oct 20).
  const [open, setOpen] = useState(comments.length > 0);
  const [mode, setMode] = useState('');      // '' | 'owner' | 'date'
  const [due, setDue] = useState(step.dueDate || '');
  const [comment, setComment] = useState('');
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
  // One thread with the step's subtask in Tasks: a comment here posts there,
  // and one made there shows here.
  async function addComment() {
    const text = comment.trim();
    if (!text) return;
    setBusy(true);
    try {
      const r = await api.addChecklistComment(step.id, text);
      setComment('');
      onChanged(r.item, r.checklistStatus, 'Comment added.');
    } catch (e) { toastErr(e?.message || 'Could not add the comment.'); }
    setBusy(false);
  }
  // Change Owner: whoever holds this step's role first, then everyone else.
  const roleSet = new Set(roleOwners);
  const ownerGroups = [
    { label: `${step.ownerRoleLabel} Owners`, people: people.filter(p => roleSet.has(p.email)) },
    { label: 'Nexus People', people: people.filter(p => !roleSet.has(p.email)) },
  ];

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
            {conds.length > 0 && !closed && (
              <span title={`Nexus marks this done by itself when: ${conds.map(c => lowerFirst(c.label)).join(' or ')}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, fontWeight: 600, color: 'var(--wk-brand)' }}>
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
          {conds.length > 0 && !closed && (
            <div style={{ fontSize: 12, color: 'var(--wk-brand)', display: 'grid', gap: 3 }}>
              <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}><Sparkles size={12} /> {conds.length === 1 ? 'Nexus marks this done by itself when:' : 'Nexus marks this done by itself when any one of these is true:'}</span>
              <ul style={{ margin: 0, paddingLeft: 36 }}>{conds.map(c => <li key={c.value}>{lowerFirst(c.label)}</li>)}</ul>
            </div>
          )}
          {step.note && (
            <div style={{ fontSize: 12.5, color: 'var(--wk-ink)', padding: '8px 10px', background: 'var(--wk-card)', border: '1px solid var(--wk-line2)', borderRadius: 6, whiteSpace: 'pre-wrap', maxWidth: '70ch' }}>
              <b style={{ fontWeight: 600 }}>{step.status === 'na' ? 'N/A Reason: ' : 'Note: '}</b>{step.note}
            </div>
          )}
          {comments.length > 0 && (
            <div style={{ display: 'grid', gap: 8, maxWidth: '70ch' }} aria-label="Comments">
              {comments.map(c => (
                <div key={c.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <Avatar name={c.authorName || c.author} />
                  <div style={{ flex: 1, minWidth: 0, padding: '7px 10px', background: 'var(--wk-card)', border: '1px solid var(--wk-line2)', borderRadius: 8 }}>
                    <div style={{ fontSize: 12, color: 'var(--wk-dim)', marginBottom: 3 }}>
                      <b style={{ fontWeight: 600, color: 'var(--wk-ink)' }}>{c.authorName || c.author}</b> · {formatDateTime(c.at)}{c.editedAt ? ' · Edited' : ''}
                    </div>
                    <div style={{ fontSize: 12.5, color: 'var(--wk-ink)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{c.body}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
          {canAct && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', maxWidth: '70ch' }}>
              <textarea value={comment} onChange={e => setComment(e.target.value)} rows={1} placeholder="Add a comment - it shows on the task too"
                aria-label="Add a comment" disabled={busy}
                onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); addComment(); } }}
                style={{ ...inputStyle, flex: 1, minHeight: 36, resize: 'vertical', fontFamily: FONT }} />
              <button className="primary-btn" onClick={addComment} disabled={busy || !comment.trim()} style={{ fontSize: 12.5, whiteSpace: 'nowrap' }}>Add Comment</button>
            </div>
          )}
          {closed && step.doneAt && (
            <div style={{ fontSize: 12, color: 'var(--wk-dim)' }}>
              {step.status === 'done' && step.doneBy === 'Nexus' && step.doneReason
                ? `Marked done by Nexus: ${lowerFirst(step.doneReason)}, ${formatDate(step.doneAt)}`
                : <>{step.status === 'na' ? 'Marked N/A' : 'Done'} {step.doneBy === 'Nexus' ? 'by Nexus' : step.doneBy ? `by ${step.doneBy}` : ''} on {formatDate(step.doneAt)}</>}
            </div>
          )}
          {canAct && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {!closed && <button onClick={markNa} disabled={busy} style={ghostBtn}><Ban size={13} /> Mark N/A</button>}
              {canEdit && !closed && <button onClick={() => setMode(m => m === 'owner' ? '' : 'owner')} style={{ ...ghostBtn, borderColor: mode === 'owner' ? 'var(--wk-brand)' : 'var(--wk-line)' }}><UserCog size={13} /> Change Owner</button>}
              {canEdit && !closed && <button onClick={() => { setDue(step.dueDate || ''); setMode(m => m === 'date' ? '' : 'date'); }} style={{ ...ghostBtn, borderColor: mode === 'date' ? 'var(--wk-brand)' : 'var(--wk-line)' }}><CalendarDays size={13} /> Change Date</button>}
            </div>
          )}
          {mode === 'owner' && canEdit && (
            <div style={{ maxWidth: 360 }}>
              <PersonSearchSelect placeholder={ownerText(step) ? `${ownerText(step)} - type to change` : 'Pick who owns this step'}
                groups={ownerGroups}
                onPick={email => { setMode(''); patch({ owner_email: email }, 'Owner changed.'); }} />
            </div>
          )}
          {mode === 'date' && canEdit && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <DateField value={due} onChange={v => setDue(v || '')} placeholder="MM/DD/YYYY" title="New due date" style={{ minWidth: 150 }} />
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
        {cl.task && (
          <div style={{ marginTop: 12, fontSize: 12.5, color: 'var(--wk-dim)', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', lineHeight: 1.5 }}>
            <ListChecks size={13} aria-hidden="true" />
            <span>Task: <b style={{ color: 'var(--wk-ink)', fontWeight: 600 }}>{cl.task.title}</b>{' '}
              {cl.task.projectName
                ? <>in {cl.task.projectName}{cl.task.sectionName ? `, section ${cl.task.sectionName}` : ''}</>
                : <span style={{ color: 'var(--wk-orange)' }}>- not in a project yet; pick one in Company Settings &gt; Checklists &gt; Where Checklist Tasks Go</span>}
            </span>
            <button onClick={() => openTask(cl.task.id)} style={{ ...ghostBtn, padding: '3px 8px', fontSize: 12 }}>Open Task</button>
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
                defaultOpen={filter !== 'all' || state === 'current' || (state === 'upcoming' && idx === currentIdx + 1) || p.steps.some(s => s.overdue || s.comments?.length)}
                renderStep={s => (
                  <StepRow key={s.id} step={s} canEdit={canEdit && cl.status !== 'cancelled'} people={people}
                    roleOwners={cl.roleOwners?.[s.ownerRole] || []}
                    canAct={cl.status !== 'cancelled' && (canEdit || (!!me && (s.ownerEmails || [s.ownerEmail]).includes(me)))}
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
  const kinds = meta?.kinds || [{ value: 'onboarding', label: 'Onboarding' }, { value: 'promotion', label: 'Promotion' }, { value: 'offboarding', label: 'Offboarding' }, { value: 'inactive', label: 'Leave or Suspension' }];
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
          <span style={{ ...inputStyle, display: 'flex', alignItems: 'center', minWidth: 170 }}>
            <DateField value={date} onChange={v => setDate(v || '')} disabled={kind === 'onboarding'} placeholder="MM/DD/YYYY" style={{ width: '100%' }}
              title={kind === 'onboarding' ? 'Onboarding counts from the start date on the profile - change it there' : ANCHOR_LABEL[kind]} />
          </span>
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
        {kind === 'promotion' && "Steps count from the day the new role takes effect, and the role's own steps are added. A signed promotion letter starts this checklist by itself."}
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

// p = one /hr/checklists/progress entry: { kind, kindLabel, status, done, total, overdue }.
// The chip names the CHECKLIST, never the person's state (Charmi, Oct 20 2026:
// a Left person showing "Offboarding 5/26" read like they were still
// leaving) - "Offboarding Checklist 5/26" in amber while steps are open (red
// once some are late), green "Offboarding Complete" when every step is done.
export function ChecklistChip({ p, onClick, compact = false }) {
  if (!p) return null;
  const look = KIND_LOOK[p.kind] || KIND_LOOK.onboarding;
  const complete = p.status === 'done' || (p.total > 0 && p.done >= p.total);
  const late = !complete && p.overdue > 0;
  const text = complete ? `${p.kindLabel} Complete` : `${p.kindLabel} Checklist`;
  const body = (
    <>
      {complete ? <CheckCircle2 size={12} aria-hidden="true" /> : <look.Icon size={12} aria-hidden="true" />}
      <span>{compact ? (complete ? 'Complete' : 'Checklist') : text}</span>
      {!complete && <span style={{ fontVariantNumeric: 'tabular-nums' }}>{p.done}/{p.total}</span>}
      {late && <span>· {p.overdue} late</span>}
    </>
  );
  const [bg, fg] = complete ? ['var(--wk-green-bg)', 'var(--wk-green)']
    : late ? ['var(--wk-red-bg)', 'var(--wk-red)'] : ['var(--wk-orange-bg)', 'var(--wk-orange)'];
  const style = { display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px', borderRadius: 6, fontSize: 11.5, fontWeight: 600, whiteSpace: 'nowrap', fontFamily: FONT,
    background: bg, color: fg, border: 'none' };
  const label = complete
    ? `${p.kindLabel} checklist complete: all ${p.total} steps done`
    : `${p.kindLabel} checklist: ${p.done} of ${p.total} done${late ? `, ${p.overdue} overdue` : ''}`;
  // role=button on a span, not a <button>: the directory row it sits in is
  // already a button, and buttons cannot nest.
  const open = e => { e.stopPropagation(); onClick(); };
  return onClick
    ? <span role="button" tabIndex={0} onClick={open}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(e); } }}
        title={`${label} - open the checklist`} aria-label={label} style={{ ...style, cursor: 'pointer' }}>{body}</span>
    : <span title={label} aria-label={label} style={style}>{body}</span>;
}

// --- People > Checklists (the board) -----------------------------------------

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
  const verb = r.kind === 'onboarding' ? (d >= 0 ? 'Starts' : 'Started') : r.kind === 'offboarding' ? (d >= 0 ? 'Leaves' : 'Left')
    : r.kind === 'promotion' ? 'New role from' : 'Leave from';
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
        <BoardTile Icon={TrendingUp} chip="dk-chip--blue" label="Promotion" value={count('promotion')} sub="people moving up" active={kind === 'promotion'} onClick={() => pickKind('promotion')} />
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
                  <look.Icon size={13} style={{ color: `var(--wk-${r.kind === 'onboarding' ? 'green' : r.kind === 'offboarding' ? 'orange' : r.kind === 'promotion' ? 'blue' : 'brand'})` }} />
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
const KIND_LABEL_OF = k => ({ onboarding: 'Onboarding', promotion: 'Promotion', offboarding: 'Offboarding', inactive: 'On Leave' }[k] || 'All');

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
            <div key={s.id} className={!s.dueDate || s.dueDate.slice(0, 10) <= toDateInputValue(new Date()) ? 'nx-needs-you' : undefined} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
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

// --- Owners + templates (Checklist Library / Company Settings) --------------

// Neil, Oct 19: payroll is Accounting, equipment is IT, there is no Finance.
const ROLE_LOOK = {
  hr:         { label: 'HR',         Icon: Users,    chip: 'dk-chip--brand', hint: 'Used when a company has no HR contact in Company Setup.' },
  it:         { label: 'IT',         Icon: Laptop,   chip: 'dk-chip--blue',  hint: 'Provisioning, licenses, sign-in, and laptops and phones in Item Management.' },
  accounting: { label: 'Accounting', Icon: Banknote, chip: 'dk-chip--green', hint: 'Tax forms, payroll, final pay and leave payout, systems outside Microsoft 365.' },
};
const OWNER_ROLES = ['hr', 'it', 'accounting'];

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

// Neil, Oct 22: "integrate role owners with department heads in departments in
// settings" - one company setup, applied everywhere. HR / IT / Accounting
// steps go to the head AND backup of the department playing that part; with
// nobody active there, to the old owner list, the HR contact, then the Global
// Admins. This card says who that is right now and what is missing.
function DepartmentOwnersCard({ entityId, people, onOpenDepartments, toastOk, toastErr }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState('');
  const load = useCallback(() => api.getChecklistOwners(entityId).then(setData).catch(() => setData(false)), [entityId]);
  useEffect(() => { load(); }, [load]);
  const nameOf = em => people.find(p => p.email === (em || '').toLowerCase())?.name || em;
  async function pick(role, deptId) {
    setBusy(role);
    try {
      const picked = Object.fromEntries(OWNER_ROLES.map(r => [r, data.departments?.[r]?.picked ? data.departments[r].id : '']));
      setData(await api.saveChecklistOwnerDepartments(entityId, { ...picked, [role]: deptId }));
      toastOk('Saved - open checklists now go to that department.');
    } catch (e) { toastErr(e?.message || 'Could not save.'); }
    setBusy('');
  }
  if (data === null) return <SkeletonBlocks count={1} height={150} />;
  if (data === false) return <div style={{ ...card, padding: 18, fontSize: 13, color: 'var(--wk-dim)' }}>Could not load who owns the steps.</div>;
  const admins = (data.globalAdmins || []).map(nameOf).join(', ') || 'nobody yet';
  return (
    <section style={{ ...card, padding: 18, marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <div style={{ flex: '1 1 300px', minWidth: 0 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, fontFamily: FONT, color: 'var(--wk-ink)' }}>Who Does Each Step</h3>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--wk-dim)', lineHeight: 1.5, maxWidth: '75ch' }}>
            HR, IT and Accounting steps go to the head and the backup of that department - both get the task, and either one closing it closes it.
            Manager steps go to the person&apos;s reports-to (no reports-to: their department head). Anything nobody owns goes to the Global Admins ({admins}).
          </p>
        </div>
        {onOpenDepartments && <button onClick={onOpenDepartments} style={ghostBtn}><Users size={13} /> Edit Heads In Departments</button>}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: 12 }}>
        {OWNER_ROLES.map(role => {
          const look = ROLE_LOOK[role];
          const d = data.departments?.[role];
          const active = d?.active || [];
          const effective = [].concat(data.effective?.[role] || []);
          const fallback = effective.length ? effective : role === 'hr' && data.hrContact ? [data.hrContact] : [];
          const warn = !d ? `No ${look.label} department` : !d.leadEmail ? 'No department head'
            : !active.length ? 'Head and backup are not active' : !d.backupEmail ? 'No backup' : '';
          return (
            <div key={role} style={{ border: `1px solid ${warn && !active.length ? 'var(--wk-orange)' : 'var(--wk-line2)'}`, borderRadius: 'var(--wk-r)', padding: 14, display: 'grid', gap: 10, alignContent: 'start', background: 'var(--wk-card)' }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <span className={`dk-chip ${look.chip}`}><look.Icon /></span>
                <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--wk-ink)', flex: 1 }}>{look.label}</div>
                {busy === role && <Spinner size={13} />}
              </div>
              <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--wk-dim)' }}>
                Department
                <select aria-label={`Department for ${look.label} steps`} value={d?.picked ? d.id : ''} disabled={!!busy}
                  onChange={e => pick(role, e.target.value)} style={inputStyle}>
                  <option value="">{d && !d.picked ? `${d.name} (matched by name)` : 'Match by name'}</option>
                  {(data.departmentChoices || []).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
              {d && (
                <div style={{ display: 'grid', gap: 6 }}>
                  {[['Head', d.leadEmail], ['Backup', d.backupEmail]].map(([lbl, em]) => (
                    <div key={lbl} style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 26 }}>
                      <Avatar name={em ? nameOf(em) : ''} empty={!em} />
                      <span style={{ fontSize: 12, color: 'var(--wk-faint)', width: 46 }}>{lbl}</span>
                      <b style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: em ? 'var(--wk-ink)' : 'var(--wk-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{em ? nameOf(em) : 'Not set'}</b>
                    </div>
                  ))}
                </div>
              )}
              {warn && (
                <div role="note" style={{ display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 12, lineHeight: 1.45, color: 'var(--wk-orange)' }}>
                  <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 2 }} />
                  <span>
                    <b>{warn}.</b>{' '}
                    {active.length ? 'Steps reach the head, but nobody covers when they are out.'
                      : `Steps go to ${fallback.length ? fallback.map(nameOf).join(', ') : `the Global Admins (${admins})`} until it is set.`}
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

// The library has no departments: each company's own decide who does a step.
function LibraryOwnersNote() {
  return (
    <section style={{ ...card, padding: '14px 18px', marginBottom: 18, fontSize: 13, color: 'var(--wk-dim)', lineHeight: 1.5 }}>
      <b style={{ color: 'var(--wk-ink)' }}>Who does each step</b> is set once per company: the head and the backup of its HR, IT and
      Accounting departments (Company Settings &gt; a company &gt; Departments). A step nobody owns goes to the Global Admins.
    </section>
  );
}

// The worker types hr_checklists._applies understands ('employee' = anyone but a contractor).
const TYPE_CHOICES = [['employee', 'Employees (Any)'], ['full_time', 'Full-Time'], ['part_time', 'Part-Time'],
  ['intern', 'Interns'], ['contractor', 'Contractors']];
const COUNTRY_OPTIONS = COUNTRIES.map(c => ({ id: c.code, label: c.name }));
const ANCHOR_NOUN = { onboarding: 'start', promotion: 'effective date', offboarding: 'last day', inactive: 'leave start' };

// "7 days before start", "3 business days after start", "No due date".
function timingText(r, kind) {
  if (r.anchor === 'none') return 'No due date';
  const n = Math.abs(Number(r.offset) || 0);
  const unit = r.bd ? (n === 1 ? 'business day' : 'business days') : (n === 1 ? 'day' : 'days');
  if (r.anchor === 'created') return n ? `${n} ${unit} after it starts` : 'When the checklist starts';
  const noun = r.anchor === 'X' ? ANCHOR_NOUN[['onboarding', 'promotion'].includes(kind) ? 'offboarding' : kind]
    : kind === 'promotion' ? ANCHOR_NOUN.promotion : 'start';
  if (!n) return `On the ${noun === 'start' ? 'start date' : noun}`;
  return `${n} ${unit} ${r.offset < 0 ? 'before' : 'after'} ${noun}`;
}
function appliesText(a, meta) {
  const bits = [];
  (a?.types || []).forEach(t => bits.push(TYPE_CHOICES.find(([v]) => v === t)?.[1] || t));
  (a?.countries || []).forEach(c => bits.push(countryName(c)));
  (a?.exit_types || []).forEach(t => bits.push(EXIT_LABEL[t] || meta?.exitTypes?.find(x => x.value === t)?.label || t));
  return bits;
}
function signalHint(signal, meta) {
  const exact = meta?.signals?.find(x => x.value === signal)?.label;
  if (exact) return lowerFirst(exact);
  const name = (signal || '').split(':')[0];
  if (name === 'envelope') return `a ${(signal.split(':')[1] || 'matching').replace(/_/g, ' ').replace(/,/g, ' or ')} document is signed in Nexus Sign`;
  return lowerFirst(meta?.signals?.find(x => x.value === name)?.label);
}
const tag = (text, tone) => (
  <span style={{ fontSize: 11.5, fontWeight: 600, padding: '2px 8px', borderRadius: 5, whiteSpace: 'nowrap',
    background: tone === 'brand' ? 'var(--wk-brand-tint)' : 'var(--wk-hover)', color: tone === 'brand' ? 'var(--wk-brand)' : 'var(--wk-dim)' }}>{text}</span>
);

function TemplateRowEditor({ r, i, total, kind, meta, set, move, remove, setApplies, onDone }) {
  const roles = meta?.roles || [];
  const picked = sigList(r.signal);
  // Every condition Nexus can check, plus any saved one it no longer lists (an old envelope kind).
  const conds = [...(meta?.signals || []).filter(s => s.value !== 'envelope'),
    ...picked.filter(v => !(meta?.signals || []).some(s => s.value === v)).map(v => ({ value: v, label: signalHint(v, meta) }))];
  const flipCond = v => set(i, { signal: (picked.includes(v) ? picked.filter(x => x !== v) : [...picked, v]).join('|') });
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
            <option value="S">{kind === 'promotion' ? 'Counted From The Effective Date' : 'Counted From The Start Date'}</option>
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
      {/* Who gets this step: searchable dropdowns, every country in the world
          (Pranshu, Oct 20 - it was US / India checkboxes). Nothing picked = everyone. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        {field(<>Worker Type <span style={{ color: 'var(--wk-faint)' }}>(none = everyone)</span></>, (
          <ChipMultiSelect value={r.applies?.types || []} options={TYPE_CHOICES.map(([id, label]) => ({ id, label }))}
            onChange={v => setApplies(i, 'types', v)} placeholder="Every worker type" searchPlaceholder="Search worker types…" />
        ))}
        {field(<>Country <span style={{ color: 'var(--wk-faint)' }}>(none = every country)</span></>, (
          <ChipMultiSelect value={r.applies?.countries || []} options={COUNTRY_OPTIONS}
            onChange={v => setApplies(i, 'countries', v)} placeholder="Every country" searchPlaceholder="Search countries…" />
        ))}
        {kind === 'offboarding' && field(<>Exit Type <span style={{ color: 'var(--wk-faint)' }}>(none = every exit)</span></>, (
          <ChipMultiSelect value={r.applies?.exit_types || []}
            options={(meta?.exitTypes || []).map(t => ({ id: t.value, label: EXIT_LABEL[t.value] || t.label }))}
            onChange={v => setApplies(i, 'exit_types', v)} placeholder="Every exit type" searchPlaceholder="Search exit types…" />
        ))}
      </div>
      {/* A multi-select (Neil, Oct 22): the owner can always tick it, and any
          ONE of the picked conditions ticks it by itself. */}
      <fieldset style={{ border: 'none', padding: 0, margin: 0, display: 'grid', gap: 8, minWidth: 0 }}>
        <legend style={{ ...capLabel, padding: 0, marginBottom: 6 }}>How It Gets Marked Done</legend>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--wk-ink)' }}>
          <input type="checkbox" checked disabled /> Done when the owner ticks it (always)
        </label>
        <span style={{ fontSize: 12.5, color: 'var(--wk-dim)' }}>And automatically when any one of these is true{picked.length ? ` (${picked.length} picked)` : ''}:</span>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(260px, 100%), 1fr))', gap: 6 }}>
          {conds.map(c => (
            <label key={c.value} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '7px 9px', borderRadius: 6, cursor: 'pointer', fontSize: 12.5, lineHeight: 1.4, color: 'var(--wk-ink)',
              border: `1px solid ${picked.includes(c.value) ? 'var(--wk-brand)' : 'var(--wk-line2)'}`, background: picked.includes(c.value) ? 'var(--wk-brand-tint)' : 'transparent' }}>
              <input type="checkbox" checked={picked.includes(c.value)} onChange={() => flipCond(c.value)} style={{ marginTop: 2 }} />
              <span>{c.label.charAt(0).toUpperCase() + c.label.slice(1)}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {field('How-To Hint (optional)', <input value={r.hint || ''} onChange={e => set(i, { hint: e.target.value })} placeholder="One sentence shown under the step" style={inputStyle} />)}
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

// `saveItems` / `resetItems` replace the company-template calls (a role's
// steps save elsewhere); `resetLabel` names the reset button.
function TemplateEditor({ template, meta, entityId, onSaved, toastOk, toastErr, saveItems, resetItems, resetLabel, emptyText }) {
  const [rows, setRows] = useState(template.items || []);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [editIdx, setEditIdx] = useState(-1);
  const [picked, setPicked] = useState(() => new Set());   // row indexes ticked for a bulk action
  const touch = () => { setDirty(true); };
  const set = (i, patch) => { setRows(r => r.map((x, j) => j === i ? { ...x, ...patch } : x)); touch(); };
  const move = (i, d) => { setRows(r => { const n = [...r]; const t = n[i]; n[i] = n[i + d]; n[i + d] = t; return n; }); setEditIdx(i + d); setPicked(new Set()); touch(); };
  const remove = (i) => { setRows(x => x.filter((_, j) => j !== i)); setEditIdx(-1); setPicked(new Set()); touch(); };
  const setApplies = (i, field, list) => set(i, { applies: { ...(rows[i].applies || {}), [field]: list } });
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
    const blank = { key: '', phase, title: '', owner: 'hr', anchor: ['onboarding', 'promotion'].includes(template.kind) ? 'S' : 'X', offset: 0, bd: false, applies: {}, signal: '', hint: '' };
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
    if (!await dialog.confirm(`Delete ${n} step${n === 1 ? '' : 's'} from this template? Open checklists mark them N/A (steps already done stay as they were).`,
      { title: 'Delete Steps', confirmText: `Delete ${n}`, danger: true })) return;
    setRows(r => r.filter((_, j) => !picked.has(j)));
    setPicked(new Set()); setEditIdx(-1); touch();
  }

  async function save() {
    if (rows.some(r => !r.title.trim())) { toastErr('Every step needs a title.'); return; }
    if (!rows.length && !saveItems) { toastErr('A template needs at least one step.'); return; }
    setBusy(true);
    try {
      const res = await (saveItems ? saveItems(rows) : api.saveChecklistTemplate(template.kind, entityId, { items: rows }));
      onSaved(res);
      setDirty(false); setEditIdx(-1); setPicked(new Set());
      toastOk(`Steps saved. ${openUpdatedText(res?.openUpdated)}`);
    } catch (e) { toastErr(e?.message || 'Could not save the steps.'); }
    setBusy(false);
  }
  async function reset() {
    if (resetItems) { await resetItems(); return; }
    const msg = entityId ? 'Go back to the Checklist Library\'s steps for this company?' : 'Put the Checklist Library back to the steps Nexus shipped with?';
    if (!await dialog.confirm(msg, { title: 'Reset Steps', confirmText: 'Reset', danger: true })) return;
    try { const res = await api.resetChecklistTemplate(template.kind, entityId); onSaved(res); toastOk(`Steps reset. ${openUpdatedText(res?.openUpdated)}`); }
    catch (e) { toastErr(e?.message || 'Could not reset the steps.'); }
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
        {rows.length > 0 && <TriCheck label="Select every step" checked={picked.size === rows.length} indeterminate={picked.size > 0}
          onChange={e => togglePick(allIdx, e.target.checked)} />}
        <span style={{ fontSize: 13, color: 'var(--wk-dim)', flex: 1, minWidth: 220, lineHeight: 1.5 }}>
          {template.inherited
            ? <>This company uses the <b style={{ color: 'var(--wk-ink)' }}>Checklist Library</b> steps. Saving a change makes a copy just for this company.</>
            : !rows.length ? (emptyText || 'No steps yet.')
              : <>{rows.length} steps in {phases.length} phases. Click a step to edit it, or tick several to change them together.</>}
        </span>
        {(resetItems ? rows.length > 0 : !template.inherited) && (
          <button onClick={reset} style={ghostBtn}><RotateCcw size={13} /> {resetLabel || (entityId ? 'Use The Library Again' : 'Reset')}</button>
        )}
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
                  set={set} move={move} remove={remove} setApplies={setApplies} onDone={() => setEditIdx(-1)} />
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
                      {sigList(r.signal).length > 0 && (
                        <span style={{ fontSize: 12, color: 'var(--wk-brand)', display: 'inline-flex', alignItems: 'flex-start', gap: 4 }}>
                          <Sparkles size={11} style={{ flexShrink: 0, marginTop: 3 }} /> Auto-ticks when: {sigList(r.signal).map(x => signalHint(x, meta)).join(' or ')}
                        </span>
                      )}
                    </span>
                    <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                      {tag(roles.find(o => o.value === r.owner)?.label || ROLE_LOOK[r.owner]?.label || r.owner, 'brand')}
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--wk-dim)', whiteSpace: 'nowrap' }}><CalendarDays size={12} /> {timingText(r, template.kind)}</span>
                      {appliesText(r.applies, meta).map(t => <span key={t}>{tag(t)}</span>)}
                    </span>
                    <Pencil size={13} color="var(--wk-faint)" aria-hidden="true" />
                  </button>
                </div>
              )))}
            </div>
          </section>
        );
      })}
      <button onClick={addPhase} style={ghostBtn}><Plus size={13} /> {rows.length ? 'Add A Phase' : 'Add The First Step'}</button>
      {dirty && <SaveBar label="Template changes not saved yet" busy={busy} saveText="Save Template"
        onDiscard={() => { setRows(template.items || []); setDirty(false); setEditIdx(-1); setPicked(new Set()); }} onSave={save} />}
    </div>
  );
}


// Copy steps between companies (Neil, Oct 19: "copy from company or have a
// common library ... and an option to copy to multiple companies and
// standardize it"). `direction` 'from' = into this company from one other
// (or the library), 'to' = from here onto several.
function CopyStepsModal({ direction, entityId, entities, kinds, kind, onClose, onDone, toastOk, toastErr }) {
  const others = entities.filter(e => e.id !== entityId);
  const [picked, setPicked] = useState(() => new Set(direction === 'from' ? [''] : []));
  const [which, setWhich] = useState(() => new Set([kind]));
  const [busy, setBusy] = useState(false);
  const flip = (set, setter, v, single) => setter(single ? new Set([v]) : (set.has(v) ? new Set([...set].filter(x => x !== v)) : new Set([...set, v])));
  const from = direction === 'from' ? [...picked][0] : entityId;
  const to = direction === 'from' ? [entityId] : [...picked];
  const nameOf = id => (id ? entities.find(e => e.id === id)?.name || id : 'Checklist Library');
  async function go() {
    if (busy || !to.length || !which.size) return;
    if (!await dialog.confirm(
      `Replace the ${[...which].map(k => kinds.find(x => x.value === k)?.label || k).join(', ')} steps of ${to.map(nameOf).join(', ')} with ${nameOf(from)}'s? Open checklists there update too (steps already done stay as they were).`,
      { title: 'Copy Steps', confirmText: 'Copy' })) return;
    setBusy(true);
    try {
      const r = await api.copyChecklistTemplates({ kinds: [...which], from_entity_id: from || '', to_entity_ids: to });
      toastOk(`Copied - ${r.companies.length} compan${r.companies.length === 1 ? 'y' : 'ies'} now ${r.companies.length === 1 ? 'has' : 'have'} the same steps. ${openUpdatedText(r.openUpdated)}`);
      onDone();
    } catch (e) { toastErr(e?.message || 'Could not copy the steps.'); setBusy(false); }
  }
  const box = (on, label, onClick, key) => (
    <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 8, border: `1px solid ${on ? 'var(--wk-brand)' : 'var(--wk-line2)'}`, cursor: 'pointer', fontSize: 13 }}>
      <input type={direction === 'from' && key?.startsWith('c:') ? 'radio' : 'checkbox'} checked={on} onChange={onClick} /> {label}
    </label>
  );
  return (
    <Modal title={direction === 'from' ? `Copy Steps Into ${nameOf(entityId)}` : `Copy ${nameOf(entityId)}'s Steps To Other Companies`} onClose={onClose}
      footer={<>
        <button onClick={onClose} style={ghostBtn}>Cancel</button>
        <button className="primary-btn" onClick={go} disabled={busy || !to.length || !which.size} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {busy ? <Spinner size={13} /> : <Copy size={13} />} Copy Steps
        </button>
      </>}>
      <div style={{ display: 'grid', gap: 18, fontFamily: FONT }}>
        <div>
          <div style={capLabel}>{direction === 'from' ? 'Copy From' : 'Copy To'}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8, marginTop: 6 }}>
            {direction === 'from' && box(picked.has(''), 'Checklist Library (the standard steps)', () => flip(picked, setPicked, '', true), 'c:')}
            {others.map(e => box(picked.has(e.id), e.name, () => flip(picked, setPicked, e.id, direction === 'from'), `c:${e.id}`))}
          </div>
          {direction === 'to' && others.length > 1 && (
            <button onClick={() => setPicked(new Set(picked.size === others.length ? [] : others.map(e => e.id)))} style={{ ...ghostBtn, marginTop: 8 }}>
              {picked.size === others.length ? 'Clear All' : 'Pick Every Company'}
            </button>
          )}
        </div>
        <div>
          <div style={capLabel}>Which Checklists</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8, marginTop: 6 }}>
            {kinds.map(k => box(which.has(k.value), k.label, () => flip(which, setWhich, k.value, false), `k:${k.value}`))}
          </div>
        </div>
        <p style={{ margin: 0, fontSize: 12.5, color: 'var(--wk-dim)', lineHeight: 1.5 }}>
          Each company gets its own copy, so you can still change one later. Open checklists there update too; steps already done stay as they were.
        </p>
      </div>
    </Modal>
  );
}

// Company Settings > Checklists: where each checklist's ONE task goes (Neil,
// Oct 22: "It should create a task inside [#General - Human Resources] called
// Onboarding - <name>"), per kind or one place for all. Changing it offers to
// move the open checklists' tasks too (Pranshu: "what if I want to change the
// task location for the checklist in future?").
const PLACE_KINDS = ['onboarding', 'promotion', 'offboarding', 'inactive'];
const blankPlace = { projectId: '', sectionId: '' };
function placeDraft(p = {}) {
  return { perKind: PLACE_KINDS.some(k => p[k]?.projectId), default: { ...blankPlace, ...(p.default || {}) },
    ...Object.fromEntries(PLACE_KINDS.map(k => [k, { ...blankPlace, ...(p[k] || {}) }])) };
}
function placeOut(d) {
  const keep = v => (v.projectId ? { projectId: v.projectId, sectionId: v.sectionId || '' } : null);
  const out = d.perKind ? Object.fromEntries(PLACE_KINDS.map(k => [k, keep(d[k])])) : { default: keep(d.default) };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v));
}
function TaskPlaceCard({ entityId, kinds, toastOk, toastErr }) {
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState(null);
  const [move, setMove] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.getChecklistTaskPlace(entityId).then(d => { setData(d); setDraft(placeDraft(d.place)); }).catch(() => setData(false));
  }, [entityId]);
  if (data === null) return <SkeletonBlocks count={1} height={110} />;
  if (data === false) return <div style={{ ...card, padding: 18, marginBottom: 18, fontSize: 13, color: 'var(--wk-dim)' }}>Could not load where checklist tasks go.</div>;
  const projects = data.projects || [];
  const auto = data.auto;
  const pick = k => (draft.perKind ? draft[k] : draft.default);
  const target = k => (pick(k).projectId ? pick(k) : { projectId: auto?.projectId || '', sectionId: '' });
  const dirty = JSON.stringify(placeOut(draft)) !== JSON.stringify(placeOut(placeDraft(data.place)));
  const moving = (data.openTasks || []).filter(t => { const p = target(t.kind); return t.projectId !== p.projectId || t.sectionId !== (p.sectionId || ''); }).length;
  const setPick = (k, v) => setDraft(d => ({ ...d, [k]: { ...d[k], ...v } }));
  async function save() {
    setBusy(true);
    try {
      const d = await api.saveChecklistTaskPlace(entityId, { place: placeOut(draft), move: move && moving > 0 });
      setData(d); setDraft(placeDraft(d.place));
      toastOk(d.moved ? `Saved. ${d.moved} open checklist task${d.moved === 1 ? '' : 's'} moved there.` : 'Saved. New checklist tasks go there.');
    } catch (e) { toastErr(e?.message || 'Could not save.'); }
    setBusy(false);
  }
  const row = (k, label) => {
    const v = pick(k);
    const secs = projects.find(p => p.id === v.projectId)?.sections || [];
    const key = draft.perKind ? k : 'default';
    return (
      <div key={k} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(200px, 100%), 1fr))', gap: 10, alignItems: 'end' }}>
        <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--wk-dim)' }}>
          {label}
          <select aria-label={`Project for ${label}`} value={v.projectId} onChange={e => setPick(key, { projectId: e.target.value, sectionId: '' })} style={inputStyle}>
            <option value="">{auto ? `Automatic (${auto.projectName})` : 'No project'}</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--wk-dim)' }}>
          Section (optional)
          <select aria-label={`Section for ${label}`} value={v.sectionId} disabled={!v.projectId || !secs.length}
            onChange={e => setPick(key, { sectionId: e.target.value })} style={inputStyle}>
            <option value="">No section</option>
            {secs.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
      </div>
    );
  };
  return (
    <section style={{ ...card, padding: 18, marginBottom: 18 }}>
      <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--wk-ink)' }}>Where Checklist Tasks Go</h3>
      <p style={{ margin: '4px 0 12px', fontSize: 13, color: 'var(--wk-dim)', lineHeight: 1.5, maxWidth: '75ch' }}>
        Each checklist gets ONE task (for example Onboarding - Jane Doe) assigned to the head of HR, with a subtask for each step on its owner&apos;s My Tasks - IT steps included. Pick the project it goes in, and a section if you like.
      </p>
      {!auto && !Object.keys(data.place || {}).length && (
        <div role="note" style={{ display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 12.5, color: 'var(--wk-orange)', marginBottom: 12 }}>
          <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 2 }} />
          <span>No HR project found for this company (a project of its HR department, or one named Human Resources), so checklist tasks are in no project until you pick one.</span>
        </div>
      )}
      <div role="radiogroup" aria-label="One place or one per checklist" style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 12, fontSize: 13 }}>
        {[[false, 'One Place For Every Checklist'], [true, 'A Place Per Checklist']].map(([v, l]) => (
          <label key={l} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="radio" name={`place-mode-${entityId}`} checked={draft.perKind === v} onChange={() => setDraft(d => ({ ...d, perKind: v }))} /> {l}
          </label>
        ))}
      </div>
      <div style={{ display: 'grid', gap: 12 }}>
        {draft.perKind ? PLACE_KINDS.map(k => row(k, kinds.find(x => x.value === k)?.label || k)) : row('default', 'Every Checklist')}
      </div>
      {dirty && (
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginTop: 14 }}>
          {moving > 0 && (
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--wk-ink)', cursor: 'pointer' }}>
              <input type="checkbox" checked={move} onChange={e => setMove(e.target.checked)} /> Move The {moving} Open Checklist Task{moving === 1 ? '' : 's'} Too
            </label>
          )}
          <span style={{ flex: 1 }} />
          <button onClick={() => setDraft(placeDraft(data.place))} disabled={busy} style={ghostBtn}>Discard</button>
          <button className="primary-btn" onClick={save} disabled={busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {busy ? <Spinner size={13} /> : <Save size={13} />} Save Place
          </button>
        </div>
      )}
    </section>
  );
}

// Company Settings > Checklists: the steps every hire at this company gets
// first, whatever the role - the Checklist Library's, or the company's own
// copy (made by editing here or by Copy From…). Roles build on top of them.
function BaselineCard({ companyName, entityId, templates, kinds, meta, onCopy, onSaved, toastOk, toastErr }) {
  const [editing, setEditing] = useState('');
  const tpl = (templates || []).find(t => t.kind === editing);
  return (
    <section style={{ ...card, padding: 18, marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <div style={{ flex: '1 1 300px', minWidth: 0 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--wk-ink)' }}>Baseline Steps</h3>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--wk-dim)', lineHeight: 1.5, maxWidth: '75ch' }}>
            Every hire at {companyName} gets these first, whatever the role; each role&apos;s own steps come after them, so a role never needs to repeat them.
          </p>
        </div>
        <button onClick={onCopy} style={ghostBtn}><Copy size={13} /> Copy From…</button>
      </div>
      {templates === null && <SkeletonBlocks count={1} height={60} />}
      {templates === false && <div style={{ fontSize: 13, color: 'var(--wk-dim)' }}>Could not load the steps.</div>}
      {templates && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(210px, 100%), 1fr))', gap: 10 }}>
          {kinds.map(k => {
            const t = templates.find(x => x.kind === k.value);
            const look = KIND_LOOK[k.value] || KIND_LOOK.onboarding;
            return (
              <div key={k.value} style={{ border: '1px solid var(--wk-line2)', borderRadius: 'var(--wk-r)', padding: 12, display: 'grid', gap: 6, alignContent: 'start' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <look.Icon size={14} color="var(--wk-dim)" />
                  <b style={{ fontSize: 13.5, color: 'var(--wk-ink)', flex: 1 }}>{k.label}</b>
                  <span style={{ fontSize: 12.5, color: 'var(--wk-dim)', fontVariantNumeric: 'tabular-nums' }}>{t?.items?.length || 0} steps</span>
                </div>
                <span style={{ fontSize: 12, color: 'var(--wk-dim)' }}>
                  {!t || t.inherited ? 'From the Checklist Library' : `Own copy for ${companyName}${t.updatedAt ? `, updated ${formatDate(t.updatedAt)}` : ''}`}
                </span>
                <button onClick={() => setEditing(k.value)} style={{ ...ghostBtn, justifySelf: 'start' }}><Pencil size={13} /> View And Edit</button>
              </div>
            );
          })}
        </div>
      )}
      {tpl && (
        <Modal title={`${companyName} - Baseline ${kinds.find(k => k.value === editing)?.label || ''} Steps`} onClose={() => setEditing('')}>
          <TemplateEditor key={`${tpl.kind}:${tpl.updatedAt}:${tpl.entityId}`} template={tpl} meta={meta} entityId={entityId} toastOk={toastOk} toastErr={toastErr}
            onSaved={onSaved} />
        </Modal>
      )}
    </section>
  );
}

export function ChecklistSettings({ entityId = '', entities = [], onOpenDepartments, toastOk, toastErr }) {
  const [loaded, setLoaded] = useState({ entityId: null, templates: null });
  const [kind, setKind] = useState('onboarding');
  const [meta, setMeta] = useState(null);
  const [copying, setCopying] = useState('');         // 'from' | 'to'
  const [reloadKey, setReloadKey] = useState(0);
  const { data: dir = [] } = usePeopleDirectory();
  const people = useMemo(() => dir.map(p => ({ email: (p.email || '').toLowerCase(), name: p.name || p.email })), [dir]);
  useEffect(() => { api.getChecklistMeta().then(setMeta).catch(() => setMeta(null)); }, []);
  useEffect(() => {
    api.getChecklistTemplates(entityId)
      .then(r => setLoaded({ entityId, templates: r.templates || [] }))
      .catch(() => setLoaded({ entityId, templates: false }));
  }, [entityId, reloadKey]);
  const templates = loaded.entityId === entityId ? loaded.templates : null;
  const setTemplates = fn => setLoaded(l => ({ ...l, templates: fn(l.templates || []) }));
  const tpl = (templates || []).find(t => t.kind === kind);
  const kinds = meta?.kinds || [{ value: 'onboarding', label: 'Onboarding' }, { value: 'promotion', label: 'Promotion' }, { value: 'offboarding', label: 'Offboarding' }, { value: 'inactive', label: 'Leave or Suspension' }];
  const companyName = entityId ? (entities.find(e => e.id === entityId)?.name || 'This company') : '';
  return (
    <div style={{ fontFamily: FONT }}>
      {/* What these settings apply to, stated once at the top. */}
      <section style={{ ...card, padding: '14px 18px', marginBottom: 18, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <span className="dk-chip dk-chip--brand"><ListChecks /></span>
        <div style={{ flex: '1 1 260px', minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--wk-ink)' }}>{entityId ? `Checklists For ${companyName}` : 'Checklist Library'}</div>
          <div style={{ fontSize: 12.5, color: 'var(--wk-dim)', lineHeight: 1.5 }}>
            {entityId
              ? 'Each role builds its own onboarding, promotion, offboarding and leave steps (Roles tab > a role > Checklists). Below: the baseline steps every hire gets first, whatever the role, then which roles are built and what is still missing.'
              : 'The standard steps every new checklist starts with, whatever the role. Each role\'s own steps are built on the role (Company Settings > Roles > a role > Checklists).'}
          </div>
        </div>
        {!entityId && entities.length > 0 && (
          <button onClick={() => setCopying('to')} style={ghostBtn}><Copy size={13} /> Copy To Companies…</button>
        )}
      </section>

      {entityId
        ? <DepartmentOwnersCard key={entityId} entityId={entityId} people={people} onOpenDepartments={onOpenDepartments} toastOk={toastOk} toastErr={toastErr} />
        : <LibraryOwnersNote />}

      {entityId && <TaskPlaceCard key={`place:${entityId}`} entityId={entityId} kinds={kinds} toastOk={toastOk} toastErr={toastErr} />}

      {entityId && (
        <BaselineCard companyName={companyName} entityId={entityId} templates={templates} kinds={kinds} meta={meta}
          onCopy={() => setCopying('from')} toastOk={toastOk} toastErr={toastErr}
          onSaved={saved => setTemplates(prev => prev.map(t => t.kind === saved.kind ? saved : t))} />
      )}

      {/* A company's own steps are its roles' (Pranshu, Oct 20: "we are
          already adding phase and steps according to role ... just see an
          audit here"). The library keeps the steps every hire gets. */}
      {entityId ? <RoleAudit entityId={entityId} companyName={companyName} kinds={kinds} toastOk={toastOk} toastErr={toastErr} /> : (
      <section style={{ ...card, padding: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
          <div style={{ flex: '1 1 240px' }}>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--wk-ink)' }}>Steps Every Hire Gets</h3>
            <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--wk-dim)' }}>Added to every checklist, before the role&apos;s own steps.</p>
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
        {templates === false && <div style={{ fontSize: 13, color: 'var(--wk-dim)' }}>Could not load the steps.</div>}
        {tpl && (
          <TemplateEditor key={`${tpl.kind}:${entityId}:${tpl.updatedAt}:${tpl.entityId}`} template={tpl} meta={meta} entityId={entityId} toastOk={toastOk} toastErr={toastErr}
            onSaved={saved => setTemplates(prev => prev.map(t => t.kind === saved.kind ? saved : t))} />
        )}
      </section>
      )}
      {copying && (
        <CopyStepsModal direction={copying} entityId={entityId} entities={entities} kinds={kinds} kind={kind}
          onClose={() => setCopying('')} onDone={() => { setCopying(''); setReloadKey(k => k + 1); }} toastOk={toastOk} toastErr={toastErr} />
      )}
    </div>
  );
}

// Company Settings > Checklists: is every role's checklist built? One row per
// role the company offers (its own and the shared ones), a cell per checklist
// - its steps, or Missing - and Build opens that role's steps right here.
function RoleAudit({ entityId, companyName, kinds, toastOk, toastErr }) {
  const [roles, setRoles] = useState(null);
  const [gapsOnly, setGapsOnly] = useState(false);
  const [building, setBuilding] = useState(null);      // { role, kind }
  useEffect(() => {
    api.getRoleChecklistRoles()
      .then(r => setRoles((r.roles || []).filter(x => !x.companyId || x.companyId === entityId)))
      .catch(() => setRoles(false));
  }, [entityId]);
  if (roles === null) return <SkeletonBlocks count={3} height={48} />;
  if (roles === false) return <div style={{ ...card, padding: 18, fontSize: 13, color: 'var(--wk-dim)' }}>Could not load the roles.</div>;
  const missing = r => kinds.filter(k => !(r.counts?.[k.value] > 0));
  const done = roles.filter(r => !missing(r).length).length;
  const shown = (gapsOnly ? roles.filter(r => missing(r).length) : roles)
    .slice().sort((a, b) => missing(b).length - missing(a).length || a.roleName.localeCompare(b.roleName));
  const setCounts = (roleId, counts) => setRoles(rs => rs.map(r => (r.roleId === roleId ? { ...r, counts } : r)));
  const cell = { padding: '10px 12px', borderBottom: '1px solid var(--wk-line2)', fontSize: 13, verticalAlign: 'middle' };
  return (
    <section style={{ ...card, padding: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <div style={{ flex: '1 1 260px' }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--wk-ink)' }}>Role Checklists</h3>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--wk-dim)' }}>
            {roles.length
              ? <><b style={{ color: done === roles.length ? 'var(--wk-green)' : 'var(--wk-ink)' }}>{done} of {roles.length}</b> roles at {companyName} have all four checklists built.</>
              : `${companyName} has no roles yet - add them on the Roles tab.`}
          </p>
        </div>
        {roles.length > 0 && done < roles.length && (
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--wk-ink)', cursor: 'pointer' }}>
            <input type="checkbox" checked={gapsOnly} onChange={e => setGapsOnly(e.target.checked)} /> Only Roles With Something Missing
          </label>
        )}
      </div>
      {roles.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT }}>
            <thead>
              <tr>
                {['Role', ...kinds.map(k => k.label), ''].map((h, i) => (
                  <th key={i} style={{ ...cell, textAlign: 'left', fontSize: 11.5, fontWeight: 700, color: 'var(--wk-dim)', textTransform: 'uppercase', letterSpacing: '.04em' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map(r => {
                const gaps = missing(r);
                return (
                  <tr key={r.roleId}>
                    <td style={cell}>
                      <div style={{ fontWeight: 700, color: 'var(--wk-ink)' }}>{r.roleName}</div>
                      <div style={{ fontSize: 12, color: 'var(--wk-dim)' }}>{[r.department, r.companyId ? '' : 'Shared role'].filter(Boolean).join(' · ')}</div>
                    </td>
                    {kinds.map(k => {
                      const n = r.counts?.[k.value] || 0;
                      return (
                        <td key={k.value} style={cell}>
                          {n > 0
                            ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--wk-green)', fontWeight: 600 }}><CheckCircle2 size={14} /> {n} {n === 1 ? 'step' : 'steps'}</span>
                            : <button onClick={() => setBuilding({ role: r, kind: k.value })} title={`Build the ${k.label.toLowerCase()} steps for ${r.roleName}`}
                                style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--wk-orange)', fontWeight: 600, fontFamily: FONT, fontSize: 13 }}>
                                <AlertTriangle size={14} /> Missing
                              </button>}
                        </td>
                      );
                    })}
                    <td style={{ ...cell, textAlign: 'right' }}>
                      <button className={gaps.length ? 'primary-btn' : undefined} style={gaps.length ? { fontSize: 12.5 } : ghostBtn}
                        onClick={() => setBuilding({ role: r, kind: gaps[0]?.value || 'onboarding' })}>
                        {gaps.length ? 'Build' : 'Open'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {building && (
        <Modal title={`${building.role.roleName} - Checklist Steps`} onClose={() => setBuilding(null)} minHeight="60vh">
          <RoleStepsEditor roleId={building.role.roleId} roleName={building.role.roleName} initialKind={building.kind}
            toastOk={toastOk} toastErr={toastErr} onCounts={c => setCounts(building.role.roleId, c)} />
        </Modal>
      )}
    </section>
  );
}

// Global Settings > Hiring > Checklist Library: the standard steps.
export function ChecklistLibrary({ toastOk, toastErr }) {
  const { data: entities = [] } = useEntities();
  return <ChecklistSettings entityId="" entities={entities} toastOk={toastOk} toastErr={toastErr} />;
}

// --- Team > Role Checklists (Neil, Oct 19) ----------------------------------
// "It really has to be a role-based thing and then we'll give it to a
// department head to build out ... so the department head can build it, edit
// it, and manage it." A role's steps are added after the company's whenever
// one of its people starts a checklist.
const countsOf = d => Object.fromEntries((d?.templates || []).map(t => [t.kind, (t.items || []).length]));

// One role's extra steps: the kind tabs and the editor. Used by Team > Role
// Checklists and by Company Settings > Roles (a role's Checklists tab, and
// the Checklists button on shared roles). `onCounts` gets {kind: steps} after
// the load and after every save so a parent can refresh its counts.
// The baseline a role builds on (Neil, Oct 22: "this is a baseline and we
// build off of the baseline"): read-only and folded, so a role adds only what
// it needs on top. `baseline` = { source: 'company' | 'library', items }.
function BaselineBlock({ baseline, companyName, roleItems = [], kindLabel = '' }) {
  const [open, setOpen] = useState(false);
  const items = baseline?.items || [];
  if (!items.length) return null;
  const where = baseline.source === 'company'
    ? `Company Settings > ${companyName} > Checklists > Baseline Steps`
    : 'Global Settings > Hiring > Checklist Library';
  const who = companyName ? `every hire at ${companyName}` : 'every hire';
  const titles = new Set(items.map(r => (r.title || '').trim().toLowerCase()));
  const repeats = roleItems.filter(r => titles.has((r.title || '').trim().toLowerCase()));
  const phases = [];
  items.forEach(r => {
    let g = phases.find(p => p.name === (r.phase || 'Steps'));
    if (!g) { g = { name: r.phase || 'Steps', rows: [] }; phases.push(g); }
    g.rows.push(r);
  });
  return (
    <section aria-label="Baseline steps" style={{ border: '1px dashed var(--wk-line)', borderRadius: 'var(--wk-r)', background: 'var(--wk-hover)', marginBottom: 14 }}>
      <button onClick={() => setOpen(o => !o)} aria-expanded={open}
        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', fontFamily: FONT, fontSize: 13, color: 'var(--wk-ink)' }}>
        {open ? <ChevronDown size={15} color="var(--wk-faint)" /> : <ChevronRight size={15} color="var(--wk-faint)" />}
        <span style={{ flex: 1, minWidth: 0 }}><b>Baseline</b> - {who} gets these {items.length} {kindLabel.toLowerCase()} steps first</span>
      </button>
      {repeats.length > 0 && (
        <div role="note" style={{ display: 'flex', gap: 6, alignItems: 'flex-start', padding: '0 12px 10px 35px', fontSize: 12, color: 'var(--wk-orange)' }}>
          <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>This role repeats {repeats.length === 1 ? 'a baseline step' : `${repeats.length} baseline steps`} ({repeats.map(r => r.title).join(', ')}) - the person would get {repeats.length === 1 ? 'it' : 'them'} twice.</span>
        </div>
      )}
      {open && (
        <div style={{ padding: '0 12px 12px 35px', display: 'grid', gap: 10 }}>
          <p style={{ margin: 0, fontSize: 12.5, color: 'var(--wk-dim)', lineHeight: 1.5 }}>
            Read-only here. They are edited in {where}. Add below only what this role needs on top of them.
          </p>
          {phases.map(p => (
            <div key={p.name}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--wk-dim)' }}>{p.name}</div>
              <ul style={{ margin: '4px 0 0', paddingLeft: 18, display: 'grid', gap: 2 }}>
                {p.rows.map(r => (
                  <li key={r.key || r.title} style={{ fontSize: 12.5, color: 'var(--wk-ink)' }}>
                    {r.title} <span style={{ color: 'var(--wk-faint)' }}>· {ROLE_LOOK[r.owner]?.label || (r.owner === 'manager' ? 'Manager' : r.owner === 'employee' ? 'Employee' : r.owner)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// Copy another role's steps into this one while building it (Neil, Oct 22:
// "we have 25 to 30 roles... there needs to be a copy from option").
function CopyRoleStepsModal({ roleId, roleName, kind, kinds, onClose, onDone, toastOk, toastErr }) {
  const [roles, setRoles] = useState(null);
  const [from, setFrom] = useState('');
  const [q, setQ] = useState('');
  const [which, setWhich] = useState(() => new Set([kind]));
  const [mode, setMode] = useState('append');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.getRoleChecklistRoles().then(r => setRoles((r.roles || []).filter(x => x.roleId !== roleId))).catch(() => setRoles(false));
  }, [roleId]);
  const src = (roles || []).find(r => r.roleId === from);
  const shown = (roles || []).filter(r => !q.trim() || `${r.roleName} ${r.department} ${r.companyName}`.toLowerCase().includes(q.trim().toLowerCase()));
  const kindName = k => kinds.find(x => x.value === k)?.label || k;
  async function go() {
    if (busy || !src || !which.size) return;
    if (mode === 'replace' && !await dialog.confirm(
      `Replace ${roleName}'s ${[...which].map(kindName).join(', ')} steps with ${src.roleName}'s?`,
      { title: 'Replace Steps', confirmText: 'Replace', danger: true })) return;
    setBusy(true);
    try {
      const r = await api.copyRoleChecklist(roleId, { from_role_id: from, kinds: [...which], mode });
      toastOk(r.copied ? `Copied ${r.copied} step${r.copied === 1 ? '' : 's'} from ${src.roleName}. ${openUpdatedText(r.openUpdated)}` : `Nothing new to copy - ${roleName} already has those steps.`);
      onDone(r);
    } catch (e) { toastErr(e?.message || 'Could not copy the steps.'); setBusy(false); }
  }
  const radio = (on, onClick, children, key) => (
    <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 8, border: `1px solid ${on ? 'var(--wk-brand)' : 'var(--wk-line2)'}`, background: on ? 'var(--wk-brand-tint)' : 'transparent', cursor: 'pointer', fontSize: 13 }}>
      {children[0]} <span style={{ flex: 1, minWidth: 0 }}>{children[1]}</span>
    </label>
  );
  return (
    <Modal title={`Copy Steps Into ${roleName}`} onClose={onClose}
      footer={<>
        <button onClick={onClose} style={ghostBtn}>Cancel</button>
        <button className="primary-btn" onClick={go} disabled={busy || !src || !which.size} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {busy ? <Spinner size={13} /> : <Copy size={13} />} Copy Steps
        </button>
      </>}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
        <span style={{ ...capLabel, flex: 1 }}>Copy From</span>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search roles" aria-label="Search roles" style={{ ...inputStyle, minWidth: 0, flex: '0 1 240px' }} />
      </div>
      <div className="nx-fill" role="radiogroup" aria-label="Role to copy from" style={{ overflowY: 'auto', display: 'grid', alignContent: 'start', gap: 6, minHeight: 160, marginBottom: 16 }}>
        {roles === null && <SkeletonBlocks count={3} height={36} />}
        {roles === false && <div style={{ fontSize: 13, color: 'var(--wk-dim)' }}>Could not load the roles.</div>}
        {roles && !shown.length && <div style={{ fontSize: 13, color: 'var(--wk-dim)' }}>No other role to copy from.</div>}
        {shown.map(r => {
          const n = Object.values(r.counts || {}).reduce((a, b) => a + b, 0);
          return radio(from === r.roleId, () => setFrom(r.roleId), [
            <input key="i" type="radio" name="copy-role" checked={from === r.roleId} onChange={() => setFrom(r.roleId)} />,
            <span key="t" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
              <b style={{ fontWeight: 600 }}>{r.roleName}</b>
              <span style={{ fontSize: 12, color: 'var(--wk-dim)' }}>{[r.companyName || 'Shared role', r.department].filter(Boolean).join(' · ')}</span>
              <span style={{ fontSize: 12, color: n ? 'var(--wk-green)' : 'var(--wk-faint)', marginLeft: 'auto' }}>{n ? `${n} step${n === 1 ? '' : 's'}` : 'No steps'}</span>
            </span>], r.roleId);
        })}
      </div>
      <div style={{ display: 'grid', gap: 14, flexShrink: 0 }}>
        <div>
          <div style={capLabel}>Which Checklists</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
            {kinds.map(k => (
              <label key={k.value} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, padding: '6px 10px', borderRadius: 8, border: `1px solid ${which.has(k.value) ? 'var(--wk-brand)' : 'var(--wk-line2)'}`, cursor: 'pointer' }}>
                <input type="checkbox" checked={which.has(k.value)} onChange={() => setWhich(s => { const n = new Set(s); if (n.has(k.value)) n.delete(k.value); else n.add(k.value); return n; })} />
                {k.label}{src ? ` (${src.counts?.[k.value] || 0})` : ''}
              </label>
            ))}
          </div>
        </div>
        <div role="radiogroup" aria-label="How to copy" style={{ display: 'grid', gap: 6 }}>
          {radio(mode === 'append', () => setMode('append'), [<input key="i" type="radio" name="copy-mode" checked={mode === 'append'} onChange={() => setMode('append')} />,
            <span key="t">Add To {roleName}&apos;s Steps <span style={{ color: 'var(--wk-dim)' }}>- a step with the same title is skipped</span></span>], 'append')}
          {radio(mode === 'replace', () => setMode('replace'), [<input key="i" type="radio" name="copy-mode" checked={mode === 'replace'} onChange={() => setMode('replace')} />,
            <span key="t">Replace {roleName}&apos;s Steps <span style={{ color: 'var(--wk-dim)' }}>- the picked checklists become a copy of the other role&apos;s</span></span>], 'replace')}
        </div>
      </div>
    </Modal>
  );
}

export function RoleStepsEditor({ roleId, roleName, toastOk, toastErr, onCounts, heading = null, initialKind = 'onboarding' }) {
  const [data, setData] = useState(null);
  const [kind, setKind] = useState(initialKind);
  const [meta, setMeta] = useState(null);
  const [copying, setCopying] = useState(false);
  useEffect(() => { api.getChecklistMeta().then(setMeta).catch(() => setMeta(null)); }, []);
  useEffect(() => {
    if (!roleId) { setData(null); return undefined; }
    let live = true;
    setData(null);
    api.getRoleChecklist(roleId)
      .then(d => { if (!live) return; setData(d); onCounts?.(countsOf(d)); })
      .catch(() => { if (live) setData(false); });
    return () => { live = false; };
  }, [roleId]);   // eslint-disable-line react-hooks/exhaustive-deps
  const kinds = meta?.kinds || [{ value: 'onboarding', label: 'Onboarding' }, { value: 'promotion', label: 'Promotion' }, { value: 'offboarding', label: 'Offboarding' }, { value: 'inactive', label: 'Leave or Suspension' }];
  const counts = countsOf(data);
  const tpl = data?.templates?.find(t => t.kind === kind);
  const saveItems = async items => {
    const saved = await api.saveRoleChecklist(roleId, kind, items);
    const next = { ...data, templates: data.templates.map(t => (t.kind === kind ? saved : t)) };
    setData(next);
    onCounts?.(countsOf(next));
    return saved;
  };
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        {heading}
        <div className="scroll-tabs" role="tablist" aria-label="Checklist kind"
          style={{ display: 'inline-flex', gap: 2, padding: 3, borderRadius: 8, background: 'var(--wk-hover)', maxWidth: '100%' }}>
          {kinds.map(k => {
            const look = KIND_LOOK[k.value] || KIND_LOOK.onboarding;
            const on = kind === k.value;
            const n = counts[k.value] || 0;
            return (
              <button key={k.value} role="tab" aria-selected={on} onClick={() => setKind(k.value)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 6, border: 'none', cursor: 'pointer', whiteSpace: 'nowrap', fontFamily: FONT, fontSize: 13, fontWeight: 600,
                  background: on ? 'var(--wk-card)' : 'transparent', color: on ? 'var(--wk-ink)' : 'var(--wk-dim)', boxShadow: on ? '0 1px 3px rgba(29,33,57,.12)' : 'none' }}>
                <look.Icon size={14} /> {k.label}
                {n > 0 && <span style={{ fontSize: 11.5, color: 'var(--wk-faint)', fontVariantNumeric: 'tabular-nums' }}>{n}</span>}
              </button>
            );
          })}
        </div>
        {data && <button onClick={() => setCopying(true)} style={ghostBtn}><Copy size={13} /> Copy From…</button>}
      </div>
      {data === null && <SkeletonBlocks count={2} height={56} />}
      {data === false && <div style={{ fontSize: 13, color: 'var(--wk-dim)' }}>Could not load this role&apos;s steps.</div>}
      {tpl && <BaselineBlock key={kind} baseline={tpl.baseline} companyName={data.companyName} roleItems={tpl.items} kindLabel={tpl.kindLabel || ''} />}
      {copying && (
        <CopyRoleStepsModal roleId={roleId} roleName={roleName || data?.roleName || 'This Role'} kind={kind} kinds={kinds}
          onClose={() => setCopying(false)} toastOk={toastOk} toastErr={toastErr}
          onDone={d => { setCopying(false); setData(d); onCounts?.(countsOf(d)); }} />
      )}
      {tpl && (
        <TemplateEditor key={`${roleId}:${kind}:${tpl.updatedAt}`} template={tpl} meta={meta} entityId="" toastOk={toastOk} toastErr={toastErr}
          onSaved={() => {}} saveItems={saveItems} resetLabel="Remove All Steps"
          emptyText={`${roleName || 'This role'} has no ${(kinds.find(k => k.value === kind)?.label || 'checklist').toLowerCase()} steps yet. Until you add some, people in this role get only the standard steps from the Checklist Library.`}
          resetItems={async () => {
            if (!await dialog.confirm(`Remove every ${kinds.find(k => k.value === kind)?.label.toLowerCase()} step of ${roleName}?`, { title: 'Remove All Steps', confirmText: 'Remove', danger: true })) return;
            try { const res = await saveItems([]); toastOk(`Steps removed. ${openUpdatedText(res?.openUpdated)}`); } catch (e) { toastErr(e?.message || 'Could not remove them.'); }
          }} />
      )}
    </>
  );
}

export function RoleChecklists({ toastOk, toastErr }) {
  const [roles, setRoles] = useState(null);
  const [roleId, setRoleId] = useState('');
  const loadRoles = useCallback(() => api.getRoleChecklistRoles()
    .then(r => { setRoles(r.roles || []); setRoleId(id => id || r.roles?.[0]?.roleId || ''); })
    .catch(() => setRoles(false)), []);
  useEffect(() => { loadRoles(); }, [loadRoles]);
  if (roles === null) return <SkeletonBlocks count={3} height={56} />;
  if (roles === false) return <div style={{ ...card, padding: 18, fontSize: 13, color: 'var(--wk-dim)' }}>Could not load your roles.</div>;
  if (!roles.length) {
    return (
      <div style={{ ...card, padding: 24, fontSize: 13.5, color: 'var(--wk-dim)', lineHeight: 1.6, fontFamily: FONT }}>
        <b style={{ color: 'var(--wk-ink)' }}>No roles to look after yet.</b> The head of a department keeps the extra checklist steps for its
        roles - set department heads in Company Settings &gt; Departments.
      </div>
    );
  }
  const role = roles.find(r => r.roleId === roleId);
  const groups = [];
  roles.forEach(r => {
    const label = `${r.companyName || 'Shared Roles'}${r.department ? ` - ${r.department}` : ''}`;
    let g = groups.find(x => x.label === label);
    if (!g) { g = { label, roles: [] }; groups.push(g); }
    g.roles.push(r);
  });
  const onCounts = c => setRoles(rs => rs.map(r => (r.roleId === roleId ? { ...r, counts: { ...r.counts, ...c } } : r)));
  return (
    <div style={{ fontFamily: FONT }}>
      <section style={{ ...card, padding: '14px 18px', marginBottom: 18, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <span className="dk-chip dk-chip--brand"><ListChecks /></span>
        <div style={{ flex: '1 1 260px', minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--wk-ink)' }}>Role Checklists</div>
          <div style={{ fontSize: 12.5, color: 'var(--wk-dim)', lineHeight: 1.5 }}>
            The extra steps one role needs - its training, its tools. They are added after the company&apos;s steps whenever someone in the role is onboarded, promoted into it, leaves or goes on leave.
          </div>
        </div>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={capLabel}>Role</span>
          <select value={roleId} onChange={e => setRoleId(e.target.value)} style={{ ...inputStyle, minWidth: 260 }}>
            {groups.map(g => (
              <optgroup key={g.label} label={g.label}>
                {g.roles.map(r => {
                  const n = Object.values(r.counts || {}).reduce((a, b) => a + b, 0);
                  return <option key={r.roleId} value={r.roleId}>{r.roleName}{n ? ` (${n} steps)` : ''}</option>;
                })}
              </optgroup>
            ))}
          </select>
        </label>
      </section>
      <section style={{ ...card, padding: 18 }}>
        <RoleStepsEditor roleId={roleId} roleName={role?.roleName} toastOk={toastOk} toastErr={toastErr} onCounts={onCounts}
          heading={(
            <div style={{ flex: '1 1 240px' }}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--wk-ink)' }}>{role?.roleName || 'Role'} Steps</h3>
              <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--wk-dim)' }}>{[role?.department, role?.companyName || 'Shared role'].filter(Boolean).join(' · ')}</p>
            </div>
          )} />
      </section>
    </div>
  );
}
