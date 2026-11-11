// Word's Home > Styles gallery: the current paragraph style is named on the
// button, and one click sets both the block type and its look.
import { ChevronDown } from 'lucide-react';
import { Menu } from './ui';

export const STYLES = [
  { key: 'normal', label: 'Normal', apply: (c) => c.setParagraph().updateAttributes('paragraph', { spacingAfter: null, lineHeight: null, indentLeft: null, indentFirst: null, border: null, backgroundColor: null, textAlign: null }).unsetFontSize().unsetColor().unsetItalic() },
  { key: 'nospacing', label: 'No Spacing', apply: (c) => c.setParagraph().updateAttributes('paragraph', { spacingAfter: 0, lineHeight: '1.2' }) },
  { key: 'h1', label: 'Heading 1', apply: (c) => c.setHeading({ level: 1 }) },
  { key: 'h2', label: 'Heading 2', apply: (c) => c.setHeading({ level: 2 }) },
  { key: 'h3', label: 'Heading 3', apply: (c) => c.setHeading({ level: 3 }) },
  { key: 'h4', label: 'Heading 4', apply: (c) => c.setHeading({ level: 4 }) },
  { key: 'title', label: 'Title', apply: (c) => c.setHeading({ level: 1 }).updateAttributes('heading', { textAlign: 'center' }).setFontSize('26pt') },
  { key: 'subtitle', label: 'Subtitle', apply: (c) => c.setParagraph().setFontSize('14pt').setColor('#6b7280') },
  { key: 'quote', label: 'Quote', apply: (c) => c.setParagraph().updateAttributes('paragraph', { indentLeft: 36, border: '1px solid #d1d5db' }).setItalic() },
];

export function currentStyle(editor) {
  if (!editor) return STYLES[0];
  if (editor.isActive('heading')) {
    const { level, textAlign } = editor.getAttributes('heading');
    if (level === 1 && textAlign === 'center') return STYLES.find((s) => s.key === 'title');
    return STYLES.find((s) => s.key === `h${level}`) || STYLES[0];
  }
  const a = editor.getAttributes('paragraph');
  if (a.indentLeft === 36 && editor.isActive('italic')) return STYLES.find((s) => s.key === 'quote');
  if (a.spacingAfter === 0 && a.lineHeight === '1.2') return STYLES.find((s) => s.key === 'nospacing');
  if (editor.getAttributes('textStyle').fontSize === '14pt' && editor.getAttributes('textStyle').color === '#6b7280') return STYLES.find((s) => s.key === 'subtitle');
  return STYLES[0];
}

// The gallery's first row (Neil, 11/11/2026: "a real Styles gallery"): each
// tile drawn in its own style, the current one outlined; the chevron opens
// every style. In the Simplified ribbon only the chevron's list shows.
const GALLERY = ['normal', 'h1', 'h2'];

export default function StyleGallery({ editor, compact = false }) {
  const cur = currentStyle(editor);
  const apply = (s) => s.apply(editor.chain().focus()).run();
  return (
    <div className="doc-style-gallery">
      {!compact && GALLERY.map((key) => {
        const s = STYLES.find((x) => x.key === key);
        return (
          <button key={key} type="button" className={`doc-style-tile doc-style-tile-${key}${cur.key === key ? ' is-active' : ''}`}
            title={`${s.label} Style`} aria-pressed={cur.key === key} onMouseDown={(e) => e.preventDefault()} onClick={() => apply(s)}>
            <span className="doc-style-sample">AaBbCc</span>
            <span className="doc-style-name">{s.label}</span>
          </button>
        );
      })}
      <Menu label={compact ? cur.label : ''} icon={compact ? undefined : ChevronDown} title={`Styles - ${cur.label}`} width={300}>
        {(close) => (
          <div className="doc-ribbon-styles">
            {STYLES.map((s) => (
              <button key={s.key} type="button" className={`doc-ribbon-style doc-ribbon-style-${s.key}${cur.key === s.key ? ' is-active' : ''}`}
                onClick={() => { apply(s); close(); }}>{s.label}</button>
            ))}
          </div>
        )}
      </Menu>
    </div>
  );
}
