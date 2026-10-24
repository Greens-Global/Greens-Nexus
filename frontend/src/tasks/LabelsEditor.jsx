// Task Module - the labels box (Oct 22 2026): the task drawer's Labels row
// and the Create Task form's.
//
// Reuse before create: typing offers the labels already in use (on tasks the
// person can open - see useLabelColors), most used first, so "urgent" lands
// on the existing "Urgent" instead of starting a near-duplicate. Whatever is
// typed is stored in the existing spelling when one exists (canonicalLabel).
//
// Keyboard: Enter or comma adds (the highlighted suggestion once the arrows
// have picked one, else what was typed); Backspace in an empty box removes
// the last label; Up / Down move through the suggestions; Escape closes them.
// Read-only: the pills alone, no box and no remove buttons.
import { useMemo, useRef, useState } from 'react';
import AnchoredMenu from '../components/AnchoredMenu';
import { NX, FONT } from './theme';
import { LabelPill, canonicalLabel, labelKey, labelSuggestions, mergeLabelLists, mergeLabels, useLabelColors } from './labels';

export default function LabelsEditor({ tags = [], onChange, readOnly = false, known = null, placeholder = 'Add label…', inputStyle }) {
  const { map, inUse } = useLabelColors();
  const [input, setInput] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const boxRef = useRef(null);
  const inputRef = useRef(null);
  const all = useMemo(() => mergeLabelLists(inUse, known || []), [inUse, known]);
  const suggestions = useMemo(() => labelSuggestions(all, input, tags), [all, input, tags]);
  const list = mergeLabels(tags);

  const add = (raw) => {
    const name = canonicalLabel(raw, map, all);
    setInput(''); setActive(-1);
    if (!name) return;
    const next = mergeLabels(tags, [name]);
    if (next.length !== list.length) onChange(next);
  };
  const remove = (name) => onChange(list.filter((x) => labelKey(x) !== labelKey(name)));

  if (readOnly) {
    if (!list.length) return <span style={{ fontSize: 13, color: NX.faint }}>-</span>;
    return (
      <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4, flex: 1 }}>
        {list.map((t) => <LabelPill key={labelKey(t)} name={t} />)}
      </span>
    );
  }

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((i) => Math.min(i + 1, suggestions.length - 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, -1)); return; }
    if (e.key === 'Enter' || e.key === ',') {
      if (e.nativeEvent?.isComposing) return;
      e.preventDefault();
      if (active >= 0 && suggestions[active]) add(suggestions[active].name);
      else if (input.trim()) add(input);
      return;
    }
    if (e.key === 'Backspace' && !input && list.length) { e.preventDefault(); remove(list[list.length - 1]); return; }
    if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); setActive(-1); }
  };

  return (
    <span ref={boxRef} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4, flex: 1, minWidth: 0 }}>
      {list.map((t) => <LabelPill key={labelKey(t)} name={t} onRemove={remove} />)}
      <input ref={inputRef} className="nx-inline-edit" value={input} aria-label="Add label" maxLength={60}
        role="combobox" aria-expanded={open && suggestions.length > 0} aria-autocomplete="list"
        onChange={(e) => { setInput(e.target.value.replace(/,/g, '')); setOpen(true); setActive(-1); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        // What was typed is kept when focus leaves - a suggestion click keeps
        // focus (its mousedown is prevented), so it is never added twice.
        onBlur={() => { if (input.trim()) add(input); setOpen(false); }}
        placeholder={placeholder}
        style={{ border: 'none', fontFamily: FONT, fontSize: 12, width: 110, color: NX.ink, background: 'transparent', ...inputStyle }} />
      <AnchoredMenu anchorRef={boxRef} open={open && suggestions.length > 0} onClose={() => setOpen(false)} role="listbox"
        aria-label="Labels in use"
        style={{ background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.16)', padding: 4, minWidth: 200, maxWidth: 320, fontFamily: FONT }}>
        <div style={{ padding: '6px 8px 4px', fontSize: 10.5, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: NX.faint }}>
          Labels in Use
        </div>
        {suggestions.map((s, i) => (
          <div key={s.key} role="option" aria-selected={i === active} data-nav-active={i === active ? '' : undefined}
            className="nx-menu-row"
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => setActive(i)}
            onClick={() => { add(s.name); inputRef.current?.focus(); }}
            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 7, cursor: 'pointer', background: i === active ? NX.hover : 'transparent' }}>
            <LabelPill name={s.name} size="sm" />
            {s.count > 0 && <span style={{ marginLeft: 'auto', fontSize: 11, color: NX.faint }}>{s.count}</span>}
          </div>
        ))}
      </AnchoredMenu>
    </span>
  );
}
