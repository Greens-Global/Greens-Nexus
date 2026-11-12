// Construction - RFIs and submittals for one jobsite.
//
// One component for the registers rather than one file each. They differ in
// their fields and their status vocabulary and in nothing else: same
// permissions (manager writes, project members read), same soft delete, same
// row shape, and the API already serves them through one set of endpoints. The
// per-kind differences live in REGISTERS below, so adding a register is a
// config entry rather than another 200 lines.
//
// These are what the weekly report's RFIs and Submittals sections print.
// Milestones left this screen in Round Two (11/05/2026): they live on the
// job's task project (the Schedule tab) since 11/03/2026, and the old rows
// were moved there.
//
// 11/03/2026 (Neil, plan item 14): soft status labels; a row opens as a sheet
// with its fields editable (an RFI's answer, responder and due date, a
// submittal's dates and revision) and one Save row; days open and a red
// Overdue label from the row's own dates against the jobsite's today; dates
// are DateField boxes, never the browser's; Remove is pressed and held
// (ui/HoldButton.jsx, HOLD_RECORD_MS) and is a soft delete server-side.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { HelpCircle, FileCheck, Plus, AlertTriangle, ChevronRight, Paperclip, X, FileSignature } from 'lucide-react';
import { api } from '../api';
import { ErrorBanner, SkeletonBlocks } from '../components/AsyncState';
import { StatusLabel } from '../components/StatusLabel';
import { SettingRow, SettingCard, Switch } from '../components/settings/SettingsUI';
import SaveRow from '../components/SaveRow';
import HoldButton, { HOLD_RECORD_MS } from '../ui/HoldButton';
import { Modal, DateField } from '../tasks/components';
import { useDraft } from '../lib/useDraft';
import { useRole } from '../contexts/RoleContext';
import { useNexusPeople } from './lib/jobForm';
import { formatDate } from '../lib/datetime';
import { CARD, TONE, personName } from './ui';
import { isOverdue, daysOpen, browserTodayISO } from './lib/registers';
import { filesFromPaste, uploadJobDocument } from './lib/upload';
import { clientId } from './lib/job';
import { usd } from './lib/money';
import { SendLinkSheet } from './OutsideLinks';

// What a status MEANS to a manager scanning the list, the same palette across
// both: red is "someone is blocked or a date was missed", yellow is "at
// risk", green is "closed out", slate is "not started / open", blue is "out
// with someone". Never orange - that is in progress only (style.css).
// `key` is the request field (snake_case, matching _REGISTER_FIELDS on the
// server); `read` pulls the same value back off the camelCase response.
const REGISTERS = {
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
      // Left empty, the server numbers it RFI-001, RFI-002... per job (Round Three, 11/11/2026).
      { key: 'number', read: 'number', label: 'Number', placeholder: 'Numbered for you' },
      { key: 'subject', read: 'subject', label: 'Subject', placeholder: 'What is being asked about', required: true },
      { key: 'question', read: 'question', label: 'Question', placeholder: 'The question as submitted', multiline: true },
      { key: 'ball_in_court', read: 'ballInCourt', label: 'Ball In Court', placeholder: 'The party who owes the answer' },
      // The Nexus person who answers it (11/03/2026): the RFI waits in their Approvals.
      { key: 'responder_email', read: 'responderEmail', label: 'Answered By', type: 'person', placeholder: 'No one named' },
      { key: 'submitted_on', read: 'submittedOn', label: 'Sent On', type: 'date' },
      { key: 'due_on', read: 'dueOn', label: 'Response Due', type: 'date' },
      { key: 'answer', read: 'answer', label: 'Answer', placeholder: 'Fill in when it comes back', multiline: true },
      { key: 'answered_on', read: 'answeredOn', label: 'Answered On', type: 'date', sheetOnly: true },
      // A dollar figure: shown to the people who may see the job's money only (the server sends null to everyone else).
      { key: 'cost_impact', read: 'costImpact', label: 'Cost Impact ($)', type: 'money', sheetOnly: true, costOnly: true },
      { key: 'schedule_impact_days', read: 'scheduleImpactDays', label: 'Schedule Impact (Days)', type: 'number', sheetOnly: true },
      // The marked-up photo or sheet the question is about (Round Three, 11/11/2026).
      { key: 'document_urls', read: 'documentUrls', label: 'Files', type: 'files' },
    ],
    title: (r) => [r.number, r.subject].filter(Boolean).join(' · ') || 'Untitled RFI',
    // What the named responder may write themselves (routers/construction.py RESPONDER_FIELDS).
    ownerKey: 'responderEmail', ownerFields: ['answer', 'answered_on', 'status'], ownerStatuses: ['answered'],
    meta: (r, names) => [
      r.ballInCourt && `Ball in court: ${r.ballInCourt}`,
      r.responderEmail && `Answered by ${personName(r.responderEmail, names)}`,
      r.dueOn && `Due ${formatDate(r.dueOn, r.dueOn)}`,
      r.answeredOn && `Answered ${formatDate(r.answeredOn, r.answeredOn)}${r.answeredBy ? ` by ${r.answeredBy.replace(/\s*<[^>]*>$/, '')} (outside link)` : ''}`,
      r.costImpact ? `${usd(r.costImpact)} cost impact` : '',
      r.scheduleImpactDays ? `${r.scheduleImpactDays} day schedule impact` : '',
      r.changeOrder?.number && `On change order ${r.changeOrder.number}`,
      r.documentUrls?.length ? `${r.documentUrls.length} file${r.documentUrls.length === 1 ? '' : 's'}` : '',
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
      { key: 'number', read: 'number', label: 'Number', placeholder: 'Numbered for you' },
      { key: 'title', read: 'title', label: 'Title', placeholder: 'What was submitted', required: true },
      { key: 'spec_section', read: 'specSection', label: 'Spec Section', placeholder: 'e.g. 03 30 00' },
      { key: 'submitted_on', read: 'submittedOn', label: 'Sent On', type: 'date' },
      { key: 'due_on', read: 'dueOn', label: 'Response Due', type: 'date' },
      { key: 'returned_on', read: 'returnedOn', label: 'Returned On', type: 'date', sheetOnly: true },
      { key: 'revision', read: 'revision', label: 'Revision', type: 'number', sheetOnly: true },
      // The Nexus person who decides it (11/03/2026): it waits in their Approvals.
      { key: 'approver_email', read: 'approverEmail', label: 'Decided By', type: 'person', placeholder: 'No one named' },
      // The server always kept a submittal's documents; the screen now shows them (Round Three, 11/11/2026).
      { key: 'document_urls', read: 'documentUrls', label: 'Files', type: 'files' },
    ],
    title: (r) => [r.number, r.title].filter(Boolean).join(' · ') || 'Untitled submittal',
    ownerKey: 'approverEmail', ownerFields: ['status', 'returned_on'],
    ownerStatuses: ['approved', 'approved_as_noted', 'revise_resubmit', 'rejected'],
    meta: (r, names) => [
      r.approverEmail && `Decided by ${personName(r.approverEmail, names)}`,
      r.specSection && `Spec ${r.specSection}`,
      r.dueOn && `Due ${formatDate(r.dueOn, r.dueOn)}`,
      r.returnedOn && `Returned ${formatDate(r.returnedOn, r.returnedOn)}`,
      r.revision ? `Revision ${r.revision}` : '',
      r.documentUrls?.length ? `${r.documentUrls.length} file${r.documentUrls.length === 1 ? '' : 's'}` : '',
    ],
  },
};

const KINDS = Object.keys(REGISTERS);

// A register's fields for this reader: Cost Impact only for the people who
// may see the job's money (the project payload carries contractValue only
// for them - routers/construction.py project_to_dict `with_cost`).
const fieldsFor = (cfg, canSeeCost) => cfg.fields.filter((f) => !f.costOnly || canSeeCost);

const fileName = (u) => {
  try { return decodeURIComponent(new URL(u, window.location.origin).pathname.split('/').pop() || 'File'); } catch { return 'File'; }
};

// Files on an RFI or a submittal: PDFs or photos into this job's own folder
// (uploadJobDocument - the server accepts only those links). Pick, drop or
// Ctrl+V; each stays a link that opens in a new tab.
function FilesField({ value, onChange, disabled, projectId, label }) {
  const list = Array.isArray(value) ? value : [];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const take = async (files) => {
    const picked = [...(files || [])].filter(Boolean);
    if (!picked.length || disabled) return;
    setBusy(true); setError('');
    const added = [];
    for (const f of picked) {
      const out = await uploadJobDocument(f, { projectId });
      if (out.error) { setError(out.error); break; }
      added.push(out.url);
    }
    setBusy(false);
    if (added.length) onChange([...list, ...added]);
  };
  return (
    <div onPaste={(e) => { const f = filesFromPaste(e); if (f.length) { e.preventDefault(); take(f); } }}
      onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); take(e.dataTransfer.files); }}
      tabIndex={disabled ? -1 : 0} aria-label={label} style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%' }}>
      {list.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {list.map((u) => (
            <div key={u} style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <a href={u} target="_blank" rel="noreferrer" style={{ fontSize: 13, fontWeight: 600, color: 'var(--wk-brand, #2b45e1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{fileName(u)}</a>
              {!disabled && (
                <button type="button" className="secondary-btn" aria-label={`Remove ${fileName(u)}`} style={{ padding: 4, minHeight: 0 }}
                  onClick={() => onChange(list.filter((x) => x !== u))}><X size={12} /></button>
              )}
            </div>
          ))}
        </div>
      )}
      {!disabled && (
        <>
          <div>
            <label className="secondary-btn" style={{ padding: '6px 10px', fontSize: 13, cursor: 'pointer', margin: 0, display: 'inline-flex' }}>
              <Paperclip size={13} />{busy ? 'Attaching…' : 'Attach'}
              <input type="file" multiple accept="application/pdf,image/*" hidden disabled={busy}
                onChange={(e) => { take(e.target.files); e.target.value = ''; }} />
            </label>
          </div>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>A PDF or a photo - or press Ctrl+V to paste one.</span>
        </>
      )}
      {disabled && list.length === 0 && <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>No files.</span>}
      {error && <span role="alert" style={{ fontSize: 13, color: 'hsl(var(--color-red))' }}>{error}</span>}
    </div>
  );
}

function Chip({ cfg, status }) {
  const [label, color] = cfg.statuses[status] || cfg.statuses[Object.keys(cfg.statuses)[0]];
  return <StatusLabel size="sm" label={label} color={color} />;
}

// One field's control: a DateField for a date (never the browser's own box -
// it follows the computer's region), a switch, a number, a text area or box.
function FieldControl({ f, value, onChange, disabled, autoFocus, people, projectId }) {
  if (f.type === 'files') {
    return <FilesField value={value} onChange={onChange} disabled={disabled} projectId={projectId} label={f.label} />;
  }
  if (f.type === 'money') {
    return (
      <input className="form-input" type="number" step="0.01" inputMode="decimal" value={value ?? ''} disabled={disabled}
        aria-label={f.label} placeholder="0" onChange={(e) => onChange(e.target.value)} style={{ width: 140 }} />
    );
  }
  if (f.type === 'person') {
    // The curated Nexus People list (getPeopleDirectory) - never M365.
    const known = (people || []).some((p) => p.email === value);
    return (
      <select className="form-input" value={value || ''} disabled={disabled} aria-label={f.label}
        onChange={(e) => onChange(e.target.value)} style={{ width: '100%' }}>
        <option value="">{f.placeholder || 'No one'}</option>
        {value && !known && <option value={value}>{value}</option>}
        {(people || []).map((p) => <option key={p.email} value={p.email}>{p.name || p.email}</option>)}
      </select>
    );
  }
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
function AddForm({ cfg, onCancel, onSave, people, projectId, canSeeCost }) {
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
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, fontSize: 13 }}>
          <AlertTriangle size={14} style={{ color: 'hsl(var(--color-red))' }} />
          <span>{error}</span>
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
        {fieldsFor(cfg, canSeeCost).filter((f) => !f.sheetOnly).map((f, i) => (
          <div key={f.key} style={(f.multiline || f.type === 'files') ? { gridColumn: '1 / -1' } : undefined}>
            <label className="form-label">{f.label}</label>
            <FieldControl f={f} value={form[f.key]} autoFocus={i === 0} people={people} projectId={projectId}
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
function RegisterSheet({ kind, row, project, canReview, canSeeCost, today, onClose, onSaved, onRemoved, onOpenChanges, people, myEmail }) {
  const cfg = REGISTERS[kind];
  const fields = fieldsFor(cfg, canSeeCost);
  // The person named to answer / decide it gives the answer or the decision,
  // and nothing else (the server holds the same line).
  const isOwner = !canReview && !!cfg.ownerKey && !!myEmail && String(row[cfg.ownerKey] || '').toLowerCase() === myEmail;
  const mayEdit = (key) => canReview || (isOwner && cfg.ownerFields.includes(key));
  const saved = useMemo(() => {
    const out = { status: row.status || Object.keys(cfg.statuses)[0] };
    for (const f of fields) out[f.key] = row[f.read] ?? (f.type === 'switch' ? false : f.type === 'files' ? [] : '');
    return out;
  }, [row, cfg, fields]);
  const { draft, patch, dirty, reset } = useDraft(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const missing = fields.some((f) => f.required && !String(draft[f.key] || '').trim());
  // An answered RFI becomes ONE draft change order (Round Three, 11/11/2026):
  // the server prefills it from the RFI and refuses a second while one lives.
  const canPrice = kind === 'rfis' && canReview && canSeeCost;
  const [making, setMaking] = useState(false);
  // Round Three item 4 (11/11/2026): the architect or engineer answers through an outside link.
  const [sendOpen, setSendOpen] = useState(false);
  const makeChangeOrder = async () => {
    setMaking(true); setError('');
    try {
      await api.createChangeOrder(project.id, { id: clientId('co'), rfi_id: row.id });
      onOpenChanges?.();
    } catch (e) {
      setMaking(false);
      setError(e.message || 'Could not make the change order.');
    }
  };
  const open = daysOpen(kind, row, today);
  const late = isOverdue(kind, row, today);

  const save = async () => {
    if (!dirty || busy || missing) return;
    setBusy(true); setError('');
    const body = {};
    for (const [k, v] of Object.entries(draft)) {
      if (JSON.stringify(v) === JSON.stringify(saved[k])) continue;
      const f = fields.find((x) => x.key === k);
      body[k] = (f?.type === 'number' || f?.type === 'money') ? Number(v || 0) : v;
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
        {open != null && <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{open} day{open === 1 ? '' : 's'} open</span>}
      </div>
      {kind === 'rfis' && canReview && row.status === 'open' && (
        <div data-rfi-outside style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 14, fontSize: 13, color: 'var(--text-secondary)' }}>
          <span>Does someone outside the company owe the answer? Send them a link - no sign-in.</span>
          <button type="button" className="secondary-btn" style={{ padding: '6px 12px', fontSize: 13 }} onClick={() => setSendOpen(true)}>Send to Answer</button>
        </div>
      )}
      {sendOpen && (
        <SendLinkSheet project={project} kind="rfi" refId={row.id} what={cfg.title(row)} defaultName={row.ballInCourt || ''}
          onClose={() => setSendOpen(false)} />
      )}
      {canPrice && (row.changeOrder || ['answered', 'closed'].includes(row.status)) && (
        <div data-rfi-change-order style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 14, fontSize: 13, color: 'var(--text-secondary)' }}>
          <FileSignature size={15} aria-hidden="true" />
          {row.changeOrder ? (
            <>
              <span>On change order <b style={{ color: 'var(--text-primary)' }}>{row.changeOrder.number}</b>.</span>
              <button type="button" className="secondary-btn" style={{ padding: '6px 12px', fontSize: 13 }} onClick={() => onOpenChanges?.()}>Open Changes</button>
            </>
          ) : (
            <>
              <span>Does the answer change the price or the schedule? Price it as a change order.</span>
              <button type="button" className="secondary-btn" style={{ padding: '6px 12px', fontSize: 13 }} disabled={making || dirty}
                title={dirty ? 'Save your changes first.' : undefined} onClick={makeChangeOrder}>{making ? 'Making…' : 'Make Change Order'}</button>
            </>
          )}
        </div>
      )}
      <div style={{ flexShrink: 0 }}>
      <SettingCard>
        <SettingRow title="Status" htmlFor={`reg-status-${row.id}`}
          control={(
            <select id={`reg-status-${row.id}`} className="form-input" value={draft.status} disabled={!mayEdit('status')}
              onChange={(e) => patch({ status: e.target.value })} style={{ width: 200 }}>
              {Object.entries(cfg.statuses)
                .filter(([v]) => canReview || v === row.status || (cfg.ownerStatuses || []).includes(v))
                .map(([v, [label]]) => <option key={v} value={v}>{label}</option>)}
            </select>
          )} />
        {fields.map((f) => (
          (f.multiline || !['date', 'switch', 'number', 'money'].includes(f.type)) ? (
            <SettingRow key={f.key} title={f.label}>
              <div style={{ width: '100%' }}>
                <FieldControl f={f} value={draft[f.key]} disabled={!mayEdit(f.key)} people={people} projectId={project.id} onChange={(v) => patch({ [f.key]: v })} />
              </div>
            </SettingRow>
          ) : (
            <SettingRow key={f.key} title={f.label}
              control={<FieldControl f={f} value={draft[f.key]} disabled={!mayEdit(f.key)} people={people} projectId={project.id} onChange={(v) => patch({ [f.key]: v })} />} />
          )
        ))}
      </SettingCard>
      </div>
      {isOwner && (
        <SaveRow dirty={dirty} busy={busy} onSave={save} onDiscard={reset} saveDisabled={missing}
          note="You were named to give this answer." />
      )}
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
export default function Registers({ project, canReview, onChanged, onOpenChanges, kinds = KINDS, title = 'RFIs And Submittals' }) {
  const [kind, setKind] = useState(kinds[0]);
  const { myEmail } = useRole();
  const people = useNexusPeople();
  // Cached per kind so switching tabs back does not re-fetch and flash a
  // loading state over a list the user was just reading.
  const [rows, setRows] = useState({});
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [openRow, setOpenRow] = useState(null);
  const cfg = REGISTERS[kind];
  const today = project.today || browserTodayISO();
  const canSeeCost = project.contractValue !== undefined;

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
          <h3 style={{ fontSize: 18, fontFamily: "'Plus Jakarta Sans', sans-serif", marginBottom: 4 }}>
            {title}
          </h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: 0 }}>{cfg.blurb}</p>
        </div>
        {canReview && !adding && (
          <button className="primary-btn" onClick={() => setAdding(true)} style={{ flexShrink: 0 }}>
            <Plus size={16} />{cfg.addLabel}
          </button>
        )}
      </div>

      <div className="scroll-tabs" style={{ display: 'flex', gap: 8, margin: '16px 0 20px' }}>
        {kinds.map((k) => {
          const KIcon = REGISTERS[k].icon;
          const active = k === kind;
          const count = rows[k]?.length;
          return (
            <button key={k} onClick={() => { setKind(k); setAdding(false); setError(''); }}
              className={active ? 'primary-btn' : 'secondary-btn'} aria-pressed={active}
              style={{ padding: '6px 14px', fontSize: 13, whiteSpace: 'nowrap' }}>
              <KIcon size={14} />{REGISTERS[k].label}
              {count ? <span style={{ opacity: 0.7, marginLeft: 2 }}>({count})</span> : null}
            </button>
          );
        })}
      </div>

      {error && <ErrorBanner message={error} onRetry={() => load(kind)} />}

      {adding && <AddForm cfg={cfg} onCancel={() => setAdding(false)} onSave={save} people={people} projectId={project.id} canSeeCost={canSeeCost} />}

      {list === undefined ? (
        <SkeletonBlocks count={3} height={72} borderRadius={8} />
      ) : list.length === 0 && !adding ? (
        <div style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--text-secondary)' }}>
          <cfg.icon size={30} style={{ opacity: 0.4, marginBottom: 12 }} />
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>
            {cfg.emptyTitle}
          </div>
          <p style={{ fontSize: 13, maxWidth: 420, margin: '0 auto' }}>{cfg.emptyHint}</p>
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
                    <strong style={{ fontSize: 15, fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
                      {cfg.title(r)}
                    </strong>
                    <Chip cfg={cfg} status={r.status} />
                    {late && <StatusLabel size="sm" label="Overdue" color={TONE.red} />}
                    {days != null && (
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{days} day{days === 1 ? '' : 's'} open</span>
                    )}
                  </div>
                  {meta.length > 0 && (
                    <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>
                      {meta.join(' · ')}
                    </div>
                  )}
                  {(r.question || r.description) && (
                    <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5, margin: '8px 0 0' }}>
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
        <RegisterSheet kind={kind} row={openRow} project={project} canReview={canReview} canSeeCost={canSeeCost} today={today} people={people}
          onOpenChanges={onOpenChanges ? () => { setOpenRow(null); onOpenChanges(); } : undefined}
          myEmail={String(myEmail || '').toLowerCase()}
          onClose={() => setOpenRow(null)}
          onSaved={() => { setOpenRow(null); changed(); }}
          onRemoved={() => { setOpenRow(null); changed(); }} />
      )}
    </div>
  );
}
