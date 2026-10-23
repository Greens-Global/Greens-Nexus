// Task Module - Manage > Labels (Neil, Oct 22 2026).
//
// Every label in use in the company, with how many tasks carry it - all of
// them, restricted tasks included (an admin view, managers only; the server
// checks again). Recolor is instant. Rename, Merge (a rename onto a label
// that already exists) and Delete rewrite the label on every task in the
// company, so each asks first and says how many tasks it will change.
//
// Behind the company walls the labels are the company's own; a Global Admin
// (or someone in several companies) picks which company's labels to manage.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pencil, Trash2, Merge, Palette, Search, Tag } from 'lucide-react';
import { api } from '../api';
import { NX, FONT, btn, card, input as inputStyle } from './theme';
import { EmptyState, Modal } from './components';
import { ErrorBanner, LoadingState } from '../components/AsyncState';
import AnchoredMenu from '../components/AnchoredMenu';
import { LABEL_TONES, LabelPill, TONE_KEYS, cleanLabel, invalidateLabelColors, labelKey, labelToneKey } from './labels';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The rows Manage lists: every label in use, plus any the map colors that
 *  no task carries now (so a stale color can still be reset or removed). */
function manageRows(data) {
  const map = data?.labels || {};
  const rows = new Map((data?.inUse || []).map((r) => [r.key, { ...r, name: map[r.key]?.name || r.name }]));
  for (const [key, e] of Object.entries(map)) {
    if (!rows.has(key)) rows.set(key, { key, name: e?.name || key, count: 0 });
  }
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
}

export default function LabelsManageTab() {
  const [company, setCompany] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [q, setQ] = useState('');
  const [renaming, setRenaming] = useState(null);   // { row, merge: bool }
  const [deleting, setDeleting] = useState(null);   // row
  const [coloring, setColoring] = useState(null);   // row key whose palette is open

  const load = useCallback(() => api.getTaskLabels({ company, all: true })
    .then((d) => { setError(''); setData(d); })
    .catch((e) => setError(e?.message || 'Could not load the labels.')), [company]);
  useEffect(() => { load(); }, [load]);

  const rows = useMemo(() => manageRows(data), [data]);
  const shown = useMemo(() => {
    const k = labelKey(q);
    return k ? rows.filter((r) => r.key.includes(k)) : rows;
  }, [rows, q]);
  const map = data?.labels || {};
  const cid = company || data?.companyId || '';

  // Every change answers with the fresh list; the shared colors everyone
  // else on this page reads are refreshed too.
  const run = async (call, done) => {
    setBusy(true); setNote('');
    try {
      const r = await call();
      setData(r);
      invalidateLabelColors();
      if (done) setNote(done(r));
      return r;
    } catch (e) {
      setNote(e?.message || 'That did not work. Try again.');
      throw e;
    } finally { setBusy(false); }
  };

  const recolor = (row, color) => {
    setColoring(null);
    run(() => api.setTaskLabelColor(row.name, color, cid)).catch(() => {});
  };

  if (!data && !error) return <LoadingState label="Loading labels" />;

  return (
    <div style={{ fontFamily: FONT }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: NX.ink }}>Labels</div>
          <div style={{ fontSize: 13, color: NX.dim, marginTop: 2 }}>
            Every label in use, with how many tasks carry it. Pick a color for a label, rename it, merge it into another, or remove it from every task.
          </div>
        </div>
        {(data?.companies || []).length > 1 && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: NX.dim }}>
            Company
            <select value={cid} onChange={(e) => { setData(null); setNote(''); setCompany(e.target.value); }}
              style={{ ...inputStyle, width: 'auto', padding: '6px 9px', cursor: 'pointer' }}>
              {data.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        )}
      </div>

      {error && <ErrorBanner message={error} onRetry={load} />}
      {note && <div role="status" style={{ marginBottom: 12, fontSize: 12.5, color: NX.dim }}>{note}</div>}

      {rows.length > 8 && (
        <div style={{ position: 'relative', maxWidth: 320, marginBottom: 12 }}>
          <Search size={14} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: NX.faint }} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search labels…" aria-label="Search labels"
            style={{ ...inputStyle, paddingLeft: 28 }} />
        </div>
      )}

      {data && rows.length === 0 ? (
        <EmptyState icon={Tag} title="No Labels Yet" hint="Labels added to tasks show up here, ready to color, rename or merge." />
      ) : shown.map((row) => (
        <LabelRow key={row.key} row={row} busy={busy} canMerge={rows.length > 1} color={map[row.key]?.color || ''}
          coloring={coloring === row.key} setColoring={(on) => setColoring(on ? row.key : null)}
          onRecolor={(c) => recolor(row, c)} onRename={() => setRenaming({ row, merge: false })}
          onMerge={() => setRenaming({ row, merge: true })} onDelete={() => setDeleting(row)} />
      ))}
      {data && rows.length > 0 && shown.length === 0 && (
        <div style={{ fontSize: 13, color: NX.faint, padding: 8 }}>No labels match.</div>
      )}

      {renaming && (
        <RenameModal row={renaming.row} merge={renaming.merge} rows={rows} busy={busy}
          onClose={() => setRenaming(null)}
          onSave={(to) => run(() => api.renameTaskLabel(renaming.row.name, to, cid),
            (r) => (r.merged
              ? `Merged "${renaming.row.name}" into "${r.name}" on ${plural(r.changed, 'task')}.`
              : `Renamed to "${r.name}" on ${plural(r.changed, 'task')}.`))
            .then(() => setRenaming(null)).catch(() => {})} />
      )}
      {deleting && (
        <Modal title="Delete Label" onClose={() => setDeleting(null)} footer={(
          <>
            <button type="button" style={btn('ghost')} onClick={() => setDeleting(null)}>Cancel</button>
            <button type="button" disabled={busy} style={{ ...btn('primary'), background: NX.red, borderColor: NX.red }}
              onClick={() => run(() => api.deleteTaskLabel(deleting.name, cid), (r) => `Removed "${deleting.name}" from ${plural(r.changed, 'task')}.`)
                .then(() => setDeleting(null)).catch(() => {})}>
              {busy ? 'Deleting…' : 'Delete Label'}
            </button>
          </>
        )}>
          <div className="nx-fill" style={{ gap: 14, fontSize: 13.5, color: NX.ink, lineHeight: 1.5 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><LabelPill name={deleting.name} /></div>
            <p style={{ margin: 0 }}>
              This removes the label from {plural(deleting.count, 'task')} in this company, including tasks you may not see in your lists and tasks in the Recycle Bin, and forgets its color.
            </p>
            <p style={{ margin: 0, color: NX.dim }}>Each task's history records the change. This cannot be undone from here.</p>
          </div>
        </Modal>
      )}
    </div>
  );
}

function LabelRow({ row, busy, canMerge, color, coloring, setColoring, onRecolor, onRename, onMerge, onDelete }) {
  const paletteRef = useRef(null);
  const icon = { ...btn('ghost'), padding: 7, color: NX.dim };
  return (
    <div data-label-row={row.key}
      style={{ ...card, display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', marginBottom: 8, flexWrap: 'wrap' }}>
      <LabelPill name={row.name} />
      <span style={{ fontSize: 12.5, color: NX.faint }}>{plural(row.count, 'task')}</span>
      <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 2 }}>
        <button ref={paletteRef} type="button" disabled={busy} onClick={() => setColoring(!coloring)}
          title="Change Color" aria-label={`Change color of ${row.name}`} aria-expanded={coloring} style={icon}><Palette size={16} /></button>
        <button type="button" disabled={busy} onClick={onRename} title="Rename" aria-label={`Rename ${row.name}`} style={icon}><Pencil size={16} /></button>
        {canMerge && (
          <button type="button" disabled={busy} onClick={onMerge} title="Merge Into Another Label" aria-label={`Merge ${row.name}`} style={icon}><Merge size={16} /></button>
        )}
        <button type="button" disabled={busy} onClick={onDelete} title="Delete" aria-label={`Delete ${row.name}`}
          style={{ ...icon, color: NX.red }}><Trash2 size={16} /></button>
      </span>
      <AnchoredMenu anchorRef={paletteRef} open={coloring} onClose={() => setColoring(false)}
        align="end" role="dialog" aria-label={`Color for ${row.name}`}
        style={{ background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 12, boxShadow: '0 12px 32px rgba(0,0,0,0.16)', padding: 10, width: 236 }}>
        <TonePicker current={color} defaultTone={labelToneKey(row.name, null)} onPick={onRecolor} />
      </AnchoredMenu>
    </div>
  );
}

function TonePicker({ current, defaultTone, onPick }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontFamily: FONT }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
        {TONE_KEYS.map((k) => {
          const on = current === k;
          return (
            <button key={k} type="button" onClick={() => onPick(k)} aria-pressed={on} title={LABEL_TONES[k].label}
              style={{
                height: 28, borderRadius: 999, cursor: 'pointer', fontSize: 11, fontWeight: 600, fontFamily: FONT,
                background: `var(--nx-tag-${k}-bg)`, color: `var(--nx-tag-${k}-fg)`,
                border: `${on ? 2 : 1}px solid ${on ? `var(--nx-tag-${k}-fg)` : `var(--nx-tag-${k}-border)`}`,
              }}>
              {LABEL_TONES[k].label}
            </button>
          );
        })}
      </div>
      <button type="button" onClick={() => onPick('')} aria-pressed={!current}
        style={{ ...btn('ghost'), justifyContent: 'flex-start', fontSize: 12, color: NX.dim }}>
        Default Color ({LABEL_TONES[defaultTone].label}){!current ? ' - in use' : ''}
      </button>
    </div>
  );
}

function RenameModal({ row, merge, rows, busy, onClose, onSave }) {
  const [to, setTo] = useState(merge ? '' : row.name);
  const key = labelKey(to);
  const target = key && key !== row.key ? rows.find((r) => r.key === key) : null;
  const others = rows.filter((r) => r.key !== row.key);
  const unchanged = !key || cleanLabel(to) === row.name;
  const tooLong = cleanLabel(to).length > 60;
  const canSave = !unchanged && !tooLong && !busy && (!merge || !!target);
  const title = merge ? 'Merge Label' : 'Rename Label';
  return (
    <Modal title={title} onClose={onClose} isDirty={!unchanged && !merge} onSave={canSave ? () => onSave(cleanLabel(to)) : undefined}
      footer={(
        <>
          <button type="button" style={btn('ghost')} onClick={onClose}>Cancel</button>
          <button type="button" disabled={!canSave} style={{ ...btn('primary'), opacity: canSave ? 1 : 0.6 }} onClick={() => onSave(cleanLabel(to))}>
            {busy ? 'Saving…' : target ? 'Merge Labels' : 'Rename Label'}
          </button>
        </>
      )}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, fontSize: 13.5, color: NX.ink, height: '100%' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <LabelPill name={row.name} /> <span style={{ color: NX.faint }}>on {plural(row.count, 'task')}</span>
        </div>
        {merge ? (
          <div className="nx-fill" style={{ gap: 6 }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: NX.dim }}>Merge Into</span>
            <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="Search labels…" aria-label="Merge into" autoFocus style={inputStyle} />
            <div style={{ flex: 1, minHeight: 120, overflowY: 'auto', border: `1px solid ${NX.border2}`, borderRadius: 8, padding: 4 }}>
              {others.filter((r) => !key || r.key.includes(key)).map((r) => (
                <button key={r.key} type="button" className="nx-menu-row" onClick={() => setTo(r.name)}
                  style={{ ...btn('ghost'), width: '100%', justifyContent: 'flex-start', gap: 8, background: target?.key === r.key ? NX.hover : 'transparent' }}>
                  <LabelPill name={r.name} size="sm" /><span style={{ marginLeft: 'auto', fontSize: 11, color: NX.faint }}>{plural(r.count, 'task')}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: NX.dim }}>New Name</span>
            <input value={to} onChange={(e) => setTo(e.target.value)} autoFocus aria-label="New name" maxLength={80}
              onKeyDown={(e) => { if (e.key === 'Enter' && canSave) onSave(cleanLabel(to)); }} style={inputStyle} />
          </label>
        )}
        <div className="nx-fill" style={{ gap: 8, color: NX.dim, lineHeight: 1.5 }}>
          {tooLong && <span role="alert" style={{ color: NX.red }}>A label can be at most 60 characters.</span>}
          {target ? (
            <span>
              <strong style={{ color: NX.ink }}>{row.name}</strong> merges into <LabelPill name={target.name} size="sm" />: its {plural(row.count, 'task')} carry {target.name} instead, and it is gone from the list. {target.name} keeps its color.
            </span>
          ) : !unchanged && !merge ? (
            <span>Every task in this company with this label, including tasks in the Recycle Bin, is renamed. The label keeps its color.</span>
          ) : merge ? (
            <span>Pick the label to merge into.</span>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
