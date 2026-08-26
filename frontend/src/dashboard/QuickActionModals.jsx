// Quick Action composers - the tiles that DO something rather than navigate.
// Lazy-loaded as one chunk from widgets.jsx so the dashboard bundle stays lean.
//
// Mail/event send through Graph when the scopes are consented and fall back to
// an Outlook deep link when they are not (see m365.js). "New Task" is the real
// Tasks-module CreateTaskModal - it needs TasksProvider, which lives on the
// Tasks view, so we mount a provider around it here just for the modal.
import { useState, useEffect, useMemo } from 'react';
import { X, Send } from 'lucide-react';
import { api } from '../api';
import { sendMail, createEvent } from '../m365';
import { TasksProvider } from '../tasks/TasksContext';
import CreateTaskModal from '../tasks/CreateTaskModal';
import { useUnsavedGuard } from '../lib/useUnsavedGuard';
import UnsavedChangesPrompt from '../components/UnsavedChangesPrompt';

const Overlay = ({ children, onClose }) => (
  <div onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
    {children}
  </div>
);

const Shell = ({ title, sub, onClose, footer, children }) => (
  <div style={{ background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth: 'clamp(520px, 60vw, 980px)', maxHeight: '85vh', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)', fontFamily: 'Inter,sans-serif' }}>
    <div style={{ padding: '15px 20px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{ flex: 1 }}>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 800 }}>{title}</h3>
        {sub && <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)' }}>{sub}</p>}
      </div>
      <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex' }}><X size={18} /></button>
    </div>
    <div style={{ padding: 18, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>{children}</div>
    {footer && <div style={{ padding: '13px 18px', borderTop: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'flex-end' }}>{footer}</div>}
  </div>
);

const Label = ({ children }) => (
  <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', display: 'block', marginBottom: 6 }}>{children}</label>
);

// The curated Nexus People list - never an M365/GAL-derived list (see CLAUDE.md).
function usePeopleDirectory() {
  const [people, setPeople] = useState([]);
  useEffect(() => {
    let alive = true;
    api.getPeopleDirectory().then((rows) => {
      if (!alive) return;
      setPeople((rows || [])
        .map((u) => ({ email: (u.email || '').toLowerCase(), name: u.name || u.display_name || u.email }))
        .filter((p) => p.email));
    }).catch(() => {});
    return () => { alive = false; };
  }, []);
  return people;
}

// Flat add-and-list picker: a select to add, hairline-separated rows to review.
function PeoplePicker({ value, onChange, people, label, placeholder }) {
  const remaining = useMemo(
    () => people.filter((p) => !value.includes(p.email)),
    [people, value],
  );
  return (
    <div>
      <Label>{label}</Label>
      <select className="form-input" value="" style={{ width: '100%' }}
        onChange={(e) => { if (e.target.value) onChange([...value, e.target.value]); }}>
        <option value="">{placeholder}</option>
        {remaining.map((p) => <option key={p.email} value={p.email}>{p.name} - {p.email}</option>)}
      </select>
      {value.length > 0 && (
        <div style={{ marginTop: 8 }}>
          {value.map((email) => {
            const p = people.find((x) => x.email === email);
            return (
              <div key={email} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 2px', borderBottom: '1px solid var(--line)', fontSize: 13 }}>
                <span style={{ flex: 1, color: 'var(--ink)' }}>
                  {p?.name || email}
                  {p?.name && <span style={{ color: 'var(--muted)', marginLeft: 6, fontSize: 12 }}>{email}</span>}
                </span>
                <button onClick={() => onChange(value.filter((v) => v !== email))} title="Remove"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 2 }}>
                  <X size={14} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Shared submit footer - reports the Graph-vs-deeplink outcome honestly.
function useSubmit(run, onClose) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async () => {
    setBusy(true); setError('');
    try {
      const { sent } = await run();
      // Deep-link handoff already opened Outlook in a new tab; close either way.
      onClose(sent ? { toast: 'Sent.' } : { toast: 'Opened in Outlook to finish sending.' });
    } catch (e) {
      setError(e?.message || 'Something went wrong.');
      setBusy(false);
    }
  };
  return { busy, error, submit };
}

const SubmitBtn = ({ busy, disabled, onClick, children }) => (
  <button onClick={onClick} disabled={busy || disabled}
    style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 16px', borderRadius: 9, border: 'none', background: 'var(--ink)', color: 'var(--paper)', fontSize: 13.5, fontWeight: 600, cursor: busy || disabled ? 'not-allowed' : 'pointer', opacity: busy || disabled ? 0.5 : 1, fontFamily: 'Inter,sans-serif' }}>
    {children}
  </button>
);

const ErrorLine = ({ error }) => error
  ? <span style={{ flex: 1, fontSize: 12.5, color: 'hsl(var(--color-red))' }}>{error}</span>
  : <span style={{ flex: 1 }} />;

// ── New Email ────────────────────────────────────────────────────────────────
function EmailModal({ onClose }) {
  const people = usePeopleDirectory();
  const [to, setTo] = useState([]);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const { busy, error, submit } = useSubmit(() => sendMail({ to, subject, body }), onClose);
  const dirty = to.length > 0 || !!subject.trim() || !!body.trim();
  const guard = useUnsavedGuard(dirty, () => onClose(), to.length ? submit : undefined);

  return (
    <>
      <Overlay onClose={guard.requestClose}>
        <Shell title="New email" sub="Sends from your Outlook mailbox" onClose={guard.requestClose}
          footer={<><ErrorLine error={error} />
            <SubmitBtn busy={busy} disabled={!to.length} onClick={submit}><Send size={14} /> {busy ? 'Sending...' : 'Send'}</SubmitBtn></>}>
          <PeoplePicker value={to} onChange={setTo} people={people} label="To" placeholder="Add a recipient..." />
          <div>
            <Label>Subject</Label>
            <input className="form-input" value={subject} onChange={(e) => setSubject(e.target.value)} style={{ width: '100%' }} />
          </div>
          <div>
            <Label>Message</Label>
            <textarea className="form-input" value={body} onChange={(e) => setBody(e.target.value)} rows={7}
              style={{ width: '100%', resize: 'vertical', fontFamily: 'Inter,sans-serif' }} />
          </div>
        </Shell>
      </Overlay>
      {guard.confirming && (
        <UnsavedChangesPrompt onKeepEditing={guard.keepEditing} onDiscard={() => onClose()} onSave={guard.saveAndClose} saving={guard.saving || busy} />
      )}
    </>
  );
}

// ── New Event ────────────────────────────────────────────────────────────────
const pad = (n) => String(n).padStart(2, '0');
const localValue = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

// Next half-hour boundary, one hour long - the usual default for a quick booking.
function defaultWindow() {
  const s = new Date();
  s.setMinutes(s.getMinutes() > 30 ? 60 : 30, 0, 0);
  const e = new Date(s.getTime() + 60 * 60 * 1000);
  return [localValue(s), localValue(e)];
}

function EventModal({ onClose }) {
  const people = usePeopleDirectory();
  const [defStart, defEnd] = useMemo(() => defaultWindow(), []);
  const [subject, setSubject] = useState('');
  const [start, setStart] = useState(defStart);
  const [end, setEnd] = useState(defEnd);
  const [location, setLocation] = useState('');
  const [attendees, setAttendees] = useState([]);
  const [body, setBody] = useState('');
  const { busy, error, submit } = useSubmit(
    () => createEvent({ subject, start, end, location, body, attendees }), onClose);

  // Keep the end after the start when the user moves the start forward.
  const onStart = (v) => {
    setStart(v);
    if (v && new Date(end) <= new Date(v)) setEnd(localValue(new Date(new Date(v).getTime() + 60 * 60 * 1000)));
  };

  const dirty = !!subject.trim() || !!location.trim() || !!body.trim() || attendees.length > 0
    || start !== defStart || end !== defEnd;
  const guard = useUnsavedGuard(dirty, () => onClose(), subject.trim() ? submit : undefined);

  return (
    <>
      <Overlay onClose={guard.requestClose}>
        <Shell title="New event" sub="Adds to your Outlook calendar and invites attendees" onClose={guard.requestClose}
          footer={<><ErrorLine error={error} />
            <SubmitBtn busy={busy} disabled={!subject.trim()} onClick={submit}><Send size={14} /> {busy ? 'Creating...' : 'Create event'}</SubmitBtn></>}>
          <div>
            <Label>Title</Label>
            <input className="form-input" value={subject} onChange={(e) => setSubject(e.target.value)} style={{ width: '100%' }} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <Label>Starts</Label>
              <input type="datetime-local" className="form-input" value={start} onChange={(e) => onStart(e.target.value)} style={{ width: '100%' }} />
            </div>
            <div>
              <Label>Ends</Label>
              <input type="datetime-local" className="form-input" value={end} onChange={(e) => setEnd(e.target.value)} style={{ width: '100%' }} />
            </div>
          </div>
          <div>
            <Label>Location</Label>
            <input className="form-input" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Room, site, or Teams" style={{ width: '100%' }} />
          </div>
          <PeoplePicker value={attendees} onChange={setAttendees} people={people} label="Attendees" placeholder="Add an attendee..." />
          <div>
            <Label>Notes</Label>
            <textarea className="form-input" value={body} onChange={(e) => setBody(e.target.value)} rows={4}
              style={{ width: '100%', resize: 'vertical', fontFamily: 'Inter,sans-serif' }} />
          </div>
        </Shell>
      </Overlay>
      {guard.confirming && (
        <UnsavedChangesPrompt onKeepEditing={guard.keepEditing} onDiscard={() => onClose()} onSave={guard.saveAndClose} saving={guard.saving || busy} />
      )}
    </>
  );
}

// ── New Task ─────────────────────────────────────────────────────────────────
// The Tasks module's own modal, with the provider it expects. The provider
// fetches the workspace on mount; the form's title/assignee/due fields are
// usable immediately and the project list fills in when the load lands.
function TaskModal({ onClose }) {
  return (
    <TasksProvider>
      <CreateTaskModal onClose={() => onClose()} />
    </TasksProvider>
  );
}

export default function QuickActionModal({ kind, onClose }) {
  if (kind === 'email') return <EmailModal onClose={onClose} />;
  if (kind === 'event') return <EventModal onClose={onClose} />;
  if (kind === 'task')  return <TaskModal  onClose={onClose} />;
  return null;
}
