// In-person training (WP 5.1, Oct 29 2026): the course builder's Sessions tab.
// Schedule a session (date, time, place, trainer, who comes), take attendance
// (Attended signs the person off: the course completes and the certificate is
// issued), or sign someone off a hands-on check with no session.
// Backend: routers/kb_training.py (sessions, attendance, sign-off).
import { useEffect, useState } from 'react';
import { CalendarPlus, Check, X, UserCheck, MapPin } from 'lucide-react';
import { api } from '../../api';
import AsyncSection from '../../components/AsyncState';
import { Modal, DateField, TimeField } from '../../tasks/components';
import { Chip, Av } from '../components/Chips';
import PeoplePick, { PeopleMultiPick } from '../components/PeoplePick';
import { useToast, errText } from '../components/Toast';
import { fmtDateTime, plural } from '../lib';

const STATUS = { invited: ['Invited', '#64748b'], attended: ['Attended', '#1e7b4e'], no_show: ['No-Show', '#dc2626'] };

function NewSession({ courseId, onSaved, onClose }) {
  const toast = useToast();
  const [day, setDay] = useState('');
  const [start, setStart] = useState('09:00');
  const [end, setEnd] = useState('10:00');
  const [location, setLocation] = useState('');
  const [trainer, setTrainer] = useState('');
  const [emails, setEmails] = useState([]);
  const [capacity, setCapacity] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.kbCreateSession(courseId, { starts_at: `${day}T${start}`, ends_at: end ? `${day}T${end}` : '', location, trainer_email: trainer,
        emails, capacity: Number(capacity) || 0, notes });
      toast(emails.length ? `Scheduled; ${plural(emails.length, 'person', 'people')} invited` : 'Session scheduled');
      onSaved(); onClose();
    } catch (e) { toast(errText(e), 'err'); } finally { setBusy(false); }
  };
  return (
    <Modal title="New Session" onClose={onClose}
           footer={<div className="kb" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
             <button type="button" className="kb-btn" onClick={onClose}>Cancel</button>
             <button type="button" className="kb-btn pri" disabled={busy || !day || !start} onClick={save}><CalendarPlus />Schedule</button></div>}>
      <div className="kb" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr', gap: 12 }}>
          <div className="kb-field"><label>Date</label><DateField value={day} onChange={setDay} noPast placeholder="Pick a date" style={{ minHeight: 40, borderRadius: 10 }} /></div>
          <div className="kb-field"><label>Starts</label><TimeField ariaLabel="Starts" value={start} onChange={setStart} /></div>
          <div className="kb-field"><label>Ends</label><TimeField ariaLabel="Ends" value={end} onChange={setEnd} /></div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
          <div className="kb-field"><label>Where</label><input className="kb-input" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Site, room or address" /></div>
          <div className="kb-field"><label>Seats</label><input className="kb-input" type="number" min="0" value={capacity} onChange={(e) => setCapacity(e.target.value)} placeholder="No limit" /></div>
        </div>
        <div className="kb-field"><label>Trainer</label><PeoplePick value={trainer} onChange={setTrainer} placeholder="You, unless you pick someone" /></div>
        <div className="kb-field"><label>Who Comes</label><PeopleMultiPick value={emails} onChange={setEmails} /><div className="kb-help">Each person gets a bell with the date and place.</div></div>
        <div className="kb-field nx-fill" style={{ display: 'flex', flexDirection: 'column' }}><label>Notes</label>
          <textarea className="kb-textarea" style={{ flex: 1, minHeight: 70 }} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What to bring, what to wear" /></div>
      </div>
    </Modal>
  );
}

function SignOff({ courseId, onSaved, onClose }) {
  const toast = useToast();
  const [who, setWho] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { await api.kbSignOff(courseId, who, note); toast('Signed off; the certificate is issued'); onSaved(); onClose(); }
    catch (e) { toast(errText(e), 'err'); } finally { setBusy(false); }
  };
  return (
    <Modal title="Sign Off a Person" onClose={onClose}
           footer={<div className="kb" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
             <button type="button" className="kb-btn" onClick={onClose}>Cancel</button>
             <button type="button" className="kb-btn pri" disabled={busy || !who} onClick={save}><UserCheck />Sign Off</button></div>}>
      <div className="kb" style={{ display: 'flex', flexDirection: 'column', gap: 12, flex: 1 }}>
        <div className="kb-meta">For a hands-on check done on site with no session. The course's editors or the person's own manager sign off; never the person themselves.</div>
        <div className="kb-field"><label>Who</label><PeoplePick value={who} onChange={setWho} allowClear={false} /></div>
        <div className="kb-field nx-fill" style={{ display: 'flex', flexDirection: 'column' }}><label>What You Saw</label>
          <textarea className="kb-textarea" style={{ flex: 1, minHeight: 90 }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional: what they did correctly" /></div>
      </div>
    </Modal>
  );
}

export default function Sessions({ course }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [newOpen, setNewOpen] = useState(false);
  const [signOpen, setSignOpen] = useState(false);
  const load = () => { setErr(''); api.kbSessions(course.id).then(setData).catch((e) => setErr(errText(e))); };
  useEffect(() => { load(); }, [course.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const mark = (s, email, status) => api.kbMarkAttendance(s.id, email, status)
    .then((r) => { setData((d) => ({ ...d, sessions: d.sessions.map((x) => (x.id === r.id ? r : x)) })); toast(status === 'attended' ? 'Signed off; the certificate is issued' : 'Marked'); })
    .catch((e) => toast(errText(e), 'err'));
  const cancel = (s) => api.kbUpdateSession(s.id, { status: 'canceled' }).then(() => { toast('Canceled; the invited were told'); load(); }).catch((e) => toast(errText(e), 'err'));
  const live = course.status === 'published' && course.delivery === 'in_person';
  return (
    <AsyncSection loading={!data && !err} error={err ? new Error(err) : null} errorMessage={err} onRetry={load}>
      {data && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="kb-meta">{live ? 'People complete this course when a trainer marks them Attended, or when they are signed off a hands-on check.' : 'Set How It\'s Taken to In Person under Settings and publish, then schedule sessions here.'}</span>
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              <button type="button" className="kb-btn sm" disabled={!live} onClick={() => setSignOpen(true)}><UserCheck />Sign Off a Person</button>
              <button type="button" className="kb-btn sm pri" disabled={!live} onClick={() => setNewOpen(true)}><CalendarPlus />New Session</button>
            </span>
          </div>
          {data.sessions.length === 0 && <section className="kb-card"><div className="kb-empty">No sessions yet.</div></section>}
          {data.sessions.map((s) => (
            <section key={s.id} className="kb-card">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                <h3 className="kb-h3" style={{ margin: 0 }}>{s.when}</h3>
                {s.location && <span className="kb-meta"><MapPin size={12} style={{ verticalAlign: 'middle' }} /> {s.location}</span>}
                <span className="kb-meta">· trainer {s.trainer_name || s.trainer_email}</span>
                {s.status === 'canceled' ? <Chip color="#64748b">Canceled</Chip>
                  : <button type="button" className="kb-btn sm ghost" style={{ marginLeft: 'auto' }} onClick={() => cancel(s)}><X />Cancel Session</button>}
              </div>
              {s.notes && <div style={{ fontSize: 13.5, marginBottom: 8 }}>{s.notes}</div>}
              {s.attendees.length === 0 && <div className="kb-empty">Nobody invited.</div>}
              {s.attendees.map((a) => (
                <div key={a.email} className="kb-row">
                  <Av name={a.name} email={a.email} size={24} />
                  <div className="kb-grow"><div className="kb-title">{a.name}</div>{a.signed_off_at && <div className="kb-meta">signed off {fmtDateTime(a.signed_off_at)}</div>}</div>
                  <Chip color={(STATUS[a.status] || STATUS.invited)[1]}>{(STATUS[a.status] || STATUS.invited)[0]}</Chip>
                  {s.status !== 'canceled' && a.status !== 'attended' && (
                    <>
                      <button type="button" className="kb-btn sm" onClick={() => mark(s, a.email, 'attended')}><Check />Attended</button>
                      {a.status !== 'no_show' && <button type="button" className="kb-btn sm ghost" onClick={() => mark(s, a.email, 'no_show')}>No-Show</button>}
                    </>
                  )}
                </div>
              ))}
            </section>
          ))}
          {data.sign_offs.length > 0 && (
            <section className="kb-card">
              <h3 className="kb-h3" style={{ marginBottom: 6 }}>Hands-On Sign-Offs</h3>
              {data.sign_offs.map((x) => (
                <div key={`${x.email}${x.at}`} className="kb-row"><Av name={x.name} email={x.email} size={24} />
                  <div className="kb-grow"><div className="kb-title">{x.name}</div><div className="kb-meta">by {x.by_name} · {fmtDateTime(x.at)}{x.note ? ` · ${x.note}` : ''}</div></div></div>
              ))}
            </section>
          )}
          {newOpen && <NewSession courseId={course.id} onSaved={load} onClose={() => setNewOpen(false)} />}
          {signOpen && <SignOff courseId={course.id} onSaved={load} onClose={() => setSignOpen(false)} />}
        </div>
      )}
    </AsyncSection>
  );
}
