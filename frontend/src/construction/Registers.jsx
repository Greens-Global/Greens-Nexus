// Construction - milestones, RFIs and submittals for one jobsite.
//
// One component for three registers rather than three files. They differ in
// their fields and their status vocabulary and in nothing else: same
// permissions (manager writes, project members read), same soft delete, same
// row shape, and the API already serves them through one set of endpoints. The
// per-kind differences live in REGISTERS below, so adding a fourth register is
// a config entry rather than another 200 lines.
//
// These three are what the weekly report's Critical Milestones, RFIs and
// Submittals sections print. Until now nothing could populate them, so those
// sections came out empty on every report.
//
// 11/03/2026 (Neil, plan item 14): soft status labels; a row opens as a sheet
// with its fields editable (an RFI's answer, responder and due date, a
// submittal's dates and revision) and one Save row; days open and a red
// Overdue label from the row's own dates against the jobsite's today; dates
// are DateField boxes, never the browser's; Remove is pressed and held
// (ui/HoldButton.jsx, HOLD_RECORD_MS) and is a soft delete server-side; the
// AI's milestone suggestion shows only while AI is on.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Flag, HelpCircle, FileCheck, Plus, Sparkles, AlertTriangle, ChevronRight } from 'lucide-react';
import { api } from '../api';
import { ErrorBanner, SkeletonBlocks } from '../components/AsyncState';
import { StatusLabel } from '../components/StatusLabel';
import { SettingRow, SettingCard, Switch } from '../components/settings/SettingsUI';
import SaveRow from '../components/SaveRow';
import HoldButton, { HOLD_RECORD_MS } from '../ui/HoldButton';
import { Modal, DateField } from '../tasks/components';
import { useDraft } from '../lib/useDraft';
import { formatDate } from '../lib/datetime';
import { CARD, TONE, personName } from './ui';
import { useConstructionMeta } from './lib/meta';
import { isOverdue, daysOpen, browserTodayISO } from './lib/registers';

// What a status MEANS to a manager scanning the list, the same palette across
// all three: red is "someone is blocked or a date was missed", yellow is "at
// risk", green is "closed out", slate is "not started / open", blue is "out
// with someone". Never orange - that is in progress only (style.css).
const REGISTERS = {
  milestones: {
    label: 'Milestones',
    icon: Flag,
    blurb: 'Schedule milestones for this jobsite. They print in the weekly report under Critical Milestones.',
    blurbAi: 'Schedule milestones for this jobsite. AI can suggest one looks hit; only you can confirm it.',
    emptyTitle: 'No milestones yet',
    emptyHint: 'Add the dates this job is measured against. They print in the weekly report under Critical Milestones.',
    addLabel: 'Add Milestone',
    noun: 'Milestone',
    statuses: {
      upcoming: ['Upcoming', TONE.slate],
      at_risk:  ['At Risk', TONE.yellow],
      hit:      ['Hit', TONE.green],
      missed:   ['Missed', TONE.red],
    },
    // `key` is the request field (snake_case, matching _REGISTER_FIELDS on the
    // server); `read` pulls the same value back off the camelCase response.
    fields: [
      { key: 'name', read: 'name', label: 'Milestone', placeholder: 'e.g. Foundation pour complete', required: true },
      { key: 'target_date', read: 'targetDate', label: 'Target Date', type: 'date' },
      { key: 'actual_date', read: 'actualDate', label: 'Actual Date', type: 'date' },
      { key: 'critical', read: 'critical', label: 'Critical Path', type: 'switch', sheetOnly: true },
      { key: 'description', read: 'description', label: 'Notes', placeholder: 'Optional', multiline: true },
    ],
    title: (r) => r.name,
    meta: (r, names) => [
      r.targetDate && `Target ${formatDate(r.targetDate, r.targetDate)}`,
      r.actualDate && `Actual ${formatDate(r.actualDate, r.actualDate)}`,
      r.critical && 'Critical Path',
      r.confirmedBy && `Confirmed by ${personName(r.confirmedBy, names)}`,
    ],
  },
  rfis: {
    label: 'RFIs',
    icon: HelpCircle,
    blurb: 'Requests for information. The report prints open ones by age, because an unanswered RFI is what a delay claim is built on.',
    emptyTitle: 'No RFIs yet',
    emptyHint: 'Log a request for information so the week it stayed open is on the record.',
    addLabel: 'Add RFI',
    noun: 'RFI',
    statuses: {
      open:     ['Open', TONE.slate],
      answered: ['Answered', TONE.blue],
      closed:   ['Closed', TONE.green],
      void:     ['Void', TONE.gray],
    },
    fields: [
      { key: 'number', read: 'number', label: 'Number', placeholder: 'RFI-014' },
      { key: 'subject', read: 'subject', label: 'Subject', placeholder: 'What is being asked about', required: true },
      { key: 'question', read: 'question', label: 'Question', placeholder: 'The question as submitted', multiline: true },
      { key: 'ball_in_court', read: 'ballInCourt', label: 'Responder', placeholder: 'Who owes the answer (Ball In Court)' },
      { key: 'submitted_on', read: 'submittedOn', label: 'Sent On', type: 'date' },
      { key: 'due_on', read: 'dueOn', label: 'Response Due', type: 'date' },
      { key: 'answer', read: 'answer', label: 'Answer', placeholder: 'Fill in when it comes back', multiline: true },
      { key: 'answered_on', read: 'answeredOn', label: 'Answered On', type: 'date', sheetOnly: true },
      { key: 'schedule_impact_days', read: 'scheduleImpactDays', label: 'Schedule Impact (Days)', type: 'number', sheetOnly: true },
    ],
    title: (r) => [r.number, r.subject].filter(Boolean).join(' · ') || 'Untitled RFI',
    meta: (r) => [
      r.ballInCourt && `Ball in court: ${r.ballInCourt}`,
      r.dueOn && `Due ${formatDate(r.dueOn, r.dueOn)}`,
      r.answeredOn && `Answered ${formatDate(r.answeredOn, r.answeredOn)}`,
      r.scheduleImpactDays ? `${r.scheduleImpactDays} day schedule impact` : '',
    ],
  },
  submittals: {
    label: 'Submittals',
    icon: FileCheck,
    blurb: 'Submittal register. Same shape as an RFI but a different lifecycle: approval with revisions rather than a question and an answer.',
    emptyTitle: 'No submittals yet',
    emptyHint: 'Track what has gone out for approval and what came back marked up.',
    addLabel: 'Add Submittal',
    noun: 'Submittal',
    statuses: {
      pending:           ['Pending', TONE.slate],
      submitted:         ['Submitted', TONE.blue],
      approved:          ['Approved', TONE.green],
      approved_as_noted: ['Approved As Noted', TONE.green],
      revise_resubmit:   ['Revise And Resubmit', TONE.yellow],
      rejected:          ['Rejected', TONE.red],
    },
    fields: [
      { key: 'number', read: 'number', label: 'Number', placeholder: 'SUB-007' },
      { key: 'title', read: 'title', label: 'Title', placeholder: 'What was submitted', required: true },
      { key: 'spec_section', read: 'specSection', label: 'Spec Section', placeholder: 'e.g. 03 30 00' },
      { key: 'submitted_on', read: 'submittedOn', label: 'Sent On', type: 'date' },
      { key: 'due_on', read: 'dueOn', label: 'Response Due', type: 'date' },
      { key: 'returned_on', read: 'returnedOn', label: 'Returned On', type: 'date', sheetOnly: true },
      { key: 'revision', read: 'revision', label: 'Revision', type: 'number', sheetOnly: true },
    ],
    title: (r) => [r.number, r.title].filter(Boolean).join(' · ') || 'Untitled submittal',
    meta: (r) => [
      r.specSection && `Spec ${r.specSection}`,
      r.dueOn && `Due ${formatDate(r.dueOn, r.dueOn)}`,
      r.returnedOn && `Returned ${formatDate(r.returnedOn, r.returnedOn)}`,
      r.revision ? `Revision ${r.revision}` : '',
    ],
  },
};

const KINDS = Object.keys(REGISTERS);

function Chip({ cfg, status }) {
  const [label, color] = cfg.statuses[status] || cfg.statuses[Object.keys(cfg.statuses)[0]];
  return <StatusLabel size="sm" label={label} color={color} />;
}

// One field's control: a DateField for a date (never the browser's own box -
// it follows the computer's region), a switch, a number, a text area or box.
function FieldControl({ f, value, onChange, disabled, autoFocus }) {
  if (f.type === 'date') {
    return <DateField value={value || ''} onChange={(v) => onChange(v || '')} placeholder="Pick a Date" title={f.label} disabled={disabled} />;
  }
  if (f.type === 'switch') {
    return <Switch checked={!!value} onChange={onChange} disabled={disabled} label={f.label} />;
  }
  if (f.multiline) {
    return (
      <textarea className="form-input" rows={3} value={value || ''} placeholder={f.placeholder || ''} disabled={disabled}
        aria-label={f.label} onChange={(e) => onChange(e.target.value)} style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit' }} />
    );
  }
  return (
    <input className="form-input" type={f.type === 'number' ? 'number' : 'text'} min={f.type === 'number' ? 0 : undefined}
      autoFocus={autoFocus} value={value ?? ''} placeholder={f.placeholder || ''} disabled={disabled} aria-label={f.label}
      onChange={(e) => onChange(f.type === 'number' ? e.target.value : e.target.value)} />
  );
}

// ── Add form ────────────────────────────────────────────────────────────────
function AddForm({ cfg, onCancel, onSave }) {
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const required = cfg.fields.filter((f) => f.required);
  const ready = required.every((f) => String(form[f.key] || '').trim());

  const submit = async (e) => {
    e.preventDefault();
    if (!ready || saving) return;
    setSaving(true); setError('');
    try {
      await onSave(form);
    } catch (err) {
      setSaving(false);
      setError(err.message || 'Could not save that.');
    }
  };

  return (
    <form onSubmit={submit} style={{
      border: '1px solid var(--border-color)', borderRadius: 8, padding: 16,
      marginBottom: 16, backgroundColor: 'var(--bg-primary)',
    }}>
      {error && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, fontSize: '0.8rem' }}>
          <AlertTriangle size={14} style={{ color: 'hsl(var(--color-red))' }} />
          <span>{error}</span>
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
        {cfg.fields.filter((f) => !f.sheetOnly).map((f, i) => (
          <div key={f.key} style={f.multiline ? { gridColumn: '1 / -1' } : undefined}>
            <label className="form-label">{f.label}</label>
            <FieldControl f={f} value={form[f.key]} autoFocus={i === 0}
              onChange={(v) => setForm((prev) => ({ ...prev, [f.key]: v }))} />
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
        <button type="button" className="secondary-btn" onClick={onCancel}>Cancel</button>
        <button type="submit" className="primary-btn" disabled={!ready || saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}

// ── One row, opened: a sheet from the right ─────────────────────────────────
function RegisterSheet({ kind, row, canReview, today, onClose, onSaved, onRemoved }) {
  const cfg = REGISTERS[kind];
  const saved = useMemo(() => {
    const out = { status: row.status || Object.keys(cfg.statuses)[0] };
    for (const f of cfg.fields) out[f.key] = row[f.read] ?? (f.type === 'switch' ? false : '');
    return out;
  }, [row, cfg]);
  const { draft, patch, dirty, reset } = useDraft(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const missing = cfg.fields.some((f) => f.required && !String(draft[f.key] || '').trim());
  const open = daysOpen(kind, row, today);
  const late = isOverdue(kind, row, today);

  const save = async () => {
    if (!dirty || busy || missing) return;
    setBusy(true); setError('');
    const body = {};
    for (const [k, v] of Object.entries(draft)) {
      if (JSON.stringify(v) === JSON.stringify(saved[k])) continue;
      const f = cfg.fields.find((x) => x.key === k);
      body[k] = f?.type === 'number' ? Number(v || 0) : v;
    }
    try {
      const next = await api.updateConstructionRegisterItem(kind, row.id, body);
      setBusy(false);
      onSaved(next);
    } catch (e) {
      setBusy(false);
      setError(e.message || 'Could not save that.');
    }
  };

  return (
    <Modal title={cfg.title(row) || cfg.noun} onClose={onClose} width={640} isDirty={dirty} onSave={save}>
      {error && <ErrorBanner message={error} onRetry={() => setError('')} />}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
        <Chip cfg={cfg} status={row.status} />
        {late && <StatusLabel size="sm" label="Overdue" color={TONE.red} />}
        {open != null && <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{open} day{open === 1 ? '' : 's'} open</span>}
      </div>
      <div style={{ flexShrink: 0 }}>
      <SettingCard>
        <SettingRow title="Status" htmlFor={`reg-status-${row.id}`}
          control={(
            <select id={`reg-status-${row.id}`} className="form-input" value={draft.status} disabled={!canReview}
              onChange={(e) => patch({ status: e.target.value })} style={{ width: 200 }}>
              {Object.entries(cfg.statuses).map(([v, [label]]) => <option key={v} value={v}>{label}</option>)}
            </select>
          )} />
        {cfg.fields.map((f) => (
          (f.multiline || (f.type !== 'date' && f.type !== 'switch' && f.type !== 'number')) ? (
            <SettingRow key={f.key} title={f.label}>
              <div style={{ width: '100%' }}>
                <FieldControl f={f} value={draft[f.key]} disabled={!canReview} onChange={(v) => patch({ [f.key]: v })} />
              </div>
            </SettingRow>
          ) : (
            <SettingRow key={f.key} title={f.label}
              control={<FieldControl f={f} value={draft[f.key]} disabled={!canReview} onChange={(v) => patch({ [f.key]: v })} />} />
          )
        ))}
      </SettingCard>
      </div>
      {canReview && (
        <SaveRow dirty={dirty} busy={busy} onSave={save} onDiscard={reset} saveDisabled={missing}
          note={missing ? 'Fill in the required field first.' : undefined}>
          <HoldButton label="Remove" doneLabel="Removed" holdMs={HOLD_RECORD_MS} size="sm"
            onConfirm={() => api.deleteConstructionRegisterItem(kind, row.id).then(() => onRemoved(row))}
            fallbackMessage={`Remove this ${cfg.noun.toLowerCase()}? It stays on any report that already printed it.`} />
        </SaveRow>
      )}
    </Modal>
  );
}

// ── Register list ───────────────────────────────────────────────────────────
export default function Registers({ project, canReview, onChanged }) {
  const [kind, setKind] = useState(KINDS[0]);
  // Cached per kind so switching tabs back does not re-fetch and flash a
  // loading state over a list the user was just reading.
  const [rows, setRows] = useState({});
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [openRow, setOpenRow] = useState(null);
  const { aiEnabled } = useConstructionMeta();
  const cfg = REGISTERS[kind];
  const today = project.today || browserTodayISO();

  const load = useCallback((k) => {
    setError('');
    api.getConstructionRegister(project.id, k)
      .then((r) => setRows((prev) => ({ ...prev, [k]: r })))
      .catch((e) => {
        setRows((prev) => ({ ...prev, [k]: [] }));
        setError(e.message || `Could not load ${REGISTERS[k].label.toLowerCase()}.`);
      });
  }, [project.id]);

  useEffect(() => { if (rows[kind] === undefined) load(kind); }, [kind, rows, load]);

  const list = rows[kind];

  const changed = () => { load(kind); onChanged?.(); };

  const save = async (form) => {
    await api.createConstructionRegisterItem(project.id, kind, form);
    setAdding(false);
    changed();
  };

  return (
    <div style={CARD}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <h3 style={{ fontSize: '1.1rem', fontFamily: "'Plus Jakarta Sans', sans-serif", marginBottom: 4 }}>
            Schedule And Correspondence
          </h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: 0 }}>{(aiEnabled && cfg.blurbAi) || cfg.blurb}</p>
        </div>
        {canReview && !adding && (
          <button className="primary-btn" onClick={() => setAdding(true)} style={{ flexShrink: 0 }}>
            <Plus size={16} />{cfg.addLabel}
          </button>
        )}
      </div>

      <div className="scroll-tabs" style={{ display: 'flex', gap: 8, margin: '16px 0 20px' }}>
        {KINDS.map((k) => {
          const KIcon = REGISTERS[k].icon;
          const active = k === kind;
          const count = rows[k]?.length;
          return (
            <button key={k} onClick={() => { setKind(k); setAdding(false); setError(''); }}
              className={active ? 'primary-btn' : 'secondary-btn'} aria-pressed={active}
              style={{ padding: '6px 14px', fontSize: '0.85rem', whiteSpace: 'nowrap' }}>
              <KIcon size={14} />{REGISTERS[k].label}
              {count ? <span style={{ opacity: 0.7, marginLeft: 2 }}>({count})</span> : null}
            </button>
          );
        })}
      </div>

      {error && <ErrorBanner message={error} onRetry={() => load(kind)} />}

      {adding && <AddForm cfg={cfg} onCancel={() => setAdding(false)} onSave={save} />}

      {list === undefined ? (
        <SkeletonBlocks count={3} height={72} borderRadius={8} />
      ) : list.length === 0 && !adding ? (
        <div style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--text-secondary)' }}>
          <cfg.icon size={30} style={{ opacity: 0.4, marginBottom: 12 }} />
          <div style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>
            {cfg.emptyTitle}
          </div>
          <p style={{ fontSize: '0.85rem', maxWidth: 420, margin: '0 auto' }}>{cfg.emptyHint}</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {list.map((r) => {
            const late = isOverdue(kind, r, today);
            const days = daysOpen(kind, r, today);
            const meta = cfg.meta(r, project.names).filter(Boolean);
            return (
              <div key={r.id} role="button" tabIndex={0} data-register-row={r.id}
                onClick={() => setOpenRow(r)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenRow(r); } }}
                style={{
                  backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-color)',
                  borderRadius: 8, padding: 16, display: 'flex', gap: 12, cursor: 'pointer',
                  justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap',
                }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <strong style={{ fontSize: '0.95rem', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
                      {cfg.title(r)}
                    </strong>
                    <Chip cfg={cfg} status={r.status} />
                    {late && <StatusLabel size="sm" label="Overdue" color={TONE.red} />}
                    {days != null && (
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{days} day{days === 1 ? '' : 's'} open</span>
                    )}
                    {/* A suggestion, never a state change - see ConstructionMilestone.
                        Shown next to the status so the manager can act on it in place. */}
                    {aiEnabled && kind === 'milestones' && r.aiDetectedAt && !r.confirmedBy && (
                      <span title="AI saw evidence this milestone was reached. Set the status to confirm."
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '0.75rem',
                          fontWeight: 600, color: 'hsl(var(--color-blue))',
                        }}>
                        <Sparkles size={11} />AI suggests this is hit
                      </span>
                    )}
                  </div>
                  {meta.length > 0 && (
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: 4 }}>
                      {meta.join(' · ')}
                    </div>
                  )}
                  {(r.question || r.description) && (
                    <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.5, margin: '8px 0 0' }}>
                      {r.question || r.description}
                    </p>
                  )}
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}
                  onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                  {canReview && (
                    <HoldButton label="Remove" doneLabel="Removed" holdMs={HOLD_RECORD_MS} size="sm"
                      onConfirm={() => api.deleteConstructionRegisterItem(kind, r.id).then(changed)}
                      fallbackMessage={`Remove this ${cfg.noun.toLowerCase()}? It stays on any report that already printed it.`} />
                  )}
                  <ChevronRight size={16} style={{ color: 'var(--text-secondary)' }} aria-hidden="true" />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {openRow && (
        <RegisterSheet kind={kind} row={openRow} canReview={canReview} today={today}
          onClose={() => setOpenRow(null)}
          onSaved={() => { setOpenRow(null); changed(); }}
          onRemoved={() => { setOpenRow(null); changed(); }} />
      )}
    </div>
  );
}
