import { useEffect, useMemo, useState } from 'react';
import { Check, Pencil, Search, Trash2, Users, X } from 'lucide-react';
import { formatDate } from '../../lib/datetime';
import { control } from './reportControls';
import { columnModes, entityText, presetLabel, reportDef, resolveConfig } from './reportModel';

// Accounting -> Reports -> Manage Saved Reports (Charmi, call of 09/29: "the
// dropdown is too small for fifty reports - it needs its own screen to
// rename them and change their filters").
//
// Every memorized report the person can see, one row each: the name (click
// the pencil to rename), what it is (statement, period, columns, book,
// entities, how many filters), who it belongs to and whether it is shared,
// when it last changed. Open puts it on the Reports screen, where its filters
// are changed and saved back ("Save Changes" appears the moment a memorized
// report differs from what is on screen). Only the person who saved a report
// renames, shares or deletes it.

const summarize = (config) => {
  const c = resolveConfig(config);
  const def = reportDef(c.report);
  const cols = columnModes(c.report).find((m) => m.key === c.cols)?.label;
  const filters = Object.values(c.dims || {}).reduce((n, v) => n + (v?.length || 0), 0) + (c.accounts?.length || 0);
  return {
    report: def.label,
    period: def.period === 'asof' ? (c.asofToday === false ? `As of ${formatDate(c.asof)}` : 'As of today') : c.preset === 'custom' ? `${formatDate(c.from)} - ${formatDate(c.to)}` : presetLabel(c.preset),
    columns: cols && cols !== 'Total Only' ? cols : '',
    book: c.book === 'accrual' ? '' : c.book === 'cash' ? 'Cash' : 'Accrual and Cash',
    entities: entityText(c, []),
    filters: filters ? `${filters} ${filters === 1 ? 'filter' : 'filters'}` : '',
  };
};

export default function SavedReportsManager({ reports, activeId, nameOf, onOpen, onRename, onShare, onDelete, onClose }) {
  const [q, setQ] = useState('');
  const [renaming, setRenaming] = useState(null);   // { id, name }
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !renaming) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, renaming]);
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    const list = reports.map((r) => ({ ...r, about: summarize(r.config) }));
    list.sort((a, b) => (b.mine - a.mine) || a.name.localeCompare(b.name, 'en-US'));
    return s ? list.filter((r) => r.name.toLowerCase().includes(s) || Object.values(r.about).some((v) => String(v).toLowerCase().includes(s))) : list;
  }, [reports, q]);
  const run = (id, fn) => {
    setBusy(id);
    setError('');
    return Promise.resolve(fn()).catch((e) => setError(e?.message || 'Could not save.')).finally(() => setBusy(''));
  };
  const saveName = () => {
    if (!renaming) return;
    const name = renaming.name.trim();
    const was = reports.find((r) => r.id === renaming.id);
    if (!name || !was || name === was.name) { setRenaming(null); return; }
    run(renaming.id, () => onRename(was, name)).then(() => setRenaming(null));
  };
  const mine = reports.filter((r) => r.mine).length;
  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div className="modal-content" role="dialog" aria-modal="true" aria-label="Saved Reports" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '96vw', width: 'min(1180px, 96vw)', maxHeight: '92vh' }}>
        <div className="modal-header" style={{ padding: '12px 18px 10px' }}>
          <div style={{ minWidth: 0 }}>
            <h3 style={{ margin: 0 }}>Saved Reports</h3>
            <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', marginTop: 2 }}>
              {reports.length} {reports.length === 1 ? 'report' : 'reports'} - {mine} yours, {reports.length - mine} shared with you. Open one to change its filters; Save Changes then keeps them.
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ position: 'relative', width: 260 }}>
              <Search size={13} style={{ position: 'absolute', left: 9, top: 9, color: 'var(--text-muted)' }} />
              <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search saved reports" aria-label="Search saved reports" autoFocus style={{ ...control, width: '100%', paddingLeft: 28 }} />
            </div>
            <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
          </div>
        </div>
        <div style={{ padding: '6px 18px 14px', overflow: 'auto' }}>
          {error && <div style={{ border: '1px solid var(--bad-fg, #dc2626)', color: 'var(--bad-fg, #dc2626)', borderRadius: 8, padding: '8px 12px', fontSize: '0.84rem', marginBottom: 8 }}>{error}</div>}
          <div className="acct-lines-wrap" style={{ maxHeight: 'calc(92vh - 150px)' }}>
            <table className="acct-lines" style={{ width: '100%', tableLayout: 'auto' }}>
              <thead>
                <tr>
                  <th scope="col">Name</th><th scope="col">Statement</th><th scope="col">Period</th><th scope="col">Columns and Book</th>
                  <th scope="col">Entities</th><th scope="col">Filters</th><th scope="col">Sharing</th><th scope="col">Updated</th><th scope="col" aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} style={r.id === activeId ? { fontWeight: 600 } : undefined}>
                    <td style={{ whiteSpace: 'normal', minWidth: 220 }}>
                      {renaming?.id === r.id ? (
                        <form onSubmit={(e) => { e.preventDefault(); saveName(); }} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                          <input type="text" value={renaming.name} maxLength={120} autoFocus aria-label="New name" onChange={(e) => setRenaming({ ...renaming, name: e.target.value })}
                            onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setRenaming(null); } }} style={{ ...control, height: 26, flex: 1, fontSize: '0.78rem' }} />
                          <button type="submit" aria-label="Save name" style={ICON}><Check size={14} /></button>
                          <button type="button" aria-label="Cancel rename" onClick={() => setRenaming(null)} style={ICON}><X size={14} /></button>
                        </form>
                      ) : (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <button type="button" className="acct-drill" onClick={() => { onOpen(r); onClose(); }} title="Open this report">{r.name}</button>
                          {r.mine && <button type="button" aria-label={`Rename ${r.name}`} title="Rename" onClick={() => setRenaming({ id: r.id, name: r.name })} style={ICON}><Pencil size={12} /></button>}
                        </span>
                      )}
                    </td>
                    <td>{r.about.report}</td>
                    <td>{r.about.period}</td>
                    <td>{[r.about.columns, r.about.book].filter(Boolean).join(' · ') || <span style={{ color: 'var(--text-muted)' }}>Total only</span>}</td>
                    <td>{r.about.entities}</td>
                    <td>{r.about.filters || <span style={{ color: 'var(--text-muted)' }}>None</span>}</td>
                    <td>
                      {r.mine ? (
                        <button type="button" onClick={() => run(r.id, () => onShare(r, !r.shared))} disabled={busy === r.id} aria-pressed={r.shared}
                          title={r.shared ? 'Shared with the accounting team - click to make it yours only' : 'Only you - click to share with the team'}
                          style={{ ...control, height: 26, display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: '0.74rem', color: r.shared ? 'var(--wk-brand, #2b45e1)' : 'var(--text-secondary)', borderColor: r.shared ? 'var(--wk-brand, #2b45e1)' : 'var(--border-color)' }}>
                          <Users size={12} /> {r.shared ? 'Shared with the team' : 'Only you'}
                        </button>
                      ) : <span style={{ color: 'var(--text-secondary)' }}>Shared by {nameOf ? nameOf(r.owner) : 'a teammate'}</span>}
                    </td>
                    <td style={{ color: 'var(--text-secondary)' }}>{r.updatedAt ? formatDate(r.updatedAt) : ''}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button type="button" className="secondary-btn" style={{ fontSize: '0.74rem', padding: '3px 10px' }} onClick={() => { onOpen(r); onClose(); }}>Open</button>
                      {r.mine && (confirm === r.id ? (
                        <span style={{ marginLeft: 8, display: 'inline-flex', gap: 8 }}>
                          <button type="button" className="acct-drill" style={{ color: 'var(--bad-fg, #dc2626)' }} onClick={() => { setConfirm(''); run(r.id, () => onDelete(r)); }}>Delete</button>
                          <button type="button" className="acct-drill" onClick={() => setConfirm('')}>Keep</button>
                        </span>
                      ) : (
                        <button type="button" aria-label={`Delete ${r.name}`} title="Delete" onClick={() => setConfirm(r.id)} style={{ ...ICON, marginLeft: 4 }}><Trash2 size={14} /></button>
                      ))}
                    </td>
                  </tr>
                ))}
                {!rows.length && (
                  <tr><td colSpan={9} style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '22px 10px', whiteSpace: 'normal' }}>
                    {reports.length ? 'No saved report matches that search.' : 'Nothing saved yet. Set up a report, then press Memorize.'}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

const ICON = { border: 'none', background: 'none', padding: 4, cursor: 'pointer', display: 'inline-flex', color: 'var(--text-muted)' };
