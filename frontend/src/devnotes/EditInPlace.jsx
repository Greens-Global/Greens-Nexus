// Edit In Place: the element's text becomes editable and a compact style
// panel (padding, margin, font size, color, background, radius, gap) previews
// on the REAL element. Save produces the `edit` block - before / after as
// computed values, so the CLI can assert them on dev later - plus the auto
// sentence; Cancel restores. Every touched element is restored when the mode
// goes off (restoreAllEdits), whatever happened in between.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { X, Check } from 'lucide-react';
import { useIsMobile } from '../lib/useIsMobile';
import { textOf } from './lib/capture';
import { placeCard } from './lib/anchor';

const PROPS = [
  { key: 'padding',         css: 'padding',          label: 'Padding' },
  { key: 'margin',          css: 'margin',           label: 'Margin' },
  { key: 'fontSize',        css: 'font-size',        label: 'Font Size' },
  { key: 'color',           css: 'color',            label: 'Color',      color: true },
  { key: 'backgroundColor', css: 'background-color', label: 'Background', color: true },
  { key: 'borderRadius',    css: 'border-radius',    label: 'Radius' },
  { key: 'gap',             css: 'gap',              label: 'Gap' },
];

// el -> restore(); module-level so BuildModeApp can restore everything on off.
const touched = new Map();
export function restoreAllEdits() { for (const fn of touched.values()) { try { fn(); } catch { /* element gone */ } } touched.clear(); }
export function restoreEdit(el) { const fn = touched.get(el); if (fn) { try { fn(); } catch { /* gone */ } touched.delete(el); } }

function rgbToHex(v) {
  const m = String(v || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return /^#[0-9a-f]{6}$/i.test(v) ? v : '#000000';
  return `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;
}
const isTransparent = (v) => /rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\)|transparent/.test(String(v));

const canEditText = (el) => el && !/^(INPUT|TEXTAREA|SELECT|IMG|SVG|VIDEO|CANVAS)$/.test(el.tagName) && !el.querySelector('input, textarea, select, img, svg, video') && !!textOf(el, 2000);

export function editSentence(text, styles) {
  const parts = [];
  if (text && text.before !== text.after) parts.push(`Change the text from '${text.before}' to '${text.after}'`);
  for (const s of styles) parts.push(`${s.prop} ${s.before} -> ${s.after}`);
  return parts.length ? `${parts.join('; ')}.` : '';
}

export default function EditInPlace({ editPick, onSave, onCancel }) {
  const { el, target, rect } = editPick;
  const isMobile = useIsMobile();
  const panelRef = useRef(null);
  const [pos, setPos] = useState(null);
  const snap = useRef(null);
  const [values, setValues] = useState({});
  const editable = canEditText(el);

  // Snapshot + make editable; register the restore for mode-off.
  useEffect(() => {
    if (!el) return undefined;
    const cs = getComputedStyle(el);
    const computed = Object.fromEntries(PROPS.map((p) => [p.key, cs.getPropertyValue(p.css)]));
    snap.current = { text: textOf(el, 2000), cssText: el.style.cssText, computed, contentEditable: el.getAttribute('contenteditable'), html: el.innerHTML };
    const restore = () => {
      el.style.cssText = snap.current.cssText;
      if (snap.current.contentEditable == null) el.removeAttribute('contenteditable'); else el.setAttribute('contenteditable', snap.current.contentEditable);
      el.classList.remove('bm-editing');
      if (editable && textOf(el, 2000) !== snap.current.text) el.innerHTML = snap.current.html;
    };
    touched.set(el, restore);
    setValues(Object.fromEntries(PROPS.map((p) => [p.key, ''])));
    el.classList.add('bm-editing');
    if (editable) {
      el.setAttribute('contenteditable', 'true');
      try {
        el.focus();
        const range = document.createRange(); range.selectNodeContents(el); range.collapse(false);
        const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
      } catch { /* focus refused */ }
    }
    return undefined;
  }, [el, editable]);

  useLayoutEffect(() => {
    if (isMobile) { setPos(null); return; }
    const size = { w: panelRef.current?.offsetWidth || 300, h: panelRef.current?.offsetHeight || 360 };
    setPos(placeCard(rect, size, { w: window.innerWidth, h: window.innerHeight }, false));
  }, [rect, isMobile]);

  const apply = (p, value) => {
    setValues((v) => ({ ...v, [p.key]: value }));
    if (value.trim()) el.style.setProperty(p.css, value.trim()); else el.style.removeProperty(p.css);
  };

  const cancel = () => { restoreEdit(el); onCancel?.(); };
  const save = () => {
    const cs = getComputedStyle(el);
    const styles = PROPS
      .map((p) => ({ prop: p.css, before: snap.current.computed[p.key], after: cs.getPropertyValue(p.css) }))
      .filter((s) => s.before !== s.after);
    const after = textOf(el, 2000);
    const text = editable && after !== snap.current.text ? { before: snap.current.text, after } : null;
    if (!text && !styles.length) { cancel(); return; }
    el.removeAttribute('contenteditable');
    el.classList.remove('bm-editing');
    // The preview stays on the element until the mode goes off (screenshots
    // then show the wanted state); its restore stays registered.
    onSave?.({ text, styles, note: editSentence(text, styles), source: target?.source || null });
  };

  return (
    <div ref={panelRef} className="bm-card bm-editpanel" role="dialog" aria-label="Edit In Place" style={pos ? { left: pos.left, top: pos.top } : undefined}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); cancel(); } }}>
      <div className="bm-card-head">
        <div className="bm-card-title">Edit In Place</div>
        <button type="button" className="bm-icon-btn" onClick={cancel} aria-label="Cancel edit"><X size={16} /></button>
      </div>
      <div className="bm-card-body">
        <div className="bm-dim bm-small">
          {editable ? 'The text on the page is editable now - click into it and type.' : 'This element has no editable text; change its style below.'}
          {target?.source?.file && <> <span className="bm-src">{target.source.file}:{target.source.line}</span></>}
        </div>
        <div className="bm-style-grid">
          {PROPS.map((p) => {
            const computed = snap.current?.computed?.[p.key] || '';
            const current = values[p.key];
            return (
              <label key={p.key} className="bm-field">
                <span className="bm-field-label">{p.label}</span>
                <span className="bm-field-row">
                  {p.color && (
                    <input type="color" aria-label={`${p.label} swatch`} className="bm-color" value={rgbToHex(current || computed)}
                      onChange={(e) => apply(p, e.target.value)} />
                  )}
                  <input className="bm-input" value={current || ''} placeholder={p.color && isTransparent(computed) ? 'transparent' : computed || '-'}
                    onChange={(e) => apply(p, e.target.value)} aria-label={p.label} />
                </span>
              </label>
            );
          })}
        </div>
      </div>
      <div className="bm-card-foot">
        <button type="button" className="bm-btn bm-btn-ghost" onClick={cancel}>Cancel</button>
        <button type="button" className="bm-btn bm-btn-primary" onClick={save}><Check size={14} /> Save Edit</button>
      </div>
    </div>
  );
}
