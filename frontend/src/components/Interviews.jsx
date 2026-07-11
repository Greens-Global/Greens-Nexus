import { useState, useEffect } from 'react';
import {
  X, Plus, Trash2, Video, Sparkles, Loader2, Trophy, Send, FileText,
  CheckCircle, Play, ClipboardList, RefreshCw,
} from 'lucide-react';
import { api } from '../api';

// AI-assisted interviews: Teams invite → live questionnaire → transcript
// auto-fill → calibrated scores → role leaderboard → final-round invite.

const Overlay = ({ children, onClose, wide }) => (
  <div onClick={e => e.target === e.currentTarget && onClose()}
    style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1250, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
    <div style={{ background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth: wide ? 760 : 560, maxHeight: 'min(92dvh, 780px)', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)', fontFamily: 'Inter,sans-serif' }}>
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

// ── Questionnaire templates ───────────────────────────────────────────────────
export function QuestionnairesModal({ onClose, toastOk, toastErr }) {
  const [tpls, setTpls] = useState(null);
  const [editing, setEditing] = useState(null);   // {id?, name, text}
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.ivTemplates().then(setTpls).catch(() => setTpls([])); }, []);

  const save = async () => {
    const questions = editing.text.split('\n').map(s => s.trim()).filter(Boolean);
    if (!editing.name.trim() || !questions.length) return;
    setBusy(true);
    try {
      const saved = editing.id
        ? await api.ivTemplateUpdate(editing.id, { name: editing.name, questions })
        : await api.ivTemplateCreate({ name: editing.name, questions });
      setTpls(ts => editing.id ? ts.map(t => t.id === saved.id ? saved : t) : [...ts, saved]);
      setEditing(null);
      toastOk?.('Questionnaire saved');
    } catch (e) { toastErr?.(e?.message || 'Could not save'); }
    finally { setBusy(false); }
  };

  return (
    <Overlay onClose={onClose}>
      <Head title="Interview questionnaires" sub="One per role — the questions you ask in the call; AI fills the answers from the transcript" onClose={onClose} />
      <div style={{ overflowY: 'auto', padding: '14px 22px' }}>
        {editing ? (
          <div>
            <label style={lbl}>Role name</label>
            <input className="form-input" style={{ width: '100%' }} value={editing.name} onChange={e => setEditing(ed => ({ ...ed, name: e.target.value }))} placeholder='e.g. "Site Manager"' />
            <label style={lbl}>Questions — one per line</label>
            <textarea className="form-input" rows={10} style={{ width: '100%', resize: 'vertical', fontSize: 13, lineHeight: 1.6 }}
              value={editing.text} onChange={e => setEditing(ed => ({ ...ed, text: e.target.value }))}
              placeholder={'Walk me through your last role.\nHow would you handle an overdue vendor?\n…'} />
            <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
              <button className="secondary-btn" onClick={() => setEditing(null)}>Cancel</button>
              <button className="primary-btn" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save questionnaire'}</button>
            </div>
          </div>
        ) : (
          <>
            {tpls === null ? <Loader2 size={18} style={{ animation: 'spin 0.8s linear infinite', color: 'var(--muted)' }} />
              : tpls.length === 0 ? <div style={{ fontSize: 13, color: 'var(--muted)', padding: '20px 0', textAlign: 'center' }}>No questionnaires yet — create one per role.</div>
              : tpls.map(t => (
                <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', borderBottom: '1px solid var(--line)' }}>
                  <ClipboardList size={15} style={{ color: 'hsl(var(--color-purple))', flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 700 }}>{t.name}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{t.questions.length} question{t.questions.length !== 1 ? 's' : ''}</div>
                  </div>
                  <button className="secondary-btn" style={{ fontSize: 12, padding: '4px 12px' }}
                    onClick={() => setEditing({ id: t.id, name: t.name, text: t.questions.map(q => q.q).join('\n') })}>Edit</button>
                  <button onClick={async () => { if (window.confirm(`Delete "${t.name}"?`)) { await api.ivTemplateDelete(t.id).catch(() => {}); setTpls(ts => ts.filter(x => x.id !== t.id)); } }}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 3 }}><Trash2 size={14} /></button>
                </div>
              ))}
            <button className="primary-btn" style={{ marginTop: 14, display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}
              onClick={() => setEditing({ name: '', text: '' })}>
              <Plus size={14} /> New questionnaire
            </button>
          </>
        )}
      </div>
    </Overlay>
  );
}

// ── Interview room for one candidate ──────────────────────────────────────────
export function InterviewPanel({ candidate: c, onClose, toastOk, toastErr }) {
  const [tpls, setTpls] = useState([]);
  const [list, setList] = useState(null);
  const [sel, setSel] = useState(null);             // selected interview object
  const [sched, setSched] = useState({ template_id: '', at: '', duration_min: 45 });
  const [busy, setBusy] = useState('');
  const [paste, setPaste] = useState('');
  const [showPaste, setShowPaste] = useState(false);

  useEffect(() => {
    api.ivTemplates().then(setTpls).catch(() => {});
    api.ivList(c.id).then(l => { setList(l); if (l.length) setSel(l[0]); }).catch(() => setList([]));
  }, [c.id]);

  const run = (key, fn, okMsg) => async () => {
    setBusy(key);
    try { const r = await fn(); if (okMsg) toastOk?.(okMsg); return r; }
    catch (e) { toastErr?.(e?.message || 'Failed'); }
    finally { setBusy(''); }
  };
  const refreshSel = (updated) => { setSel(updated); setList(l => l.map(x => x.id === updated.id ? updated : x)); };

  const schedule = run('sched', async () => {
    if (!sched.at) return;
    const created = await api.ivSchedule(c.id, { ...sched, at: new Date(sched.at).toISOString() });
    setList(l => [created, ...(l || [])]);
    setSel(created);
    if (created.inviteSent) toastOk?.('Teams invite sent to the candidate ✓');
    else toastErr?.(created.graphError || 'Interview saved, but the Teams invite could not be sent');
  });

  const setAnswer = (qid, answer) => refreshSel({ ...sel, answers: sel.answers.map(a => a.qid === qid ? { ...a, answer } : a) });

  return (
    <Overlay onClose={onClose} wide>
      <Head title={`Interviews — ${c.firstName} ${c.lastName || ''}`} sub={c.roleTitle || c.department || ''} onClose={onClose} />
      <div style={{ overflowY: 'auto', padding: '14px 22px', flex: 1 }}>

        {/* Schedule a new round */}
        <div style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '12px 14px', marginBottom: 14, background: 'var(--mist)' }}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div style={{ flex: 1, minWidth: 160 }}>
              <label style={lbl}>Questionnaire</label>
              <select className="form-input" style={{ width: '100%', fontSize: 12.5 }} value={sched.template_id} onChange={e => setSched(s => ({ ...s, template_id: e.target.value }))}>
                <option value="">No questionnaire</option>
                {tpls.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <div>
              <label style={lbl}>When</label>
              <input type="datetime-local" className="form-input" style={{ fontSize: 12.5 }} value={sched.at} onChange={e => setSched(s => ({ ...s, at: e.target.value }))} />
            </div>
            <div>
              <label style={lbl}>Minutes</label>
              <input type="number" className="form-input" style={{ width: 76, fontSize: 12.5 }} min={15} max={240} value={sched.duration_min} onChange={e => setSched(s => ({ ...s, duration_min: +e.target.value || 45 }))} />
            </div>
            <button className="primary-btn" onClick={schedule} disabled={busy === 'sched' || !sched.at}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
              {busy === 'sched' ? <Loader2 size={13} style={{ animation: 'spin 0.7s linear infinite' }} /> : <Video size={14} />} Send Teams invite
            </button>
          </div>
          <p style={{ margin: '8px 0 0', fontSize: 11, color: 'var(--muted)' }}>The candidate gets a calendar invite with the Teams link on {c.email || 'their email'}.</p>
        </div>

        {/* Rounds */}
        {list === null ? <Loader2 size={16} style={{ animation: 'spin 0.8s linear infinite', color: 'var(--muted)' }} /> : list.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
            {list.map(iv => (
              <button key={iv.id} onClick={() => setSel(iv)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '6px 12px', borderRadius: 10, cursor: 'pointer', fontFamily: 'Inter,sans-serif', fontSize: 12,
                  border: `1.5px solid ${sel?.id === iv.id ? 'var(--pine)' : 'var(--line)'}`, background: sel?.id === iv.id ? 'hsla(var(--color-green),0.06)' : 'var(--card)' }}>
                <span style={{ fontWeight: 700 }}>{iv.at ? new Date(iv.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Unscheduled'}</span>
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
              {sel.status === 'scheduled' && (
                <button className="primary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}
                  onClick={run('live', async () => refreshSel(await api.ivPatch(sel.id, { status: 'live' })), 'Interview started — questionnaire is live')}>
                  <Play size={13} /> Interview started
                </button>
              )}
              {sel.status === 'live' && (
                <button className="secondary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}
                  onClick={run('done', async () => refreshSel(await api.ivPatch(sel.id, { status: 'completed', answers: sel.answers })), 'Marked completed')}>
                  <CheckCircle size={13} /> End interview
                </button>
              )}
              <div style={{ flex: 1 }} />
              {sel.status === 'scored' && <span style={{ fontSize: 15, fontWeight: 800, color: 'hsl(var(--color-green))' }}><Trophy size={14} style={{ verticalAlign: 'middle', marginRight: 5 }} />{Math.round(sel.totalScore)}/100</span>}
            </div>

            {/* Transcript + AI actions */}
            {(sel.status === 'live' || sel.status === 'completed' || sel.status === 'scored') && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
                <button className="secondary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }} disabled={!!busy}
                  onClick={run('pull', async () => { await api.ivPullTranscript(sel.id); refreshSel({ ...sel, hasTranscript: true }); }, 'Transcript pulled from Teams')}>
                  {busy === 'pull' ? <Loader2 size={13} style={{ animation: 'spin 0.7s linear infinite' }} /> : <RefreshCw size={13} />} Pull Teams transcript
                </button>
                <button className="secondary-btn" style={{ fontSize: 12 }} onClick={() => setShowPaste(p => !p)}>
                  <FileText size={13} style={{ verticalAlign: 'middle', marginRight: 5 }} />Paste transcript
                </button>
                <button className="secondary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'hsl(var(--color-purple))' }}
                  disabled={!!busy || !(sel.hasTranscript)} title={sel.hasTranscript ? '' : 'Pull or paste a transcript first'}
                  onClick={run('fill', async () => refreshSel(await api.ivAutofill(sel.id)), 'Answers auto-filled from the transcript')}>
                  {busy === 'fill' ? <Loader2 size={13} style={{ animation: 'spin 0.7s linear infinite' }} /> : <Sparkles size={13} />} AI auto-fill answers
                </button>
                <button className="primary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }} disabled={!!busy}
                  onClick={run('cal', async () => refreshSel(await api.ivCalibrate(sel.id)), 'Scored — check the leaderboard')}>
                  {busy === 'cal' ? <Loader2 size={13} style={{ animation: 'spin 0.7s linear infinite' }} /> : <Trophy size={13} />} Calibrate score
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
                  value={a.answer || ''} placeholder="Their answer — type it, or let AI fill it from the transcript"
                  onChange={e => setAnswer(a.qid, e.target.value)}
                  onBlur={() => api.ivPatch(sel.id, { answers: sel.answers }).catch(() => {})} />
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

  return (
    <Overlay onClose={onClose} wide>
      <Head title="Interview leaderboard" sub="Calibrated scores per role — invite the winner to the offer discussion" onClose={onClose} />
      <div style={{ overflowY: 'auto', padding: '14px 22px' }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
          <select className="form-input" style={{ fontSize: 12.5 }} value={tid} onChange={e => setTid(e.target.value)}>
            <option value="">All roles</option>
            {tpls.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          {(rows || []).length >= 2 && (
            <button className="primary-btn" onClick={recommend} disabled={recBusy}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
              {recBusy ? <Loader2 size={13} style={{ animation: 'spin 0.7s linear infinite' }} /> : <Sparkles size={13} />}
              {recBusy ? 'Comparing…' : 'AI: whom should we hire?'}
            </button>
          )}
        </div>

        {rec && (
          <div style={{ border: '1px solid hsla(var(--color-purple),0.3)', background: 'hsla(var(--color-purple),0.05)', borderRadius: 12, padding: '12px 14px', marginBottom: 14 }}>
            <div style={{ fontSize: 13.5, fontWeight: 800, marginBottom: 4 }}>
              <Sparkles size={13} style={{ verticalAlign: 'middle', marginRight: 6, color: 'hsl(var(--color-purple))' }} />
              AI recommendation: <span style={{ color: 'hsl(var(--color-purple))' }}>{rec.pick || '—'}</span>
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
        {rows === null ? <Loader2 size={18} style={{ animation: 'spin 0.8s linear infinite', color: 'var(--muted)' }} />
          : rows.length === 0 ? <div style={{ fontSize: 13, color: 'var(--muted)', padding: '24px 0', textAlign: 'center' }}>No calibrated interviews yet — run "Calibrate score" after each interview.</div>
          : rows.map((iv, i) => (
            <div key={iv.id} style={{ borderBottom: '1px solid var(--line)', padding: '10px 0' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ width: 30, height: 30, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 13,
                  background: i === 0 ? 'hsla(45,90%,50%,0.18)' : 'var(--mist)', color: i === 0 ? '#b45309' : 'var(--muted)' }}>
                  {i + 1}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 700 }}>
                    {iv.candidateName || '—'}
                    {iv.candidateStage === 'hired' && (
                      <span style={{ marginLeft: 7, fontSize: 10, fontWeight: 800, letterSpacing: '.04em', color: 'hsl(var(--color-green))', background: 'hsla(var(--color-green),0.12)', padding: '2px 8px', borderRadius: 10 }}>HIRED</span>
                    )}
                    {iv.candidateStage === 'offer' && (
                      <span style={{ marginLeft: 7, fontSize: 10, fontWeight: 800, letterSpacing: '.04em', color: 'hsl(var(--color-purple))', background: 'hsla(var(--color-purple),0.12)', padding: '2px 8px', borderRadius: 10 }}>OFFER</span>
                    )}
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{iv.templateName || 'No questionnaire'} · {iv.at ? new Date(iv.at).toLocaleDateString() : ''}</div>
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
    </Overlay>
  );
}
