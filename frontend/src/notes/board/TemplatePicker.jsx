// New Board asks what to start from (11/02/2026): Blank, Grid, Kanban,
// Timeline, Floor Plan. A question, so the shared Modal stays a centered card
// on a desktop (placement="center"); on a phone it is the full-screen sheet
// the Modal already draws there.
import { LayoutTemplate, Grid3x3, Columns3, CalendarRange, Home } from 'lucide-react';
import { Modal } from '../../tasks/components';
import { TEMPLATES } from './templates';

const ICONS = { blank: LayoutTemplate, grid: Grid3x3, kanban: Columns3, timeline: CalendarRange, floorplan: Home };

export default function TemplatePicker({ onPick, onClose, busy = false }) {
  return (
    <Modal title="New Board" onClose={onClose} placement="center" width="520px" minHeight="0">
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
