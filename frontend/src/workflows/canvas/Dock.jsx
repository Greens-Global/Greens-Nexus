// The dock of blocks (10/30/2026): the six step kinds, each a block you
// drag onto a connector. A tap on a block (no movement) appends it to the
// end of the workflow - the drag hook decides which happened.
import { STEP_KINDS } from '../lib/definition';
import { CANVAS_ICONS, KIND_COLOR, MODULE_COLOR } from './palette';

const ORDER = ['action', 'if', 'approval', 'wait', 'for_each', 'stop'];
const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');

export default function Dock({ canEdit = true, onPaletteDown }) {
  return (
    <aside className="wfc-dock" aria-label="Blocks">
      <div className="wfc-dock-lbl">Blocks</div>
      {ORDER.map((kind) => {
        const Icon = CANVAS_ICONS[kind];
        return (
          <button key={kind} type="button" className="wfc-block" data-kind={kind} disabled={!canEdit}
            aria-label={`${STEP_KINDS[kind].label} block: drag it onto a connector, or press to add it at the end`}
            onPointerDown={(e) => { if (canEdit && onPaletteDown) onPaletteDown(e, kind); }}>
            <span className="wfc-ic" style={{ background: KIND_COLOR[kind] || MODULE_COLOR.tasks }} aria-hidden="true"><Icon /></span>
            {STEP_KINDS[kind].label}
          </button>
        );
      })}
      <div className="wfc-dock-tip">
        Drop a block on any connector.<br />
        Scroll to pan, <kbd>{isMac() ? '⌘' : 'Ctrl'}</kbd> + scroll to zoom, <kbd>Esc</kbd> closes the panel.
      </div>
    </aside>
  );
}
