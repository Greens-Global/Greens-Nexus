// One run (Oct 28 2026): the shared Modal (60vw / 60vh) with the step
// timeline - a status label, the times, each step's input and output as a
// definition list, its detail, and the error in red - the event payload
// folded away, Replay for a failed run, Cancel for one still waiting, and
// "Open <subject>" into the subject's own module. GET /workflows/runs/{id}.
import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, RotateCcw, XCircle } from 'lucide-react';
import { api } from '../api';
import AsyncSection, { SkeletonBlocks } from '../components/AsyncState';
import { StatusLabel } from '../components/StatusLabel';
import { formatDateTime } from '../lib/datetime';
import { dialog } from '../ui/dialog';
import { Modal } from '../tasks/components';
import { runStatusMeta } from './lib/status';
import { FONT, Muted, errorText, goTo } from './ui';

export default function RunDrawer({ id, onClose, onChanged }) {
  const [run, setRun] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    return api.wfRunGet(id)
      .then((r) => { setRun(r || null); setError(!r); })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const replay = async () => {
    setBusy(true); setNotice('');
    try { await api.wfRunReplay(id); await load(); onChanged?.(); }
    catch (e) { setNotice(errorText(e, 'The run could not be replayed - please try again.')); }
    finally { setBusy(false); }
  };
  const cancel = async () => {
    const ok = await dialog.confirm('Cancel this run? The steps still waiting will not happen.', { title: 'Cancel Run', confirmText: 'Cancel Run', danger: true });
    if (!ok) return;
    setBusy(true); setNotice('');
    try { await api.wfRunCancel(id); await load(); onChanged?.(); }
    catch (e) { setNotice(errorText(e, 'The run could not be cancelled - please try again.')); }
    finally { setBusy(false); }
  };

  const m = runStatusMeta(run?.status);
  const steps = Array.isArray(run?.steps) ? run.steps : [];
  const title = run ? `${run.workflowName || 'Workflow'}${run.version ? ` v${run.version}` : ''} - Run` : 'Run';

  const footer = (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', width: '100%', fontFamily: FONT }}>
      {notice && <span role="alert" style={{ color: 'hsl(var(--color-red))', fontSize: 13, flex: '1 1 100%' }}>{notice}</span>}
      {run?.subjectLink?.view && (
        <button type="button" className="secondary-btn" onClick={() => { goTo(run.subjectLink); onClose(); }} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <ExternalLink size={13} /> Open {run.subjectLabel || 'Subject'}
        </button>
      )}
      <span style={{ flex: 1 }} />
      {run?.status === 'failed' && (
        <button type="button" className="secondary-btn" onClick={replay} disabled={busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <RotateCcw size={13} /> Replay
        </button>
      )}
      {run?.status === 'waiting' && (
        <button type="button" className="secondary-btn" onClick={cancel} disabled={busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <XCircle size={13} /> Cancel
        </button>
      )}
      <button type="button" className="primary-btn" onClick={onClose}>Close</button>
    </div>
  );

  return (
    <Modal title={title} onClose={onClose} footer={footer}>
      <div style={{ fontFamily: FONT, display: 'flex', flexDirection: 'column', gap: 14, minHeight: 0 }}>
        <AsyncSection loading={loading && !run} error={error && !run} onRetry={load}
          errorMessage="This run couldn't be loaded right now - please try again."
          skeleton={<SkeletonBlocks count={3} height={72} />}>
          {run && (
            <>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <StatusLabel label={m.label} color={m.color} />
                <span style={{ fontSize: 13.5, fontWeight: 600 }}>{run.subjectLabel || (run.entity ? `${run.entity} ${run.subjectId || ''}` : '')}</span>
                <Muted>{run.triggerKind ? `${capital(run.triggerKind)} trigger` : ''}{run.startedBy ? ` - started by ${run.startedBy}` : ''}</Muted>
              </div>
              <Facts rows={[
                ['Started', run.startedAt ? formatDateTime(run.startedAt) : '-'],
                ['Finished', run.finishedAt ? formatDateTime(run.finishedAt) : '-'],
                run.summary ? ['Summary', run.summary] : null,
              ]} />
              {run.error && (
                <div role="alert" style={{ padding: '10px 12px', borderRadius: 8, background: 'hsla(var(--color-red),0.08)', color: 'hsl(var(--color-red))', fontSize: 13, overflowWrap: 'anywhere' }}>
                  {run.error}
                </div>
              )}

              <div className="nx-fill" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <h4 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em' }}>Steps</h4>
                {steps.length === 0 ? (
                  <Muted>No steps ran.</Muted>
                ) : (
                  <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
                    {steps.map((s, i) => <Step key={s.id || s.stepId || i} step={s} index={i + 1} />)}
                  </ol>
                )}
              </div>

              {run.event && (
                <details style={{ border: '1px solid var(--line)', borderRadius: 10, padding: '8px 12px', fontSize: 13 }}>
                  <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
                    Event{run.event.key ? `: ${run.event.key}` : ''}{run.event.at ? ` - ${formatDateTime(run.event.at)}` : ''}
                  </summary>
                  <pre style={{ margin: '8px 0 0', fontSize: 12, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: 'var(--ink)', maxHeight: 320, overflow: 'auto' }}>
                    {JSON.stringify(run.event.payload ?? {}, null, 2)}
                  </pre>
                  <Muted style={{ display: 'block', marginTop: 6 }}>Only the fields you may see are shown here.</Muted>
                </details>
              )}
            </>
          )}
        </AsyncSection>
      </div>
    </Modal>
  );
}

const capital = (s) => String(s || '').replace(/^\w/, (c) => c.toUpperCase());

function Step({ step, index }) {
  const m = runStatusMeta(step.status);
  const failed = step.status === 'failed';
  return (
    <li style={{ border: `1px solid ${failed ? 'hsla(var(--color-red),0.5)' : 'var(--line)'}`, borderRadius: 10, padding: '10px 12px', display: 'grid', gap: 6 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <Muted style={{ fontVariantNumeric: 'tabular-nums' }}>{index}.</Muted>
        <span style={{ fontSize: 13.5, fontWeight: 700, flex: 1, minWidth: 120 }}>{step.label || step.action || capital(step.kind)}</span>
        {step.attempt > 1 && <Muted>attempt {step.attempt}</Muted>}
        <StatusLabel label={m.label} color={m.color} size="sm" />
      </div>
      <Muted>
        {step.startedAt ? formatDateTime(step.startedAt) : ''}
        {step.finishedAt ? ` to ${formatDateTime(step.finishedAt)}` : ''}
      </Muted>
      {step.detail && (
        <div style={{ fontSize: 13, color: failed ? 'hsl(var(--color-red))' : 'var(--ink)', overflowWrap: 'anywhere' }}>{step.detail}</div>
      )}
      <Pairs title="Input" obj={step.input} />
      <Pairs title="Output" obj={step.output} />
    </li>
  );
}

/** An object as a definition list; nested values are shown as JSON. */
function Pairs({ title, obj }) {
  if (!obj || typeof obj !== 'object' || !Object.keys(obj).length) return null;
  return (
    <div>
      <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 2 }}>{title}</div>
      <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'minmax(80px, max-content) minmax(0, 1fr)', gap: '2px 12px', fontSize: 12.5 }}>
        {Object.entries(obj).map(([k, v]) => (
          <Pair key={k} k={k} v={v} />
        ))}
      </dl>
    </div>
  );
}

function Pair({ k, v }) {
  const text = v == null ? '-' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return (
    <>
      <dt style={{ color: 'var(--muted)', fontWeight: 600, overflowWrap: 'anywhere' }}>{k}</dt>
      <dd style={{ margin: 0, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{text}</dd>
    </>
  );
}

function Facts({ rows }) {
  const list = rows.filter(Boolean);
  return (
    <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr)', gap: '4px 14px', fontSize: 13 }}>
      {list.map(([k, v]) => (
        <Pair key={k} k={k} v={v} />
      ))}
    </dl>
  );
}
