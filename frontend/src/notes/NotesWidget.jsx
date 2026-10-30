// The dashboard's Notes tile, tied to the Notes module (Oct 29 2026): a
// capture line that adds to today's scratchpad, then the pinned notes (or
// the latest ones when nothing is pinned), each opening on Dashboard > Notes.
//
// Before Notes the tile kept its own text in the view's config (`text`). That
// text moves into a note called "Dashboard Notes" the first time the tile
// shows on a view its owner can save; on a shared view (someone else's
// published layout) it stays on the tile, read-only, as before.
import { useCallback, useEffect, useRef, useState } from 'react';
import { StickyNote, ArrowRight, CornerDownLeft, Pin } from 'lucide-react';
import { api } from '../api';
import { DashCard } from '../dashboard/widgets.jsx';
import { LoadingState } from '../components/AsyncState';
import { colorCss, localDay, noteTitle, editedLabel } from './notesModel';
import './notes.css';

const openNotes = (id) => window.dispatchEvent(new CustomEvent('nexus:navigate', {
  detail: { view: 'dashboard', sub: id ? `notes:${id}` : 'notes' },
}));

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export default function NotesWidget({ config, saveConfig, canSaveConfig, phone }) {
  const [list, setList] = useState(null);
  const [error, setError] = useState('');
  const [line, setLine] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const legacy = (config?.text || '').trim();
  const migrating = useRef(false);

  const load = useCallback(async () => {
    try {
      const [pinned, recent] = await Promise.all([
        api.notesList({ view: 'pinned' }),
        api.notesList({ view: 'all', today: localDay() }),
      ]);
      const rows = (pinned?.notes || []).length ? pinned.notes : (recent?.notes || []);
      setList({ rows: rows.slice(0, 8), pinned: (pinned?.notes || []).length > 0, total: recent?.counts?.all || 0 });
      setError('');
    } catch (e) { setError(e.message || 'Could not load notes'); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // The tile's old text becomes a note, once.
  useEffect(() => {
    if (!legacy || !canSaveConfig || !saveConfig || migrating.current) return;
    migrating.current = true;
    const body = legacy.split(/\r?\n/).filter((l) => l.trim()).map((l) => `<p>${esc(l)}</p>`).join('');
    api.noteCreate({ title: 'Dashboard Notes', body, day: localDay() })
      .then(() => Promise.resolve(saveConfig({ text: '' })))
      .then(() => { setNotice('Your tile notes are now the note "Dashboard Notes".'); load(); })
      .catch(() => { migrating.current = false; });
  }, [legacy, canSaveConfig, saveConfig, load]);

  const capture = async (e) => {
    e.preventDefault();
    const text = line.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      await api.noteDailyAppend(localDay(), text);
      setLine('');
      setNotice("Added to today's scratchpad");
      load();
    } catch (err) { setNotice(err.message || 'Could not add it'); } finally { setBusy(false); }
  };
  useEffect(() => { if (!notice) return undefined; const t = setTimeout(() => setNotice(''), 3500); return () => clearTimeout(t); }, [notice]);

  return (
    <DashCard title="Notes" sub={notice || undefined}
      action={<button type="button" className="nt-tag" onClick={() => openNotes('')} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--wk-green)', fontWeight: 600 }}>
        Open Notes <ArrowRight size={12} aria-hidden="true" />
      </button>}>
      <div className="nt-w">
        <form className="nt-w-capture" onSubmit={capture}>
          <StickyNote size={15} aria-hidden="true" style={{ color: 'var(--wk-orange)', flexShrink: 0 }} />
          <input value={line} onChange={(e) => setLine(e.target.value)} disabled={busy} aria-label="Add to today's scratchpad"
            placeholder="Jot something down - [ ] makes a to-do" style={{ fontSize: phone ? 16 : 13.5 }} maxLength={2000} />
          {line.trim() && <button type="submit" className="nt-icon-btn" aria-label="Add" title="Add (Enter)"><CornerDownLeft size={14} /></button>}
        </form>
        {legacy && !canSaveConfig && (
          <div style={{ fontSize: 12.5, color: 'var(--muted)', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{legacy}</div>
        )}
        <div className="nt-w-list">
          {error && <div className="nt-empty" style={{ padding: 10 }}>{error} <button type="button" className="nt-tag" onClick={load}>Retry</button></div>}
          {!list && !error && <LoadingState compact minHeight={60} />}
          {list && list.rows.length === 0 && <div className="nt-empty" style={{ padding: '10px 4px', textAlign: 'left' }}>No notes yet. Type above, or open Notes to start one.</div>}
          {list && list.rows.length > 0 && <div className="nt-w-label">{list.pinned ? 'Pinned' : 'Latest'}</div>}
          {list?.rows.map((n) => (
            <button key={n.id} type="button" className="nt-w-row" onClick={() => openNotes(n.id)}>
              {n.color && <span className="nt-row-rule" style={{ background: colorCss(n.color) }} aria-hidden="true" />}
              <span className="nt-row-top">
                <span className="nt-row-title">{noteTitle(n)}</span>
                {n.pinned && <Pin size={12} aria-hidden="true" style={{ color: 'var(--wk-faint)' }} />}
              </span>
              {n.preview ? <span className="nt-row-preview" style={{ WebkitLineClamp: 1 }}>{n.preview}</span>
                : <span className="nt-row-meta">{editedLabel(n.updatedAt)}</span>}
            </button>
          ))}
        </div>
      </div>
    </DashCard>
  );
}
