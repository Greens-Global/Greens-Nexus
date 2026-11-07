// New Board asks what to start from (11/02/2026): Blank, Grid, Kanban,
// Timeline, Floor Plan. A question, so the shared Modal stays a centered card
// on a desktop (placement="center"); on a phone it is the full-screen sheet
// the Modal already draws there.
//
// Your Templates (Neil, 11/06/2026): the person's own boards marked Use as
// Template (view=templates) sit above; picking one copies its drawing.
import { useEffect, useState } from 'react';
import { LayoutTemplate, Grid3x3, Columns3, CalendarRange, Home, PenTool } from 'lucide-react';
import { Modal } from '../../tasks/components';
import { api } from '../../api';
import { TEMPLATES } from './templates';

const ICONS = { blank: LayoutTemplate, grid: Grid3x3, kanban: Columns3, timeline: CalendarRange, floorplan: Home };

export default function TemplatePicker({ onPick, onPickBoard, onClose, busy = false }) {
  const [mine, setMine] = useState([]);
  const wantMine = !!onPickBoard;
  useEffect(() => {
    if (!wantMine) return undefined;
    let alive = true;
    api.notesList({ view: 'templates' })
      .then((r) => { if (alive) setMine((r?.notes || []).filter((n) => n.kind === 'board')); })
      .catch(() => { /* the built-in layouts still show */ });
    return () => { alive = false; };
  }, [wantMine]);
  return (
    <Modal title="New Board" onClose={onClose} placement="center" width="520px" minHeight="0">
      {mine.length > 0 && (<>
        <div className="nt-tpl-kicker">Your Templates</div>
        <div className="nt-tpl-grid" role="group" aria-label="Your Templates" style={{ marginBottom: 16 }}>
          {mine.map((n) => (
            <button key={n.id} type="button" className="nt-tpl" disabled={busy} onClick={() => onPickBoard(n)} aria-label={`${n.title || 'Untitled Board'} - your template`}>
              {n.thumbUrl ? <img className="nt-tpl-thumb" src={n.thumbUrl} alt="" loading="lazy" /> : <PenTool size={22} aria-hidden="true" />}
              <span className="nt-tpl-label">{n.title || 'Untitled Board'}</span>
            </button>
          ))}
        </div>
      </>)}
      <p className="nt-tpl-hint">Start from a layout, or a blank board. Everything on it can be changed.</p>
      <div className="nt-tpl-grid" role="group" aria-label="Templates">
        {TEMPLATES.map((t) => {
          const Icon = ICONS[t.key] || LayoutTemplate;
          return (
            <button key={t.key} type="button" className="nt-tpl" disabled={busy} onClick={() => onPick(t.key)}
              aria-label={`${t.label} - ${t.hint}`}>
              <Icon size={22} aria-hidden="true" />
              <span className="nt-tpl-label">{t.label}</span>
              <span className="nt-tpl-sub">{t.hint}</span>
            </button>
          );
        })}
      </div>
    </Modal>
  );
}
