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
import { useCallback, useEffect, useState } from 'react';
import { Flag, HelpCircle, FileCheck, Plus, Trash2, Sparkles, AlertTriangle } from 'lucide-react';
import { api } from '../api';
import { ErrorBanner, SkeletonBlocks } from '../components/AsyncState';

const CARD = {
  backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)',
  borderRadius: 12, padding: 24, marginBottom: 24, boxShadow: 'var(--shadow-sm)',
};

// Chip colors carry meaning, so they are assigned by what the status MEANS to a
// manager scanning the list, not by register. Red is "someone is blocked or a
// date was missed", amber is "at risk", green is "closed out", grey is "not
// started". A reader learns the palette once across all three.
const TONE = {
  grey:  { bg: 'var(--border-color)',            fg: 'var(--text-secondary)' },
  blue:  { bg: 'hsl(var(--color-blue))',         fg: '#fff' },
  green: { bg: 'hsl(var(--color-green))',        fg: '#fff' },
  amber: { bg: 'hsl(var(--color-amber, 38 92% 45%))', fg: '#fff' },
  red:   { bg: 'hsl(var(--color-red))',          fg: '#fff' },
};

const REGISTERS = {
  milestones: {
    label: 'Milestones',
    icon: Flag,
    blurb: 'Schedule milestones for this jobsite. AI can suggest one looks hit; only you can confirm it.',
    emptyTitle: 'No milestones yet',
    emptyHint: 'Add the dates this job is measured against. They print in the weekly report under Critical Milestones.',
    addLabel: 'Add Milestone',
    statuses: {
      upcoming: ['Upcoming', 'grey'],
      at_risk:  ['At Risk', 'amber'],
      hit:      ['Hit', 'green'],
      missed:   ['Missed', 'red'],
    },
    // `key` is the request field (snake_case, matching _REGISTER_FIELDS on the
    // server); `read` pulls the same value back off the camelCase response.
    fields: [
      { key: 'name', read: 'name', label: 'Milestone', placeholder: 'e.g. Foundation pour complete', required: true },
      { key: 'target_date', read: 'targetDate', label: 'Target Date', type: 'date' },
      { key: 'actual_date', read: 'actualDate', label: 'Actual Date', type: 'date' },
      { key: 'description', read: 'description', label: 'Notes', placeholder: 'Optional' },
    ],
    title: (r) => r.name,
    meta: (r) => [
      r.targetDate && `Target ${r.targetDate}`,
      r.actualDate && `Actual ${r.actualDate}`,
      r.critical && 'Critical path',
      r.confirmedBy && `Confirmed by ${r.confirmedBy}`,
    ],
  },
  rfis: {
    label: 'RFIs',
    icon: HelpCircle,
    blurb: 'Requests for information. The report prints open ones by age, because an unanswered RFI is what a delay claim is built on.',
    emptyTitle: 'No RFIs yet',
    emptyHint: 'Log a request for information so the week it stayed open is on the record.',
    addLabel: 'Add RFI',
    statuses: {
      open:     ['Open', 'red'],
      answered: ['Answered', 'blue'],
      closed:   ['Closed', 'green'],
      void:     ['Void', 'grey'],
    },
    fields: [
      { key: 'number', read: 'number', label: 'Number', placeholder: 'RFI-014' },
      { key: 'subject', read: 'subject', label: 'Subject', placeholder: 'What is being asked about', required: true },
      { key: 'question', read: 'question', label: 'Question', placeholder: 'The question as submitted', multiline: true },
      { key: 'ball_in_court', read: 'ballInCourt', label: 'Ball In Court', placeholder: 'Party owing the response' },
      { key: 'due_on', read: 'dueOn', label: 'Response Due', type: 'date' },
      { key: 'answer', read: 'answer', label: 'Answer', placeholder: 'Fill in when it comes back', multiline: true },
    ],
    title: (r) => [r.number, r.subject].filter(Boolean).join(' · ') || 'Untitled RFI',
    meta: (r) => [
      r.ballInCourt && `Ball in court: ${r.ballInCourt}`,
      r.dueOn && `Due ${r.dueOn}`,
      r.answeredOn && `Answered ${r.answeredOn}`,
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
    statuses: {
      pending:           ['Pending', 'grey'],
      submitted:         ['Submitted', 'blue'],
      approved:          ['Approved', 'green'],
      approved_as_noted: ['Approved As Noted', 'green'],
      revise_resubmit:   ['Revise And Resubmit', 'amber'],
      rejected:          ['Rejected', 'red'],
    },
    fields: [
      { key: 'number', read: 'number', label: 'Number', placeholder: 'SUB-007' },
      { key: 'title', read: 'title', label: 'Title', placeholder: 'What was submitted', required: true },
      { key: 'spec_section', read: 'specSection', label: 'Spec Section', placeholder: 'e.g. 03 30 00' },
      { key: 'due_on', read: 'dueOn', label: 'Response Due', type: 'date' },
    ],
    title: (r) => [r.number, r.title].filter(Boolean).join(' · ') || 'Untitled submittal',
    meta: (r) => [
      r.specSection && `Spec ${r.specSection}`,
      r.dueOn && `Due ${r.dueOn}`,
      r.returnedOn && `Returned ${r.returnedOn}`,
      r.revision ? `Revision ${r.revision}` : '',
    ],
  },
};

const KINDS = Object.keys(REGISTERS);

function Chip({ cfg, status }) {
  const [label, tone] = cfg.statuses[status] || cfg.statuses[Object.keys(cfg.statuses)[0]];
  const t = TONE[tone];
  return (
    <span style={{
      backgroundColor: t.bg, color: t.fg, fontSize: '0.7rem',
      padding: '2px 8px', borderRadius: 4, fontWeight: 600, whiteSpace: 'nowrap',
    }}>{label}</span>
  );
}

// ── Add form ────────────────────────────────────────────────────────────────
function AddForm({ cfg, onCancel, onSave }) {
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const required = cfg.fields.filter((f) => f.required);
  const ready = required.every((f) => (form[f.key] || '').trim());

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
        {cfg.fields.map((f, i) => (
          <div key={f.key} style={f.multiline ? { gridColumn: '1 / -1' } : undefined}>
            <label className="form-label">{f.label}</label>
            {f.multiline ? (
              <textarea className="form-input" rows={3} value={form[f.key] || ''}
                placeholder={f.placeholder || ''}
                onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} />
            ) : (
              <input className="form-input" type={f.type || 'text'} autoFocus={i === 0}
                value={form[f.key] || ''} placeholder={f.placeholder || ''}
                onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} />
            )}
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

// ── Register list ───────────────────────────────────────────────────────────
export default function Registers({ project, canReview }) {
  const [kind, setKind] = useState(KINDS[0]);
  // Cached per kind so switching tabs back does not re-fetch and flash a
  // loading state over a list the user was just reading.
  const [rows, setRows] = useState({});
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const cfg = REGISTERS[kind];

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

  const save = async (form) => {
    await api.createConstructionRegisterItem(project.id, kind, form);
    setAdding(false);
    load(kind);
  };

  const setStatus = async (row, status) => {
    // Optimistic: a status dropdown that freezes for a round trip gets clicked
    // twice. Reload on either outcome so a rejected change snaps back rather
    // than leaving the list lying.
    setRows((prev) => ({
      ...prev,
      [kind]: (prev[kind] || []).map((r) => (r.id === row.id ? { ...r, status } : r)),
    }));
    try {
      await api.updateConstructionRegisterItem(kind, row.id, { status });
    } catch (e) {
      setError(e.message || 'Could not update that.');
    } finally {
      load(kind);
    }
  };

  const remove = async (row) => {
    try {
      await api.deleteConstructionRegisterItem(kind, row.id);
    } catch (e) {
      setError(e.message || 'Could not remove that.');
    } finally {
      load(kind);
    }
  };

  return (
    <div style={CARD}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <h3 style={{ fontSize: '1.1rem', fontFamily: "'Plus Jakarta Sans', sans-serif", marginBottom: 4 }}>
            Schedule And Correspondence
          </h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: 0 }}>{cfg.blurb}</p>
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
              className={active ? 'primary-btn' : 'secondary-btn'}
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
          {list.map((r) => (
            <div key={r.id} style={{
              backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-color)',
              borderRadius: 8, padding: 16, display: 'flex', gap: 12,
              justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap',
            }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <strong style={{ fontSize: '0.95rem', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
                    {cfg.title(r)}
                  </strong>
                  <Chip cfg={cfg} status={r.status} />
                  {/* A suggestion, never a state change - see ConstructionMilestone.
                      Shown next to the status so the manager can act on it in place. */}
                  {kind === 'milestones' && r.aiDetectedAt && !r.confirmedBy && (
                    <span title="AI saw evidence this milestone was reached. Set the status to confirm."
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '0.7rem',
                        fontWeight: 600, color: 'hsl(var(--color-blue))',
                      }}>
                      <Sparkles size={11} />AI suggests this is hit
                    </span>
                  )}
                </div>
                {(() => {
                  const meta = cfg.meta(r).filter(Boolean);
                  return meta.length ? (
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: 4 }}>
                      {meta.join(' · ')}
                    </div>
                  ) : null;
                })()}
                {(r.question || r.description) && (
                  <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.5, margin: '8px 0 0' }}>
                    {r.question || r.description}
                  </p>
                )}
              </div>

              {canReview && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                  <select className="form-input" value={r.status || ''}
                    onChange={(e) => setStatus(r, e.target.value)}
                    style={{ padding: '4px 8px', fontSize: '0.8rem', width: 'auto' }}>
                    {Object.entries(cfg.statuses).map(([v, [label]]) => (
                      <option key={v} value={v}>{label}</option>
                    ))}
                  </select>
                  <button className="secondary-btn" title="Remove" onClick={() => remove(r)}
                    style={{ padding: 6 }}>
                    <Trash2 size={14} />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
