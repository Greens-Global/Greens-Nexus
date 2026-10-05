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
  return hist ? `${base} · ${hist} historical left out` : base;
}
