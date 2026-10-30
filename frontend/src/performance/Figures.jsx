// A row of plain figures over a list (Oct 29 2026): the count and the words,
// a dot of the status color, hairlines between - no boxes, no pills. With
// `onPick` each figure is a toggle that filters the list under it (a thin
// rule under the picked one); picking it again clears it.
export default function Figures({ items, value = '', onPick, label }) {
  return (
    <div className="nx-perf-figs" role={onPick ? 'group' : undefined} aria-label={label}>
      {items.map(it => {
        const body = (
          <>
            <span className="nx-perf-fig-n">{it.n}</span>
            <span className="nx-perf-fig-l">
              {it.color && <span className="nx-perf-fig-dot" style={{ background: it.color }} aria-hidden="true" />}
              {it.label}
            </span>
          </>
        );
        if (!onPick) return <div key={it.key} className="nx-perf-fig" title={it.hint}>{body}</div>;
        const on = value === it.key;
        return (
          <button key={it.key} type="button" className="nx-perf-fig nx-perf-fig-btn" aria-pressed={on} title={it.hint}
            onClick={() => onPick(on ? '' : it.key)} style={on ? { '--rule': it.color || 'var(--wk-brand)' } : undefined}>
            {body}
          </button>
        );
      })}
    </div>
  );
}
