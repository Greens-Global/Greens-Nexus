// Workflows > Runs (Oct 28 2026): what the workflows did. Two views -
//   Runs     one row per run (workflow, subject, status, when)
//   Actions  one row per step that changed or sent something, newest first,
//            across workflows: what, to whom, which record (a link) - Neil's
//            "review the action that results"
// Filters: workflow, status, a date range (DateField, never a native date
// box). Keyset paging: GET /workflows/runs?before=<cursor> with the `next`
// the server returned - Load More appends. The server pages by time, so the
// To date seeds the first request's `before` (the end of that day) and the
// From date is applied to each page; once a page runs past From there is
// nothing older to load. A row opens the run drawer; run:<id> in the
// address opens it directly.
// The Actions view lists STEPS, whose statuses are done | failed - its
// status filter offers only those two.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { History, ListChecks } from 'lucide-react';
import { api } from '../api';
import AsyncSection, { SkeletonBlocks, Spinner } from '../components/AsyncState';
import { StatusLabel } from '../components/StatusLabel';
import { formatDateTime } from '../lib/datetime';
import { useIsMobile } from '../lib/useIsMobile';
import { DateField, EmptyState } from '../tasks/components';
import RunDrawer from './RunDrawer';
import { beforeFor, inRange, nextCursor, statusesFor } from './lib/runs';
import { RUN_STATUS, runStatusMeta } from './lib/status';
import { buildSub } from './lib/sub';
import { Card, Chip, FONT, LinkButton, Muted } from './ui';
import { goTo } from './lib/navigate';

const PAGE = 50;

export default function Runs({ go, openRunId = null, initialWorkflow = '' }) {
  const isMobile = useIsMobile('(max-width: 760px)');
  const [kind, setKind] = useState('runs');
  const [workflow, setWorkflow] = useState(initialWorkflow);
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [workflows, setWorkflows] = useState([]);
  const [items, setItems] = useState(null);
  const [next, setNext] = useState(null);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState(false);
  const gen = useRef(0);

  useEffect(() => {
    let on = true;
    api.wfList({ scope: 'all' }).catch(() => api.wfList({ scope: 'company' })).then((l) => { if (on && Array.isArray(l)) setWorkflows(l); }).catch(() => {});
    return () => { on = false; };
  }, []);

  const load = useCallback((cursor = null) => {
    const my = ++gen.current;
    if (cursor) setMore(true); else { setLoading(true); setItems(null); setNext(null); }
    const before = cursor || beforeFor(to);
    return api.wfRuns({ kind, workflow, status, before, limit: PAGE })
      .then((res) => {
        if (my !== gen.current) return;
        const page = Array.isArray(res?.items) ? res.items : [];
        setItems((cur) => (cursor ? [...(cur || []), ...page] : page));
        setNext(nextCursor(page, res?.next, from));
        setError(false);
      })
      .catch(() => { if (my === gen.current) setError(true); })
      .finally(() => { if (my === gen.current) { setLoading(false); setMore(false); } });
  }, [kind, workflow, status, from, to]);

  useEffect(() => { load(); }, [load]);

  // The Actions view speaks in step statuses; a run status picked before
  // the switch would filter everything out.
  const switchKind = (k) => {
    setKind(k);
    if (status && !statusesFor(k).includes(status)) setStatus('');
  };

  const shown = useMemo(() => inRange(items, from, to), [items, from, to]);

  const open = (runId) => go(buildSub('run', runId));
  const close = () => go('runs');

  const select = (value, onChange, label, children) => (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}
      style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--ink)', font: 'inherit', fontSize: 13, maxWidth: '100%' }}>
      {children}
    </select>
  );

  return (
    <div style={{ fontFamily: FONT }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
        <div role="tablist" aria-label="View" style={{ display: 'flex', gap: 8 }}>
          <Chip on={kind === 'runs'} onClick={() => switchKind('runs')}>Runs</Chip>
          <Chip on={kind === 'actions'} onClick={() => switchKind('actions')}>Actions</Chip>
        </div>
        {select(workflow, setWorkflow, 'Workflow', (
          <>
            <option value="">Every workflow</option>
            {workflows.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </>
        ))}
        {select(status, setStatus, 'Status', (
          <>
            <option value="">Any status</option>
            {statusesFor(kind).map((s) => <option key={s} value={s}>{RUN_STATUS[s].label}</option>)}
          </>
        ))}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--muted)' }}>
          <DateField value={from} onChange={setFrom} placeholder="From" title="From date" max={to || ''} />
          <span>to</span>
          <DateField value={to} onChange={setTo} placeholder="To" title="To date" />
          {(from || to) && <LinkButton onClick={() => { setFrom(''); setTo(''); }} style={{ fontSize: 12.5 }}>Clear</LinkButton>}
        </span>
      </div>

      <AsyncSection loading={loading && !items} error={error && !items} onRetry={() => load()}
        errorMessage="The runs couldn't be loaded right now - please try again."
        isEmpty={!shown.length && !next}
        skeleton={<SkeletonBlocks count={5} height={52} borderRadius={10} />}
        emptyContent={
          <Card>
            <EmptyState icon={kind === 'runs' ? History : ListChecks}
              title={kind === 'runs' ? 'No runs match' : 'No actions match'}
              hint={items?.length || from || to || status || workflow ? 'Widen the date range or the filters.' : 'Runs appear here as published workflows fire.'} />
          </Card>
        }>
        <Card>
          {kind === 'runs'
            ? shown.map((r) => <RunRow key={r.id} run={r} onOpen={() => open(r.id)} isMobile={isMobile} />)
            : shown.map((a) => <ActionRow key={a.id} row={a} onOpen={() => open(a.runId)} isMobile={isMobile} />)}
          {!shown.length && next && (
            <div style={{ padding: '14px 16px', fontSize: 13, color: 'var(--muted)' }}>Nothing in this page matches the date range - load more to look further back.</div>
          )}
          {next && (
            <div style={{ padding: 12, textAlign: 'center', borderTop: '1px solid var(--line)' }}>
              <button type="button" className="secondary-btn" onClick={() => load(next)} disabled={more} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                {more ? <Spinner size="inline" /> : null} Load More
              </button>
            </div>
          )}
        </Card>
      </AsyncSection>

      {openRunId && <RunDrawer key={openRunId} id={openRunId} onClose={close} onChanged={() => load()} />}
    </div>
  );
}

const RUN_GRID = { display: 'grid', gridTemplateColumns: 'minmax(160px, 1.3fr) minmax(160px, 2fr) 120px 170px', gap: 12, alignItems: 'center' };

function RunRow({ run, onOpen, isMobile }) {
  const m = runStatusMeta(run.status);
  const when = run.startedAt ? formatDateTime(run.startedAt) : '-';
  return (
    <button type="button" onClick={onOpen}
      style={{ ...(isMobile ? { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: '2px 10px' } : RUN_GRID), width: '100%', textAlign: 'left', padding: '10px 16px',
        border: 'none', borderTop: '1px solid var(--line)', background: 'none', cursor: 'pointer', font: 'inherit', color: 'var(--ink)', fontFamily: FONT, fontSize: 13.5 }}>
      <span style={{ fontWeight: 700, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{run.workflowName}{run.version ? <Muted> v{run.version}</Muted> : null}</span>
      {isMobile ? <StatusLabel label={m.label} color={m.color} size="sm" /> : null}
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--muted)' }} title={run.summary || ''}>
        {run.subjectLabel || run.summary || (run.triggerKind ? `${run.triggerKind} trigger` : '')}
        {run.status === 'failed' && run.error ? <span style={{ color: 'hsl(var(--color-red))' }}> - {run.error}</span> : null}
      </span>
      {!isMobile ? <StatusLabel label={m.label} color={m.color} size="sm" /> : null}
      <Muted style={{ whiteSpace: 'nowrap', textAlign: isMobile ? 'right' : 'left' }}>{when}</Muted>
    </button>
  );
}

function ActionRow({ row, onOpen, isMobile }) {
  const m = runStatusMeta(row.status);
  const sent = Array.isArray(row.sent) ? row.sent : [];
  const affected = Array.isArray(row.affected) ? row.affected : [];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'minmax(0, 1fr)' : 'minmax(0, 1fr) auto', gap: '4px 12px', padding: '10px 16px', borderTop: '1px solid var(--line)', fontSize: 13.5 }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <strong>{row.actionLabel || row.action}</strong>
          <StatusLabel label={m.label} color={m.color} size="sm" />
          <LinkButton onClick={onOpen} style={{ fontSize: 12.5 }}>{row.workflowName}</LinkButton>
        </div>
        {row.line && <div style={{ marginTop: 2, overflowWrap: 'anywhere' }}>{row.line}</div>}
        {sent.length > 0 && <Muted>To {sent.join(', ')}</Muted>}
        {affected.length > 0 && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
            {affected.map((a, i) => (
              a.link?.view
                ? <LinkButton key={`${a.entity}:${a.id}:${i}`} onClick={() => goTo(a.link)} style={{ fontSize: 12.5 }}>{a.label || `${a.entity} ${a.id}`}</LinkButton>
                : <Muted key={`${a.entity}:${a.id}:${i}`}>{a.label || `${a.entity} ${a.id}`}</Muted>
            ))}
          </div>
        )}
      </div>
      <Muted style={{ whiteSpace: 'nowrap', textAlign: isMobile ? 'left' : 'right' }}>{row.startedAt ? formatDateTime(row.startedAt) : ''}</Muted>
    </div>
  );
}
