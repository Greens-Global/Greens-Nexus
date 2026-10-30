// 1:1s (Neil, Oct 27 2026): a manager and a direct report, one-off or
// recurring, with a Teams meeting, a shared agenda either side adds to,
// shared notes, the manager's private notes (the server never sends them to
// the report) and action items that become Tasks.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Video, Plus, Check, Trash2, CalendarClock, Lock, AlertTriangle } from 'lucide-react';
import { api } from '../api';
import { Modal, DateField, TimeField, PersonSelect } from '../tasks/components';
import { StatusLabel } from '../components/StatusLabel';
import { LoadingState, ErrorBanner } from '../components/AsyncState';
import { formatDate, formatDateTime } from '../lib/datetime';
import { NX } from '../tasks/theme';
import { CADENCES, localTimeZone, LBL, muted } from './lib';
import DictateButton from '../components/DictateButton';

const MEETING_STATUS = {
  scheduled: { label: 'Scheduled', color: NX.blue },
  done: { label: 'Done', color: NX.green },
  canceled: { label: 'Canceled', color: '#64748b' },
};

export function OneOnOneList({ items, onOpen, empty = 'No 1:1s yet.' }) {
  if (!items?.length) return <div style={{ ...muted, padding: '6px 2px' }}>{empty}</div>;
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {items.map(s => (
        <button key={s.id} type="button" onClick={() => onOpen?.(s)}
          style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left', padding: '11px 12px',
            border: '1px solid var(--line)', borderRadius: 12, background: 'var(--card)', cursor: 'pointer', fontFamily: 'inherit', color: 'var(--ink)' }}>
          <span className="wkc-chip"><CalendarClock size={14} /></span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 13.5, fontWeight: 600 }}>With {s.withName}</span>
            <span style={{ display: 'block', ...muted, fontSize: 12, marginTop: 2 }}>
              {s.status === 'ended' ? 'Ended' : s.next ? `Next ${formatDateTime(s.next.at)}` : 'Nothing scheduled'} · {s.cadenceLabel}
            </span>
          </span>
          {s.status === 'active' && !s.teamsMeeting && (
            <span title={s.graphError || 'No Teams meeting'} style={{ color: NX.amber, display: 'inline-flex' }}><AlertTriangle size={15} /></span>
          )}
        </button>
      ))}
    </div>
  );
}

const field = { display: 'grid', gap: 5, minWidth: 0 };

export function NewOneOnOneModal({ ctx, reportEmail = '', onClose, onCreated, toastOk, toastErr }) {
  const reports = useMemo(() => (ctx?.reports || []).map(r => ({ email: r.email, name: r.name })), [ctx]);
  const [who, setWho] = useState(reportEmail || reports[0]?.email || '');
  const [day, setDay] = useState('');
  const [time, setTime] = useState('10:00');
  const [length, setLength] = useState(30);
  const [cadence, setCadence] = useState('weekly');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function save() {
    if (!who) { setErr('Pick who the 1:1 is with.'); return; }
    if (!day || !time) { setErr('Pick the day and time of the first one.'); return; }
    setBusy(true); setErr('');
    try {
      const out = await api.perfOneOnOneCreate({ report_email: who, start_local: `${day}T${time}`, time_zone: localTimeZone(),
        cadence, duration_min: Number(length), title });
      if (out.teamsMeeting) toastOk?.('1:1 set up - the Teams invite is on both calendars.');
      else toastErr?.(`1:1 set up in Nexus, but no Teams meeting was made: ${out.graphError || 'Microsoft did not answer.'}`);
      onCreated?.(out);
    } catch (e) { setErr(e?.message || 'Could not set up the 1:1.'); }
    finally { setBusy(false); }
  }
  return (
    <Modal title="Set Up a 1:1" onClose={onClose}
      footer={<>
        <button type="button" className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="primary-btn" onClick={save} disabled={busy}>{busy ? 'Setting Up…' : 'Set Up 1:1'}</button>
      </>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, flex: 1 }}>
        {err && <ErrorBanner message={err} />}
        {!reports.length ? <div style={muted}>1:1s are set up with the people who report to you - nobody reports to you in Nexus People yet.</div> : (<>
          <div style={field}>
            <span style={LBL}>With</span>
            <PersonSelect value={who} onChange={setWho} people={reports} allowNone={false} ariaLabel="With" />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
            <div style={field}>
              <span style={LBL}>First One On</span>
              <span className="form-input" style={{ display: 'flex', alignItems: 'center' }}>
                <DateField value={day} onChange={setDay} noPast placeholder="Pick a day" style={{ width: '100%' }} />
              </span>
            </div>
            <label style={field}>
              <span style={LBL}>Time</span>
              <TimeField value={time} onChange={setTime} ariaLabel="Time" />
            </label>
            <label style={field}>
              <span style={LBL}>Length</span>
              <select className="form-input" value={length} onChange={e => setLength(e.target.value)}>
                {[15, 30, 45, 60].map(m => <option key={m} value={m}>{m} Minutes</option>)}
              </select>
            </label>
            <label style={field}>
              <span style={LBL}>Repeats</span>
              <select className="form-input" value={cadence} onChange={e => setCadence(e.target.value)}>
                {CADENCES.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
              </select>
            </label>
          </div>
          <label style={field}>
            <span style={LBL}>Title</span>
            <input className="form-input" value={title} onChange={e => setTitle(e.target.value)} placeholder="1:1 - you and them" />
          </label>
          <div style={{ ...muted, lineHeight: 1.5 }}>
            A Teams meeting goes on your calendar and theirs. Either of you can add to the agenda before each meeting; your private notes are only ever shown to you.
          </div>
        </>)}
      </div>
    </Modal>
  );
}

function Agenda({ meeting, series, onChange, toastErr }) {
  const [text, setText] = useState('');
  const pointRef = useRef(null);
  const open = meeting.status !== 'canceled';
  const run = (p) => p.then(onChange).catch(e => toastErr?.(e?.message || 'Could not save that.'));
  return (
    <section>
      <div style={{ ...LBL, marginBottom: 6 }}>Agenda</div>
      {!meeting.agenda.length && <div style={{ ...muted, marginBottom: 6 }}>Nothing on the agenda yet - add what you want to talk about.</div>}
      <div style={{ display: 'grid', gap: 4 }}>
        {meeting.agenda.map(a => (
          <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5 }}>
            <input type="checkbox" checked={a.done} aria-label={`Talked about: ${a.text}`}
              onChange={e => run(api.perfAgendaUpdate(a.id, { done: e.target.checked }))} />
            <span style={{ flex: 1, textDecoration: a.done ? 'line-through' : 'none', color: a.done ? 'var(--muted)' : 'var(--ink)' }}>{a.text}</span>
            <span style={{ ...muted, fontSize: 11.5 }}>{a.byName}</span>
            {a.mine && meeting.status === 'scheduled' && (
              <button type="button" className="secondary-btn" aria-label={`Remove ${a.text}`} title="Remove"
                onClick={() => run(api.perfAgendaRemove(a.id))} style={{ padding: 4 }}><Trash2 size={13} /></button>
            )}
          </div>
        ))}
      </div>
      {open && series.current && (
        <form onSubmit={e => { e.preventDefault(); if (!text.trim()) return; run(api.perfAgendaAdd(meeting.id, text.trim())); setText(''); }}
          style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <input ref={pointRef} className="form-input" value={text} onChange={e => setText(e.target.value)} placeholder="Add a talking point" aria-label="Add a talking point" style={{ flex: 1 }} />
          <DictateButton target={pointRef} title="Say the Talking Point" />
          <button type="submit" className="secondary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Plus size={14} /> Add</button>
        </form>
      )}
    </section>
  );
}

function Actions({ meeting, series, onChange, toastErr }) {
  const me = series.side === 'manager' ? series.managerEmail : series.reportEmail;
  const pair = [{ email: series.managerEmail, name: series.managerName }, { email: series.reportEmail, name: series.reportName }];
  const [text, setText] = useState('');
  const itemRef = useRef(null);
  const [owner, setOwner] = useState(series.reportEmail);
  const [due, setDue] = useState('');
  const [makeTask, setMakeTask] = useState(true);
  const [busy, setBusy] = useState(false);
  async function add(e) {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    try {
      onChange(await api.perfActionAdd(meeting.id, { text: text.trim(), owner_email: owner, due_on: due, make_task: makeTask }));
      setText(''); setDue('');
    } catch (err) { toastErr?.(err?.message || 'Could not add the action item.'); }
    finally { setBusy(false); }
  }
  return (
    <section>
      <div style={{ ...LBL, marginBottom: 6 }}>Action Items</div>
      {!meeting.actions.length && <div style={{ ...muted, marginBottom: 6 }}>No action items.</div>}
      <div style={{ display: 'grid', gap: 4 }}>
        {meeting.actions.map(a => (
          <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5, flexWrap: 'wrap' }}>
            <input type="checkbox" checked={a.done} aria-label={`Done: ${a.text}`}
              onChange={e => api.perfActionUpdate(a.id, { done: e.target.checked }).then(onChange).catch(err => toastErr?.(err?.message || 'Could not update it.'))} />
            <span style={{ flex: 1, minWidth: 140, textDecoration: a.done ? 'line-through' : 'none' }}>{a.text}</span>
            <span style={{ ...muted, fontSize: 12 }}>{[a.owner === me ? 'You' : a.ownerName, a.dueOn ? `Due ${formatDate(a.dueOn)}` : '', a.taskCode ? `Task ${a.taskCode}` : ''].filter(Boolean).join(' · ')}</span>
          </div>
        ))}
      </div>
      {series.current && meeting.status !== 'canceled' && (
        <form onSubmit={add} style={{ display: 'grid', gap: 8, marginTop: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <input ref={itemRef} className="form-input" value={text} onChange={e => setText(e.target.value)} placeholder="Add an action item" aria-label="Add an action item" style={{ flex: 1, minWidth: 0 }} />
            <DictateButton target={itemRef} title="Say the Action Item" />
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ minWidth: 170 }}><PersonSelect value={owner} onChange={setOwner} people={pair} allowNone={false} ariaLabel="Owner" /></span>
            <span className="form-input" style={{ display: 'inline-flex', alignItems: 'center', width: 160 }}>
              <DateField value={due} onChange={setDue} noPast placeholder="No due date" style={{ width: '100%' }} />
            </span>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
              <input type="checkbox" checked={makeTask} onChange={e => setMakeTask(e.target.checked)} /> Make It a Task
            </label>
            <button type="submit" className="secondary-btn" disabled={busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Plus size={14} /> Add</button>
          </div>
        </form>
      )}
    </section>
  );
}

function MeetingPane({ meeting, series, onChange, toastOk, toastErr }) {
  const [shared, setShared] = useState(meeting.sharedNotes);
  const sharedRef = useRef(null);
  const privRef = useRef(null);
  const [priv, setPriv] = useState(meeting.privateNotes || '');
  const [busy, setBusy] = useState(false);
  const isManager = series.side === 'manager';
  const live = !!series.current;
  const dirty = shared !== meeting.sharedNotes || (isManager && priv !== (meeting.privateNotes || ''));
  async function patch(data, ok) {
    setBusy(true);
    try { onChange(await api.perfMeetingUpdate(meeting.id, { ...data, ...('shared_notes' in data ? { notes_at: meeting.notesAt || '' } : {}) })); if (ok) toastOk?.(ok); }
    catch (e) { toastErr?.(e?.message || 'Could not save.'); }
    finally { setBusy(false); }
  }
  const st = MEETING_STATUS[meeting.status] || MEETING_STATUS.scheduled;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, flex: 1, minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 15, fontWeight: 700 }}>{formatDateTime(meeting.at)}</span>
        <StatusLabel label={st.label} color={st.color} size="sm" />
        {series.joinUrl && meeting.status === 'scheduled' && (
          <a href={series.joinUrl} target="_blank" rel="noopener noreferrer" className="secondary-btn"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 'auto', textDecoration: 'none' }}><Video size={14} /> Join Teams Meeting</a>
        )}
      </div>
      <Agenda meeting={meeting} series={series} onChange={onChange} toastErr={toastErr} />
      {/* A mic on each (Oct 30 2026): say the notes during or right after the 1:1. */}
      <div className="nx-fill" style={{ display: 'flex', flexDirection: 'column', gap: 5, flex: 1 }}>
        <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span style={LBL}>Shared Notes</span>
          {live && <DictateButton target={sharedRef} title="Say the Shared Notes" />}
        </span>
        <textarea ref={sharedRef} aria-label="Shared Notes" className="form-input" value={shared} readOnly={!live} onChange={e => setShared(e.target.value)} placeholder="Notes you both see" style={{ fontFamily: 'inherit' }} />
      </div>
      {isManager && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ ...LBL, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Lock size={12} /> Private Notes - Only You See These</span>
            {live && <DictateButton target={privRef} title="Say the Private Notes" />}
          </span>
          <textarea ref={privRef} aria-label="Private Notes" className="form-input" rows={4} value={priv} readOnly={!live} onChange={e => setPriv(e.target.value)} placeholder="Never shown to them" style={{ fontFamily: 'inherit', resize: 'vertical' }} />
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {live && dirty && <button type="button" className="primary-btn" disabled={busy}
          onClick={() => patch({ shared_notes: shared, ...(isManager ? { private_notes: priv } : {}) }, 'Notes saved.')}>Save Notes</button>}
        {live && meeting.status === 'scheduled' && (
          <button type="button" className="secondary-btn" disabled={busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            onClick={() => patch({ status: 'done', ...(dirty ? { shared_notes: shared, ...(isManager ? { private_notes: priv } : {}) } : {}) }, 'Marked as done.')}>
            <Check size={14} /> Mark as Done
          </button>
        )}
        {live && meeting.status === 'scheduled' && isManager && (
          <button type="button" className="secondary-btn" disabled={busy} onClick={() => patch({ status: 'canceled' }, 'Meeting canceled in Nexus.')}>Cancel This One</button>
        )}
      </div>
      <Actions meeting={meeting} series={series} onChange={onChange} toastErr={toastErr} />
    </div>
  );
}

export function OneOnOneModal({ seriesId, onClose, onChanged, toastOk, toastErr }) {
  const [s, setS] = useState(null);
  const [err, setErr] = useState('');
  const [pick, setPick] = useState('');
  useEffect(() => {
    let live = true;
    api.perfOneOnOne(seriesId).then(r => { if (live) { setS(r); setPick(r.next?.id || r.meetings?.[0]?.id || ''); } })
      .catch(e => { if (live) setErr(e?.message || 'Could not load the 1:1.'); });
    return () => { live = false; };
  }, [seriesId]);
  const update = useCallback((out) => { setS(out); onChanged?.(out); }, [onChanged]);
  async function end() {
    try { update(await api.perfOneOnOneEnd(s.id)); toastOk?.('1:1 ended - its notes stay here.'); }
    catch (e) { toastErr?.(e?.message || 'Could not end the 1:1.'); }
  }
  const meeting = s?.meetings?.find(m => m.id === pick) || null;
  const nowUtc = new Date().toISOString().slice(0, 19);
  const upcoming = (s?.meetings || []).filter(m => m.status === 'scheduled' && m.at >= nowUtc).reverse();
  const past = (s?.meetings || []).filter(m => !upcoming.includes(m));
  return (
    <Modal title={s ? `1:1 With ${s.withName}` : '1:1'} onClose={onClose} width="72vw"
      footer={<>
        {s?.side === 'manager' && s.status === 'active' && <button type="button" className="secondary-btn" onClick={end}>End This 1:1</button>}
        <button type="button" className="primary-btn" onClick={onClose}>Done</button>
      </>}>
      {err ? <ErrorBanner message={err} /> : !s ? <LoadingState size="section" label="Loading the 1:1" /> : (
        <div style={{ display: 'flex', gap: 18, flex: 1, minHeight: 0, flexWrap: 'wrap' }}>
          <nav aria-label="Meetings" style={{ flex: '0 0 210px', minWidth: 180, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ ...muted, fontSize: 12, marginBottom: 4 }}>{s.cadenceLabel}{s.status === 'ended' ? ' · Ended' : ''}</div>
            {s.status === 'active' && !s.current && (
              <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6, lineHeight: 1.4 }}>{s.reportName} no longer reports to {s.managerName} - this 1:1 is kept as history.</div>
            )}
            {!s.teamsMeeting && s.current && (
              <div style={{ fontSize: 12, color: NX.amber, marginBottom: 6, lineHeight: 1.4 }}>No Teams meeting: {s.graphError || 'Microsoft did not answer.'}</div>
            )}
            {[['Upcoming', upcoming], ['Past', past]].map(([label, list]) => list.length > 0 && (
              <div key={label} style={{ display: 'grid', gap: 3, marginBottom: 8 }}>
                <div style={LBL}>{label}</div>
                {list.map(m => (
                  <button key={m.id} type="button" onClick={() => setPick(m.id)} aria-current={m.id === pick ? 'true' : undefined}
                    style={{ textAlign: 'left', padding: '7px 9px', borderRadius: 8, border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5,
                      background: m.id === pick ? 'var(--wk-brand-tint)' : 'transparent', color: m.id === pick ? 'var(--wk-brand)' : 'var(--ink)', fontWeight: m.id === pick ? 700 : 500 }}>
                    {formatDateTime(m.at)}{m.status !== 'scheduled' ? ` · ${MEETING_STATUS[m.status]?.label || m.status}` : ''}
                  </button>
                ))}
              </div>
            ))}
          </nav>
          <div style={{ flex: '1 1 380px', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            {meeting ? <MeetingPane key={meeting.id} meeting={meeting} series={s} onChange={update} toastOk={toastOk} toastErr={toastErr} />
              : <div style={muted}>Pick a meeting.</div>}
          </div>
        </div>
      )}
    </Modal>
  );
}
