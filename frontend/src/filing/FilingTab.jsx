import { useEffect, useMemo, useRef, useState } from 'react';
import { FolderInput, RefreshCw, SlidersHorizontal, Square, X } from 'lucide-react';
import { api } from '../api';
import EgnyteTree from '../egnyte/EgnyteTree';
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
  labeled:   { bg: 'hsla(var(--color-green), 0.12)', fg: 'hsl(var(--color-green))', label: 'Labeled' },
  unlabeled: { bg: 'hsla(45, 93%, 47%, 0.14)',       fg: 'hsl(35, 90%, 34%)',       label: 'Unlabeled' },
  renamed:   { bg: 'hsl(var(--color-green))',         fg: '#fff',                    label: 'Renamed' },
};

// The suggestion differs from the current name only in separators and
// whitespace - "Plan -Charles" vs "Plan - Charles". Called out in words,
// because to the eye the two names read identical (Visesh, 11/04).
const spacingOnly = (a, b) =>
  !!a && !!b && a !== b && a.replace(/[\s-]+/g, '') === b.replace(/[\s-]+/g, '');

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
  const [view, setView] = useState('queue');      // queue = work the moves; names = what every file should be called
  // A review row whose name is already canonical needs nothing - hidden from
  // the queue by default (Visesh, 11/04: ignore the correctly labeled files).
  const [hideLabeled, setHideLabeled] = useState(true);
  const [fileIt, setFileIt] = useState(null);     // the row being filed by hand
  const ROW_PAGE = 200;
  const [shown, setShown] = useState(ROW_PAGE);   // rows rendered; Show More adds a page
  const [query, setQuery] = useState('');         // narrows the rows by name or folder
  const [rulesOpen, setRulesOpen] = useState(false);
  const [activity, setActivity] = useState(null);
  // The tree's ticks: which folders the next scan covers. Empty = the
  // configured #Unsorted staging folders (the server default). Selection and
  // toggles are per-viewer conveniences, so localStorage is the right home -
  // wrapped, because private windows and blocked site data throw.
  const [pickedFolders, setPickedFolders] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem('filing-picked') || '[]')); }
    catch { return new Set(); }
  });
  const [includeSub, setIncludeSub] = useState(() => {
    try { return localStorage.getItem('filing-include-sub') !== '0'; } catch { return true; }
  });
  useEffect(() => {
    try {
      localStorage.setItem('filing-picked', JSON.stringify([...pickedFolders]));
      localStorage.setItem('filing-include-sub', includeSub ? '1' : '0');
    } catch { /* per-viewer convenience only */ }
  }, [pickedFolders, includeSub]);
  const [progress, setProgress] = useState(null);   // {folders, files} while a walk runs
  const cancelRef = useRef(false);

  const loadStatus = () => api.filingStatus().then(setStatus).catch(() => setStatus(false));
  useEffect(() => { loadStatus(); }, []);
  useEffect(() => { api.filingActivity().then(d => setActivity(d.rows)).catch(() => setActivity([])); }, []);

  // Counts and totals are recomputed here because a walked scan arrives in
  // pieces - the server's per-call numbers only cover that call.
  const assemble = (proposals, missingRoots, truncated) => {
    const counts = { auto: 0, review: 0, skip: 0 };
    const totals = { files: 0, labeled: 0, unlabeled: 0 };
    for (const p of proposals) {
      counts[p.status] = (counts[p.status] || 0) + 1;
      if (p.status !== 'skip') { totals.files += 1; totals[p.labeled ? 'labeled' : 'unlabeled'] += 1; }
    }
    return { proposals, counts, totals, missingRoots, truncated };
  };

  // Ticked folders are walked CLIENT-side, a few folders per request, so no
  // single call can outlive the 18-second request limit however deep the
  // tree goes - and the table fills while the walk runs, with a Stop that
  // keeps what is already found.
  // Escondido's #Unsorted alone has a child with 178 subfolders (11/04), so
  // the caps sit well above a real entity tree; the table renders in pages
  // (ROW_PAGE) so a large result never freezes the browser.
  const WALK_FOLDER_CAP = 2000;
  const WALK_FILE_CAP = 10000;
  const runScan = async () => {
    setScanning(true); setResults({}); setSelected(new Set()); setShown(ROW_PAGE);
    cancelRef.current = false;
    try {
      if (!pickedFolders.size) {
        const data = await api.filingScan();
        setScan(data);
        setSelected(new Set(data.proposals.filter(p => p.status === 'auto').map(p => p.sourcePath)));
        return;
      }
      const seen = new Set();
      const queue = [...pickedFolders];
      const missing = [];
      let all = [];
      let folders = 0;
      let truncated = false;
      // One lone failed request (a worker blip, the 11/04 502) must not
      // kill a long walk - a batch gets one more try before giving up.
      const scanBatch = async (paths) => {
        try { return await api.filingScan({ paths }); }
        catch { return await api.filingScan({ paths }); }
      };
      while (queue.length && !cancelRef.current) {
        if (folders >= WALK_FOLDER_CAP || all.length >= WALK_FILE_CAP) { truncated = true; break; }
        // Two batches in flight: a deep tree walks almost twice as fast, and
        // two requests is gentle enough on the API and on Egnyte's rate cap.
        const batches = [];
        while (batches.length < 2 && queue.length) {
          const batch = [];
          while (batch.length < 5 && queue.length) {
            const p = queue.shift();
            if (!seen.has(p)) { seen.add(p); batch.push(p); }
          }
          if (batch.length) batches.push(batch);
        }
        if (!batches.length) continue;
        const resList = await Promise.all(batches.map(scanBatch));
        for (const r of resList) {
          if (r.truncated) truncated = true;   // one folder past the server's per-call cap
          folders += (r.scannedRoots || []).length;
          missing.push(...(r.missingRoots || []));
          all = all.concat(r.proposals || []);
          if (includeSub) queue.push(...(r.subfolders || []));
        }
        setProgress({ folders, files: all.filter(p => p.status !== 'skip').length });
        setScan(assemble(all, missing, truncated));
      }
      const stopped = cancelRef.current && queue.length > 0;
      setScan(assemble(all, missing, truncated || stopped));
      setSelected(new Set(all.filter(p => p.status === 'auto').map(p => p.sourcePath)));
      if (stopped) toastOk?.('Scan stopped - keeping what was found');
    } catch (e) {
      toastErr?.(e.message || 'The scan failed');
    } finally {
      setScanning(false);
      setProgress(null);
    }
  };

  // Rename in place: same folder, the suggested name - through the same
  // /filing/apply as every move (audit row, no overwrite, Egnyte permissions).
  const fixName = async (p) => {
    const newName = p.newName || p.canonicalName;
    const folder = p.sourcePath.slice(0, p.sourcePath.lastIndexOf('/'));
    try {
      const out = await api.filingApply([{ sourcePath: p.sourcePath, destFolder: folder, newName, docType: p.docType || 'Rename', rule: 'rename' }]);
      const r = out.results?.[0];
      if (r?.ok) {
        toastOk?.(`Renamed to ${newName}`);
        setResults(prev => ({ ...prev, [p.sourcePath]: { ...r, renamed: true } }));
        api.filingActivity().then(d => setActivity(d.rows)).catch(() => {});
      } else {
        toastErr?.(r?.error || 'Could not rename the file');
      }
    } catch (e) {
      toastErr?.(e.message || 'Could not rename the file');
    }
  };

  // The rename-only workflow (Visesh, 11/04: "what if somebody just wants to
  // label files"): every wrong name fixed in place, folders untouched.
  const fixable = useMemo(
    () => (scan?.proposals || []).filter(p => p.status === 'review' && !results[p.sourcePath]?.ok
      && (p.newName || p.canonicalName) && (p.newName || p.canonicalName) !== p.currentName),
    [scan, results]);

  const fixAllNames = async () => {
    const ok = await dialog.confirm(
      `Rename ${fixable.length} file${fixable.length === 1 ? '' : 's'} in place to their SOP names? Folders stay as they are; every rename is in the Audit Log.`,
      { title: 'Fix All Names', confirmText: `Rename ${fixable.length}` });
    if (!ok) return;
    setApplying(true);
    try {
      let renamed = 0, failed = 0;
      const next = { ...results };
      for (let i = 0; i < fixable.length; i += 50) {
        const batch = fixable.slice(i, i + 50).map(p => ({
          sourcePath: p.sourcePath,
          destFolder: p.sourcePath.slice(0, p.sourcePath.lastIndexOf('/')),
          newName: p.newName || p.canonicalName,
          docType: p.docType || 'Rename', rule: 'rename',
        }));
        const out = await api.filingApply(batch);
        for (const r of out.results) next[r.sourcePath] = r.ok ? { ...r, renamed: true } : r;
        renamed += out.moved; failed += out.failed;
      }
      setResults(next);
      if (renamed) toastOk?.(`Renamed ${renamed} file${renamed === 1 ? '' : 's'}`);
      if (failed) toastErr?.(`${failed} could not be renamed - see the rows for why`);
      api.filingActivity().then(d => setActivity(d.rows)).catch(() => {});
    } catch (e) {
      toastErr?.(e.message || 'Could not rename the files');
    } finally {
      setApplying(false);
    }
  };

  // One click to the destination the team's own history points at.
  const fileToLearned = async (p) => {
    try {
      const out = await api.filingApply([{
        sourcePath: p.sourcePath, destFolder: p.learnedDest,
        newName: p.newName || p.canonicalName || p.currentName,
        docType: p.docType || 'Learned', rule: 'learned',
      }]);
      const r = out.results?.[0];
      if (r?.ok) {
        toastOk?.(`Filed to ${p.learnedDest}`);
        setResults(prev => ({ ...prev, [p.sourcePath]: r }));
        api.filingActivity().then(d => setActivity(d.rows)).catch(() => {});
      } else {
        toastErr?.(r?.error || 'Could not move the file');
      }
    } catch (e) {
      toastErr?.(e.message || 'Could not move the file');
    }
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
    let base = hideLabeled ? all.filter(p => !(p.status === 'review' && p.labeled)) : all;
    const q = query.trim().toLowerCase();
    if (q) base = base.filter(p => p.sourcePath.toLowerCase().includes(q));
    if (filter === 'all') return base;
    return base.filter(p => p.status === filter);
  }, [scan, filter, hideLabeled, query]);

  // The scan as a report - a spreadsheet the labeling team or a reviewer can
  // work from. Built in the browser from what is on screen; nothing is sent.
  const exportCsv = () => {
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['Status', 'Labeled', 'Current Name', 'Folder', 'Doc Type', 'Suggested Name', 'Files To', 'Learned Folder', 'Why'];
    const lines = [head.map(cell).join(',')];
    for (const p of (scan?.proposals || [])) {
      if (p.status === 'skip') continue;
      lines.push([
        p.status === 'auto' ? 'Ready' : 'Needs Review', p.labeled ? 'Yes' : 'No',
        p.currentName, p.sourcePath.slice(0, p.sourcePath.lastIndexOf('/')), p.docType,
        p.newName || p.canonicalName, p.destFolder, p.learnedDest || '', (p.reasons || []).join('; '),
      ].map(cell).join(','));
    }
    const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'filing-scan.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const hiddenLabeled = useMemo(
    () => (scan?.proposals || []).filter(p => p.status === 'review' && p.labeled).length,
    [scan]);

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
            Pick folders on the left - or scan the #Unsorted staging folders by default - and every file inside gets a proposed name and home per the naming SOPs. Nothing moves until you press Move.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {status.mayConfigure && (
            <button className="secondary-btn" onClick={() => setRulesOpen(true)} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <SlidersHorizontal size={15} /> Rules
            </button>
          )}
          {scanning ? (
            <button className="secondary-btn" onClick={() => { cancelRef.current = true; }} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Square size={13} /> Stop
            </button>
          ) : (
            <button className="primary-btn" onClick={runScan} disabled={!status.configured} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <RefreshCw size={15} />
              Scan Now{pickedFolders.size ? ` (${pickedFolders.size} Folder${pickedFolders.size === 1 ? '' : 's'})` : ''}
            </button>
          )}
        </div>
      </div>

      {!status.configured && (
        <div style={{ padding: 16, borderRadius: 12, background: 'hsla(45, 93%, 47%, 0.1)', fontSize: 13.5 }}>
          Egnyte is not connected yet, so there is nothing to scan. Once the Egnyte module is set up this screen works by itself.
        </div>
      )}

      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      {status.configured && (
        <div style={{ flex: '0 0 300px', minWidth: 260, maxWidth: 360, border: '1px solid var(--border-color)', borderRadius: 12, padding: '10px 8px', maxHeight: '72vh', overflowY: 'auto' }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, padding: '2px 6px 6px' }}>Scan These Folders</div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '0 6px 8px', cursor: 'pointer' }}>
            <input type="checkbox" checked={includeSub} onChange={e => setIncludeSub(e.target.checked)} />
            Include Subfolders
          </label>
          <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', padding: '0 6px 8px' }}>
            Tick folders (or click one) and press Scan Now. Nothing ticked scans the #Unsorted staging folders.
            {pickedFolders.size > 0 && (
              <button className="btn-sm" onClick={() => setPickedFolders(new Set())} style={{ marginLeft: 6, fontSize: 11 }}>
                Clear ({pickedFolders.size})
              </button>
            )}
          </div>
          <EgnyteTree
            rootLabel="All Files"
            selected={pickedFolders}
            onToggleSelect={(p) => setPickedFolders(prev => {
              const n = new Set(prev);
              if (n.has(p)) n.delete(p); else n.add(p);
              return n;
            })}
            onSelect={(p) => setPickedFolders(p ? new Set([p]) : new Set())}
          />
        </div>
      )}
      <div style={{ flex: 1, minWidth: 360, display: 'flex', flexDirection: 'column', gap: 16 }}>

      {!scan && !scanning && status.configured && (
        <div style={{ border: '1px dashed var(--border-color)', borderRadius: 12, padding: '18px 20px', fontSize: 13, lineHeight: 1.6 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>How It Works</div>
          <ol style={{ margin: 0, paddingLeft: 18, color: 'var(--text-secondary)' }}>
            <li>Tick one or more folders on the left (or click one). Include Subfolders reaches every file inside, however deep.</li>
            <li>Press Scan Now. Each file gets the name the naming SOPs give it; files already named right are counted and hidden.</li>
            <li>Only labeling? Press Fix All Names - every wrong name is corrected in place and nothing moves.</li>
            <li>Filing too? Open a file with its name to check it, then File It (pick the folder) or File to Learned (where the team filed similar files before).</li>
          </ol>
          <div style={{ marginTop: 8, color: 'var(--text-secondary)' }}>Every rename and move is in the Audit Log, and nothing is ever overwritten.</div>
        </div>
      )}

      {scanning && (
        <LoadingState size="section" label={progress
          ? `Scanned ${progress.folders} folder${progress.folders === 1 ? '' : 's'} - ${progress.files} file${progress.files === 1 ? '' : 's'} so far`
          : 'Reading the folders'} />
      )}

      {scan && (
        <>
          {/* Totals: how much of the pile is named right. Each tile opens its
              slice - the number you want to act on is one click away. */}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {[['Total Files', scan.totals?.files ?? 0, null, 'Every scanned file',
               () => { setView('queue'); setFilter('all'); setHideLabeled(false); }],
              ['Labeled', scan.totals?.labeled ?? 0, 'hsl(var(--color-green))', 'Already named right - the Proposed Names view',
               () => setView('names')],
              ['Unlabeled', scan.totals?.unlabeled ?? 0, 'hsl(35, 90%, 34%)', 'The files that need work',
               () => { setView('queue'); setFilter('review'); setHideLabeled(true); }]]
              .map(([label, n, color, hint, go]) => (
              <button key={label} type="button" onClick={go} title={hint}
                style={{ flex: '0 0 auto', minWidth: 130, padding: '10px 16px', border: '1px solid var(--border-color)', borderRadius: 12, background: 'none', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit' }}>
                <div style={{ fontSize: 22, fontWeight: 700, color: color || 'inherit' }}>{n}</div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{label}</div>
              </button>
            ))}
          </div>

          {/* Filing Queue works the moves; Proposed Names shows what every file should be called */}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className={view === 'queue' ? 'secondary-btn' : 'btn-sm'} onClick={() => setView('queue')} style={{ fontSize: 12.5, padding: '4px 12px' }}>Filing Queue</button>
            <button className={view === 'names' ? 'secondary-btn' : 'btn-sm'} onClick={() => setView('names')} style={{ fontSize: 12.5, padding: '4px 12px' }}>
              Proposed Names{scan.totals?.unlabeled ? ` (${scan.totals.unlabeled})` : ''}
            </button>
          </div>

          {view === 'names' && <NamesTable proposals={scan.proposals} />}

          {view === 'queue' && (<>
          {/* Counts + filter */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {FILTERS.map(f => (
              <button key={f.key} onClick={() => { setFilter(f.key); setShown(ROW_PAGE); }}
                className={filter === f.key ? 'secondary-btn' : 'btn-sm'}
                style={{ fontSize: 12.5, padding: '4px 12px' }}>
                {f.label}{f.key !== 'all' ? ` (${scan.counts[f.key] || 0})` : ` (${scan.proposals.length})`}
              </button>
            ))}
            {hiddenLabeled > 0 && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--text-secondary)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                <input type="checkbox" checked={hideLabeled} onChange={e => setHideLabeled(e.target.checked)} />
                Hide Correctly Labeled ({hiddenLabeled})
              </label>
            )}
            <input value={query} onChange={e => { setQuery(e.target.value); setShown(ROW_PAGE); }}
              placeholder="Find a file or folder" aria-label="Find a file or folder in the results"
              style={{ fontSize: 12.5, padding: '5px 10px', border: '1px solid var(--border-color)', borderRadius: 8, minWidth: 200 }} />
            <div style={{ flex: 1 }} />
            {!scanning && (
              <button className="btn-sm" onClick={exportCsv} title="Download this scan as a spreadsheet">
                Export CSV
              </button>
            )}
            {fixable.length > 0 && !scanning && (
              <button className="secondary-btn" onClick={fixAllNames} disabled={applying}>
                Fix All Names ({fixable.length})
              </button>
            )}
            {readyLeft > 0 && !scanning && (
              <button className="primary-btn" onClick={applySelected} disabled={applying}>
                {applying ? 'Moving...' : `Move ${readyLeft} File${readyLeft === 1 ? '' : 's'}`}
              </button>
            )}
          </div>

          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            Ready rows move together with the Move button. A Needs Review row is filed by hand: press File It, adjust the name, pick the folder.
          </div>

          {scan.missingRoots?.length > 0 && (
            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
              Not scanned (no access or missing): {scan.missingRoots.join(', ')}
            </div>
          )}
          {scan.truncated && !scanning && (
            <div style={{ fontSize: 12.5, color: 'hsl(35, 90%, 34%)' }}>
              The scan stopped before reaching every folder (stopped by hand, or past {WALK_FOLDER_CAP.toLocaleString('en-US')} folders / {WALK_FILE_CAP.toLocaleString('en-US')} files). Tick a smaller folder to see the rest.
            </div>
          )}

          {/* Proposals table - header stays put while a 500-row scan scrolls */}
          <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: '65vh', border: '1px solid var(--border-color)', borderRadius: 12 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: 'left' }}>
                  {['', 'File', 'Doc Type', 'Files To', 'Status'].map((h, i) => (
                    <th key={h || 'tick'} style={{ padding: '8px 10px', width: i === 0 ? 30 : undefined, position: 'sticky', top: 0, zIndex: 1, background: 'var(--bg-secondary)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={5} style={{ padding: 18, textAlign: 'center', color: 'var(--text-secondary)' }}>
                    Nothing here - the staging folders are clean.
                  </td></tr>
                )}
                {rows.slice(0, shown).map((p) => {
                  const r = results[p.sourcePath];
                  const effective = r ? (r.ok ? (r.renamed ? 'renamed' : 'done') : 'failed') : p.status;
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
                        {p.previewUrl ? (
                          <a href={p.previewUrl} target="_blank" rel="noreferrer" title="Open the file in Egnyte's viewer"
                            style={{ fontWeight: 600, wordBreak: 'break-word', color: 'inherit' }}>
                            {p.currentName}
                          </a>
                        ) : (
                          <div style={{ fontWeight: 600, wordBreak: 'break-word' }}>{p.currentName}</div>
                        )}
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
                        ) : (p.newName || p.canonicalName) ? (
                          <>
                            <div style={{ wordBreak: 'break-word' }}>Suggested: {p.newName || p.canonicalName}</div>
                            <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                              {spacingOnly(p.currentName, p.newName || p.canonicalName)
                                ? 'differs only in spacing - Fix Name puts it right'
                                : 'no folder yet - use File It'}
                            </div>
                            {p.learnedDest && !r?.ok && (
                              <div style={{ fontSize: 11.5, color: 'hsl(var(--color-green))', wordBreak: 'break-all' }}>
                                Learned: usually filed to {p.learnedDest} ({p.learnedCount}x)
                              </div>
                            )}
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
                        {p.status === 'review' && !r?.ok && (
                          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                            <button className="btn-sm" onClick={() => setFileIt(p)} style={{ fontSize: 12 }}>
                              File It
                            </button>
                            {(p.newName || p.canonicalName) && (p.newName || p.canonicalName) !== p.currentName && (
                              <button className="btn-sm" onClick={() => fixName(p)} style={{ fontSize: 12 }}
                                title="Rename in place to the suggested name - the file stays where it is">
                                Fix Name
                              </button>
                            )}
                            {p.learnedDest && (
                              <button className="btn-sm" onClick={() => fileToLearned(p)} style={{ fontSize: 12 }}
                                title={`Move to ${p.learnedDest} - where ${p.learnedCount} similar file${p.learnedCount === 1 ? ' was' : 's were'} filed before`}>
                                File to Learned
                              </button>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {rows.length > shown && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5, color: 'var(--text-secondary)' }}>
              Showing {shown.toLocaleString('en-US')} of {rows.length.toLocaleString('en-US')}
              <button className="secondary-btn" onClick={() => setShown(s => s + ROW_PAGE)} style={{ fontSize: 12.5 }}>
                Show {Math.min(ROW_PAGE, rows.length - shown)} More
              </button>
            </div>
          )}
          </>)}
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

      </div>
      </div>

      {fileIt && (
        <FileItSheet proposal={fileIt} onClose={() => setFileIt(null)}
          onFiled={(r) => {
            setResults(prev => ({ ...prev, [r.sourcePath]: r }));
            setFileIt(null);
            api.filingActivity().then(d => setActivity(d.rows)).catch(() => {});
          }}
          toastOk={toastOk} toastErr={toastErr} />
      )}

      {rulesOpen && (
        <RulesSheet status={status} onClose={() => setRulesOpen(false)}
          onSaved={(data) => setStatus(s => ({ ...s, templates: data.templates, scanRoots: data.scanRoots }))}
          toastOk={toastOk} toastErr={toastErr} />
      )}
    </div>
  );
}

// Every scanned file beside the name the rulebook would give it - the reading
// view for "what should these be called". Unlabeled files sort first; a file
// whose name is already canonical says so instead of repeating itself.
function NamesTable({ proposals }) {
  const sorted = useMemo(() => {
    const files = proposals.filter(p => p.status !== 'skip');
    return [...files].sort((a, b) => (a.labeled === b.labeled ? 0 : a.labeled ? 1 : -1));
  }, [proposals]);
  return (
    <div style={{ overflowX: 'auto', border: '1px solid var(--border-color)', borderRadius: 12 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ textAlign: 'left', background: 'var(--bg-secondary)' }}>
            <th style={{ padding: '8px 10px' }}>Current Name</th>
            <th style={{ padding: '8px 10px' }}>Should Be</th>
            <th style={{ padding: '8px 10px' }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 && (
            <tr><td colSpan={3} style={{ padding: 18, textAlign: 'center', color: 'var(--text-secondary)' }}>
              Nothing here - the staging folders are clean.
            </td></tr>
          )}
          {sorted.map((p) => {
            const shouldBe = p.newName || p.canonicalName;
            return (
              <tr key={p.sourcePath} style={{ borderTop: '1px solid var(--border-color)', verticalAlign: 'top' }}>
                <td style={{ padding: '8px 10px', maxWidth: 380 }}>
                  <div style={{ wordBreak: 'break-word' }}>{p.currentName}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', wordBreak: 'break-all' }}>
                    {p.sourcePath.slice(0, p.sourcePath.lastIndexOf('/'))}
                  </div>
                </td>
                <td style={{ padding: '8px 10px', maxWidth: 380, wordBreak: 'break-word' }}>
                  {p.labeled
                    ? <span style={{ color: 'var(--text-secondary)' }}>Already right</span>
                    : (shouldBe || <span style={{ color: 'var(--text-secondary)' }}>No date in the name - a person names it</span>)}
                </td>
                <td style={{ padding: '8px 10px' }}>
                  <StatusChip status={p.labeled ? 'labeled' : 'unlabeled'} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Manual filing for a row the rules could not finish (Visesh, 11/04): the
// suggested name prefilled and editable, the destination picked from the
// same tree, one Move File. It goes through the same /filing/apply as the
// automatic moves - audit row, no overwrite, the caller's own Egnyte
// permissions - so by-hand never means around-the-guardrails.
function FileItSheet({ proposal, onClose, onFiled, toastOk, toastErr }) {
  const suggested = proposal.newName || proposal.canonicalName || proposal.currentName;
  const [name, setName] = useState(suggested);
  // The learned route (where the team filed similar files before) is the
  // best opening guess for the destination.
  const [dest, setDest] = useState(proposal.destFolder || proposal.learnedDest || '');
  const [busy, setBusy] = useState(false);
  const move = async () => {
    setBusy(true);
    try {
      const out = await api.filingApply([{
        sourcePath: proposal.sourcePath, destFolder: dest, newName: name.trim(),
        docType: proposal.docType || 'Manual', rule: proposal.rule || 'manual',
      }]);
      const r = out.results?.[0];
      if (r?.ok) { toastOk?.(`Filed ${name.trim()}`); onFiled(r); }
      else toastErr?.(r?.error || 'Could not move the file');
    } catch (e) {
      toastErr?.(e.message || 'Could not move the file');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="File This Document" onClose={onClose} width="max(60vw, 640px)">
      <div className="nx-fill" style={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0 }}>
        <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', wordBreak: 'break-all' }}>
          {proposal.sourcePath}
          {proposal.previewUrl && (
            <a href={proposal.previewUrl} target="_blank" rel="noreferrer" style={{ marginLeft: 8, whiteSpace: 'nowrap' }}>
              Open the File
            </a>
          )}
        </div>
        <label style={{ fontSize: 12.5, fontWeight: 600 }}>
          New Name
          <input value={name} onChange={e => setName(e.target.value)}
            style={{ display: 'block', width: '100%', marginTop: 4, fontSize: 13, padding: '8px 10px', border: '1px solid var(--border-color)', borderRadius: 8, boxSizing: 'border-box' }} />
        </label>
        <div style={{ fontSize: 12.5, fontWeight: 600 }}>
          Files To
          {dest
            ? <span style={{ fontWeight: 500, color: 'var(--text-secondary)', wordBreak: 'break-all' }}> - {dest}</span>
            : <span style={{ fontWeight: 500, color: 'hsl(35, 90%, 34%)' }}> - pick the folder below</span>}
        </div>
        <div style={{ flex: 1, minHeight: 240, overflowY: 'auto', border: '1px solid var(--border-color)', borderRadius: 10, padding: 6 }}>
          <EgnyteTree rootLabel="All Files"
            selected={dest ? new Set([dest]) : new Set()}
            onToggleSelect={(p) => setDest(prev => (prev === p ? '' : p))}
            onSelect={(p) => setDest(p || '')} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="secondary-btn" onClick={onClose}>Cancel</button>
          <button className="primary-btn" disabled={busy || !dest || !name.trim() || name.includes('/')} onClick={move}>
            {busy ? 'Moving...' : 'Move File'}
          </button>
        </div>
      </div>
    </Modal>
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
