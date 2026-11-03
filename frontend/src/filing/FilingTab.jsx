import { useEffect, useMemo, useState } from 'react';
import { FolderInput, RefreshCw, SlidersHorizontal, X } from 'lucide-react';
import { api } from '../api';
import { Modal } from '../tasks/components';
import { dialog } from '../ui/dialog';
import { ErrorBanner, LoadingState, SkeletonBlocks } from '../components/AsyncState';
import { formatDateTime } from '../lib/datetime';

// â”€â”€ Documents > Filing & Sorting â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// The Egnyte filing engine's screen (routers/filing.py + filing_rules.py).
// Scan reads the #Unsorted staging folders and proposes, per the Filing
// Rulebook, a canonical name and destination for every file; a person applies.
// Rules only - no AI. A doc class auto-files only after a manager verified its
// destination and switched it on under Rules; everything else is the review
// queue, each row saying in plain words what a human must decide.

const CHIP = {
  auto:   { bg: 'hsla(var(--color-green), 0.12)', fg: 'hsl(var(--color-green))', label: 'Ready' },
  review: { bg: 'hsla(45, 93%, 47%, 0.14)',        fg: 'hsl(35, 90%, 34%)',       label: 'Needs Review' },
  skip:   { bg: 'hsla(220, 9%, 46%, 0.12)',        fg: 'hsl(220, 9%, 40%)',       label: 'Skipped' },
  done:   { bg: 'hsl(var(--color-green))',          fg: '#fff',                    label: 'Filed' },
  failed: { bg: 'hsla(var(--color-red), 0.12)',     fg: 'hsl(var(--color-red))',   label: 'Failed' },
};

function StatusChip({ status }) {
  const c = CHIP[status] || CHIP.skip;
  return (
    <span style={{ display: 'inline-block', padding: '2px 10px', borderRadius: 999, fontSize: 11.5, fontWeight: 700, background: c.bg, color: c.fg, whiteSpace: 'nowrap' }}>
      {c.label}
    </span>
  );
}

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'auto', label: 'Ready' },
  { key: 'review', label: 'Needs Review' },
  { key: 'skip', label: 'Skipped' },
];

export default function FilingTab({ toastOk, toastErr }) {
  const [status, setStatus] = useState(null);     // null = loading, false = failed
  const [scan, setScan] = useState(null);         // {proposals, counts, ...}
  const [scanning, setScanning] = useState(false);
  const [applying, setApplying] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [results, setResults] = useState({});     // sourcePath -> {ok, error, to}
  const [filter, setFilter] = useState('all');
  const [rulesOpen, setRulesOpen] = useState(false);
  const [activity, setActivity] = useState(null);

  const loadStatus = () => api.filingStatus().then(setStatus).catch(() => setStatus(false));
  useEffect(() => { loadStatus(); }, []);
  useEffect(() => { api.filingActivity().then(d => setActivity(d.rows)).catch(() => setActivity([])); }, []);

  const runScan = () => {
    setScanning(true); setResults({}); setSelected(new Set());
    api.filingScan()
      .then((data) => {
        setScan(data);
        // Everything that is ready starts selected - the person unticks, not ticks.
        setSelected(new Set(data.proposals.filter(p => p.status === 'auto').map(p => p.sourcePath)));
      })
      .catch(e => toastErr?.(e.message || 'The scan failed'))
      .finally(() => setScanning(false));
  };

  const applySelected = async () => {
    const moves = (scan?.proposals || [])
      .filter(p => p.status === 'auto' && selected.has(p.sourcePath) && !results[p.sourcePath]?.ok)
      .map(p => ({ sourcePath: p.sourcePath, destFolder: p.destFolder, newName: p.newName, docType: p.docType, rule: p.rule }));
    if (!moves.length) return;
    const ok = await dialog.confirm(
      `Move ${moves.length} file${moves.length === 1 ? '' : 's'} out of #Unsorted into ${moves.length === 1 ? 'its folder' : 'their folders'}? Each move is logged in the Audit Log and can be moved back.`,
      { title: 'File These Documents', confirmText: `Move ${moves.length}` });
    if (!ok) return;
    setApplying(true);
    try {
      const out = await api.filingApply(moves);
      const next = { ...results };
      for (const r of out.results) next[r.sourcePath] = r;
      setResults(next);
      if (out.moved) toastOk?.(`Filed ${out.moved} document${out.moved === 1 ? '' : 's'}`);
      if (out.failed) toastErr?.(`${out.failed} could not be moved - see the rows for why`);
      api.filingActivity().then(d => setActivity(d.rows)).catch(() => {});
    } catch (e) {
      toastErr?.(e.message || 'Could not apply the moves');
    } finally {
      setApplying(false);
    }
  };

  const rows = useMemo(() => {
    const all = scan?.proposals || [];
    if (filter === 'all') return all;
    return all.filter(p => p.status === filter);
  }, [scan, filter]);

  const readyLeft = useMemo(
    () => (scan?.proposals || []).filter(p => p.status === 'auto' && selected.has(p.sourcePath) && !results[p.sourcePath]?.ok).length,
    [scan, selected, results]);

  if (status === null) return <SkeletonBlocks count={4} height={56} />;
  if (status === false) return <ErrorBanner message="Could not load Filing & Sorting." onRetry={() => { setStatus(null); loadStatus(); }} />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
            <FolderInput size={18} /> Filing & Sorting
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4, maxWidth: 640 }}>
            Scans the #Unsorted folders in Egnyte and proposes a name and a home for each file per the naming SOPs. Nothing moves until you press Move.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {status.mayConfigure && (
            <button className="secondary-btn" onClick={() => setRulesOpen(true)} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <SlidersHorizontal size={15} /> Rules
            </button>
          )}
          <button className="primary-btn" onClick={runScan} disabled={scanning || !status.configured} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <RefreshCw size={15} style={scanning ? { animation: 'spin 1s linear infinite' } : undefined} />
            {scanning ? 'Scanning...' : 'Scan Now'}
          </button>
        </div>
      </div>

      {!status.configured && (
        <div style={{ padding: 16, borderRadius: 12, background: 'hsla(45, 93%, 47%, 0.1)', fontSize: 13.5 }}>
          Egnyte is not connected yet, so there is nothing to scan. Once the Egnyte module is set up this screen works by itself.
        </div>
      )}

      {scanning && <LoadingState size="section" label="Reading the #Unsorted folders" />}

      {scan && !scanning && (
        <>
          {/* Counts + filter */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {FILTERS.map(f => (
              <button key={f.key} onClick={() => setFilter(f.key)}
                className={filter === f.key ? 'secondary-btn' : 'btn-sm'}
                style={{ fontSize: 12.5, padding: '4px 12px' }}>
                {f.label}{f.key !== 'all' ? ` (${scan.counts[f.key] || 0})` : ` (${scan.proposals.length})`}
              </button>
            ))}
            <div style={{ flex: 1 }} />
            {readyLeft > 0 && (
              <button className="primary-btn" onClick={applySelected} disabled={applying}>
                {applying ? 'Moving...' : `Move ${readyLeft} File${readyLeft === 1 ? '' : 's'}`}
              </button>
            )}
          </div>

          {scan.missingRoots?.length > 0 && (
            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
              Not scanned (no access or missing): {scan.missingRoots.join(', ')}
            </div>
          )}
          {scan.truncated && (
            <div style={{ fontSize: 12.5, color: 'hsl(35, 90%, 34%)' }}>
              Showing the first 500 items - file some and scan again for the rest.
            </div>
          )}

          {/* Proposals table */}
          <div style={{ overflowX: 'auto', border: '1px solid var(--border-color)', borderRadius: 12 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: 'left', background: 'var(--bg-secondary)' }}>
                  <th style={{ padding: '8px 10px', width: 30 }}></th>
                  <th style={{ padding: '8px 10px' }}>File</th>
                  <th style={{ padding: '8px 10px' }}>Doc Type</th>
                  <th style={{ padding: '8px 10px' }}>Files To</th>
                  <th style={{ padding: '8px 10px' }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={5} style={{ padding: 18, textAlign: 'center', color: 'var(--text-secondary)' }}>
                    Nothing here - the staging folders are clean.
                  </td></tr>
                )}
                {rows.map((p) => {
                  const r = results[p.sourcePath];
                  const effective = r ? (r.ok ? 'done' : 'failed') : p.status;
                  return (
                    <tr key={p.sourcePath} style={{ borderTop: '1px solid var(--border-color)', verticalAlign: 'top' }}>
                      <td style={{ padding: '8px 10px' }}>
                        {p.status === 'auto' && !r?.ok && (
                          <input type="checkbox" checked={selected.has(p.sourcePath)}
                            onChange={(e) => {
                              const next = new Set(selected);
                              if (e.target.checked) next.add(p.sourcePath); else next.delete(p.sourcePath);
                              setSelected(next);
                            }} />
                        )}
                      </td>
                      <td style={{ padding: '8px 10px', maxWidth: 340 }}>
                        <div style={{ fontWeight: 600, wordBreak: 'break-word' }}>{p.currentName}</div>
                        <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', wordBreak: 'break-all' }}>
                          {p.sourcePath.slice(0, p.sourcePath.lastIndexOf('/'))}
                        </div>
                      </td>
                      <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>{p.docType || '-'}</td>
                      <td style={{ padding: '8px 10px', maxWidth: 380 }}>
                        {p.destFolder ? (
                          <>
                            <div style={{ wordBreak: 'break-word' }}>{p.newName}</div>
                            <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', wordBreak: 'break-all' }}>{p.destFolder}</div>
                          </>
                        ) : <span style={{ color: 'var(--text-secondary)' }}>-</span>}
                      </td>
                      <td style={{ padding: '8px 10px', maxWidth: 300 }}>
                        <StatusChip status={effective} />
                        {r && !r.ok && <div style={{ fontSize: 12, color: 'hsl(var(--color-red))', marginTop: 4 }}>{r.error}</div>}
                        {!r && p.reasons?.length > 0 && (
                          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
                            {p.reasons.join('; ')}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Recent filings */}
      {activity?.length > 0 && (
        <div>
          <div style={{ fontSize: 13.5, fontWeight: 700, margin: '8px 0' }}>Recent Filings</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {activity.slice(0, 10).map((a, i) => (
              <div key={i} style={{ fontSize: 12.5, color: 'var(--text-secondary)', wordBreak: 'break-all' }}>
                {formatDateTime(a.at)} - {a.by} filed {a.to}
              </div>
            ))}
          </div>
        </div>
      )}

      {rulesOpen && (
        <RulesSheet status={status} onClose={() => setRulesOpen(false)}
          onSaved={(data) => setStatus(s => ({ ...s, templates: data.templates, scanRoots: data.scanRoots }))}
          toastOk={toastOk} toastErr={toastErr} />
      )}
    </div>
  );
}

// The Rules sheet: which document classes may auto-file, and which folders get
// scanned. A class switch saves on change (house rule); review-always classes
// show why they stay human instead of a switch.
function RulesSheet({ status, onClose, onSaved, toastOk, toastErr }) {
  const [newRoot, setNewRoot] = useState('');
  const save = (body, okMsg) =>
    api.filingConfig(body)
      .then((data) => { onSaved(data); toastOk?.(okMsg); })
      .catch(e => toastErr?.(e.message || 'Could not save'));

  return (
    <Modal title="Filing Rules" onClose={onClose} width="max(60vw, 560px)">
      <div className="nx-fill" style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 18, paddingRight: 4 }}>
        <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
          A class auto-files only after you have checked its destination against the real Egnyte tree and switched it on here. Until then its files appear as Needs Review with the proposed destination shown, so you can verify before trusting it.
        </div>

        <div>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Scanned Folders</div>
          {status.scanRoots.map((root) => (
            <div key={root} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--border-color)', fontSize: 12.5 }}>
              <span style={{ flex: 1, wordBreak: 'break-all' }}>{root}</span>
              <button className="btn-sm" title="Stop scanning this folder"
                onClick={() => save({ scanRoots: status.scanRoots.filter(r => r !== root) }, 'Folder removed')}>
                <X size={14} />
              </button>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <input value={newRoot} onChange={e => setNewRoot(e.target.value)} placeholder="/Shared/#Entities/Some Entity/#Unsorted"
              style={{ flex: 1, fontSize: 12.5, padding: '6px 10px', border: '1px solid var(--border-color)', borderRadius: 8 }} />
            <button className="secondary-btn" disabled={!newRoot.trim()}
              onClick={() => { save({ scanRoots: [...status.scanRoots, newRoot.trim()] }, 'Folder added'); setNewRoot(''); }}>
              Add
            </button>
          </div>
        </div>

        <div>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Document Classes</div>
          {status.templates.map((t) => (
            <div key={t.key} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--border-color)' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{t.label}</div>
                {t.dest && <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', wordBreak: 'break-all' }}>{t.dest}</div>}
                {(t.reviewReason || t.note) && (
                  <div style={{ fontSize: 11.5, color: 'hsl(35, 90%, 34%)', marginTop: 2 }}>{t.reviewReason || t.note}</div>
                )}
              </div>
              {t.reviewAlways ? (
                <span style={{ fontSize: 11.5, color: 'var(--text-secondary)', whiteSpace: 'nowrap', paddingTop: 2 }}>Human Only</span>
              ) : (
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, whiteSpace: 'nowrap', cursor: 'pointer' }}>
                  <input type="checkbox" checked={t.confirmed}
                    onChange={(e) => save({ confirmed: { [t.key]: e.target.checked } },
                      e.target.checked ? `${t.label} now auto-files` : `${t.label} back to review`)} />
                  Auto-File
                </label>
              )}
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
