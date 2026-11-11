// Word's dialog launchers (Neil, 11/11/2026): the small arrow in a ribbon
// group's corner opens the whole dialog. Both are forms, so on a computer
// they are sheets from the right (the house rule for popups); phones get the
// bottom sheet the shared Modal draws.
//
// Paragraph: alignment, indents (inches, Word's US measure), spacing (pt),
// line spacing and the tab stops - every stop listed, typed, removed, with
// Word's "Default Stops: 0.5 in" past the last one. Font: face, size (pt,
// what Word and the exporter mean by a size), style, color and effects.
import { useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Modal } from '../../tasks/components';
import { cleanTabStops, TAB_ALIGNS } from '../../lib/docTabs';

const ALIGN_LABEL = { left: 'Left', center: 'Centered', right: 'Right', justify: 'Justified' };
const TAB_ALIGN_LABEL = { left: 'Left', center: 'Center', right: 'Right', decimal: 'Decimal' };
const LINE_SPACING = [['', 'Single (Default)'], ['1.2', 'Single'], ['1.38', '1.15'], ['1.8', '1.5 Lines'], ['2.4', 'Double']];
const toIn = (pt) => (pt ? Math.round((pt / 72) * 100) / 100 : 0);
const toPt = (inches) => Math.round((Number(inches) || 0) * 72 * 2) / 2;

function Field({ label, children, hint }) {
  return (
    <label className="doc-dlg-field">
      <span className="doc-dlg-label">{label}</span>
      {children}
      {hint && <span className="doc-dlg-hint">{hint}</span>}
    </label>
  );
}

export function ParagraphDialog({ attrs = {}, onApply, onClose }) {
  const left0 = attrs.indentLeft != null ? Number(attrs.indentLeft) || 0 : (Number(attrs.indent) || 0) * 18;
  const first0 = Number(attrs.indentFirst) || 0;
  const [align, setAlign] = useState(attrs.textAlign || 'left');
  const [left, setLeft] = useState(String(toIn(left0)));
  const [right, setRight] = useState(String(toIn(Number(attrs.indentRight) || 0)));
  const [special, setSpecial] = useState(first0 > 0 ? 'first' : first0 < 0 ? 'hanging' : 'none');
  const [by, setBy] = useState(String(toIn(Math.abs(first0)) || 0.5));
  const [before, setBefore] = useState(String(attrs.spacingBefore ?? ''));
  const [after, setAfter] = useState(String(attrs.spacingAfter ?? ''));
  const [line, setLine] = useState(LINE_SPACING.some(([v]) => v === (attrs.lineHeight || '')) ? (attrs.lineHeight || '') : (attrs.lineHeight || ''));
  const [tabs, setTabs] = useState(() => cleanTabStops(attrs.tabStops).map((t) => ({ pos: String(toIn(t.pos)), align: t.align })));
  const original = useMemo(() => JSON.stringify(attrs), [attrs]);

  const apply = () => {
    const firstPt = special === 'none' ? 0 : toPt(by) * (special === 'hanging' ? -1 : 1);
    const patch = {
      textAlign: align === 'left' ? null : align,
      indentLeft: toPt(left) || null,
      indentRight: toPt(right) || null,
      indentFirst: firstPt || null,
      indent: 0,
      spacingBefore: before === '' ? null : Math.max(0, Number(before) || 0),
      spacingAfter: after === '' ? null : Math.max(0, Number(after) || 0),
      lineHeight: line || null,
      tabStops: (() => { const v = cleanTabStops(tabs.map((t) => ({ pos: toPt(t.pos), align: t.align }))); return v.length ? v : null; })(),
    };
    onApply(patch);
    onClose();
  };
  const footer = (
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
      <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
      <button type="button" className="primary-btn" onClick={apply}>Apply</button>
    </div>
  );
  return (
    <Modal title="Paragraph" onClose={onClose} footer={footer} width="min(560px, 100vw)" minHeight="auto" isDirty={false} key={original}>
      <div className="doc-dlg">
        <section className="doc-dlg-section">
          <h4>General</h4>
          <Field label="Alignment">
            <select className="form-input" value={align} onChange={(e) => setAlign(e.target.value)}>
              {Object.entries(ALIGN_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Field>
        </section>
        <section className="doc-dlg-section">
          <h4>Indentation</h4>
          <div className="doc-dlg-grid">
            <Field label="Left" hint="inches"><input className="form-input" type="number" step="0.0625" value={left} onChange={(e) => setLeft(e.target.value)} aria-label="Left indent, inches" /></Field>
            <Field label="Right" hint="inches"><input className="form-input" type="number" step="0.0625" min="0" value={right} onChange={(e) => setRight(e.target.value)} aria-label="Right indent, inches" /></Field>
            <Field label="Special">
              <select className="form-input" value={special} onChange={(e) => setSpecial(e.target.value)} aria-label="Special indent">
                <option value="none">(None)</option><option value="first">First Line</option><option value="hanging">Hanging</option>
              </select>
            </Field>
            <Field label="By" hint="inches"><input className="form-input" type="number" step="0.0625" min="0" value={by} disabled={special === 'none'} onChange={(e) => setBy(e.target.value)} aria-label="Special indent by, inches" /></Field>
          </div>
        </section>
        <section className="doc-dlg-section">
          <h4>Spacing</h4>
          <div className="doc-dlg-grid">
            <Field label="Before" hint="points"><input className="form-input" type="number" min="0" step="1" value={before} placeholder="Auto" onChange={(e) => setBefore(e.target.value)} aria-label="Space before, points" /></Field>
            <Field label="After" hint="points"><input className="form-input" type="number" min="0" step="1" value={after} placeholder="Auto" onChange={(e) => setAfter(e.target.value)} aria-label="Space after, points" /></Field>
            <Field label="Line Spacing">
              <select className="form-input" value={line} onChange={(e) => setLine(e.target.value)} aria-label="Line spacing">
                {LINE_SPACING.map(([v, l]) => <option key={v || 'auto'} value={v}>{l}</option>)}
                {line && !LINE_SPACING.some(([v]) => v === line) && <option value={line}>{line}</option>}
              </select>
            </Field>
          </div>
        </section>
        <section className="doc-dlg-section">
          <h4>Tabs</h4>
          {tabs.length === 0 && <p className="doc-dlg-note">No tab stops. A tab goes to Word&apos;s default stops, every 0.5 inch.</p>}
          {tabs.map((t, i) => (
            <div key={i} className="doc-dlg-tab">
              <input className="form-input" type="number" step="0.0625" min="0" value={t.pos} aria-label={`Tab stop ${i + 1} position, inches`}
                onChange={(e) => setTabs((ts) => ts.map((x, j) => (j === i ? { ...x, pos: e.target.value } : x)))} />
              <span className="doc-dlg-hint">in</span>
              <select className="form-input" value={t.align} aria-label={`Tab stop ${i + 1} alignment`}
                onChange={(e) => setTabs((ts) => ts.map((x, j) => (j === i ? { ...x, align: e.target.value } : x)))}>
                {TAB_ALIGNS.map((a) => <option key={a} value={a}>{TAB_ALIGN_LABEL[a]}</option>)}
              </select>
              <button type="button" className="doc-dlg-icon" title="Clear this tab stop" aria-label={`Clear tab stop ${i + 1}`} onClick={() => setTabs((ts) => ts.filter((_, j) => j !== i))}><Trash2 size={14} /></button>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button type="button" className="secondary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
              onClick={() => setTabs((ts) => [...ts, { pos: String((Number(ts[ts.length - 1]?.pos) || 0) + 1), align: 'left' }])}><Plus size={13} /> Add Tab Stop</button>
            {tabs.length > 0 && <button type="button" className="secondary-btn" onClick={() => setTabs([])}>Clear All</button>}
          </div>
          <p className="doc-dlg-note">Positions are measured from the left margin, as in Word. You can also click the ruler to set one.</p>
        </section>
      </div>
    </Modal>
  );
}

const FONT_SIZES_PT = ['8', '9', '10', '10.5', '11', '12', '14', '16', '18', '20', '24', '28', '36', '48', '72'];

// `marks`: { fontFamily, fontSize, color, bold, italic, underline, strike,
// superscript, subscript } for the selection; onApply(next) sets them.
export function FontDialog({ marks = {}, fonts = {}, onApply, onClose }) {
  const [face, setFace] = useState(marks.fontFamily || '');
  const [size, setSize] = useState(String(marks.fontSize || '').replace(/(px|pt)$/, ''));
  const [bold, setBold] = useState(!!marks.bold);
  const [italic, setItalic] = useState(!!marks.italic);
  const [underline, setUnderline] = useState(!!marks.underline);
  const [strike, setStrike] = useState(!!marks.strike);
  const [script, setScript] = useState(marks.superscript ? 'super' : marks.subscript ? 'sub' : '');
  const [color, setColor] = useState(marks.color || '');
  const style = {
    fontFamily: face ? `"${face}", Inter, sans-serif` : undefined,
    fontSize: size ? `${Math.min(Number(size) || 12, 48)}pt` : undefined,
    fontWeight: bold ? 700 : 400, fontStyle: italic ? 'italic' : 'normal',
    textDecoration: [underline && 'underline', strike && 'line-through'].filter(Boolean).join(' ') || 'none',
    color: color || undefined, verticalAlign: script === 'super' ? 'super' : script === 'sub' ? 'sub' : undefined,
  };
  const footer = (
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
      <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
      <button type="button" className="primary-btn" onClick={() => { onApply({ fontFamily: face, fontSize: size ? `${size}pt` : '', bold, italic, underline, strike, superscript: script === 'super', subscript: script === 'sub', color }); onClose(); }}>Apply</button>
    </div>
  );
  return (
    <Modal title="Font" onClose={onClose} footer={footer} width="min(520px, 100vw)" minHeight="auto">
      <div className="doc-dlg">
        <section className="doc-dlg-section">
          <div className="doc-dlg-grid">
            <Field label="Font">
              <select className="form-input" value={face} onChange={(e) => setFace(e.target.value)} aria-label="Font">
                <option value="">Default Font</option>
                {Object.entries(fonts).map(([g, list]) => <optgroup key={g} label={g}>{list.map((f) => <option key={f} value={f}>{f}</option>)}</optgroup>)}
              </select>
            </Field>
            <Field label="Size" hint="points">
              <input className="form-input" list="doc-dlg-sizes" value={size} onChange={(e) => setSize(e.target.value.replace(/[^\d.]/g, ''))} placeholder="Default" aria-label="Font size, points" />
              <datalist id="doc-dlg-sizes">{FONT_SIZES_PT.map((s) => <option key={s} value={s} />)}</datalist>
            </Field>
          </div>
        </section>
        <section className="doc-dlg-section">
          <h4>Style</h4>
          <div className="doc-dlg-checks">
            <label><input type="checkbox" checked={bold} onChange={(e) => setBold(e.target.checked)} /> Bold</label>
            <label><input type="checkbox" checked={italic} onChange={(e) => setItalic(e.target.checked)} /> Italic</label>
            <label><input type="checkbox" checked={underline} onChange={(e) => setUnderline(e.target.checked)} /> Underline</label>
          </div>
        </section>
        <section className="doc-dlg-section">
          <h4>Effects</h4>
          <div className="doc-dlg-checks">
            <label><input type="checkbox" checked={strike} onChange={(e) => setStrike(e.target.checked)} /> Strikethrough</label>
            <label><input type="checkbox" checked={script === 'super'} onChange={(e) => setScript(e.target.checked ? 'super' : '')} /> Superscript</label>
            <label><input type="checkbox" checked={script === 'sub'} onChange={(e) => setScript(e.target.checked ? 'sub' : '')} /> Subscript</label>
          </div>
          <Field label="Font Color">
            <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
              <input type="color" value={color || '#111827'} onChange={(e) => setColor(e.target.value)} aria-label="Font color" style={{ width: 36, height: 28, padding: 0, border: '1px solid var(--line)', borderRadius: 6 }} />
              <button type="button" className="secondary-btn" onClick={() => setColor('')}>Automatic</button>
            </span>
          </Field>
        </section>
        <section className="doc-dlg-section">
          <h4>Preview</h4>
          <div className="doc-dlg-preview"><span style={style}>{face || 'The quick brown fox jumps over the lazy dog'}</span></div>
        </section>
      </div>
    </Modal>
  );
}
