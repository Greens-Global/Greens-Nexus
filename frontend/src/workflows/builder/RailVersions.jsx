// Versions rail (Oct 2026): every Publish is a version. Pick two to read
// the English diff between them; Restore publishes an old definition as a
// new version (after a confirm).
import { useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { api } from '../../api';
import AsyncSection, { SkeletonBlocks } from '../../components/AsyncState';
import { dialog } from '../../ui/dialog';
import { formatDateTime } from '../../lib/datetime';
import { btn } from '../../tasks/theme';
import { chip, hint, sentence } from '../lib/text.builder-helpers';

export default function RailVersions({ workflow, onRestored }) {
  const id = workflow?.id;
  const [tick, setTick] = useState(0);
  // Keyed by what was asked for, so a reload shows the skeleton and a
  // comparison never shows the previous pair's lines.
  const listKey = `${id}:${tick}`;
  const [loaded, setLoaded] = useState({ key: '', rows: null, error: null });
  const versions = loaded.key === listKey ? loaded.rows : null;
  const error = loaded.key === listKey ? loaded.error : null;
  const [picked, setPicked] = useState([]);
  const pairKey = picked.length === 2 ? `${id}:${Math.min(...picked)}-${Math.max(...picked)}` : '';
  const [compared, setCompared] = useState({ key: '', lines: null, error: '' });
  const diff = compared.key === pairKey ? compared.lines : null;
  const diffError = compared.key === pairKey ? compared.error : '';
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!id) return undefined;
    let alive = true;
    api.wfVersions(id).then((rows) => { if (alive) setLoaded({ key: listKey, rows: Array.isArray(rows) ? rows : rows?.items || [], error: null }); })
      .catch((e) => { if (alive) setLoaded({ key: listKey, rows: null, error: e }); });
    return () => { alive = false; };
  }, [id, listKey]);

  useEffect(() => {
    if (!pairKey) return undefined;
    let alive = true;
    const [a, b] = picked.slice().sort((x, y) => x - y);
    api.wfDiff(id, a, b).then((d) => { if (alive) setCompared({ key: pairKey, lines: d?.lines || [], error: '' }); })
      .catch(() => { if (alive) setCompared({ key: pairKey, lines: null, error: 'The comparison could not be loaded.' }); });
    return () => { alive = false; };
  }, [id, picked, pairKey]);

  const toggle = (v) => setPicked((p) => (p.includes(v) ? p.filter((x) => x !== v) : [...p.slice(-1), v]));

  const restore = async (v) => {
    const ok = await dialog.confirm(`Restore version ${v}? It is published as a new version and starts running right away.`, { title: 'Restore Version', confirmText: 'Restore' });
    if (!ok) return;
    setBusy(true);
    try {
      await api.wfRestore(id, v);
      setTick((t) => t + 1);
      onRestored?.();
    } catch (e) {
      await dialog.alert(e?.message || 'The version could not be restored.');
    } finally { setBusy(false); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={hint}>Pick two versions to compare them.</div>
      <AsyncSection loading={versions === null && !error} error={error} isEmpty={!versions?.length}
        errorMessage="Versions could not be loaded." skeleton={<SkeletonBlocks count={3} height={44} borderRadius={8} />}
        emptyContent={<div style={hint}>Nothing published yet. Publish creates version 1.</div>}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {(versions || []).map((v) => {
            const n = v.version;
            const current = n === workflow?.version;
            return (
              <div key={n} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 8px', border: '1px solid var(--nx-border2)', borderRadius: 8 }}>
                <input type="checkbox" checked={picked.includes(n)} onChange={() => toggle(n)} aria-label={`Compare version ${n}`} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, display: 'flex', gap: 6, alignItems: 'center' }}>
                    Version {n}
                    {current && <span style={{ ...chip, fontSize: 10.5, padding: '1px 6px' }}>Current</span>}
                  </div>
                  <div style={hint}>{v.publishedByName || v.publishedBy || ''}{v.publishedAt ? ` - ${formatDateTime(v.publishedAt)}` : ''}{v.note ? ` - ${v.note}` : ''}</div>
                </div>
                {!current && (
                  <button type="button" onClick={() => restore(n)} disabled={busy} style={{ ...btn('ghost'), padding: '4px 8px', fontSize: 12 }} aria-label={`Restore version ${n}`}>
                    <RotateCcw size={13} /> Restore
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </AsyncSection>
      {picked.length === 2 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 13, fontWeight: 700 }}>Version {Math.min(...picked)} to {Math.max(...picked)}</div>
          {diffError && <div style={{ ...hint, color: '#dc2626' }}>{diffError}</div>}
          {diff === null && !diffError && <SkeletonBlocks count={2} height={20} borderRadius={6} />}
          {diff && !diff.length && <div style={hint}>No difference.</div>}
          {(diff || []).map((line, i) => <div key={i} style={{ ...sentence, fontSize: 13 }}>{line}</div>)}
        </div>
      )}
    </div>
  );
}
