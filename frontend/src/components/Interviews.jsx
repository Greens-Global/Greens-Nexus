import { useState, useEffect } from 'react';
import {
  X, Plus, Trash2, Video, Sparkles, Trophy, Send, FileText,
  CheckCircle, Play, ClipboardList, RefreshCw, Save, ChevronRight, XCircle, CalendarDays, Clock, AlertTriangle,
} from 'lucide-react';
import { api } from '../api';
import { dialog } from '../ui/dialog';
import { formatDate, formatDateTime } from '../lib/datetime';
import { useUnsavedGuard } from '../lib/useUnsavedGuard';
import UnsavedChangesPrompt from './UnsavedChangesPrompt';
import { Spinner } from './AsyncState';

// AI-assisted interviews: Teams invite → live questionnaire → transcript
// auto-fill → calibrated scores → role leaderboard → final-round invite.

const Overlay = ({ children, onClose, wide }) => (
  <div onClick={e => e.target === e.currentTarget && onClose()}
    style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1250, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
    <div style={{ background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth: 'clamp(560px, 60vw, 1100px)', maxHeight: 'min(92dvh, 780px)', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)', fontFamily: 'Inter,sans-serif' }}>
      {children}
    </div>
  </div>
);
const Head = ({ title, sub, onClose }) => (
  <div style={{ padding: '16px 22px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
    <div style={{ flex: 1 }}>
      <div style={{ fontWeight: 800, fontSize: 15.5 }}>{title}</div>
      {sub && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 1 }}>{sub}</div>}
    </div>
    <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
  </div>
);
const lbl = { fontSize: 11, fontWeight: 700, color: 'var(--muted)', display: 'block', margin: '10px 0 4px', textTransform: 'uppercase', letterSpacing: '.04em' };
const STATUS_CHIP = {
  scheduled: ['hsla(var(--color-blue),0.12)', 'hsl(var(--color-blue))'],
  live:      ['hsla(var(--color-orange),0.14)', 'hsl(var(--color-orange))'],
  completed: ['var(--mist)', 'var(--muted)'],
  scored:    ['hsla(var(--color-green),0.12)', 'hsl(var(--color-green))'],
};
const Chip = ({ s }) => { const [bg, fg] = STATUS_CHIP[s] || STATUS_CHIP.scheduled; return <span style={{ padding: '2px 10px', borderRadius: 12, fontSize: 10.5, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.04em', background: bg, color: fg }}>{s}</span>; };

// Open a recording / transcript through its short-lived link (private bucket).
async function openInterviewFile(iv, kind, toastErr) {
  try { const { url } = await api.ivFile(iv.id, kind); window.open(url, '_blank', 'noopener'); }
  catch (e) { toastErr?.(e?.message || 'Could not open the file.'); }
}
const fmtMb = b => (b > 0 ? ` (${(b / 1048576).toFixed(b > 10485760 ? 0 : 1)} MB)` : '');

// Where the recording stands for one round (Pranshu, Oct 8: the meeting
// records itself; afterwards the recording and transcript are kept).
export function RecordingLine({ iv, onPull, busy, toastErr, compact }) {
  const links = (
    <>
      {iv.hasRecording && (
        <button type="button" className="secondary-btn" style={{ fontSize: 11.5, padding: '3px 10px', display: 'inline-flex', alignItems: 'center', gap: 5 }}
          onClick={() => openInterviewFile(iv, 'recording', toastErr)}><Play size={11} /> Play Recording{fmtMb(iv.recordingSize)}</button>
      )}
      {iv.hasTranscriptFile && (
        <button type="button" className="secondary-btn" style={{ fontSize: 11.5, padding: '3px 10px', display: 'inline-flex', alignItems: 'center', gap: 5 }}
          onClick={() => openInterviewFile(iv, 'transcript', toastErr)}><FileText size={11} /> Transcript</button>
      )}
    </>
  );
  if (['scheduled', 'live'].includes(iv.status)) {
    if (!iv.joinUrl) return null;
    const on = iv.autoRecord === 'on';
    return (
      <div style={{ fontSize: 12, color: on ? 'hsl(var(--color-green))' : 'hsl(var(--color-orange))', display: 'flex', gap: 6, alignItems: 'flex-start' }}>
        <Video size={13} style={{ flexShrink: 0, marginTop: 1 }} />
        <span>{on ? 'Auto-recording on - the call records and transcribes itself from the start.'
          : `Auto-recording is off${iv.autoRecord ? ` (${iv.autoRecord.replace(/^failed: /, '')})` : ''} - press Record in Teams when the call starts.`}</span>
      </div>
    );
  }
  if (iv.hasRecording || iv.hasTranscriptFile) {
    return <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>{links}</div>;
  }
  if (!iv.recordingStatus || compact) return null;
  const failed = iv.recordingStatus === 'failed';
  return (
    <div style={{ fontSize: 12, color: failed ? 'hsl(var(--color-red))' : 'var(--muted)', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      {failed ? <AlertTriangle size={13} /> : <Clock size={13} />}
      <span style={{ flex: 1 }}>{iv.recordingNote || 'Waiting for the Teams recording'}</span>
      {onPull && (
        <button type="button" className="secondary-btn" style={{ fontSize: 11.5, padding: '3px 10px' }} onClick={onPull} disabled={!!busy}>
          {busy ? <Spinner size={12} /> : 'Pull Recording'}
        </button>
      )}
    </div>
  );
}

// The rounds a person went through before they were hired - the profile's
// Interviews tab. Read only: the decision was made in the pipeline.
export function EmployeeInterviews({ employeeId, toastErr }) {
  const [rows, setRows] = useState(null);
  useEffect(() => { api.getEmployeeInterviews(employeeId).then(setRows).catch(() => setRows([])); }, [employeeId]);
  if (rows === null) return <div style={{ marginTop: 18 }}><Spinner size={15} /></div>;
  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.07em', color: 'var(--muted)', textTransform: 'uppercase', marginBottom: 8 }}>
        <Video size={11} style={{ verticalAlign: 'middle', marginRight: 5 }} />Interviews
      </div>
      {rows.length === 0 ? <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No interview rounds on record - they were added to People directly.</div>
        : rows.map(iv => (
          <div key={iv.id} style={{ border: '1px solid var(--line)', borderRadius: 10, padding: '9px 12px', marginBottom: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <b style={{ fontSize: 13 }}>{iv.at ? formatDateTime(iv.at) : 'Unscheduled'}</b>
              <Chip s={iv.status} />
              {iv.status === 'scored' && <span style={{ fontSize: 12, fontWeight: 800, color: 'hsl(var(--color-green))' }}><Trophy size={11} style={{ verticalAlign: 'middle', marginRight: 3 }} />{Math.round(iv.totalScore)}/100</span>}
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
              With {(iv.interviewerNames || iv.interviewerEmails || []).join(', ') || 'no one set'} · {iv.durationMin} minutes
              {iv.templateName ? ` · Questionnaire: ${iv.templateName}` : ''}
            </div>
            {iv.summary && <div style={{ fontSize: 12.5, marginTop: 6 }}><strong>AI verdict:</strong> {iv.summary}</div>}
            <div style={{ marginTop: 8 }}><RecordingLine iv={iv} toastErr={toastErr} compact /></div>
          </div>
        ))}
    </div>
  );
}

// ── Questionnaire templates ───────────────────────────────────────────────────
export function QuestionnairesModal({ onClose, toastOk, toastErr }) {
  const [tpls, setTpls] = useState(null);
  const [editing, setEditing] = useState(null);   // {id?, name, text, roleIds, isGeneral}
  const [busy, setBusy] = useState(false);
  const [roles, setRoles] = useState([]);
  const loadTpls = () => api.ivTemplates().then(setTpls).catch(() => setTpls([]));
  useEffect(() => { loadTpls(); api.hiringAllRoles().then(o => setRoles(o.roles || [])).catch(() => {}); }, []);
  const roleName = id => { const r = roles.find(x => x.id === id); return r ? r.name + (r.companyName ? ` (${r.companyName})` : '') : 'A removed role'; };

  const save = async () => {
    const questions = editing.text.split('\n').map(s => s.trim()).filter(Boolean);
    if (!editing.name.trim() || !questions.length) return;
    setBusy(true);
    try {
      const body = { name: editing.name, questions, role_ids: editing.roleIds || [], is_general: !!editing.isGeneral };
      editing.id ? await api.ivTemplateUpdate(editing.id, body) : await api.ivTemplateCreate(body);
      // A role belongs to one questionnaire and there is one General - the
      // server may have moved links off another one, so reload them all.
      await loadTpls();
      setEditing(null);
      toastOk?.('Questionnaire saved');
    } catch (e) { toastErr?.(e?.message || 'Could not save'); }
    finally { setBusy(false); }
  };

  const dirty = !!(editing && (editing.name.trim() || editing.text.trim()));
  const guard = useUnsavedGuard(dirty, onClose, save);

  return (
    <Overlay onClose={guard.requestClose}>
      <Head title="Interview Questionnaires" sub="Linked to roles - an interview uses its role's questionnaire, or the General one, automatically" onClose={guard.requestClose} />
      <div style={{ overflowY: 'auto', padding: '14px 22px' }}>
        {editing ? (
          <div>
            <label style={lbl}>Name</label>
            <input className="form-input" style={{ width: '100%' }} value={editing.name} onChange={e => setEditing(ed => ({ ...ed, name: e.target.value }))} placeholder='e.g. "Site Manager" or "General"' />
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '12px 0 2px', fontSize: 12.5, cursor: 'pointer' }}>
              <input type="checkbox" checked={!!editing.isGeneral} onChange={e => setEditing(ed => ({ ...ed, isGeneral: e.target.checked }))} style={{ accentColor: 'var(--pine)' }} />
              General - used for any role that has no questionnaire of its own
            </label>
            <label style={lbl}>Used For These Roles</label>
            <div style={{ border: '1px solid var(--line)', borderRadius: 10, maxHeight: 180, overflowY: 'auto', padding: '6px 10px' }}>
              {roles.length === 0 ? <div style={{ fontSize: 12, color: 'var(--muted)', padding: 4 }}>No job roles yet - they are set up in Settings &gt; Access.</div>
                : roles.map(r => {
                  const on = (editing.roleIds || []).includes(r.id);
                  const other = (tpls || []).find(t => t.id !== editing.id && (t.roleIds || []).includes(r.id));
                  return (
                    <label key={r.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0', fontSize: 12.5, cursor: 'pointer' }}>
                      <input type="checkbox" checked={on} style={{ accentColor: 'var(--pine)' }}
                        onChange={e => setEditing(ed => ({ ...ed, roleIds: e.target.checked ? [...(ed.roleIds || []), r.id] : (ed.roleIds || []).filter(x => x !== r.id) }))} />
                      <span style={{ flex: 1 }}>{r.name}{r.companyName ? <span style={{ color: 'var(--muted)' }}> - {r.companyName}</span> : null}</span>
                      {other && !on && <span style={{ fontSize: 11, color: 'var(--muted)' }}>now: {other.name}</span>}
                    </label>
                  );
                })}
            </div>
            <label style={lbl}>Questions - one per line</label>
            <textarea className="form-input" rows={10} style={{ width: '100%', resize: 'vertical', fontSize: 13, lineHeight: 1.6 }}
              value={editing.text} onChange={e => setEditing(ed => ({ ...ed, text: e.target.value }))}
              placeholder={'Walk me through your last role.\nHow would you handle an overdue vendor?\n…'} />
            <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
              <button className="secondary-btn" onClick={() => setEditing(null)}>Cancel</button>
              <button className="primary-btn" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save Questionnaire'}</button>
            </div>
          </div>
        ) : (
          <>
            {tpls === null ? <Spinner size="inline" />
              : tpls.length === 0 ? <div style={{ fontSize: 13, color: 'var(--muted)', padding: '20px 0', textAlign: 'center' }}>No questionnaires yet - create one per role.</div>
              : tpls.map(t => (
                <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', borderBottom: '1px solid var(--line)' }}>
                  <ClipboardList size={15} style={{ color: 'hsl(var(--color-purple))', flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 700 }}>{t.name}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                      {t.questions.length} question{t.questions.length !== 1 ? 's' : ''}
                      {' · '}{t.isGeneral ? 'General' : ''}{t.isGeneral && (t.roleIds || []).length ? ' + ' : ''}
                      {(t.roleIds || []).length ? (t.roleIds || []).map(roleName).join(', ') : t.isGeneral ? '' : 'Not linked to a role yet'}
                    </div>
                  </div>
                  <button className="secondary-btn" style={{ fontSize: 12, padding: '4px 12px' }}
                    onClick={() => setEditing({ id: t.id, name: t.name, text: t.questions.map(q => q.q).join('\n'), roleIds: t.roleIds || [], isGeneral: !!t.isGeneral })}>Edit</button>
                  <button onClick={async () => {
                      if (!await dialog.confirm(`Delete "${t.name}"?`, { title: 'Delete template', confirmText: 'Delete', danger: true })) return;
                      try { await api.ivTemplateDelete(t.id); setTpls(ts => ts.filter(x => x.id !== t.id)); toastOk?.('Template deleted.'); }
                      catch (e) { toastErr?.(e?.message || 'Could not delete the template.'); }
                    }}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 3 }}><Trash2 size={14} /></button>
                </div>
              ))}
            <button className="primary-btn" style={{ marginTop: 14, display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}
              onClick={() => setEditing({ name: '', text: '', roleIds: [], isGeneral: false })}>
              <Plus size={14} /> New Questionnaire
            </button>
          </>
        )}
      </div>
      {guard.confirming && (
        <UnsavedChangesPrompt
          onKeepEditing={guard.keepEditing}
          onDiscard={() => { setEditing(null); onClose(); }}
          onSave={guard.saveAndClose}
          saving={busy}
        />
      )}
    </Overlay>
  );
}

// ── Interview room for one candidate ──────────────────────────────────────────
// The room (Neil, Oct 8): the questions on screen during the call, and at the
// bottom right ONE clear way out - End Interview takes everything in (the
// answers typed now, the Teams transcript once it is published, the AI fill
// and the score) and Nexus finishes the merge by itself. Once scored, the
// decision is made right here: Move To Offer, Another Round, or Reject.
export function InterviewPanel({ candidate: c, onClose, onDecision, toastOk, toastErr }) {
  const [list, setList] = useState(null);
  const [sel, setSel] = useState(null);             // selected interview object
  const [busy, setBusy] = useState('');
  const [paste, setPaste] = useState('');
  const [showPaste, setShowPaste] = useState(false);

  useEffect(() => {
    api.ivList(c.id).then(all => {
      // Canceled rounds stay in the candidate's history, not in the room. Open
      // on the round happening now, else the next one, else the latest.
      const l = all.filter(x => x.status !== 'canceled');
      setList(l);
      const pick = l.find(x => x.status === 'live') || [...l].reverse().find(x => x.status === 'scheduled') || l[0];
      if (pick) setSel(pick);
    }).catch(() => setList([]));
  }, [c.id]);

  const run = (key, fn, okMsg) => async () => {
    setBusy(key);
    try { const r = await fn(); if (okMsg) toastOk?.(okMsg); return r; }
    catch (e) { toastErr?.(e?.message || 'Failed'); }
    finally { setBusy(''); }
  };
  const refreshSel = (updated) => { setSel(updated); setList(l => l.map(x => x.id === updated.id ? updated : x)); };

  const setAnswer = (qid, answer) => { setTyped(true); refreshSel({ ...sel, answers: sel.answers.map(a => a.qid === qid ? { ...a, answer } : a) }); };
  const [typed, setTyped] = useState(false);      // answers changed since the last save

  // While Nexus is merging (waiting on the Teams transcript, scoring), keep the
  // room current so HR sees it land without pressing anything.
  const waiting = sel?.followupStatus === 'waiting';
  useEffect(() => {
    if (!waiting) return undefined;
    const id = sel.id;
    const t = setInterval(() => {
      api.ivList(c.id).then(all => { const u = all.find(x => x.id === id); if (u) refreshSel(u); }).catch(() => {});
    }, 15000);
    return () => clearInterval(t);
  }, [waiting, sel?.id, c.id]);

  const saveAnswers = run('save', async () => { refreshSel({ ...(await api.ivPatch(sel.id, { answers: sel.answers })), followupStatus: sel.followupStatus }); setTyped(false); }, 'Answers saved');
  const endInterview = run('end', async () => {
    const u = await api.ivFinish(sel.id, { answers: sel.answers });
    refreshSel(u); setTyped(false);
    toastOk?.(u.followupNote?.startsWith('Waiting') ? 'Interview ended - Nexus pulls the Teams transcript as soon as it is published, then scores it.' : 'Interview ended - scoring now.');
  });
  const retryNow = run('retry', async () => refreshSel(await api.ivFollowupNow(sel.id)));
  const decide = (kind) => { if (onDecision) { onClose(); onDecision(kind, c); } };

  // A pending "schedule a round" draft or a pasted-but-unsaved transcript would
  // otherwise be silently lost on an overlay click - per-question answers are
  // excluded since those already auto-save onBlur (see onBlur below).
  const dirty = !!paste.trim() || typed;
  const guard = useUnsavedGuard(dirty, onClose, typed && sel ? saveAnswers : undefined);

  return (
    <Overlay onClose={guard.requestClose} wide>
      <Head title={`Interviews - ${c.firstName} ${c.lastName || ''}`} sub={c.roleTitle || c.department || ''} onClose={guard.requestClose} />
      <div style={{ overflowY: 'auto', padding: '14px 22px', flex: 1 }}>

        {/* Rounds */}
        {list === null ? <Spinner size={16} /> : list.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--muted)', padding: '24px 0', textAlign: 'center' }}>No interview scheduled yet - schedule it from the candidate.</div>
        ) : (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
            {list.map(iv => (
              <button key={iv.id} onClick={() => setSel(iv)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '6px 12px', borderRadius: 10, cursor: 'pointer', fontFamily: 'Inter,sans-serif', fontSize: 12,
                  border: `1.5px solid ${sel?.id === iv.id ? 'var(--pine)' : 'var(--line)'}`, background: sel?.id === iv.id ? 'hsla(var(--color-green),0.06)' : 'var(--card)' }}>
                <span style={{ fontWeight: 700 }}>{iv.at ? formatDateTime(iv.at) : 'Unscheduled'}</span>
                <Chip s={iv.status} />
              </button>
            ))}
          </div>
        )}

        {sel && (
          <div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
              {sel.joinUrl && (
                <a href={sel.joinUrl} target="_blank" rel="noreferrer" className="secondary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, textDecoration: 'none' }}>
                  <Video size={13} /> Join Teams meeting
                </a>
              )}
              <div style={{ flex: 1 }} />
              {sel.status === 'scored' && <span style={{ fontSize: 15, fontWeight: 800, color: 'hsl(var(--color-green))' }}><Trophy size={14} style={{ verticalAlign: 'middle', marginRight: 5 }} />{Math.round(sel.totalScore)}/100</span>}
            </div>
            <div style={{ marginBottom: 12 }}>
              <RecordingLine iv={sel} busy={busy === 'rec'} toastErr={toastErr}
                onPull={run('rec', async () => refreshSel(await api.ivPullRecording(sel.id)), 'Recording saved')} />
            </div>

            {sel.followupStatus && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', borderRadius: 10, padding: '9px 12px', marginBottom: 12, fontSize: 12.5,
                background: sel.followupStatus === 'failed' ? 'hsla(var(--color-red),0.08)' : sel.followupStatus === 'done' ? 'hsla(var(--color-green),0.08)' : 'hsla(var(--color-blue),0.08)' }}>
                {sel.followupStatus === 'waiting' ? <Clock size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                  : sel.followupStatus === 'failed' ? <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1, color: 'hsl(var(--color-red))' }} />
                    : <CheckCircle size={14} style={{ flexShrink: 0, marginTop: 1, color: 'hsl(var(--color-green))' }} />}
                <span style={{ flex: 1 }}>
                  {sel.followupStatus !== 'waiting' ? sel.followupNote
                    : (sel.followupNote || '').startsWith('Waiting for Teams')
                      ? `${sel.followupNote}. Nexus keeps trying for up to 2 hours and scores it as soon as it arrives - you'll get a bell.`
                      : `${sel.followupNote || 'Working on it'} - you'll get a bell when it's scored.`}
                </span>
                {['waiting', 'failed'].includes(sel.followupStatus) && (
                  <button className="secondary-btn" style={{ fontSize: 11.5, padding: '3px 10px' }} onClick={retryNow} disabled={!!busy}>
                    {busy === 'retry' ? <Spinner size={12} /> : 'Retry Now'}
                  </button>
                )}
              </div>
            )}

            {/* Transcript + AI actions */}
            {(sel.status === 'completed' || sel.status === 'scored') && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
                <button className="secondary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }} disabled={!!busy}
                  onClick={run('pull', async () => { await api.ivPullTranscript(sel.id); refreshSel({ ...sel, hasTranscript: true }); }, 'Transcript pulled from Teams')}>
                  {busy === 'pull' ? <Spinner size={13} /> : <RefreshCw size={13} />} Pull Teams Transcript
                </button>
                <button className="secondary-btn" style={{ fontSize: 12 }} onClick={() => setShowPaste(p => !p)}>
                  <FileText size={13} style={{ verticalAlign: 'middle', marginRight: 5 }} />Paste Transcript
                </button>
                <button className="secondary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'hsl(var(--color-purple))' }}
                  disabled={!!busy || !(sel.hasTranscript)} title={sel.hasTranscript ? '' : 'Pull or paste a transcript first'}
                  onClick={run('fill', async () => refreshSel(await api.ivAutofill(sel.id)), 'Answers auto-filled from the transcript')}>
                  {busy === 'fill' ? <Spinner size={13} /> : <Sparkles size={13} />} AI Auto-fill Answers
                </button>
                <button className="primary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }} disabled={!!busy}
                  onClick={run('cal', async () => refreshSel(await api.ivCalibrate(sel.id)), 'Scored - check the leaderboard')}>
                  {busy === 'cal' ? <Spinner size={13} /> : <Trophy size={13} />} Calibrate Score
                </button>
              </div>
            )}
            {showPaste && (
              <div style={{ marginBottom: 12 }}>
                <textarea className="form-input" rows={5} style={{ width: '100%', fontSize: 12, resize: 'vertical' }} value={paste}
                  placeholder="Paste the Teams transcript here (Meeting → … → View transcript → copy)" onChange={e => setPaste(e.target.value)} />
                <button className="secondary-btn" style={{ marginTop: 6, fontSize: 12 }} disabled={!paste.trim() || !!busy}
                  onClick={run('save-t', async () => { const u = await api.ivPatch(sel.id, { transcript: paste }); refreshSel({ ...u, hasTranscript: true }); setShowPaste(false); setPaste(''); }, 'Transcript saved')}>
                  Save transcript
                </button>
              </div>
            )}

            {/* Questionnaire */}
            {sel.answers?.length ? sel.answers.map((a, i) => (
              <div key={a.qid} style={{ marginBottom: 12, border: '1px solid var(--line)', borderRadius: 10, padding: '10px 12px' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                  <span style={{ fontSize: 12.5, fontWeight: 700, flex: 1 }}>{i + 1}. {a.q}</span>
                  {a.score !== null && a.score !== undefined && (
                    <span style={{ fontSize: 12, fontWeight: 800, color: a.score >= 7 ? 'hsl(var(--color-green))' : a.score >= 4 ? 'hsl(var(--color-orange))' : 'hsl(var(--color-red))', flexShrink: 0 }}>{a.score}/10</span>
                  )}
                </div>
                <textarea className="form-input" rows={2} style={{ width: '100%', marginTop: 6, fontSize: 12.5, resize: 'vertical' }}
                  value={a.answer || ''} placeholder="Their answer - type it, or let AI fill it from the transcript"
                  onChange={e => setAnswer(a.qid, e.target.value)}
                  onBlur={() => { if (sel.status !== 'live') api.ivPatch(sel.id, { answers: sel.answers }).then(() => setTyped(false)).catch(() => {}); }} />
                {a.rationale && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}><Sparkles size={10} style={{ verticalAlign: 'middle', marginRight: 4 }} />{a.rationale}</div>}
              </div>
            )) : <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No questionnaire attached to this round.</div>}

            {sel.summary && (
              <div style={{ background: 'hsla(var(--color-green),0.06)', border: '1px solid hsla(var(--color-green),0.25)', borderRadius: 10, padding: '10px 12px', fontSize: 12.5 }}>
                <strong>AI verdict:</strong> {sel.summary}
              </div>
            )}
          </div>
        )}
      </div>
      <div style={{ padding: '12px 22px', borderTop: '1px solid var(--line)', display: 'flex', gap: 10, justifyContent: 'flex-end', alignItems: 'center', flexWrap: 'wrap', flexShrink: 0 }}>
        {sel?.status === 'scored' && <span style={{ marginRight: 'auto', fontSize: 12.5, fontWeight: 700 }}>
          <Trophy size={13} style={{ verticalAlign: 'middle', marginRight: 5, color: 'hsl(var(--color-green))' }} />Scored {Math.round(sel.totalScore)}/100 - what next?</span>}
        <button className="secondary-btn" onClick={guard.requestClose}>Close</button>
        {sel?.status === 'scheduled' && (
          <button className="primary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} disabled={!!busy}
            onClick={run('live', async () => refreshSel(await api.ivPatch(sel.id, { status: 'live' })), 'Interview started - the questions are live')}>
            {busy === 'live' ? <Spinner size={14} /> : <Play size={14} />} Start Interview
          </button>
        )}
        {sel?.status === 'live' && <>
          <button className="secondary-btn" onClick={saveAnswers} disabled={!!busy || !typed} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {busy === 'save' ? <Spinner size={13} /> : <Save size={13} />} Save
          </button>
          <button className="primary-btn" onClick={endInterview} disabled={!!busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {busy === 'end' ? <Spinner size={14} /> : <CheckCircle size={14} />} End Interview
          </button>
        </>}
        {sel?.status === 'completed' && !sel.followupStatus && (
          <button className="primary-btn" onClick={endInterview} disabled={!!busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {busy === 'end' ? <Spinner size={14} /> : <Sparkles size={14} />} Score Interview
          </button>
        )}
        {sel?.status === 'completed' && typed && (
          <button className="secondary-btn" onClick={saveAnswers} disabled={!!busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Save size={13} /> Save
          </button>
        )}
        {sel?.status === 'scored' && onDecision && <>
          <button onClick={() => decide('reject')}
            style={{ background: 'none', border: '1px solid hsla(var(--color-red),0.4)', borderRadius: 8, padding: '7px 14px', fontSize: 12.5, cursor: 'pointer', color: 'hsl(var(--color-red))', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: 'Inter,sans-serif' }}>
            <XCircle size={13} /> Reject
          </button>
          <button className="secondary-btn" onClick={() => decide('another')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><CalendarDays size={13} /> Another Round</button>
          <button className="primary-btn" onClick={() => decide('offer')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><ChevronRight size={14} /> Move To Offer</button>
        </>}
      </div>
      {guard.confirming && (
        <UnsavedChangesPrompt
          onKeepEditing={guard.keepEditing}
          onDiscard={() => { setPaste(''); onClose(); }}
          onSave={typed && sel ? guard.saveAndClose : undefined}
          saving={busy === 'save'}
        />
      )}
    </Overlay>
  );
}

// ── Leaderboard ───────────────────────────────────────────────────────────────
export function LeaderboardModal({ onClose, toastOk, toastErr }) {
  const [tpls, setTpls] = useState([]);
  const [tid, setTid] = useState('');
  const [rows, setRows] = useState(null);
  const [inviting, setInviting] = useState(null);   // interview id with date picker open
  const [finalAt, setFinalAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [rec, setRec] = useState(null);             // AI hire recommendation
  const [recBusy, setRecBusy] = useState(false);

  useEffect(() => { api.ivTemplates().then(setTpls).catch(() => {}); }, []);
  useEffect(() => { setRows(null); setRec(null); api.ivLeaderboard(tid).then(setRows).catch(() => setRows([])); }, [tid]);

  const recommend = async () => {
    setRecBusy(true);
    try { setRec(await api.ivRecommend(tid)); }
    catch (e) { toastErr?.(e?.message || 'Could not compare candidates'); }
    finally { setRecBusy(false); }
  };

  const invite = async (iv) => {
    if (!finalAt) return;
    setBusy(true);
    try {
      await api.ivFinalRound(iv.id, { at: new Date(finalAt).toISOString(), duration_min: 30 });
      toastOk?.(`Final-round invite sent to ${iv.candidateName} ✓`);
      setInviting(null); setFinalAt('');
    } catch (e) { toastErr?.(e?.message || 'Could not send the invite'); }
    finally { setBusy(false); }
  };

  const dirty = !!finalAt;
  const invitingRow = inviting ? (rows || []).find(r => r.id === inviting) : null;
  const guard = useUnsavedGuard(dirty, onClose, invitingRow ? () => invite(invitingRow) : undefined);

  return (
    <Overlay onClose={guard.requestClose} wide>
      <Head title="Interview Leaderboard" sub="Calibrated scores per role - invite the winner to the offer discussion" onClose={guard.requestClose} />
      <div style={{ overflowY: 'auto', padding: '14px 22px' }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
          <select className="form-input" style={{ fontSize: 12.5 }} value={tid} onChange={e => setTid(e.target.value)}>
            <option value="">All Roles</option>
            {tpls.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          {(rows || []).length >= 2 && (
            <button className="primary-btn" onClick={recommend} disabled={recBusy}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
              {recBusy ? <Spinner size={13} /> : <Sparkles size={13} />}
              {recBusy ? 'Comparing…' : 'AI: whom should we hire?'}
            </button>
          )}
        </div>

        {rec && (
          <div style={{ border: '1px solid hsla(var(--color-purple),0.3)', background: 'hsla(var(--color-purple),0.05)', borderRadius: 12, padding: '12px 14px', marginBottom: 14 }}>
            <div style={{ fontSize: 13.5, fontWeight: 800, marginBottom: 4 }}>
              <Sparkles size={13} style={{ verticalAlign: 'middle', marginRight: 6, color: 'hsl(var(--color-purple))' }} />
              AI recommendation: <span style={{ color: 'hsl(var(--color-purple))' }}>{rec.pick || '-'}</span>
              {rec.runnerUp && <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}> · runner-up {rec.runnerUp}</span>}
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--ink)', lineHeight: 1.55 }}>{rec.reasoning}</div>
            {(rec.comparison || []).length > 0 && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 8, marginTop: 10 }}>
                {rec.comparison.map((c, i) => (
                  <div key={i} style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, padding: '8px 11px', fontSize: 11.5 }}>
                    <div style={{ fontWeight: 800, marginBottom: 3 }}>{c.name}</div>
                    {c.strengths && <div style={{ color: 'hsl(var(--color-green))' }}>+ {c.strengths}</div>}
                    {c.concerns && <div style={{ color: 'hsl(var(--color-red))', marginTop: 2 }}>− {c.concerns}</div>}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {rows === null ? <Spinner size="inline" />
          : rows.length === 0 ? <div style={{ fontSize: 13, color: 'var(--muted)', padding: '24px 0', textAlign: 'center' }}>No calibrated interviews yet - run "Calibrate score" after each interview.</div>
          : rows.map((iv, i) => (
            <div key={iv.id} style={{ borderBottom: '1px solid var(--line)', padding: '10px 0' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ width: 30, height: 30, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 13,
                  background: i === 0 ? 'hsla(45,90%,50%,0.18)' : 'var(--mist)', color: i === 0 ? '#b45309' : 'var(--muted)' }}>
                  {i + 1}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 700 }}>
                    {iv.candidateName || '-'}
                    {iv.candidateStage === 'hired' && (
                      <span style={{ marginLeft: 7, fontSize: 10, fontWeight: 800, letterSpacing: '.04em', color: 'hsl(var(--color-green))', background: 'hsla(var(--color-green),0.12)', padding: '2px 8px', borderRadius: 10 }}>HIRED</span>
                    )}
                    {iv.candidateStage === 'offer' && (
                      <span style={{ marginLeft: 7, fontSize: 10, fontWeight: 800, letterSpacing: '.04em', color: 'hsl(var(--color-purple))', background: 'hsla(var(--color-purple),0.12)', padding: '2px 8px', borderRadius: 10 }}>OFFER</span>
                    )}
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{iv.templateName || 'No questionnaire'} · {iv.at ? formatDate(iv.at) : ''}</div>
                </div>
                <span style={{ fontSize: 17, fontWeight: 800, color: iv.totalScore >= 70 ? 'hsl(var(--color-green))' : iv.totalScore >= 45 ? 'hsl(var(--color-orange))' : 'hsl(var(--color-red))' }}>
                  {Math.round(iv.totalScore)}
                </span>
                {iv.candidateStage === 'hired' ? null : inviting !== iv.id ? (
                  <button className="secondary-btn" style={{ fontSize: 11.5, padding: '4px 11px', display: 'inline-flex', alignItems: 'center', gap: 5 }}
                    onClick={() => { setInviting(iv.id); setFinalAt(''); }}>
                    <Send size={12} /> Final round
                  </button>
                ) : (
                  <span style={{ display: 'inline-flex', gap: 6 }}>
                    <input type="datetime-local" className="form-input" style={{ fontSize: 11.5, padding: '4px 8px' }} value={finalAt} onChange={e => setFinalAt(e.target.value)} />
                    <button className="primary-btn" style={{ fontSize: 11.5, padding: '4px 11px' }} disabled={!finalAt || busy} onClick={() => invite(iv)}>
                      {busy ? '…' : 'Send'}
                    </button>
                  </span>
                )}
              </div>
              {iv.summary && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 5, marginLeft: 42 }}>{iv.summary}</div>}
            </div>
          ))}
      </div>
      {guard.confirming && (
        <UnsavedChangesPrompt
          onKeepEditing={guard.keepEditing}
          onDiscard={() => { setInviting(null); setFinalAt(''); onClose(); }}
          onSave={invitingRow ? guard.saveAndClose : undefined}
          saving={busy}
        />
      )}
    </Overlay>
  );
}
