// Task Module - board card previews (Planner's "Show On Card", Neil, Oct 22
// 2026). Under a card's title: the task's cover image, its first open
// checklist lines (tickable right there by whoever may tick them), or the
// start of its description as plain text.
//
// The server builds `task.cardPreview` in bulk with the task list (backend
// task_card_preview.py) - this file only draws it. `task.cardPreviewMode` is
// the setting: '' Automatic, 'checklist', 'description', 'none' or
// 'image:<attachment id>'. The image URL arrives already turned into the
// signed-in /files/view address by api.js. The description arrives as plain
// text and is drawn as a text node - never as HTML.
import { useEffect, useState } from 'react';
import { api } from '../api';
import { NX, FONT } from './theme';
import { SHOW_ON_CARD, IMAGE_MODE, isCoverCandidate } from './boardLayout';

/** The preview under a board card's title, or nothing. */
export default function CardPreview({ task, store, canEdit = false }) {
  const p = task?.cardPreview;
  if (!p || typeof p !== 'object') return null;
  if (p.kind === 'image' && p.url) return <CoverImage key={p.url} url={p.url} name={p.name} />;
  if (p.kind === 'checklist' && Array.isArray(p.items) && p.items.length) {
    // Keyed on the lines shown: a refreshed preview (a ticked line has left
    // it) starts clean.
    return <ChecklistPreview key={p.items.map((i) => i.id).join(',')} preview={p} store={store} canEdit={canEdit} />;
  }
  if (p.kind === 'description' && p.text) {
    return (
      <div data-testid="card-preview-text" style={{
        marginTop: 6, fontSize: 12, lineHeight: 1.45, color: NX.dim, overflowWrap: 'anywhere',
        display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden',
      }}>{String(p.text)}</div>
    );
  }
  return null;
}

function CoverImage({ url, name }) {
  // A file that will not load (removed in the meantime, signed URL refused)
  // leaves no broken-image box on the card.
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <img data-testid="card-preview-image" src={url} alt={name || 'Cover image'} loading="lazy" decoding="async"
      draggable={false} onError={() => setFailed(true)}
      style={{ display: 'block', width: '100%', height: 'auto', maxHeight: 140, objectFit: 'cover', borderRadius: 8, marginTop: 8, background: NX.surface2 }} />
  );
}

function ChecklistPreview({ preview, store, canEdit }) {
  // Lines ticked here, until the next refresh drops them (the card shows
  // OPEN lines). id -> true/false while saving or saved.
  const [ticked, setTicked] = useState({});
  const [error, setError] = useState('');
  const me = String(store?.myEmail || '').toLowerCase();
  const mayTick = (item) => canEdit || (!!me && String(item.assigneeId || '').toLowerCase() === me);
  const tick = async (item, done) => {
    setError('');
    setTicked((m) => ({ ...m, [item.id]: done }));
    try {
      const res = await api.updateTaskChecklistItem(item.id, { done });
      if (res?.task) store?.applyServerTask?.(res.task);
    } catch (e) {
      setTicked((m) => { const n = { ...m }; delete n[item.id]; return n; });
      setError(e?.message || 'That did not save. Try again.');
    }
  };
  const stop = (e) => e.stopPropagation();
  return (
    <div data-testid="card-preview-checklist" onClick={stop} onMouseDown={stop} onKeyDown={stop}
      style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 2, fontFamily: FONT }}>
      {preview.items.map((item) => {
        const done = !!ticked[item.id];
        const allowed = mayTick(item);
        return (
          <label key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: done ? NX.faint : NX.ink, cursor: allowed ? 'pointer' : 'default', minWidth: 0, minHeight: 22 }}>
            <input type="checkbox" className="nx-check" checked={done} disabled={!allowed} onChange={(e) => tick(item, e.target.checked)}
              aria-label={item.title} style={{ flexShrink: 0, margin: 0, cursor: allowed ? 'pointer' : 'default' }} />
            <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: done ? 'line-through' : 'none' }} title={item.title}>{item.title}</span>
          </label>
        );
      })}
      {preview.more > 0 && <div style={{ fontSize: 11.5, color: NX.faint, paddingLeft: 20 }}>+{preview.more} more</div>}
      {error && <div role="alert" style={{ fontSize: 11.5, color: NX.red }}>{error}</div>}
    </div>
  );
}

const isPicked = (a, picked) => !!picked && (a.id === picked || a.versionGroup === picked);

/** The drawer's "Show On Card" choice: Automatic / Checklist / Description /
 *  None, or one of the task's image files. Only editors change it (the
 *  caller passes `disabled` otherwise; the server refuses anyway). */
export function ShowOnCardSelect({ task, onChange, disabled = false, style }) {
  const [images, setImages] = useState([]);
  const count = (task?.attachmentIds || []).length;
  const taskId = task?.id;
  useEffect(() => {
    let alive = true;
    if (!taskId || !count) return () => { alive = false; };
    api.getTaskAttachments(taskId)
      .then((rows) => { if (alive) setImages((rows || []).filter(isCoverCandidate)); })
      .catch(() => { if (alive) setImages([]); });
    return () => { alive = false; };
  }, [taskId, count]);
  const shown = count ? images : [];
  const mode = task?.cardPreviewMode || '';
  const picked = mode.startsWith(IMAGE_MODE) ? mode.slice(IMAGE_MODE.length) : '';
  return (
    <select value={mode} disabled={disabled} aria-label="Show On Card" onChange={(e) => onChange(e.target.value)}
      style={{ width: 'auto', minWidth: 180, maxWidth: '100%', padding: '5px 8px', fontSize: 13, cursor: disabled ? 'default' : 'pointer', ...style }}>
      {SHOW_ON_CARD.map((o) => <option key={o.key || 'auto'} value={o.key}>{o.label}</option>)}
      {(shown.length > 0 || picked) && (
        <optgroup label="Image">
          {/* The file picked may have had a new version since - it is still
              that file (the card shows its newest version). */}
          {shown.map((a) => <option key={a.id} value={isPicked(a, picked) ? mode : `${IMAGE_MODE}${a.id}`}>{a.name}</option>)}
          {picked && !shown.some((a) => isPicked(a, picked)) && <option value={mode}>Picked Image</option>}
        </optgroup>
      )}
    </select>
  );
}
