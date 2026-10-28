// Test rail (Oct 2026). Test With A Recent Event: one of the last real
// events of the trigger's kind, or the catalog sample, run in plan mode -
// every condition shown with its value and a pass / fail mark, every step as
// the line it would produce, a wait as "Would wait until ...". Nothing is
// sent. A schedule previews who it would run on ("If this ran now: N");
// a date or manual trigger tests with the catalog sample only.
import { useEffect, useState } from 'react';
import { Check, Play, X } from 'lucide-react';
import { api } from '../../api';
import AsyncSection, { SkeletonBlocks } from '../../components/AsyncState';
import { StatusLabel } from '../../components/StatusLabel';
import { formatDateTime } from '../../lib/datetime';
import { btn } from '../../tasks/theme';
import { RUN_STEP_STATUS, chip, hint, sentence } from '../lib/text.builder-helpers';
import { errorText } from '../lib/errors';

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function stepLine(s) {
  const detail = String(s.detail || '');
  if (s.kind === 'wait') {
    const until = ISO_RE.test(detail) ? formatDateTime(detail) : detail.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, (m) => formatDateTime(m));
    return until ? `Would wait until ${until}` : 'Would wait';
  }
  return detail || s.label || s.action || s.kind;
}

export default function RailTest({ workflow, definition, dirty, onBeforeTest, onTested }) {
  const id = workflow?.id;
  const kind = definition?.trigger?.kind || 'event';
  // The recent events are keyed by the workflow they were loaded for, so a
  // different workflow shows the skeleton, never the last one's rows.
  const eventsKey = `${id}:${kind}`;
  const [loaded, setLoaded] = useState({ key: '', rows: null, error: null });
  const events = loaded.key === eventsKey ? loaded.rows : null;
  const eventsError = loaded.key === eventsKey ? loaded.error : null;
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState(null);

  useEffect(() => {
    if (!id || kind !== 'event') return undefined;
    let alive = true;
    api.wfRecentEvents(id).then((rows) => { if (alive) setLoaded({ key: eventsKey, rows: Array.isArray(rows) ? rows : rows?.items || [], error: null }); })
      .catch((e) => { if (alive) setLoaded({ key: eventsKey, rows: null, error: e }); });
    return () => { alive = false; };
  }, [id, kind, eventsKey]);

  const run = async (eventId) => {
    setRunning(true); setError(''); setResult(null);
    try {
      if (dirty && onBeforeTest) await onBeforeTest();
      const r = await api.wfTest(id, eventId ? { eventId } : {});
      setResult(r);
      onTested?.(r);
    } catch (e) {
      setError(errorText(e, 'The test could not run.'));
    } finally { setRunning(false); }
  };

  const loadPreview = async () => {
    setPreviewError(null); setPreview(null); setRunning(true);
    try {
      if (dirty && onBeforeTest) await onBeforeTest();
      const p = await api.wfPreviewSchedule(id);
      setPreview(p);
    } catch (e) { setPreviewError(e); } finally { setRunning(false); }
  };

  const steps = result?.steps || [];
  const trace = result?.trace || [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {dirty && <div style={hint}>Your changes are saved as a draft before the test runs.</div>}

      {kind === 'event' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>Test With A Recent Event</div>
            <button type="button" onClick={() => run('')} disabled={running} style={btn('outline')}><Play size={13} /> Use Sample</button>
          </div>
          <AsyncSection loading={events === null && !eventsError} error={eventsError} isEmpty={!events?.length}
            errorMessage="Recent events could not be loaded." skeleton={<SkeletonBlocks count={3} height={34} borderRadius={8} />}
            emptyContent={<div style={hint}>No recent events of this kind yet. Use Sample runs the catalog's example.</div>}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 220, overflowY: 'auto' }}>
              {(events || []).map((ev) => (
                <button key={ev.id} type="button" onClick={() => run(ev.id)} disabled={running} style={{
                  display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', width: '100%', textAlign: 'left',
                  border: '1px solid var(--nx-border2)', background: 'var(--nx-surface)', borderRadius: 8, padding: '7px 10px', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, color: 'var(--nx-ink)',
                }}>
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ev.subjectLabel || ev.subject_label || ev.id}</span>
                  <span style={{ ...hint, flexShrink: 0 }}>{formatDateTime(ev.at)}</span>
                </button>
              ))}
            </div>
          </AsyncSection>
        </div>
      )}

      {kind === 'schedule' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>Preview</div>
            <span style={{ display: 'inline-flex', gap: 6 }}>
              {kind === 'schedule' && <button type="button" onClick={loadPreview} disabled={running} style={btn('outline')}>Who Would It Run On</button>}
              <button type="button" onClick={() => run('')} disabled={running} style={btn('outline')}><Play size={13} /> Use Sample</button>
            </span>
          </div>
          {previewError && <div style={{ ...hint, color: 'hsl(var(--color-red))' }}>{errorText(previewError, 'The preview could not be loaded.')}</div>}
          {preview && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={sentence}>If this ran now: <strong>{preview.count ?? (preview.items || []).length}</strong></div>
              {(preview.items || []).map((it, i) => <div key={i} style={{ ...hint, color: 'var(--nx-ink)' }}>{it.label}</div>)}
              {!(preview.items || []).length && <div style={hint}>Nobody right now.</div>}
            </div>
          )}
        </div>
      )}

      {(kind === 'manual' || kind === 'date') && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 700 }}>Test With The Sample</div>
          <button type="button" onClick={() => run('')} disabled={running} style={btn('outline')}><Play size={13} /> Use Sample</button>
        </div>
      )}

      {running && <SkeletonBlocks count={3} height={28} borderRadius={8} />}
      {error && <div style={{ ...hint, color: 'hsl(var(--color-red))' }}>{error}</div>}

      {result && !running && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }} aria-label="Test result">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 700 }}>Result</span>
            <StatusLabel label={result.summary ? 'Tested' : 'Tested'} color="#2563eb" size="sm" />
            {result.subjectLabel && <span style={hint}>{result.subjectLabel}</span>}
          </div>
          {result.summary && <div style={sentence}>{result.summary}</div>}
          {!!trace.length && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ ...hint, fontWeight: 700 }}>Conditions</div>
              {trace.map((t, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5 }} data-testid="trace-row">
                  <span aria-label={t.ok ? 'Passed' : 'Failed'} style={{ color: t.ok ? 'hsl(var(--color-green))' : 'hsl(var(--color-red))', flexShrink: 0, marginTop: 2 }}>{t.ok ? <Check size={14} /> : <X size={14} />}</span>
                  <span>
                    <span style={{ color: 'var(--nx-ink)' }}>{t.field} {t.op} {Array.isArray(t.value) ? t.value.join(', ') : String(t.value ?? '')}</span>
                    <span style={hint}> (was {String(t.actual ?? '-')})</span>
                  </span>
                </div>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ ...hint, fontWeight: 700 }}>Steps</div>
            {!steps.length && <div style={hint}>No step would run.</div>}
            {steps.map((s, i) => {
              const meta = RUN_STEP_STATUS[s.status] || { label: s.status, color: '#64748b' };
              return (
                <div key={s.stepId || i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5 }} data-testid="planned-step">
                  <StatusLabel label={meta.label} color={meta.color} size="sm" />
                  <span style={{ color: s.status === 'skipped' ? 'var(--nx-dim)' : 'var(--nx-ink)' }}>{stepLine(s)}</span>
                </div>
              );
            })}
          </div>
          <span style={{ ...chip, alignSelf: 'flex-start', fontSize: 11.5 }}>Nothing was sent. This was a dry run.</span>
        </div>
      )}
    </div>
  );
}
