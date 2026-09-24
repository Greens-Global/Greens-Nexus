// Task Module - the due-date conversation, under the Due Date row of the task
// drawer (Neil, Sep 24).
//
// "I can say, Sagar please finish Nexus Sign on Friday. But you could feel it
// was never possible on Friday. That negotiation must be done." A date set for
// somebody else is a target until they confirm it. The assignee confirms or
// proposes another date; the requester accepts or declines. Once agreed,
// pushing it later is an extension and is counted (DueBadge). The server
// (backend task_due.py) owns the rules - this only offers the next step.
import { useState } from 'react';
import { CalendarCheck, CalendarClock, ChevronRight, History } from 'lucide-react';
import { api } from '../api';
import { useTasks } from './TasksContext';
import { NX, FONT, btn, input as inputStyle } from './theme';
import { DateField } from './components';
import { taskAssignees, fmtDate } from './lib';
import { dueHistoryLines } from './dueHistory';

function Panel({ color, icon: Icon, children }) {
  return (
    <div style={{
      display: 'flex', gap: 9, alignItems: 'flex-start', padding: '9px 11px', borderRadius: 10,
      background: `${color}14`, border: `1px solid ${color}40`, fontSize: 12.5, color: NX.ink, width: '100%',
    }}>
      <Icon size={15} style={{ color, flexShrink: 0, marginTop: 1 }} />
      <div style={{ flex: 1, minWidth: 0, display: 'grid', gap: 8 }}>{children}</div>
    </div>
  );
}

export default function DueNegotiation({ task }) {
  const { myEmail, nameOf, applyServerTask } = useTasks();
  const [mode, setMode] = useState(null);     // null | 'propose' | 'counter'
  const [date, setDate] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);

  const me = (myEmail || '').toLowerCase();
  const assignees = taskAssignees(task);
  const isAssignee = assignees.includes(me);
  const requester = task.requesterId || '';
  const isRequester = requester && requester === me;
  const agreement = task.dueAgreement || '';
  const proposal = task.dueProposal;
  const history = dueHistoryLines(task, nameOf);
  const who = (e) => (e ? nameOf?.(e) || e : 'the requester');

  const run = async (call) => {
    setBusy(true); setErr('');
    try {
      applyServerTask?.(await call());
      setMode(null); setDate(''); setNote('');
    } catch (e) {
      setErr(e?.message || 'Could not save that.');
    } finally {
      setBusy(false);
    }
  };

  let panel = null;
  if (task.dueOn && !task.completed && agreement === 'pending') {
    if (isAssignee) {
      panel = (
        <Panel color={NX.amber} icon={CalendarClock}>
          <div>
            <b>{who(requester)}</b> set this for <b>{fmtDate(task.dueOn)}</b>. Can you make it?
          </div>
          {mode === 'propose' ? (
            <div style={{ display: 'grid', gap: 6 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ color: NX.dim }}>Propose</span>
                <DateField value={date} onChange={setDate} noPast title="Proposed Due Date"
                  style={{ ...inputStyle, width: 'auto', padding: '5px 9px', fontSize: 12 }} />
              </div>
              <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500}
                placeholder="Why this date? (optional)" style={{ ...inputStyle, fontSize: 12.5, padding: '6px 9px' }} />
              <div style={{ display: 'flex', gap: 6 }}>
                <button disabled={busy || !date} onClick={() => run(() => api.proposeTaskDue(task.id, date, note.trim()))}
                  style={{ ...btn('primary'), padding: '6px 11px', fontSize: 12.5, opacity: busy || !date ? 0.6 : 1 }}>Send Proposal</button>
                <button onClick={() => { setMode(null); setErr(''); }} style={{ ...btn('ghost'), padding: '6px 11px', fontSize: 12.5 }}>Cancel</button>
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button disabled={busy} onClick={() => run(() => api.confirmTaskDue(task.id))}
                style={{ ...btn('primary'), padding: '6px 11px', fontSize: 12.5 }}>Confirm Date</button>
              <button disabled={busy} onClick={() => setMode('propose')}
                style={{ ...btn('outline'), padding: '6px 11px', fontSize: 12.5 }}>Propose New Date</button>
            </div>
          )}
        </Panel>
      );
    } else if (assignees.length) {
      panel = (
        <div style={{ fontSize: 12, color: NX.faint }}>
          Waiting for {assignees.map(who).join(', ')} to confirm this date.
        </div>
      );
    }
  } else if (task.dueOn && !task.completed && agreement === 'proposed' && proposal) {
    const proposer = who(proposal.by);
    if (isRequester) {
      panel = (
        <Panel color={NX.blue} icon={CalendarClock}>
          <div>
            <b>{proposer}</b> asked to move this from <b>{fmtDate(task.dueOn)}</b> to <b>{fmtDate(proposal.dueOn)}</b>.
            {proposal.note && <div style={{ color: NX.dim, marginTop: 3 }}>"{proposal.note}"</div>}
          </div>
          {mode === 'counter' && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ color: NX.dim }}>Suggest</span>
              <DateField value={date} onChange={setDate} noPast title="Suggested Due Date"
                style={{ ...inputStyle, width: 'auto', padding: '5px 9px', fontSize: 12 }} />
            </div>
          )}
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500}
            placeholder={mode === 'counter' ? 'Why this date? (optional)' : 'Add a note (optional)'}
            style={{ ...inputStyle, fontSize: 12.5, padding: '6px 9px' }} />
          {mode === 'counter' ? (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button disabled={busy || !date} onClick={() => run(() => api.respondTaskDue(task.id, false, note.trim(), date))}
                style={{ ...btn('primary'), padding: '6px 11px', fontSize: 12.5, opacity: busy || !date ? 0.6 : 1 }}>Send Suggestion</button>
              <button onClick={() => { setMode(null); setDate(''); setErr(''); }}
                style={{ ...btn('ghost'), padding: '6px 11px', fontSize: 12.5 }}>Cancel</button>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button disabled={busy} onClick={() => run(() => api.respondTaskDue(task.id, true, note.trim()))}
                style={{ ...btn('primary'), padding: '6px 11px', fontSize: 12.5 }}>Accept {fmtDate(proposal.dueOn)}</button>
              <button disabled={busy} onClick={() => run(() => api.respondTaskDue(task.id, false, note.trim()))}
                style={{ ...btn('outline'), padding: '6px 11px', fontSize: 12.5 }}>Keep {fmtDate(task.dueOn)}</button>
              <button disabled={busy} onClick={() => { setMode('counter'); setErr(''); }}
                style={{ ...btn('outline'), padding: '6px 11px', fontSize: 12.5 }}>Suggest New Date</button>
            </div>
          )}
        </Panel>
      );
    } else {
      panel = (
        <div style={{ fontSize: 12, color: NX.faint }}>
          {(proposal.by || '').toLowerCase() === me ? 'You' : proposer} proposed {fmtDate(proposal.dueOn)} - waiting for {who(requester)} to answer.
        </div>
      );
    }
  } else if (task.dueOn && agreement === 'accepted' && isRequester && !isAssignee) {
    panel = (
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: NX.green }}>
        <CalendarCheck size={13} /> Confirmed by {assignees.map(who).join(', ')}
      </div>
    );
  }

  if (!panel && history.length <= 1 && !task.dueExtensionCount) return null;
  return (
    <div style={{ display: 'grid', gap: 6, marginLeft: 108, fontFamily: FONT }}>
      {panel}
      {err && <div style={{ fontSize: 12, color: NX.red }}>{err}</div>}
      {history.length > 1 && (
        <div>
          <button onClick={() => setHistoryOpen((o) => !o)} aria-expanded={historyOpen}
            style={{ ...btn('ghost'), padding: '2px 0', fontSize: 12, gap: 4, color: NX.dim }}>
            <ChevronRight size={13} style={{ transform: historyOpen ? 'rotate(90deg)' : 'none', transition: 'transform .12s' }} />
            <History size={12} /> Date History ({history.length})
          </button>
          {historyOpen && (
            <div style={{ display: 'grid', gap: 4, marginTop: 4, paddingLeft: 18 }}>
              {history.map((h, i) => (
                <div key={`${h.at}-${i}`} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: NX.dim }}>
                  <span style={{ minWidth: 0 }}>{h.text}</span>
                  {h.extension && <span style={{ fontSize: 10.5, fontWeight: 700, color: NX.red, flexShrink: 0 }}>Extension</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
