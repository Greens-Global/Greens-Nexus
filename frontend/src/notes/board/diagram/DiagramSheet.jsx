// The diagram sheet (Neil, 11/06/2026): Diagram from Text and the three
// Nexus data sources, one sheet from the right. Left is what you give it
// (the text, or the person / workflow / project), right is the diagram as it
// will land, drawn here in plain SVG from the same layout the board uses -
// so the preview costs nothing and never touches the engine. Place on Board
// hands the graph back; the board builds and selects it.
import { useEffect, useMemo, useState } from 'react';
import { Modal } from '../../../tasks/components';
import { btn } from '../../../tasks/theme';
import { parseText, layout, bounds, edgePoints, STARTERS, SHAPE_STYLE } from './graph';
import { SOURCES, sourceOptions, loadGraph } from './sources';

const DIRS = [{ key: 'TB', label: 'Top to Bottom' }, { key: 'LR', label: 'Left to Right' }];
const TEXT_HINT = 'One step per line. Join steps with ->, label a line with -yes->.\nEnd a name with ? for a decision, (Start) for a start or end, {Note} for a note.\nIndent a line under another to hang it from that one.';

function Preview({ placed }) {
  const b = bounds(placed);
  if (!placed?.nodes?.length) return <div className="nx-dg-empty">The diagram shows here as you type.</div>;
  const at = new Map(placed.nodes.map((n) => [n.id, n]));
  const pad = 16;
  return (
    <svg className="nx-dg-svg" viewBox={`${b.x - pad} ${b.y - pad} ${b.w + pad * 2} ${b.h + pad * 2}`} role="img" aria-label="Diagram preview">
      <defs>
        <marker id="nx-dg-head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="currentColor" />
        </marker>
      </defs>
      {placed.edges.map((e, i) => {
        const a = at.get(e.from); const c = at.get(e.to);
        if (!a || !c) return null;
        const [x1, y1, x2, y2] = edgePoints(a, c, placed.dir);
        return (
          <g key={i}>
            <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="currentColor" strokeWidth="1.6" markerEnd="url(#nx-dg-head)" />
            {e.label && <text x={(x1 + x2) / 2} y={(y1 + y2) / 2} className="nx-dg-elabel">{e.label}</text>}
          </g>
        );
      })}
      {placed.nodes.map((n) => {
        const s = SHAPE_STYLE[n.shape] || SHAPE_STYLE.step;
        const common = { fill: s.fill, stroke: s.stroke, strokeWidth: 1.6 };
        const cx = n.x + n.w / 2; const cy = n.y + n.h / 2;
        const lines = String(n.label).split('\n');
        return (
          <g key={n.id}>
            {n.shape === 'decision' && <polygon points={`${cx},${n.y} ${n.x + n.w},${cy} ${cx},${n.y + n.h} ${n.x},${cy}`} {...common} />}
            {n.shape === 'terminal' && <ellipse cx={cx} cy={cy} rx={n.w / 2} ry={n.h / 2} {...common} />}
            {(n.shape === 'step' || n.shape === 'note') && <rect x={n.x} y={n.y} width={n.w} height={n.h} rx="10" {...common} />}
            <text x={cx} y={cy - ((lines.length - 1) * 9)} className="nx-dg-nlabel">
              {lines.map((l, i) => <tspan key={i} x={cx} dy={i ? 18 : 0}>{l.length > 28 ? `${l.slice(0, 27)}...` : l}</tspan>)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export default function DiagramSheet({ mode = 'text', initialRef = '', onPlace, onClose }) {
  const isText = mode === 'text';
  const [text, setText] = useState(STARTERS[0].text);
  const [dir, setDir] = useState('TB');
  const [options, setOptions] = useState(null);
  const [ref, setRef] = useState(initialRef);
  const [data, setData] = useState(null);       // { ref, graph } | { ref, error }
  const [optError, setOptError] = useState('');

  useEffect(() => {
    if (isText) return undefined;
    let on = true;
    sourceOptions(mode)
      .then((o) => { if (!on) return; setOptions(o); if (!initialRef && mode !== 'org' && o[0]) setRef(o[0].value); })
      .catch((e) => { if (on) { setOptions([]); setOptError(e?.status === 403 ? 'You do not have access to this list.' : 'This list did not load. Try again in a moment.'); } });
    return () => { on = false; };
  }, [mode, isText, initialRef]);

  useEffect(() => {
    if (isText || options == null || (mode !== 'org' && !ref)) return undefined;
    let on = true;
    loadGraph(mode, ref)
      .then((graph) => { if (on) setData({ ref, graph }); })
      .catch(() => { if (on) setData({ ref, error: true }); });
    return () => { on = false; };
  }, [mode, ref, isText, options]);

  const graph = useMemo(() => (isText ? parseText(text) : data?.ref === ref ? data.graph : null), [isText, text, data, ref]);
  const placed = useMemo(() => (graph ? layout(graph, { dir }) : null), [graph, dir]);
  const count = graph?.nodes?.length || 0;
  const loading = !isText && !optError && (options == null || (data?.ref !== ref && (mode === 'org' || ref)));
  const title = isText ? 'Diagram from Text' : SOURCES[mode]?.label || 'Diagram';
  const empty = !isText && !loading && graph && !count
    ? (mode === 'tasks' ? 'No task in this project waits on another.' : 'Nothing to draw here yet.') : '';

  const place = () => {
    if (!count) return;
    onPlace?.(graph, { dir, source: isText ? '' : mode, ref: isText ? '' : ref });
  };

  const footer = (
    <div className="nx-dg-foot">
      <span className="nx-dg-count">{count ? `${count} ${count === 1 ? 'box' : 'boxes'}${graph?.truncated ? ' (first 200)' : ''}` : ''}</span>
      <button type="button" style={btn('outline')} onClick={onClose}>Cancel</button>
      <button type="button" style={{ ...btn('primary'), opacity: count ? 1 : 0.55 }} onClick={place} disabled={!count}>Place on Board</button>
    </div>
  );

  return (
    <Modal title={title} onClose={onClose} footer={footer} zIndex={4200}>
      <div className="nx-dg">
        <div className="nx-dg-side">
          {isText ? (<>
            <div className="nx-dg-starters" role="group" aria-label="Start From">
              {STARTERS.map((s) => (
                <button key={s.key} type="button" className="nx-dg-chip" onClick={() => setText(s.text)}>{s.label}</button>
              ))}
            </div>
            <textarea className="nx-dg-text nx-fill" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false}
              aria-label="Diagram Text" placeholder="(Start) -> Review -> Approved?" />
            <p className="nx-dg-hint">{TEXT_HINT}</p>
          </>) : (<>
            <label className="nx-dg-label" htmlFor="nx-dg-ref">{mode === 'org' ? 'Start From' : mode === 'workflow' ? 'Workflow' : 'Project'}</label>
            <select id="nx-dg-ref" className="nx-dg-select" value={ref} onChange={(e) => setRef(e.target.value)} disabled={!options?.length}>
              {(options || []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            {optError && <p className="nx-dg-error" role="alert">{optError}</p>}
            {data?.error && data.ref === ref && <p className="nx-dg-error" role="alert">This did not load. Try again in a moment.</p>}
            <p className="nx-dg-hint">
              {mode === 'org' && 'Drawn from the Contact Directory: each person under their manager.'}
              {mode === 'workflow' && 'The workflow as the builder lays it out: its trigger, steps, branches and answers.'}
              {mode === 'tasks' && 'Tasks that wait on another, an arrow from the blocker to what it holds up. Finished tasks are ovals.'}
              {' '}It is a snapshot - select it later and choose Refresh from Source to draw it again from today's data.
            </p>
          </>)}
          <div className="nx-dg-label">Direction</div>
          <div className="nx-dg-seg" role="radiogroup" aria-label="Direction">
            {DIRS.map((d) => (
              <button key={d.key} type="button" role="radio" aria-checked={dir === d.key} onClick={() => setDir(d.key)}>{d.label}</button>
            ))}
          </div>
        </div>
        <div className="nx-dg-preview nx-fill">
          {loading ? <div className="nx-dg-empty">Loading...</div>
            : empty ? <div className="nx-dg-empty">{empty}</div>
              : <Preview placed={placed} />}
        </div>
      </div>
    </Modal>
  );
}
