// Insert Board (11/02/2026): the editor's picker of the person's boards. The
// list is the notes list filtered to kind 'board' (the API has no kind
// filter; a few hundred notes at most, so the filter is here). Picking one
// inserts a boardEmbed node (BoardEmbed.jsx) at the cursor. The person's own
// boards come first; one shared with them says so ("Shared with you") - its
// picture shows only to people the board is shared with. On a phone the
// picker is a bottom sheet over the note, not a popover.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useScrollLock } from '../../lib/useScrollLock';
import { PenTool, Search, X } from 'lucide-react';
import { api } from '../../api';
import { noteTitle } from '../notesModel';
import { formatDate } from '../../lib/datetime';

// Mounted only while open (NoteEditor renders it conditionally), so its
// state starts fresh each time without a reset in an effect.
export default function BoardPicker({ open = true, onClose, onPick, excludeId = '', phone = false }) {
  const [boards, setBoards] = useState(null);     // null = loading
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const box = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    api.notesList({ view: 'all' })
      .then((r) => {
        if (!alive) return;
        const list = (r?.notes || []).filter((n) => n.kind === 'board' && n.id !== excludeId && !n.trashedAt);
        setBoards([...list.filter((n) => n.mine !== false), ...list.filter((n) => n.mine === false)]);
      })
      .catch((e) => { if (alive) { setBoards([]); setError(e?.message || 'Could not load your boards'); } });
    return () => { alive = false; };
  }, [open, excludeId]);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    const onDown = (e) => { if (box.current && !box.current.contains(e.target)) onClose(); };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown, true);
    return () => { document.removeEventListener('keydown', onKey, true); document.removeEventListener('pointerdown', onDown, true); };
  }, [open, onClose]);
  useScrollLock(!!(open && phone));
  if (!open) return null;
  const needle = q.trim().toLowerCase();
  const shown = (boards || []).filter((b) => !needle || noteTitle(b).toLowerCase().includes(needle)).slice(0, 40);
  const panel = (
    <div ref={box} className={`nt-board-pick${phone ? ' is-sheet' : ''}`} role="dialog" aria-label="Insert Board" aria-modal={phone ? 'true' : undefined}>
      {phone && <div className="nt-board-pick-grab" aria-hidden="true" />}
      <div className="nt-board-pick-head">
        <Search size={14} aria-hidden="true" />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a board" aria-label="Find a board" />
        <button type="button" className="nt-icon-btn" aria-label="Close" onClick={onClose}><X size={15} /></button>
      </div>
      {boards === null && <div className="nt-board-pick-empty">Loading your boards…</div>}
      {error && <div className="nt-board-pick-empty" role="alert">{error}</div>}
      {boards && !error && shown.length === 0 && (
        <div className="nt-board-pick-empty">{boards.length ? 'No board matches.' : 'No boards yet. Start one with New Board.'}</div>
      )}
      {shown.length > 0 && (
        <ul className="nt-board-pick-list">
          {shown.map((b) => (
            <li key={b.id}>
              <button type="button" onClick={() => onPick({ noteId: b.id, title: noteTitle(b), thumbUrl: b.thumbUrl || '' })}>
                {b.thumbUrl ? <img src={b.thumbUrl} alt="" loading="lazy" /> : <span className="is-empty" aria-hidden="true"><PenTool size={14} /></span>}
                <span className="nt-board-pick-title">{noteTitle(b)}{b.mine === false && <small className="nt-board-pick-shared">Shared with you</small>}</span>
                <span className="nt-board-pick-when">{b.updatedAt ? formatDate(b.updatedAt) : ''}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
  if (!phone) return panel;
  return createPortal(<><div className="nt-qn-overlay nt-board-pick-overlay" aria-hidden="true" />{panel}</>, document.body);
}
