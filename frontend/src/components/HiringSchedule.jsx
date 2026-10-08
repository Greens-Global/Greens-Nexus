// Interview scheduling - the ONE way an interview gets on the calendar
// (Neil, Oct 8: "I don't think this is a necessary step. I think it's getting
// confusing" - there used to be a date-only field on the card AND a second
// schedule inside the Interview Room).
//
//   SchedulingFields        - date, time, length, who it is with, questionnaire
//   ScheduleInterviewModal  - schedule / reschedule from the candidate
//   questionnaireFor        - the role's questionnaire, else General (same rule
//                             as the server's questionnaire_for)
//
// The Teams invite goes to the candidate and every interviewer; scheduling
// moves the candidate to Interview (or back from Offer for another round).
import { useEffect, useState } from 'react';
import { X, Video, CalendarDays } from 'lucide-react';
import { api } from '../api';
import { usePeopleDirectory } from '../lib/queries';
import { useRole } from '../contexts/RoleContext';
import { formatDateTime } from '../lib/datetime';
import PersonSearchSelect from './PersonSearchSelect';
import { Spinner } from './AsyncState';

const FL = { fontSize: 11, fontWeight: 700, color: 'var(--muted)', display: 'block', marginBottom: 5, letterSpacing: '.04em', textTransform: 'uppercase' };
const hint = { fontSize: 11.5, color: 'var(--muted)', marginTop: 4 };
const DURATIONS = [15, 30, 45, 60, 90, 120];

export function questionnaireFor(tpls, roleId) {
  return (roleId && (tpls || []).find(t => (t.roleIds || []).includes(roleId))) || (tpls || []).find(t => t.isGeneral) || null;
}

const pad = n => String(n).padStart(2, '0');
function nextHour() {
  const d = new Date(); d.setMinutes(0, 0, 0); d.setHours(d.getHours() + 1);
  return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:00` };
}
export function emptySchedule(myEmail, from) {
  if (from?.at) {
    const d = new Date(from.at);
    return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
             duration: from.durationMin || 45, interviewers: from.interviewerEmails?.length ? from.interviewerEmails : [myEmail].filter(Boolean),
             templateId: from.templateId || '' };
  }
  return { ...nextHour(), duration: 45, interviewers: [myEmail].filter(Boolean), templateId: '' };
}
export function scheduleBody(v, replaceId = '') {
  return { at: new Date(`${v.date}T${v.time}`).toISOString(), duration_min: Number(v.duration) || 45,
           interviewer_emails: v.interviewers, template_id: v.templateId || '', replace_interview_id: replaceId };
}
export function scheduleProblems(v) {
  return [!v.date && 'Date', !v.time && 'Time', !(v.interviewers || []).length && 'Who it is with'].filter(Boolean);
}

export function SchedulingFields({ value: v, onChange, roleId, tpls }) {
  const { data: people = [] } = usePeopleDirectory();
  const set = (k, x) => onChange({ ...v, [k]: x });
  const name = e => people.find(p => p.email === e)?.name || e;
  const auto = questionnaireFor(tpls, roleId);
  const pickedTpl = v.templateId && v.templateId !== 'none' ? (tpls || []).find(t => t.id === v.templateId) : null;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
      <div><label style={FL}>Date *</label>
        <input type="date" className="form-input" style={{ width: '100%' }} value={v.date} onChange={e => set('date', e.target.value)} /></div>
      <div><label style={FL}>Time *</label>
        <input type="time" className="form-input" style={{ width: '100%' }} value={v.time} onChange={e => set('time', e.target.value)} /></div>
      <div><label style={FL}>Length</label>
        <select className="form-input" style={{ width: '100%' }} value={v.duration} onChange={e => set('duration', Number(e.target.value))}>
          {DURATIONS.map(m => <option key={m} value={m}>{m} minutes</option>)}
        </select></div>
      <div style={{ gridColumn: '1 / -1' }}><label style={FL}>With *</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
          {(v.interviewers || []).map(e => (
            <span key={e} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 6px 3px 10px', borderRadius: 999, background: 'var(--mist)', border: '1px solid var(--line)', fontSize: 12 }}>
              {name(e)}
              <button type="button" aria-label={`Remove ${name(e)}`} onClick={() => set('interviewers', v.interviewers.filter(x => x !== e))}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 2 }}><X size={12} /></button>
            </span>
          ))}
        </div>
        <PersonSearchSelect placeholder="+ add an interviewer - type a name"
          groups={[{ label: 'Nexus People', people: people.filter(p => !(v.interviewers || []).includes(p.email)) }]}
          onPick={e => e && set('interviewers', [...(v.interviewers || []), e])} />
        <div style={hint}>Everyone here gets the Teams invite with the candidate.</div>
      </div>
      <div style={{ gridColumn: '1 / -1' }}><label style={FL}>Questionnaire</label>
        <select className="form-input" style={{ width: '100%' }} value={v.templateId} onChange={e => set('templateId', e.target.value)}>
          <option value="">{auto ? `${auto.name} (${(auto.roleIds || []).includes(roleId) ? 'for this role' : 'General'})` : 'None set up for this role'}</option>
          {(tpls || []).filter(t => t.id !== auto?.id).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          <option value="none">No questionnaire</option>
        </select>
        <div style={hint}>{pickedTpl ? 'Using a different questionnaire for this round.' : auto ? 'Picked from the role automatically.' : 'Link a questionnaire to this role (or mark one General) under Questionnaires.'}</div>
      </div>
    </div>
  );
}

export function ScheduleInterviewModal({ candidate: c, replace, onClose, onScheduled, toastOk, toastErr }) {
  const { myEmail } = useRole();
  const [tpls, setTpls] = useState([]);
  const [v, setV] = useState(() => emptySchedule(myEmail, replace));
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.ivTemplates().then(setTpls).catch(() => {}); }, []);
  const problems = scheduleProblems(v);
  const name = [c.firstName, c.lastName].filter(Boolean).join(' ');

  async function go() {
    if (problems.length || busy) return;
    setBusy(true);
    try {
      const iv = await api.ivSchedule(c.id, scheduleBody(v, replace?.id || ''));
      if (iv.inviteSent) toastOk?.(`${replace ? 'Rescheduled' : 'Scheduled'} - Teams invite sent to ${name} and the interviewers.`);
      else toastErr?.(`${replace ? 'Rescheduled' : 'Scheduled'}, but the Teams invite did not go out: ${iv.graphError || 'unknown error'}`);
      onScheduled?.(iv);
    } catch (e) { toastErr?.(e?.message || 'Could not schedule the interview.'); setBusy(false); }
  }
  return (
    <div onClick={e => e.target === e.currentTarget && onClose()}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1260, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth: 'clamp(480px, 50vw, 720px)', maxHeight: 'min(92dvh, 760px)', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)', fontFamily: 'Inter,sans-serif' }}>
        <div style={{ padding: '16px 22px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 800, fontSize: 15.5 }}>{replace ? 'Reschedule Interview' : 'Schedule Interview'} - {name}</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 1 }}>
              {replace ? <>Moving the round on {formatDateTime(replace.at)}. The old invite is withdrawn.</>
                : c.stage === 'offer' ? 'Another round - this moves them back to Interview.'
                  : `Teams invite to ${c.email || 'their email'} and everyone interviewing.`}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ overflowY: 'auto', flex: 1, padding: '16px 22px' }}>
          {!c.email && <div style={{ fontSize: 12.5, color: 'hsl(var(--color-orange))', marginBottom: 12 }}>Add the candidate's email first (Edit) - the invite goes there.</div>}
          <SchedulingFields value={v} onChange={setV} roleId={c.roleId} tpls={tpls} />
        </div>
        <div style={{ padding: '12px 22px', borderTop: '1px solid var(--line)', display: 'flex', gap: 10, justifyContent: 'flex-end', alignItems: 'center' }}>
          {problems.length > 0 && <span style={{ fontSize: 11.5, color: 'var(--muted)', marginRight: 'auto' }}>Still needed: {problems.join(', ')}</span>}
          <button className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary-btn" onClick={go} disabled={busy || !!problems.length || !c.email} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {busy ? <Spinner size={14} /> : replace ? <CalendarDays size={14} /> : <Video size={14} />} {replace ? 'Reschedule' : 'Schedule And Send Invite'}
          </button>
        </div>
      </div>
    </div>
  );
}
