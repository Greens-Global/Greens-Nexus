import { useEffect, useState } from 'react';

// The two ledger scans (Loans > Set Up From the Ledger, MRI > Leasing > Set
// Up From the Ledger) run as background jobs on the API (Oct 2: 145 s and
// 305 s live, more than one request may take). The first GET starts the
// scan and answers 202 {scanning, done, total, startedAt}; later GETs the
// same until the result. The dialog polls every three seconds and shows
// "Reading the ledger... 120 of 317 entities" with a bar until the table.
// A failed job answers 424 once (Try Again starts it over).

export const POLL_MS = 3000;

/** Polls `fetcher` until it answers something other than {scanning: true}.
 *  {data, progress, error, retry}: all three null while the first answer is
 *  on its way; `retry` starts over (after a 424). */
export function useLedgerScan(fetcher, deps = [], pollMs = POLL_MS) {
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify([...deps, attempt]);
  // The answer is kept with the key of the run it belongs to, so a new run
  // (another month, Try Again) shows as pending without resetting state in
  // the effect.
  const [state, setState] = useState({ key: null, data: null, progress: null, error: null });
  useEffect(() => {
    let alive = true;
    let timer = null;
    const tick = () => fetcher()
      .then((d) => {
        if (!alive) return;
        if (d && d.scanning) {
          setState({ key, data: null, progress: d, error: null });
          timer = setTimeout(tick, pollMs);
        } else {
          setState({ key, data: d, progress: null, error: null });
        }
      })
      .catch((e) => { if (alive) setState({ key, data: null, progress: null, error: e }); });
    tick();
    return () => { alive = false; if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, pollMs]);
  const current = state.key === key ? state : { data: null, progress: null, error: null };
  return { data: current.data, progress: current.progress, error: current.error, retry: () => setAttempt((n) => n + 1) };
}

export function ScanProgress({ progress, what = 'entities' }) {
  const done = progress?.done || 0;
  const total = progress?.total || 0;
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <div style={{ display: 'grid', gap: 8, padding: '12px 0' }} aria-live="polite">
      <div style={{ fontSize: '0.86rem', color: 'var(--text-secondary)' }}>
        Reading the ledger...{total ? ` ${done} of ${total} ${what}` : ''}
      </div>
      <div role="progressbar" aria-valuemin={0} aria-valuemax={total || 100} aria-valuenow={total ? done : 0} aria-label="Ledger scan progress"
        style={{ height: 8, borderRadius: 999, background: 'var(--bg-secondary)', overflow: 'hidden', border: '1px solid var(--border-color)' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: 'var(--wk-brand, #2b45e1)', transition: 'width 600ms ease' }} />
      </div>
      <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>The scan keeps running on the server; you can close this and open it again later.</div>
    </div>
  );
}

/** "Entities scanned: 253 leaf entities (64 parents skipped - their figures roll up from the children)". */
export function entitiesScannedText(data) {
  const n = data?.entitiesScanned ?? 0;
  const parents = data?.parentsSkipped ?? 0;
  const leaf = `${n} leaf ${n === 1 ? 'entity' : 'entities'}`;
  const base = parents ? `Entities scanned: ${leaf} (${parents} ${parents === 1 ? 'parent' : 'parents'} skipped - their figures roll up from the children)` : `Entities scanned: ${leaf}`;
  // Oct 6 (Loans): historical (H) entities are not read unless asked for.
  const hist = data?.historicalSkipped ?? 0;
  return hist ? `${base}; ${hist} historical (H) ${hist === 1 ? 'entity' : 'entities'} not read` : base;
}

// ── Oct 7 (Charmi): partial results and Retry ───────────────────────────────
// MRI "Set Up From the Ledger" timed out on most entity batches and then said
// "none had one"; MRE "Add From the Ledger" sat at 133 of 142 for 5+ minutes.
// The scan now has a time limit and answers `failed` - [{code, name, reason}]
// for every entity it could not read - with what it did read. The dialog
// says "Read 37 of 142 entities - 105 could not be read", lists them, and
// Retry reads just those again (the same GET with entities=...), merged in.

/** The first scan with every Retry after it: proposals together (a later
 *  read wins), and only the entities still not read as failed. */
export function mergeScans(base, retries = [], keyOf = (p) => JSON.stringify(p)) {
  if (!base) return null;
  let failed = [...(base.failed || [])];
  const by = new Map((base.proposals || []).map((p) => [keyOf(p), p]));
  retries.forEach(({ codes, data }) => {
    if (!data) return;
    failed = failed.filter((f) => !codes.includes(f.code)).concat(data.failed || []);
    (data.proposals || []).forEach((p) => by.set(keyOf(p), p));
  });
  const total = base.entitiesScanned ?? 0;
  return { ...base, failed, proposals: [...by.values()], entitiesRead: Math.max(0, total - failed.length) };
}

export function scanStatusText(total, failed) {
  const n = (k) => `${k} ${k === 1 ? 'entity' : 'entities'}`;
  if (!failed) return `Read all ${n(total)}.`;
  return `Read ${total - failed} of ${n(total)} - ${failed} could not be read.`;
}

/** Retry for the entities a scan could not read: `fetchFor(codes)` is the
 *  scan's GET for just those codes (it answers 202 {scanning} until done).
 *  Runs from the click, polls until the answer, keeps every answer. */
export function useScanRetry(fetchFor, pollMs = POLL_MS) {
  const [retries, setRetries] = useState([]);   // [{ codes, data }]
  const [running, setRunning] = useState(null); // { done, total } while a retry reads
  const [error, setError] = useState(null);
  const run = async (codes) => {
    if (!codes.length || running) return;
    setError(null);
    setRunning({ done: 0, total: codes.length });
    try {
      let d = await fetchFor(codes);
      while (d && d.scanning) {
        setRunning({ done: d.done || 0, total: d.total || codes.length });
        await new Promise((r) => { setTimeout(r, pollMs); });
        d = await fetchFor(codes);
      }
      setRetries((list) => [...list, { codes, data: d }]);
    } catch (e) {
      setError(e);
    } finally {
      setRunning(null);
    }
  };
  return { retries, running, error, run, reset: () => setRetries([]) };
}

/** "Read 37 of 142 entities - 105 could not be read." with the list and Retry. */
export function ScanOutcome({ total, failed = [], onRetry, running = null, error = null }) {
  if (!failed.length) return <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>{scanStatusText(total, 0)}</div>;
  return (
    <div role="status" style={{ fontSize: '0.8rem', color: '#92400e', background: 'rgba(217,119,6,0.08)', border: '1px solid rgba(217,119,6,0.3)', borderRadius: 8, padding: '8px 10px', display: 'grid', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <strong style={{ flex: 1, minWidth: 220 }}>{scanStatusText(total, failed.length)}</strong>
        {onRetry && (
          <button type="button" className="secondary-btn" disabled={!!running} onClick={() => onRetry(failed.map((f) => f.code))} style={{ fontSize: '0.76rem' }}>
            {running ? `Retrying... ${running.done} of ${running.total}` : `Retry ${failed.length} ${failed.length === 1 ? 'Entity' : 'Entities'}`}
          </button>
        )}
      </div>
      <span style={{ color: 'var(--text-secondary)' }}>What is below comes from the entities that were read. The others were not read in time, so nothing is known about them yet.</span>
      {error && <span style={{ color: 'var(--bad-fg, #dc2626)' }}>{error.message || 'The retry could not run.'}</span>}
      <details>
        <summary style={{ cursor: 'pointer' }}>Not Read ({failed.length})</summary>
        <ul style={{ margin: '6px 0 0', paddingLeft: 18, maxHeight: 160, overflowY: 'auto', color: 'var(--text-secondary)' }}>
          {failed.map((f) => <li key={f.code}>{f.name} ({f.code}): {f.reason}</li>)}
        </ul>
      </details>
    </div>
  );
}
