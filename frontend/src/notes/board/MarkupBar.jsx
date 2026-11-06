// The Board's markup bar (Neil, 11/06/2026): the reviewer's tools - Select,
// Move Around, Pen, Highlighter, Arrow, Box, Text, Comment, Eraser - one ink
// dot that opens the inks and widths, and on a phone Undo / Redo, Delete and
// More. A computer gets a floating pill at the foot of the stage beside the
// engine's full strip; a phone gets a dock along the bottom edge, in thumb
// reach, every target 44px, the tools scrolling sideways when the screen is
// narrow, clear of the home indicator and the keyboard's strip.
//
// Pure UI: what each choice does to the engine is Board.jsx's (through the
// adapter's `markup`); the tools themselves are markupTools.js.
import { useEffect, useRef, useState } from 'react';
import {
  MousePointer2, Hand, PenLine, Highlighter, MoveUpRight, Square, Type, MessageSquarePlus, Eraser,
  Undo2, Redo2, Trash2, MoreHorizontal, Check,
} from 'lucide-react';
import { MARKUP_TOOLS, MARKUP_COLORS, MARKUP_SIZES, colorByKey } from './markupTools';

const ICONS = {
  select: MousePointer2, hand: Hand, pen: PenLine, highlight: Highlighter, arrow: MoveUpRight,
  box: Square, text: Type, comment: MessageSquarePlus, eraser: Eraser,
};

export default function MarkupBar({
  phone = false, tool, colorKey, sizeKey, hasSelection = false,
  onTool, onColor, onSize, onUndo, onRedo, onDelete, onMore,
}) {
  const [tray, setTray] = useState(false);
  const trayRef = useRef(null);
  const dotRef = useRef(null);
  const ink = colorByKey(colorKey);
  // The highlighter has one width (wide); the tray says so instead of
  // offering widths that would not apply.
  const sizes = tool === 'highlight' ? [] : MARKUP_SIZES;

  // The tray closes on a tap anywhere else or on Escape.
  useEffect(() => {
    if (!tray) return undefined;
    const away = (e) => {
      if (trayRef.current?.contains(e.target) || dotRef.current?.contains(e.target)) return;
      setTray(false);
    };
    const esc = (e) => { if (e.key === 'Escape') { setTray(false); dotRef.current?.focus(); } };
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', esc); };
  }, [tray]);

  const tools = MARKUP_TOOLS.filter((t) => phone || t.key !== 'hand');   // a computer pans with Space or the wheel

  return (
    <div className={`nx-mk${phone ? ' is-phone' : ''}`} data-testid="nx-markup">
      {phone && (
        <div className="nx-mk-float" role="group" aria-label="History">
          <button type="button" className="nx-mk-btn" onClick={onUndo} aria-label="Undo" title="Undo"><Undo2 size={18} /></button>
          <button type="button" className="nx-mk-btn" onClick={onRedo} aria-label="Redo" title="Redo"><Redo2 size={18} /></button>
          {hasSelection && (
            <button type="button" className="nx-mk-btn is-danger" onClick={onDelete} aria-label="Delete Selected" title="Delete Selected"><Trash2 size={18} /></button>
          )}
        </div>
      )}

      {tray && (
        <div className="nx-mk-tray" ref={trayRef} role="dialog" aria-label={hasSelection && tool === 'select' ? 'Ink for the Selection' : 'Ink'}>
          {hasSelection && tool === 'select' && <div className="nx-mk-tray-kicker">Selection</div>}
          <div className="nx-mk-inks" role="radiogroup" aria-label="Ink">
            {MARKUP_COLORS.map((c) => (
              <button key={c.key} type="button" role="radio" aria-checked={colorKey === c.key} aria-label={c.label} title={c.label}
                className="nx-mk-ink" style={{ '--ink': c.color }} onClick={() => onColor?.(c.key)}>
                {colorKey === c.key && <Check size={14} strokeWidth={3} aria-hidden />}
              </button>
            ))}
          </div>
          {sizes.length > 0 && (
            <div className="nx-mk-sizes" role="radiogroup" aria-label="Width">
              {sizes.map((s) => (
                <button key={s.key} type="button" role="radio" aria-checked={sizeKey === s.key} aria-label={s.label} title={s.label}
                  className="nx-mk-size" onClick={() => onSize?.(s.key)}>
                  <span style={{ height: s.width * 1.5 + 1, background: ink.color }} aria-hidden />
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="nx-mk-bar" role="toolbar" aria-label="Markup Tools">
        <div className="nx-mk-tools">
          {tools.map((t) => {
            const Icon = ICONS[t.key];
            const on = tool === t.key;
            const title = t.hint && !phone ? `${t.label} - ${t.hint}` : t.label;
            return (
              <button key={t.key} type="button" className={`nx-mk-btn${on ? ' is-on' : ''}`} aria-pressed={on} aria-label={t.label} title={title}
                onClick={() => onTool?.(t.key)} data-tool={t.key}>
                <Icon size={phone ? 20 : 18} strokeWidth={on ? 2.25 : 1.9} />
                {(t.key === 'pen' || t.key === 'highlight') && on && <i className="nx-mk-tip" style={{ background: ink.color }} aria-hidden />}
              </button>
            );
          })}
        </div>
        <span className="nx-mk-sep" aria-hidden />
        <button ref={dotRef} type="button" className={`nx-mk-btn nx-mk-dot${tray ? ' is-on' : ''}`} aria-expanded={tray} aria-label={`Ink: ${ink.label}`} title="Ink and Width"
          onClick={() => setTray((v) => !v)}>
          <span style={{ background: ink.color }} aria-hidden />
        </button>
        {phone && onMore && (
          <button type="button" className="nx-mk-btn" onClick={onMore} aria-label="More" title="More"><MoreHorizontal size={20} /></button>
        )}
      </div>
    </div>
  );
}
