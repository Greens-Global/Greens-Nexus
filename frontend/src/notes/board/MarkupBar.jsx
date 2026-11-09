// The Board's markup bar (Neil, 11/06/2026): the reviewer's tools - Select,
// Move Around, Pen, Highlighter, Arrow, Box, Text, Comment, Eraser - one ink
// dot that opens the inks and widths, More Tools for the rest of the
// whiteboard (ellipse, diamond, line, image, frame, laser pointer), and on a
// phone Undo / Redo, Style (the engine's full properties panel), Delete and
// More. ONE bar: the engine's own tool strip is hidden wherever it shows. A computer gets a floating pill at the foot of the stage beside the
// engine's full strip; a phone gets a dock along the bottom edge, in thumb
// reach, every target 44px, the tools scrolling sideways when the screen is
// narrow, clear of the home indicator and the keyboard's strip.
//
// Pure UI: what each choice does to the engine is Board.jsx's (through the
// adapter's `markup`); the tools themselves are markupTools.js.
import { useEffect, useRef, useState } from 'react';
import {
  MousePointer2, Hand, PenLine, Highlighter, MoveUpRight, Square, Type, MessageSquarePlus, Eraser,
  Undo2, Redo2, Trash2, MoreHorizontal, Check, Circle, Diamond, Minus, ImagePlus, Frame, Pointer, Shapes, SlidersHorizontal, ChevronDown,
  Workflow, RectangleHorizontal, StickyNote, FileText, Users, ListTree, RefreshCw, ArrowDownNarrowWide, ArrowRightLeft, FileSymlink, Network,
} from 'lucide-react';
import { MARKUP_TOOLS, MORE_TOOLS, MARKUP_COLORS, MARKUP_SIZES, colorByKey, isMoreTool } from './markupTools';

const ICONS = {
  select: MousePointer2, hand: Hand, pen: PenLine, highlight: Highlighter, arrow: MoveUpRight,
  box: Square, text: Type, comment: MessageSquarePlus, eraser: Eraser,
  ellipse: Circle, diamond: Diamond, line: Minus, image: ImagePlus, frame: Frame, laser: Pointer,
};

// The Diagram menu (Neil, 11/06/2026, board/diagram/): boxes that start a
// flow (then the + on a selected box grows it), the text and data diagrams,
// Tidy Up, and Refresh for a data diagram. What each row does is Board.jsx's.
const DIAGRAM_ROWS = [
  { kicker: 'Add a Box' },
  { key: 'shape:step', label: 'Step', Icon: RectangleHorizontal },
  { key: 'shape:decision', label: 'Decision', Icon: Diamond },
  { key: 'shape:terminal', label: 'Start / End', Icon: Circle },
  { key: 'shape:note', label: 'Note', Icon: StickyNote },
  { key: 'record', label: 'Record Card', Icon: FileSymlink },
  { kicker: 'Draw a Diagram' },
  { key: 'text', label: 'Diagram from Text', Icon: FileText },
  { key: 'org', label: 'Org Chart from People', Icon: Users },
  { key: 'workflow', label: 'Workflow as Diagram', Icon: Workflow },
  { key: 'tasks', label: 'Task Dependencies', Icon: ListTree },
  { key: 'systems', label: 'Systems Map', Icon: Network },
  { kicker: 'Arrange' },
  { key: 'tidy:TB', label: 'Tidy Up: Top to Bottom', Icon: ArrowDownNarrowWide, needs: 'tidy' },
  { key: 'tidy:LR', label: 'Tidy Up: Left to Right', Icon: ArrowRightLeft, needs: 'tidy' },
  { key: 'refresh', label: 'Refresh from Source', Icon: RefreshCw, needs: 'refresh' },
];

export default function MarkupBar({
  diagram = null,
  phone = false, tool, colorKey, sizeKey, hasSelection = false, styleOpen = false,
  onTool, onColor, onSize, onUndo, onRedo, onDelete, onMore, onStyle, onHide,
}) {
  // One pop-up at a time: the inks ('ink'), More Tools ('more') or Diagram ('diagram').
  const [pop, setPop] = useState('');
  const tray = pop === 'ink';
  const setTray = (v) => setPop((p) => ((typeof v === 'function' ? v(p === 'ink') : v) ? 'ink' : ''));
  const trayRef = useRef(null);
  const dgRef = useRef(null);
  const dgBtnRef = useRef(null);
  const dotRef = useRef(null);
  const moreRef = useRef(null);
  const moreBtnRef = useRef(null);
  const ink = colorByKey(colorKey);
  // The highlighter has one width (wide); the tray says so instead of
  // offering widths that would not apply.
  const sizes = tool === 'highlight' ? [] : MARKUP_SIZES;

  // A pop-up closes on a tap anywhere else or on Escape.
  useEffect(() => {
    if (!pop) return undefined;
    const mine = [trayRef, dotRef, moreRef, moreBtnRef, dgRef, dgBtnRef];
    const away = (e) => { if (!mine.some((r) => r.current?.contains(e.target))) setPop(''); };
    const esc = (e) => { if (e.key === 'Escape') { const back = pop === 'ink' ? dotRef : pop === 'diagram' ? dgBtnRef : moreBtnRef; setPop(''); back.current?.focus(); } };
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', esc); };
  }, [pop]);
  const moreOn = isMoreTool(tool);
  const MoreIcon = moreOn ? ICONS[tool] : Shapes;
  const moreLabel = moreOn ? MORE_TOOLS.find((t) => t.key === tool)?.label : '';

  const tools = MARKUP_TOOLS.filter((t) => phone || t.key !== 'hand');   // a computer pans with Space or the wheel

  return (
    <div className={`nx-mk${phone ? ' is-phone' : ''}`} data-testid="nx-markup">
      {phone && (
        <div className="nx-mk-float" role="group" aria-label="History">
          <button type="button" className="nx-mk-btn" onClick={onUndo} aria-label="Undo" title="Undo"><Undo2 size={18} /></button>
          <button type="button" className="nx-mk-btn" onClick={onRedo} aria-label="Redo" title="Redo"><Redo2 size={18} /></button>
          {onStyle && (hasSelection || styleOpen) && (
            <button type="button" className={`nx-mk-btn${styleOpen ? ' is-on' : ''}`} onClick={onStyle} aria-pressed={styleOpen}
              aria-label="Style" title="Fill, Opacity, Font and Layers"><SlidersHorizontal size={18} /></button>
          )}
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

      {pop === 'more' && (
        <div className="nx-mk-tray nx-mk-more" ref={moreRef} role="menu" aria-label="More Tools">
          {MORE_TOOLS.map((t) => {
            const Icon = ICONS[t.key];
            return (
              <button key={t.key} type="button" role="menuitemradio" aria-checked={tool === t.key} className={`nx-mk-more-row${tool === t.key ? ' is-on' : ''}`}
                onClick={() => { setPop(''); onTool?.(t.key); }} data-tool={t.key}>
                <Icon size={18} /> <span>{t.label}</span>{!phone && <kbd>{t.hint}</kbd>}
              </button>
            );
          })}
        </div>
      )}

      {pop === 'diagram' && diagram && (
        <div className="nx-mk-tray nx-mk-more nx-mk-diagram" ref={dgRef} role="menu" aria-label="Diagram">
          {DIAGRAM_ROWS.filter((r) => !r.needs || (r.needs === 'tidy' ? diagram.canTidy : diagram.canRefresh)).map((r) => (r.kicker
            ? <div key={r.kicker} className="nx-mk-tray-kicker">{r.kicker}</div>
            : (
              <button key={r.key} type="button" role="menuitem" className="nx-mk-more-row" data-diagram={r.key}
                onClick={() => { setPop(''); diagram.onAction?.(r.key); }}>
                <r.Icon size={18} /> <span>{r.label}</span>
              </button>
            )))}
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
          <button ref={moreBtnRef} type="button" className={`nx-mk-btn${moreOn || pop === 'more' ? ' is-on' : ''}`} aria-expanded={pop === 'more'} aria-haspopup="menu"
            aria-label={moreOn ? `More Tools: ${moreLabel}` : 'More Tools'} title="More Tools" onClick={() => setPop((p) => (p === 'more' ? '' : 'more'))}>
            <MoreIcon size={phone ? 20 : 18} />
          </button>
        </div>
        {diagram && (
          <button ref={dgBtnRef} type="button" className={`nx-mk-btn${pop === 'diagram' ? ' is-on' : ''}`} aria-expanded={pop === 'diagram'} aria-haspopup="menu"
            aria-label="Diagram" title="Diagram" onClick={() => setPop((p) => (p === 'diagram' ? '' : 'diagram'))} data-testid="nx-mk-diagram">
            <Workflow size={phone ? 20 : 18} />
          </button>
        )}
        <span className="nx-mk-sep" aria-hidden />
        <button ref={dotRef} type="button" className={`nx-mk-btn nx-mk-dot${tray ? ' is-on' : ''}`} aria-expanded={tray} aria-label={`Ink: ${ink.label}`} title="Ink and Width"
          onClick={() => setTray((v) => !v)}>
          <span style={{ background: ink.color }} aria-hidden />
        </button>
        {phone && onMore && (
          <button type="button" className="nx-mk-btn" onClick={onMore} aria-label="More" title="More"><MoreHorizontal size={20} /></button>
        )}
        {!phone && onHide && (<>
          <span className="nx-mk-sep" aria-hidden />
          <button type="button" className="nx-mk-btn" onClick={onHide} aria-label="Hide Tools" title="Hide Tools"><ChevronDown size={18} /></button>
        </>)}
      </div>
    </div>
  );
}
