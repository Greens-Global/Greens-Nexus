import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  FlaskConical, Plus, X, Loader2, Camera, CheckCircle, XCircle, MinusCircle,
  ChevronRight, Bug, ListChecks, ScrollText, Sparkles, UserPlus, Video, Square,
  Paperclip, Send, Pencil, Archive, Check, CircleDot, Play, Bot,
} from 'lucide-react';
import { api } from '../api';
import { supabase } from '../lib/supabase';
import { useRole } from '../contexts/RoleContext';
import { useNameResolver } from '../lib/useNameResolver';
import { startRecording, stopRecording, isRecording, eventCount, startFlowRecording } from '../lib/stepRecorder';
import { replayFlow } from '../lib/flowReplayer';
import { graphToken, graphJSON, postChatMessage, GRAPH } from '../teamsGraph';
import { msalInstance } from '../msalInstance';

// ── Testing module — interactive QA runs over the audit test cases, bug
// reports with recorded steps + AI conversion, assignments with due dates.
// Dev-only: the backend 404s everything unless NEXUS_QA_MODULE is set.

const QA_MODULES = ['People', 'My HR', 'Item Management', 'Asset Management', 'Documents (E-Sign)', 'Time Clock', 'Dashboards', 'Other'];
const RESULT_META = {
  pass:    { label: 'Pass',    fg: 'hsl(var(--color-green))',  bg: 'hsla(var(--color-green),0.12)',  Icon: CheckCircle },
  fail:    { label: 'Fail',    fg: 'hsl(var(--color-red))',    bg: 'hsla(var(--color-red),0.12)',    Icon: XCircle },
  blocked: { label: 'Blocked', fg: 'hsl(var(--color-orange))', bg: 'hsla(var(--color-orange),0.12)', Icon: MinusCircle },
  skipped: { label: 'Skipped', fg: 'var(--muted)',             bg: 'var(--mist)',                    Icon: MinusCircle },
};
const PRI_COLOR = { High: 'hsl(var(--color-red))', Medium: 'hsl(var(--color-orange))', Low: 'var(--muted)' };
const FL = { fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', display: 'block', marginBottom: 6, letterSpacing: '.05em', textTransform: 'uppercase' };
const inputStyle = { width: '100%', padding: '9px 12px', borderRadius: 9, border: '1px solid var(--line)', background: 'var(--card)', fontFamily: 'Inter,sans-serif', fontSize: 13.5, color: 'var(--ink)' };

// Evidence uploads land in the qa-evidence bucket (create on the Supabase project).
async function uploadEvidence(file, prefix = 'shot') {
  const safe = (file.name || 'paste.png').replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = `${prefix}-${Date.now()}-${safe}`;
  const { data, error } = await supabase.storage.from('qa-evidence')
    .upload(path, file, { contentType: file.type || 'image/png', upsert: false, cacheControl: '31536000' });
  if (error || !data) throw new Error(error?.message || 'Upload failed');
  return supabase.storage.from('qa-evidence').getPublicUrl(data.path).data.publicUrl;
}

function filesFromPaste(e) {
  const out = [];
  for (const item of e.clipboardData?.items || []) {
    if (item.type?.startsWith('image/')) { const f = item.getAsFile(); if (f) out.push(f); }
  }
  return out;
}

function Shot({ url, onRemove, size = 34 }) {
  return (
    <span style={{ position: 'relative', display: 'inline-block' }}>
      <a href={url} target="_blank" rel="noreferrer">
        <img src={url} alt="evidence" style={{ width: size, height: size, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--line)', display: 'block' }} />
      </a>
      {onRemove && (
        <button onClick={onRemove} aria-label="Remove screenshot" style={{ position: 'absolute', top: -6, right: -6, width: 16, height: 16, borderRadius: '50%', border: 'none', background: 'var(--ink)', color: 'var(--card)', cursor: 'pointer', display: 'grid', placeItems: 'center', padding: 0 }}>
          <X size={10} />
        </button>
      )}
    </span>
  );
}

function ResultPill({ result }) {
  const m = RESULT_META[result];
  if (!m) return <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>Not run</span>;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 10px', borderRadius: 20, fontSize: 11.5, fontWeight: 700, background: m.bg, color: m.fg, whiteSpace: 'nowrap' }}>
      <m.Icon size={12} /> {m.label}
    </span>
  );
}

function Modal({ title, wide, onClose, children }) {
  useEffect(() => { const h = e => e.key === 'Escape' && onClose(); window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, [onClose]);
  return (
    <div role="dialog" aria-modal="true" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1250, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth: wide ? 760 : 540, maxHeight: 'min(92dvh, 840px)', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)' }}>
        <div style={{ padding: '16px 22px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, flex: 1 }}>{title}</h3>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ overflowY: 'auto', flex: 1, padding: '18px 22px' }}>{children}</div>
      </div>
    </div>
  );
}

// ── Case runner — the interactive checklist with per-step evidence ────────────
function CaseRunner({ caseObj, runId, existing, onSaved, onFileBug, onClose, toastOk, toastErr }) {
  const steps = caseObj.steps || [];
  const [stepState, setStepState] = useState(() => steps.map((_, i) => existing?.stepState?.[i] || { done: false, shot: '' }));
  const [notes, setNotes] = useState(existing?.notes || '');
  const [overallShot, setOverallShot] = useState(existing?.evidence?.shot || '');
  const [activeStep, setActiveStep] = useState(-1);   // paste target: -1 = overall
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef(null);
  const pendingStep = useRef(-1);

  const attachTo = useCallback(async (file, idx) => {
    setUploading(true);
    try {
      const url = await uploadEvidence(file, idx >= 0 ? `step${idx + 1}` : 'overall');
      if (idx >= 0) setStepState(p => p.map((s, i) => i === idx ? { ...s, shot: url } : s));
      else setOverallShot(url);
      toastOk(idx >= 0 ? `Screenshot attached to step ${idx + 1}.` : 'Overall screenshot attached.');
    } catch (e) { toastErr(e?.message || 'Could not upload screenshot.'); }
    setUploading(false);
  }, [toastOk, toastErr]);

  const onPaste = e => {
    const files = filesFromPaste(e);
    if (files.length) { e.preventDefault(); attachTo(files[0], activeStep); }
  };

  async function save(result) {
    setBusy(true);
    const failedStep = result === 'fail'
      ? (activeStep >= 0 ? activeStep : Math.max(0, stepState.findIndex(s => !s.done)))
      : -1;
    try {
      await api.qaUpsertResult(runId, {
        case_id: caseObj.id, result, failed_step: failedStep,
        step_state: stepState, notes, evidence: { shot: overallShot },
      });
      onSaved();
      if (result === 'fail' && onFileBug) {
        onFileBug({
          description: `Test case failed: "${caseObj.title}" (${caseObj.module})` + (notes ? ` — ${notes}` : '') + ` — failed at step ${failedStep + 1}: "${steps[failedStep] || ''}"`,
          module_hint: caseObj.module, case_id: caseObj.id, run_id: runId, failed_step: failedStep,
          screenshots: [overallShot, ...stepState.map(s => s.shot)].filter(Boolean),
        });
      } else {
        toastOk(`Saved: ${RESULT_META[result]?.label || result}.`);
        onClose();
      }
    } catch (e) { toastErr(e?.message || 'Could not save the result.'); setBusy(false); }
  }

  return (
    <Modal title={caseObj.title} wide onClose={onClose}>
      <div onPaste={onPaste}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12, fontSize: 12, color: 'var(--muted)' }}>
          <span style={{ fontWeight: 700, color: PRI_COLOR[caseObj.priority] }}>{caseObj.priority}</span>
          · {caseObj.module} · {caseObj.feature}
          {existing?.result && <ResultPill result={existing.result} />}
        </div>
        {caseObj.precondition && (
          <div style={{ background: 'var(--mist)', borderRadius: 10, padding: '10px 14px', fontSize: 13, marginBottom: 14 }}>
            <b>Before you start:</b> {caseObj.precondition}
          </div>
        )}
        <div style={FL}>Steps — tick as you go · click a row, then paste (Ctrl+V) or attach to add a screenshot to that step</div>
        <div style={{ border: '1px solid var(--line)', borderRadius: 12, overflow: 'hidden', marginBottom: 14 }}>
          {steps.map((s, i) => (
            <div key={i} onClick={() => setActiveStep(i)}
              style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px', borderBottom: i < steps.length - 1 ? '1px solid var(--line)' : 'none', cursor: 'pointer', background: activeStep === i ? 'hsla(var(--color-blue),0.06)' : 'transparent' }}>
              <button onClick={e => { e.stopPropagation(); setStepState(p => p.map((st, j) => j === i ? { ...st, done: !st.done } : st)); setActiveStep(i); }}
                aria-label={`Mark step ${i + 1} done`}
                style={{ width: 20, height: 20, borderRadius: 6, border: `1.5px solid ${stepState[i]?.done ? 'hsl(var(--color-green))' : 'var(--line-strong,rgba(0,0,0,0.25))'}`, background: stepState[i]?.done ? 'hsl(var(--color-green))' : 'transparent', color: '#fff', cursor: 'pointer', display: 'grid', placeItems: 'center', flexShrink: 0, marginTop: 1 }}>
                {stepState[i]?.done && <Check size={13} />}
              </button>
              <div style={{ flex: 1, fontSize: 13.5, textDecoration: stepState[i]?.done ? 'none' : 'none', color: 'var(--ink)' }}>
                <span style={{ color: 'var(--muted)', fontWeight: 700, marginRight: 6 }}>{i + 1}.</span>{s}
              </div>
              {stepState[i]?.shot
                ? <Shot url={stepState[i].shot} onRemove={() => setStepState(p => p.map((st, j) => j === i ? { ...st, shot: '' } : st))} />
                : (
                  <button onClick={e => { e.stopPropagation(); pendingStep.current = i; setActiveStep(i); fileRef.current?.click(); }}
                    title="Attach a screenshot to this step" aria-label={`Attach screenshot to step ${i + 1}`}
                    style={{ border: '1px dashed var(--line)', background: 'none', borderRadius: 7, cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 6, flexShrink: 0 }}>
                    <Camera size={13} />
                  </button>
                )}
            </div>
          ))}
        </div>

        <div style={{ background: 'hsla(var(--color-green),0.06)', border: '1px solid hsla(var(--color-green),0.2)', borderRadius: 10, padding: '10px 14px', fontSize: 13, marginBottom: 14 }}>
          <b>What you should see:</b> {caseObj.expected}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 14, alignItems: 'start', marginBottom: 14 }}>
          <div>
            <label style={FL}>Notes (what actually happened)</label>
            <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} style={{ ...inputStyle, resize: 'vertical' }} placeholder="Anything worth recording…" />
          </div>
          <div onClick={() => setActiveStep(-1)}>
            <label style={FL}>Overall screenshot</label>
            {overallShot
              ? <Shot url={overallShot} size={54} onRemove={() => setOverallShot('')} />
              : (
                <button onClick={() => { pendingStep.current = -1; setActiveStep(-1); fileRef.current?.click(); }}
                  style={{ width: 88, height: 54, border: '2px dashed var(--line)', borderRadius: 9, background: activeStep === -1 ? 'hsla(var(--color-blue),0.06)' : 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: 10.5, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3 }}>
                  <Camera size={14} /> add / paste
                </button>
              )}
          </div>
        </div>

        <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }}
          onChange={e => { const f = e.target.files?.[0]; if (f) attachTo(f, pendingStep.current); e.target.value = ''; }} />

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="secondary-btn" disabled={busy} title="Record yourself doing this test once — replay it next time"
            onClick={() => {
              onClose();
              startFlowRecording(events => {
                api.qaSaveFlow(caseObj.id, events)
                  .then(() => { sessionStorage.setItem('qa-flow-saved', caseObj.title); window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'testing' } })); })
                  .catch(() => {});
              });
            }}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginRight: 'auto' }}>
            <CircleDot size={13} style={{ color: 'hsl(var(--color-red))' }} /> Record flow
          </button>
          {(caseObj.flow || []).length > 0 && (
            <button className="secondary-btn" disabled={busy} title="Auto-replay the recorded flow (pauses where you must type or pick)"
              onClick={() => {
                onClose();
                replayFlow(caseObj.flow, { onDone: () => window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'testing' } })) });
              }}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Play size={13} /> Replay flow ({caseObj.flow.length})
            </button>
          )}
          {uploading && <Loader2 size={14} style={{ animation: 'spin 1s linear infinite', color: 'var(--muted)' }} />}
          <button className="secondary-btn" disabled={busy} onClick={() => save('skipped')}>Skip</button>
          <button className="secondary-btn" disabled={busy} onClick={() => save('blocked')} style={{ color: 'hsl(var(--color-orange))' }}>Blocked</button>
          <button className="secondary-btn" disabled={busy} onClick={() => save('fail')} style={{ color: 'hsl(var(--color-red))', fontWeight: 700 }}>
            <XCircle size={14} style={{ verticalAlign: -2, marginRight: 5 }} />Fail — file a bug
          </button>
          <button className="primary-btn" disabled={busy} onClick={() => save('pass')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {busy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <CheckCircle size={14} />} Pass
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── Assign modal — cases → person + due date; fires email + bell + Teams DM ──
function AssignModal({ runId, cases, resultsByCase, onClose, onDone, toastOk, toastErr }) {
  const [people, setPeople] = useState([]);
  const [email, setEmail] = useState('');
  const [module, setModule] = useState(QA_MODULES[0]);
  const [onlyUnrun, setOnlyUnrun] = useState(true);
  const [due, setDue] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.getPeopleDirectory().then(setPeople).catch(() => {}); }, []);

  const pool = useMemo(() => cases.filter(c => c.module === module && c.status === 'active' && (!onlyUnrun || !resultsByCase[c.id]?.result)), [cases, module, onlyUnrun, resultsByCase]);

  async function sendTeamsDM(assigneeEmail, text) {
    try {
      const tok = await graphToken();
      if (!tok) return false;
      // Find an existing 1:1 chat with the assignee…
      const data = await graphJSON(`${GRAPH}/me/chats?$filter=chatType eq 'oneOnOne'&$expand=members&$top=50`, tok);
      let chatId = (data?.value || []).find(c => (c.members || []).some(m => (m.email || '').toLowerCase() === assigneeEmail))?.id;
      // …or create one (needs the Chat.Create scope — ask interactively once).
      if (!chatId) {
        const account = msalInstance.getAllAccounts()[0];
        const tok2 = (await msalInstance.acquireTokenPopup({ scopes: ['Chat.Create', 'ChatMessage.Send'], account }).catch(() => null))?.accessToken;
        if (!tok2) return false;
        const me = account?.username;
        const r = await fetch(`${GRAPH}/chats`, {
          method: 'POST', headers: { Authorization: `Bearer ${tok2}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chatType: 'oneOnOne',
            members: [me, assigneeEmail].map(u => ({
              '@odata.type': '#microsoft.graph.aadUserConversationMember',
              roles: ['owner'],
              'user@odata.bind': `https://graph.microsoft.com/v1.0/users('${u}')`,
            })),
          }),
        });
        if (!r.ok) return false;
        chatId = (await r.json()).id;
      }
      await postChatMessage(tok, chatId, text);
      return true;
    } catch { return false; }
  }

  async function assign() {
    if (!email || pool.length === 0 || busy) return;
    setBusy(true);
    try {
      const res = await api.qaAssign({ run_id: runId, assignee_email: email, case_ids: pool.map(c => c.id), due_date: due, note });
      const teamsOk = await sendTeamsDM(email, res.teamsSummary || '');
      toastOk(`Assigned ${pool.length} case${pool.length !== 1 ? 's' : ''} — bell ✓ · email ${res.emailSent ? '✓' : '✗'} · Teams ${teamsOk ? '✓' : '✗'}`);
      onDone();
    } catch (e) { toastErr(e?.message || 'Could not assign.'); setBusy(false); }
  }

  return (
    <Modal title="Assign test cases" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <label style={FL}>Assign to</label>
          <select value={email} onChange={e => setEmail(e.target.value)} style={inputStyle}>
            <option value="">— pick a person —</option>
            {people.map(p => <option key={p.email} value={p.email}>{p.name}</option>)}
          </select>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <label style={FL}>Module</label>
            <select value={module} onChange={e => setModule(e.target.value)} style={inputStyle}>
              {QA_MODULES.map(m => <option key={m}>{m}</option>)}
            </select>
          </div>
          <div>
            <label style={FL}>Due date</label>
            <input type="date" value={due} onChange={e => setDue(e.target.value)} min={new Date().toISOString().slice(0, 10)} style={inputStyle} />
          </div>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
          <input type="checkbox" checked={onlyUnrun} onChange={e => setOnlyUnrun(e.target.checked)} />
          Only cases not yet run in this run
        </label>
        <div>
          <label style={FL}>Note (goes in the email / Teams message)</label>
          <input value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. please finish before Friday's release" style={inputStyle} />
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
          {pool.length} case{pool.length !== 1 ? 's' : ''} will be assigned. They'll get a bell notification, an email, and a Teams message (sent from you).
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary-btn" onClick={assign} disabled={!email || pool.length === 0 || busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, opacity: (!email || pool.length === 0) ? 0.6 : 1 }}>
            {busy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <UserPlus size={14} />} Assign
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── Case editor (library + AI-draft review) ───────────────────────────────────
function CaseEditor({ caseObj, onClose, onSaved, toastErr }) {
  const editing = !!caseObj?.id;
  const [f, setF] = useState(() => ({
    module: caseObj?.module || QA_MODULES[0], feature: caseObj?.feature || '',
    title: caseObj?.title || '', precondition: caseObj?.precondition || '',
    stepsText: (caseObj?.steps || []).join('\n'), expected: caseObj?.expected || '',
    priority: caseObj?.priority || 'Medium',
  }));
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));

  async function save(approve = false) {
    if (!f.title.trim()) return toastErr('Title is required.');
    const steps = f.stepsText.split('\n').map(s => s.replace(/^\d+\.\s*/, '').trim()).filter(Boolean);
    if (!steps.length) return toastErr('At least one step is required.');
    setBusy(true);
    const body = { module: f.module, feature: f.feature, title: f.title.trim(), precondition: f.precondition, steps, expected: f.expected, priority: f.priority, ...(approve ? { status: 'active' } : {}) };
    try {
      const saved = editing ? await api.qaUpdateCase(caseObj.id, body) : await api.qaCreateCase(body);
      onSaved(saved);
    } catch (e) { toastErr(e?.message || 'Could not save.'); setBusy(false); }
  }

  return (
    <Modal title={editing ? (caseObj.status === 'draft' ? 'Review AI draft' : 'Edit test case') : 'New test case'} wide onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 120px', gap: 12 }}>
          <div><label style={FL}>Module</label>
            <select value={f.module} onChange={e => set('module', e.target.value)} style={inputStyle}>{QA_MODULES.map(m => <option key={m}>{m}</option>)}</select></div>
          <div><label style={FL}>Feature</label><input value={f.feature} onChange={e => set('feature', e.target.value)} style={inputStyle} /></div>
          <div><label style={FL}>Priority</label>
            <select value={f.priority} onChange={e => set('priority', e.target.value)} style={inputStyle}>{['High', 'Medium', 'Low'].map(p => <option key={p}>{p}</option>)}</select></div>
        </div>
        <div><label style={FL}>Title</label><input value={f.title} onChange={e => set('title', e.target.value)} style={inputStyle} autoFocus={!editing} /></div>
        <div><label style={FL}>Before you start</label><input value={f.precondition} onChange={e => set('precondition', e.target.value)} style={inputStyle} /></div>
        <div><label style={FL}>Steps — one per line</label>
          <textarea value={f.stepsText} onChange={e => set('stepsText', e.target.value)} rows={7} style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.6 }} /></div>
        <div><label style={FL}>What you should see</label>
          <textarea value={f.expected} onChange={e => set('expected', e.target.value)} rows={2} style={{ ...inputStyle, resize: 'vertical' }} /></div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
          {caseObj?.status === 'draft' && (
            <button className="primary-btn" onClick={() => save(true)} disabled={busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {busy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Check size={14} />} Approve into library
            </button>
          )}
          <button className={caseObj?.status === 'draft' ? 'secondary-btn' : 'primary-btn'} onClick={() => save(false)} disabled={busy}>Save</button>
        </div>
      </div>
    </Modal>
  );
}

// ── Report-a-bug form + list ──────────────────────────────────────────────────
function ReportBug({ prefill, onPrefillUsed, canEdit, toastOk, toastErr, onOpenDraft }) {
  const nameOf = useNameResolver();
  const [desc, setDesc] = useState('');
  const [moduleHint, setModuleHint] = useState('');
  const [recording, setRecording] = useState(isRecording());
  const [recCount, setRecCount] = useState(0);
  const [stepsLog, setStepsLog] = useState([]);
  const [shots, setShots] = useState([]);
  const [recordingUrl, setRecordingUrl] = useState('');
  const [screenBusy, setScreenBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [bugs, setBugs] = useState(null);
  const [convertBusy, setConvertBusy] = useState('');
  const [openLog, setOpenLog] = useState('');   // bug id whose recorded steps are expanded
  const [linked, setLinked] = useState(null);   // {case_id, run_id, failed_step} from a failing case
  const fileRef = useRef(null);
  const mediaRef = useRef(null);

  const load = () => api.qaBugs().then(setBugs).catch(() => setBugs([]));
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (prefill) {
      setDesc(prefill.description || '');
      setModuleHint(prefill.module_hint || '');
      setShots(prefill.screenshots || []);
      setLinked({ case_id: prefill.case_id, run_id: prefill.run_id, failed_step: prefill.failed_step });
      onPrefillUsed?.();
    }
  }, [prefill]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => setRecCount(eventCount()), 800);
    return () => clearInterval(t);
  }, [recording]);

  const toggleRecording = () => {
    if (recording) { setStepsLog(stopRecording()); setRecording(false); toastOk('Step recording stopped — the log is attached to this report.'); }
    else { startRecording(); setRecording(true); setRecCount(0); }
  };

  async function recordScreen() {
    if (!navigator.mediaDevices?.getDisplayMedia) return toastErr('Screen recording needs a desktop browser.');
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const rec = new MediaRecorder(stream, { mimeType: 'video/webm' });
      const chunks = [];
      rec.ondataavailable = e => e.data.size && chunks.push(e.data);
      rec.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        setScreenBusy(true);
        try {
          const file = new File([new Blob(chunks, { type: 'video/webm' })], 'recording.webm', { type: 'video/webm' });
          setRecordingUrl(await uploadEvidence(file, 'rec'));
          toastOk('Screen recording attached.');
        } catch (e) { toastErr(e?.message || 'Could not upload the recording.'); }
        setScreenBusy(false);
        mediaRef.current = null;
      };
      rec.start();
      mediaRef.current = rec;
      setTimeout(() => { if (mediaRef.current === rec && rec.state === 'recording') rec.stop(); }, 60_000);   // 60s cap
    } catch { /* user cancelled the picker */ }
  }

  async function addShots(files) {
    for (const f of files) {
      try { setShots(p => [...p]); const url = await uploadEvidence(f); setShots(p => [...p, url]); }
      catch (e) { toastErr(e?.message || 'Screenshot upload failed.'); }
    }
  }

  async function submit() {
    if (!desc.trim() || busy) return;
    setBusy(true);
    try {
      const log = recording ? stopRecording() : stepsLog;
      if (recording) setRecording(false);
      const created = await api.qaCreateBug({ description: desc.trim(), module_hint: moduleHint, steps_log: log, recording_url: recordingUrl, screenshots: shots, ...(linked || {}) });
      setDesc(''); setModuleHint(''); setStepsLog([]); setShots([]); setRecordingUrl(''); setLinked(null);
      toastOk(created?.status === 'converted'
        ? 'Bug report sent — the AI drafted a test case, review it in the Library.'
        : 'Bug report sent — thank you!');
      load();
    } catch (e) { toastErr(e?.message || 'Could not send the report.'); }
    setBusy(false);
  }

  async function convert(bug) {
    setConvertBusy(bug.id);
    try {
      const draft = await api.qaConvertBug(bug.id);
      toastOk('AI drafted a test case — review and approve it.');
      load();
      onOpenDraft?.(draft);
    } catch (e) { toastErr(e?.message || 'AI conversion failed.'); }
    setConvertBusy('');
  }

  return (
    <div onPaste={e => { const fs = filesFromPaste(e); if (fs.length) { e.preventDefault(); addShots(fs); } }}>
      <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: 18, marginBottom: 20 }}>
        <div style={{ fontWeight: 800, fontSize: 15, marginBottom: 4 }}>Found something broken?</div>
        <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 0 14px' }}>
          Describe it in your own words. Record your steps while you reproduce it, paste screenshots (Ctrl+V), and the AI turns it into a proper test case.
        </p>
        {linked?.case_id && <div style={{ fontSize: 12, color: 'hsl(var(--color-red))', fontWeight: 600, marginBottom: 10 }}>Linked to the failing test case — evidence carried over.</div>}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 220px', gap: 12, marginBottom: 12 }}>
          <textarea value={desc} onChange={e => setDesc(e.target.value)} rows={3} placeholder="What happened, and what did you expect instead?" style={{ ...inputStyle, resize: 'vertical' }} />
          <div>
            <select value={moduleHint} onChange={e => setModuleHint(e.target.value)} style={{ ...inputStyle, marginBottom: 8 }}>
              <option value="">Which module? (optional)</option>
              {QA_MODULES.map(m => <option key={m}>{m}</option>)}
            </select>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button className="secondary-btn" onClick={toggleRecording} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6, color: recording ? 'hsl(var(--color-red))' : undefined }}>
                {recording ? <><Square size={12} /> Stop ({recCount})</> : <><ListChecks size={13} /> Record steps</>}
              </button>
              <button className="secondary-btn" onClick={recordScreen} disabled={screenBusy || !!recordingUrl} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {screenBusy ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <Video size={13} />} {recordingUrl ? 'Recorded ✓' : 'Record screen'}
              </button>
              <button className="secondary-btn" onClick={() => fileRef.current?.click()} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Paperclip size={13} /> Screenshots
              </button>
            </div>
          </div>
        </div>
        {(stepsLog.length > 0 || shots.length > 0) && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12, fontSize: 12, color: 'var(--muted)' }}>
            {stepsLog.length > 0 && <span><ListChecks size={12} style={{ verticalAlign: -2 }} /> {stepsLog.length} recorded steps attached</span>}
            {shots.map((u, i) => <Shot key={u + i} url={u} onRemove={() => setShots(p => p.filter(x => x !== u))} />)}
          </div>
        )}
        <input ref={fileRef} type="file" accept="image/*" multiple style={{ display: 'none' }}
          onChange={e => { addShots([...e.target.files]); e.target.value = ''; }} />
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button className="primary-btn" onClick={submit} disabled={!desc.trim() || busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, opacity: desc.trim() ? 1 : 0.6 }}>
            {busy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Send size={14} />} Send report
          </button>
        </div>
      </div>

      {!bugs ? <div style={{ padding: 30, textAlign: 'center' }}><Loader2 size={18} style={{ animation: 'spin 1s linear infinite', color: 'var(--muted)' }} /></div>
        : bugs.length === 0 ? <div style={{ color: 'var(--muted)', fontSize: 13, padding: '10px 4px' }}>No bug reports yet.</div>
        : (
          <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: 6 }}>
            {bugs.map(b => (
              <div key={b.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '11px 12px', borderBottom: '1px solid var(--line)' }}>
                <Bug size={15} style={{ color: b.status === 'converted' ? 'hsl(var(--color-green))' : 'var(--muted)', flexShrink: 0, marginTop: 2 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5 }}>{b.description}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 3, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    {nameOf(b.createdBy)} · {(b.createdAt || '').slice(0, 10)}
                    {b.moduleHint && <span>· {b.moduleHint}</span>}
                    {b.stepsLog.length > 0 && (
                      <button onClick={() => setOpenLog(openLog === b.id ? '' : b.id)}
                        style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'hsl(var(--color-blue))', fontSize: 11.5, fontWeight: 600, padding: 0, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                        <ChevronRight size={11} style={{ transform: openLog === b.id ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }} />
                        {b.stepsLog.length} recorded steps
                      </button>
                    )}
                    {b.recordingUrl && <a href={b.recordingUrl} target="_blank" rel="noreferrer">recording</a>}
                    {b.screenshots.map((u, i) => <Shot key={u + i} url={u} size={22} />)}
                  </div>
                  {openLog === b.id && (
                    <div style={{ marginTop: 8, background: 'var(--mist)', borderRadius: 8, padding: '10px 14px', fontSize: 12.5, maxHeight: 240, overflowY: 'auto' }}>
                      {(() => {
                        let n = 0;
                        const VERB = { clicked: 'Click', 'typed into': 'Type into', 'picked from': 'Choose from' };
                        // Render-time echo dedupe so logs recorded before the
                        // recorder fix also read cleanly.
                        const log = b.stepsLog.filter((s, i, a) => {
                          const p = a[i - 1];
                          return !(p && p.role === s.role && p.label === s.label && (s.t || 0) - (p.t || 0) < 2000);
                        });
                        return log.map((s, i) => s.role === 'opened' ? (
                          <div key={i} style={{ padding: '6px 0 3px', fontWeight: 800, fontSize: 11, letterSpacing: '.05em', textTransform: 'uppercase', color: 'hsl(var(--color-blue))' }}>
                            On {s.label}
                          </div>
                        ) : (
                          <div key={i} style={{ padding: '2px 0', color: 'var(--ink)' }}>
                            <span style={{ color: 'var(--muted)', fontWeight: 700, marginRight: 6 }}>{++n}.</span>
                            {VERB[s.role] || s.role} <b>“{s.label}”</b>
                          </div>
                        ));
                      })()}
                    </div>
                  )}
                </div>
                <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 9px', borderRadius: 20, whiteSpace: 'nowrap', background: b.status === 'converted' ? 'hsla(var(--color-green),0.12)' : b.status === 'dismissed' ? 'var(--mist)' : 'hsla(var(--color-orange),0.12)', color: b.status === 'converted' ? 'hsl(var(--color-green))' : b.status === 'dismissed' ? 'var(--muted)' : 'hsl(var(--color-orange))' }}>
                  {b.status === 'converted' ? 'Converted' : b.status === 'dismissed' ? 'Dismissed' : 'New'}
                </span>
                {canEdit && b.status === 'new' && (
                  <>
                    <button className="secondary-btn" onClick={() => convert(b)} disabled={convertBusy === b.id} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' }}>
                      {convertBusy === b.id ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <Sparkles size={12} />} Convert with AI
                    </button>
                    <button onClick={() => api.qaUpdateBug(b.id, { status: 'dismissed' }).then(load)} title="Dismiss" aria-label="Dismiss report"
                      style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted)', padding: 4 }}><X size={14} /></button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
    </div>
  );
}

// ── Main view ─────────────────────────────────────────────────────────────────
const TABS = [['run', 'Run tests', ListChecks], ['bugs', 'Report a bug', Bug], ['library', 'Library', FlaskConical], ['log', 'Log', ScrollText]];

export default function Testing() {
  const { canAccessModule } = useRole();
  const nameOf = useNameResolver();
  const [enabled, setEnabled] = useState(null);
  const [tab, setTab] = useState('run');
  const [cases, setCases] = useState(null);
  const [runs, setRuns] = useState(null);
  const [runId, setRunId] = useState('');
  const [results, setResults] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [openModule, setOpenModule] = useState('');
  const [runner, setRunner] = useState(null);
  const [assignOpen, setAssignOpen] = useState(false);
  const [editor, setEditor] = useState(undefined);
  const [libFilter, setLibFilter] = useState({ module: 'All', source: 'All' });
  const [genBusy, setGenBusy] = useState('');
  const [activity, setActivity] = useState(null);
  const [bugPrefill, setBugPrefill] = useState(null);
  const [newRunOpen, setNewRunOpen] = useState(false);
  const [newRunName, setNewRunName] = useState('');
  const [toast, setToast] = useState(null);
  const toastOk = m => { setToast({ m, kind: 'ok' }); setTimeout(() => setToast(null), 4000); };
  const toastErr = m => { setToast({ m, kind: 'error' }); setTimeout(() => setToast(null), 5500); };

  const canEdit = canAccessModule('testing', 'administrator', 'editor');
  const myEmail = (msalInstance.getAllAccounts()[0]?.username || '').toLowerCase();

  useEffect(() => { api.qaEnabled().then(r => setEnabled(!!r?.enabled)).catch(() => setEnabled(false)); }, []);
  // Returning from a flow recording (which navigates across modules) lands back
  // here — confirm the save that happened while this view was unmounted.
  useEffect(() => {
    const t = sessionStorage.getItem('qa-flow-saved');
    if (t) { sessionStorage.removeItem('qa-flow-saved'); toastOk(`Flow recorded and saved to “${t}” — use Replay flow next time.`); }
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!enabled) return;
    api.qaCases().then(setCases).catch(() => setCases([]));
    api.qaRuns().then(rs => { setRuns(rs); if (rs[0] && !runId) setRunId(rs[0].id); }).catch(() => setRuns([]));
  }, [enabled]);   // eslint-disable-line react-hooks/exhaustive-deps
  const loadResults = useCallback(() => {
    if (!runId) return;
    api.qaRunResults(runId).then(setResults).catch(() => setResults([]));
    api.qaAssignments(runId).then(setAssignments).catch(() => {});
  }, [runId]);
  useEffect(() => { loadResults(); }, [loadResults]);
  useEffect(() => { if (tab === 'log') api.qaActivity().then(setActivity).catch(() => setActivity([])); }, [tab]);

  const resultsByCase = useMemo(() => Object.fromEntries(results.map(r => [r.caseId, r])), [results]);
  const activeCases = useMemo(() => (cases || []).filter(c => c.status === 'active'), [cases]);
  const byModule = useMemo(() => {
    const m = new Map();
    for (const c of activeCases) { if (!m.has(c.module)) m.set(c.module, []); m.get(c.module).push(c); }
    return m;
  }, [activeCases]);
  const myAssigned = useMemo(() => {
    const ids = new Set();
    let due = '';
    for (const a of assignments) if (a.assignee === myEmail) { (a.caseIds || []).forEach(id => ids.add(id)); if (a.dueDate && (!due || a.dueDate < due)) due = a.dueDate; }
    const remaining = [...ids].filter(id => !resultsByCase[id]?.result).length;
    return { ids, due, remaining };
  }, [assignments, myEmail, resultsByCase]);

  if (enabled === null) return <div style={{ padding: 60, textAlign: 'center' }}><Loader2 size={20} style={{ animation: 'spin 1s linear infinite', color: 'var(--muted)' }} /></div>;
  if (!enabled) return <div style={{ padding: '60px 20px', textAlign: 'center', color: 'var(--muted)' }}>The Testing module is only available on the dev environment.</div>;

  async function createRun() {
    if (!newRunName.trim()) return;
    try {
      const r = await api.qaCreateRun(newRunName.trim());
      setRuns(p => [r, ...(p || [])]); setRunId(r.id); setNewRunOpen(false); setNewRunName('');
      toastOk(`Run “${r.name}” created.`);
    } catch (e) { toastErr(e?.message || 'Could not create the run.'); }
  }

  return (
    <div style={{ animation: 'fadeIn var(--transition-normal) ease-in-out' }}>
      <div className="view-header" style={{ marginBottom: 18 }}>
        <div className="view-title-group">
          <h2>Testing</h2>
          <p>Run the QA test cases, report what you find, and turn bugs into new cases. Dev environment only.</p>
        </div>
      </div>

      <div className="scroll-tabs" style={{ display: 'flex', gap: 8, marginBottom: 22, borderBottom: '1px solid var(--line)', paddingBottom: 1 }}>
        {TABS.map(([key, label, Icon]) => (
          <button key={key} onClick={() => setTab(key)}
            style={{ background: 'none', border: 'none', padding: '10px 16px', fontFamily: 'Inter,sans-serif', fontWeight: 600, fontSize: 13.5, cursor: 'pointer', color: tab === key ? 'var(--ink)' : 'var(--muted)', position: 'relative', display: 'flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap' }}>
            <Icon size={16} /> {label}
            {tab === key && <span style={{ position: 'absolute', left: 0, right: 0, bottom: -1, height: 2.5, background: 'var(--ink)', borderRadius: '4px 4px 0 0' }} />}
          </button>
        ))}
      </div>

      {/* ── RUN TESTS ── */}
      {tab === 'run' && (
        !cases || !runs ? <div style={{ padding: 40, textAlign: 'center' }}><Loader2 size={18} style={{ animation: 'spin 1s linear infinite', color: 'var(--muted)' }} /></div> : (
          <>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16 }}>
              <select value={runId} onChange={e => setRunId(e.target.value)} style={{ ...inputStyle, width: 260 }}>
                {runs.length === 0 && <option value="">— create a run to start —</option>}
                {runs.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
              <button className="secondary-btn" onClick={() => setNewRunOpen(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Plus size={14} /> New run</button>
              <div style={{ flex: 1 }} />
              {canEdit && runId && <button className="primary-btn" onClick={() => setAssignOpen(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}><UserPlus size={14} /> Assign cases</button>}
            </div>

            {myAssigned.ids.size > 0 && (
              <div style={{ background: 'hsla(var(--color-blue),0.08)', border: '1px solid hsla(var(--color-blue),0.25)', borderRadius: 12, padding: '11px 16px', marginBottom: 16, fontSize: 13, fontWeight: 600 }}>
                Assigned to you in this run: {myAssigned.ids.size} case{myAssigned.ids.size !== 1 ? 's' : ''} · {myAssigned.remaining} remaining{myAssigned.due ? ` · due ${myAssigned.due}` : ''}
              </div>
            )}

            {runId && [...byModule.entries()].map(([mod, list]) => {
              const done = list.filter(c => resultsByCase[c.id]?.result).length;
              const failed = list.filter(c => resultsByCase[c.id]?.result === 'fail').length;
              const open = openModule === mod;
              return (
                <div key={mod} style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, marginBottom: 10, overflow: 'hidden' }}>
                  <button onClick={() => setOpenModule(open ? '' : mod)}
                    style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', padding: '13px 16px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', fontFamily: 'Inter,sans-serif' }}>
                    <ChevronRight size={15} style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s', color: 'var(--muted)', flexShrink: 0 }} />
                    <span style={{ fontWeight: 700, fontSize: 14, flex: 1 }}>{mod}</span>
                    {failed > 0 && <span style={{ fontSize: 11.5, fontWeight: 700, color: 'hsl(var(--color-red))' }}>{failed} failed</span>}
                    <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>{done}/{list.length}</span>
                    <span style={{ width: 90, height: 6, borderRadius: 4, background: 'var(--mist)', overflow: 'hidden', flexShrink: 0 }}>
                      <span style={{ display: 'block', width: `${(done / list.length) * 100}%`, height: '100%', background: failed ? 'hsl(var(--color-orange))' : 'hsl(var(--color-green))' }} />
                    </span>
                  </button>
                  {open && list.map(c => {
                    const r = resultsByCase[c.id];
                    const mine = myAssigned.ids.has(c.id);
                    return (
                      <button key={c.id} onClick={() => setRunner(c)}
                        style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '10px 16px 10px 43px', background: 'none', border: 'none', borderTop: '1px solid var(--line)', cursor: 'pointer', textAlign: 'left', fontFamily: 'Inter,sans-serif' }}>
                        <span style={{ width: 7, height: 7, borderRadius: '50%', background: PRI_COLOR[c.priority], flexShrink: 0 }} title={`${c.priority} priority`} />
                        <span style={{ flex: 1, fontSize: 13.5, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {c.title}{mine && <span style={{ fontSize: 10.5, fontWeight: 800, color: 'hsl(var(--color-blue))', marginLeft: 8 }}>YOURS</span>}
                        </span>
                        {r?.testedBy && <span style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{nameOf(r.testedBy)}</span>}
                        <ResultPill result={r?.result} />
                      </button>
                    );
                  })}
                </div>
              );
            })}
            {!runId && <div style={{ color: 'var(--muted)', fontSize: 13.5, textAlign: 'center', padding: 30 }}>Create a run to start testing — e.g. “Jul 15 regression”.</div>}
          </>
        )
      )}

      {/* ── REPORT A BUG ── */}
      {tab === 'bugs' && (
        <ReportBug prefill={bugPrefill} onPrefillUsed={() => setBugPrefill(null)} canEdit={canEdit}
          toastOk={toastOk} toastErr={toastErr} onOpenDraft={d => { setEditor(d); }} />
      )}

      {/* ── LIBRARY ── */}
      {tab === 'library' && (
        !cases ? <div style={{ padding: 40, textAlign: 'center' }}><Loader2 size={18} style={{ animation: 'spin 1s linear infinite', color: 'var(--muted)' }} /></div> : (
          <>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
              <select value={libFilter.module} onChange={e => setLibFilter(p => ({ ...p, module: e.target.value }))} style={{ ...inputStyle, width: 200 }}>
                <option>All</option>{QA_MODULES.map(m => <option key={m}>{m}</option>)}
              </select>
              <select value={libFilter.source} onChange={e => setLibFilter(p => ({ ...p, source: e.target.value }))} style={{ ...inputStyle, width: 160 }}>
                <option value="All">All sources</option><option value="seed">Seeded (audit)</option><option value="ai">AI converted</option><option value="manual">Manual</option>
              </select>
              <div style={{ flex: 1 }} />
              {canEdit && <button className="primary-btn" onClick={() => setEditor(null)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Plus size={14} /> New test case</button>}
            </div>
            <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: 6 }}>
              {cases.filter(c => (libFilter.module === 'All' || c.module === libFilter.module) && (libFilter.source === 'All' || c.source === libFilter.source)).map(c => (
                <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderBottom: '1px solid var(--line)' }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: PRI_COLOR[c.priority], flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{c.module} · {c.feature} · {(c.steps || []).length} steps</div>
                  </div>
                  {c.status === 'draft' && <span style={{ fontSize: 10.5, fontWeight: 800, color: 'hsl(var(--color-orange))', background: 'hsla(var(--color-orange),0.12)', padding: '2px 8px', borderRadius: 20 }}>AI DRAFT</span>}
                  {(c.flow || []).length > 0 && <span title="Has a recorded flow — replayable" style={{ fontSize: 10.5, fontWeight: 800, color: 'hsl(var(--color-blue))', background: 'hsla(var(--color-blue),0.10)', padding: '2px 8px', borderRadius: 20 }}>FLOW</span>}
                  {c.e2eSpec && <span title="Has a Playwright test — runs automatically in CI" style={{ fontSize: 10.5, fontWeight: 800, color: 'hsl(var(--color-green))', background: 'hsla(var(--color-green),0.10)', padding: '2px 8px', borderRadius: 20, display: 'inline-flex', alignItems: 'center', gap: 3 }}><Bot size={10} /> E2E</span>}
                  {c.source === 'ai' && c.status !== 'draft' && <Sparkles size={13} style={{ color: 'var(--muted)' }} title="Converted from a bug report" />}
                  {canEdit && (
                    <>
                      <button className="secondary-btn" title={c.e2eSpec ? 'Regenerate the Playwright test (AI)' : 'Generate a Playwright test (AI) — runs automatically in CI'}
                        disabled={genBusy === c.id}
                        onClick={() => { setGenBusy(c.id); api.qaGenerateE2e(c.id)
                          .then(() => { toastOk('Playwright test generated — CI will run it on its next pass.'); api.qaCases().then(setCases); })
                          .catch(e => toastErr(e?.message || 'Generation failed.'))
                          .finally(() => setGenBusy('')); }}
                        style={{ padding: '5px 9px' }}>
                        {genBusy === c.id ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <Bot size={12} />}
                      </button>
                      <button className="secondary-btn" onClick={() => setEditor(c)} title={c.status === 'draft' ? 'Review draft' : 'Edit'} style={{ padding: '5px 9px' }}><Pencil size={12} /></button>
                      <button className="secondary-btn" onClick={() => api.qaUpdateCase(c.id, { status: 'archived' }).then(() => { toastOk('Archived.'); api.qaCases().then(setCases); })} title="Archive" style={{ padding: '5px 9px' }}><Archive size={12} /></button>
                    </>
                  )}
                </div>
              ))}
            </div>
          </>
        )
      )}

      {/* ── LOG ── */}
      {tab === 'log' && (
        !activity ? <div style={{ padding: 40, textAlign: 'center' }}><Loader2 size={18} style={{ animation: 'spin 1s linear infinite', color: 'var(--muted)' }} /></div> :
        activity.length === 0 ? <div style={{ color: 'var(--muted)', fontSize: 13.5, textAlign: 'center', padding: 30 }}>No testing activity yet.</div> : (
          <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: 6 }}>
            {activity.map((e, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: '1px solid var(--line)', fontSize: 13 }}>
                {e.kind === 'result'
                  ? <><ResultPill result={e.result} /><span style={{ flex: 1, minWidth: 0 }}><b>{nameOf(e.by)}</b> ran “{e.case}”{e.run ? ` in ${e.run}` : ''}</span></>
                  : <><UserPlus size={14} style={{ color: 'hsl(var(--color-blue))', flexShrink: 0 }} /><span style={{ flex: 1, minWidth: 0 }}><b>{nameOf(e.by)}</b> assigned {e.count} case{e.count !== 1 ? 's' : ''} to <b>{nameOf(e.assignee)}</b>{e.due ? ` (due ${e.due})` : ''}{e.run ? ` in ${e.run}` : ''}</span></>}
                <span style={{ fontSize: 11.5, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{(e.at || '').slice(0, 16).replace('T', ' ')}</span>
              </div>
            ))}
          </div>
        )
      )}

      {/* modals */}
      {runner && (
        <CaseRunner caseObj={runner} runId={runId} existing={resultsByCase[runner.id]}
          onSaved={loadResults} onClose={() => setRunner(null)} toastOk={toastOk} toastErr={toastErr}
          onFileBug={pref => { setRunner(null); setBugPrefill(pref); setTab('bugs'); }} />
      )}
      {assignOpen && (
        <AssignModal runId={runId} cases={activeCases} resultsByCase={resultsByCase}
          onClose={() => setAssignOpen(false)} onDone={() => { setAssignOpen(false); loadResults(); }}
          toastOk={toastOk} toastErr={toastErr} />
      )}
      {editor !== undefined && (
        <CaseEditor caseObj={editor} onClose={() => setEditor(undefined)} toastErr={toastErr}
          onSaved={() => { setEditor(undefined); toastOk('Test case saved.'); api.qaCases().then(setCases); }} />
      )}
      {newRunOpen && (
        <Modal title="New test run" onClose={() => setNewRunOpen(false)}>
          <label style={FL}>Run name</label>
          <input value={newRunName} onChange={e => setNewRunName(e.target.value)} onKeyDown={e => e.key === 'Enter' && createRun()}
            placeholder="e.g. Jul 15 regression" style={inputStyle} autoFocus />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
            <button className="secondary-btn" onClick={() => setNewRunOpen(false)}>Cancel</button>
            <button className="primary-btn" onClick={createRun} disabled={!newRunName.trim()}>Create</button>
          </div>
        </Modal>
      )}

      {toast && (
        <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', background: toast.kind === 'error' ? 'hsl(var(--color-red))' : 'hsl(var(--color-green))', color: '#fff', borderRadius: 10, padding: '10px 18px', fontSize: 13, fontWeight: 600, zIndex: 1300, boxShadow: 'var(--shadow-lg)', maxWidth: '90vw' }}>{toast.m}</div>
      )}
    </div>
  );
}
