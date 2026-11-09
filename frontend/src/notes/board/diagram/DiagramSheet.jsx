// The diagram sheet (Neil, 11/06/2026): Diagram from Text and the Nexus data
// sources, one sheet from the right. Left is what you give it (the text, or
// the person / workflow / project / property), right is the diagram as it
// will land, drawn here in plain SVG from the same layout and arrow routes
// the board uses - so the preview costs nothing and never touches the
// engine. Place on Board hands the graph back; the board builds and selects it.
//
// 11/08/2026 (Neil): groups, three arrow kinds and icons in the text; the
// Systems map (A Property / Nexus Connections); "Group By Company" on the org
// chart; and From a Sentence - an AI that would write the text for review,
// which stays OFF (its button disabled, with the reason) until AI is on for
// Nexus and a Super Administrator turns Settings > Notes & Boards > Diagram
// From a Sentence on. The server refuses it either way (routers/notes_diagram.py).
import { useEffect, useMemo, useState } from 'react';
import { Modal } from '../../../tasks/components';
import { btn } from '../../../tasks/theme';
import { api } from '../../../api';
import { useRole } from '../../../contexts/RoleContext';
import {
  parseText, layout, bounds, routeAll, routeMid, glyphBox, STARTERS, SHAPE_STYLE, EDGE_STYLE, GROUP_STYLE, GROUP_LABEL,
} from './graph';
import { GlyphSvg } from './glyphs';
import { SOURCES, sourceOptions, loadGraph } from './sources';
import { AI_OFF_NOTE } from './aiNote';

const DIRS = [{ key: 'TB', label: 'Top to Bottom' }, { key: 'LR', label: 'Left to Right' }];
const TEXT_HINT = [
  'One step per line. Arrows: => main flow, -> normal, -.-> dashed. Label one with =yes=>, -yes-> or -.yes.->.',
  'End a name with ? for a decision, (Start) for a start or end, {Note} for a note. Add an icon with Gate | lock.',
  'A line ending in : starts a group; indent its members under it (one group may sit inside another).',
  'Indent a line under a step to hang it from that one.',
].join('\n');

function Preview({ placed, routes }) {
  const b = bounds(placed);
  if (!placed?.nodes?.length) return <div className="nx-dg-empty">The diagram shows here as you type.</div>;
  const pad = 16;
  const kinds = Object.keys(EDGE_STYLE);
  return (
    <svg className="nx-dg-svg" viewBox={`${b.x - pad} ${b.y - pad} ${b.w + pad * 2} ${b.h + pad * 2}`} role="img" aria-label="Diagram preview">
      <defs>
        {kinds.map((k) => (
          <marker key={k} id={`nx-dg-head-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill={EDGE_STYLE[k].stroke} />
          </marker>
        ))}
      </defs>
      {(placed.groups || []).map((g) => {
        const st = g.parent ? GROUP_STYLE.inner : GROUP_STYLE.outer;
        const lx = g.x + GROUP_LABEL.dx; const ly = g.y + GROUP_LABEL.dy;
        return (
          <g key={g.id} data-group={g.label}>
            <rect x={g.x} y={g.y} width={g.w} height={g.h} rx="8" fill={st.fill} stroke={st.stroke} strokeWidth="1" />
            <GlyphSvg glyph={g.glyph} x={lx} y={ly + 1} w={GROUP_LABEL.glyph} h={GROUP_LABEL.glyph} color={st.ink} />
            <text x={lx + (g.glyph ? GROUP_LABEL.glyph + 6 : 0)} y={ly + 9} className="nx-dg-glabel" fill={st.ink}>{g.label}</text>
          </g>
        );
      })}
      {placed.edges.map((e, i) => {
        const pts = routes?.[i];
        if (!pts) return null;
        const k = EDGE_STYLE[e.kind] ? e.kind : 'normal';
        const [mx, my] = routeMid(pts);
        return (
          <g key={i} data-edge={k}>
            <polyline points={pts.map((p) => p.join(',')).join(' ')} fill="none" stroke={EDGE_STYLE[k].stroke}
              strokeWidth={EDGE_STYLE[k].width * 0.8} strokeDasharray={EDGE_STYLE[k].dash ? '7 5' : undefined} markerEnd={`url(#nx-dg-head-${k})`} />
            {e.label && <text x={mx} y={my} className="nx-dg-elabel">{e.label}</text>}
          </g>
        );
      })}
      {placed.nodes.map((n) => {
        const s = SHAPE_STYLE[n.shape] || SHAPE_STYLE.step;
        const common = { fill: s.fill, stroke: s.stroke, strokeWidth: 1.6 };
        const cx = n.x + n.w / 2; const cy = n.y + n.h / 2;
        const lines = String(n.label).split('\n');
        const gb = n.glyph ? glyphBox(n) : null;
        return (
          <g key={n.id}>
            {n.shape === 'decision' && <polygon points={`${cx},${n.y} ${n.x + n.w},${cy} ${cx},${n.y + n.h} ${n.x},${cy}`} {...common} />}
            {n.shape === 'terminal' && <ellipse cx={cx} cy={cy} rx={n.w / 2} ry={n.h / 2} {...common} />}
            {(n.shape === 'step' || n.shape === 'note') && <rect x={n.x} y={n.y} width={n.w} height={n.h} rx="10" {...common} />}
            {gb && <GlyphSvg glyph={n.glyph} x={gb.x} y={gb.y} w={gb.w} h={gb.h} color="#1c2420" />}
            <text x={cx} y={cy - ((lines.length - 1) * 9)} className="nx-dg-nlabel">
              {lines.map((l, i) => <tspan key={i} x={cx} dy={i ? 18 : 0}>{l.length > 28 ? `${l.slice(0, 27)}...` : l}</tspan>)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** From a Sentence: the box, the button, and why it is off. */
function SentenceBox({ onWritten }) {
  const [state, setState] = useState(null);   // { diagramAiEnabled, aiAvailable } | { error }
  const [sentence, setSentence] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [tries, setTries] = useState(0);
  useEffect(() => {
    let on = true;
    api.getDiagramAiSettings()
      .then((r) => { if (on) setState(r || {}); })
      .catch(() => { if (on) setState({ error: true }); });
    return () => { on = false; };
  }, [tries]);
  const ready = !!(state?.aiAvailable && state?.diagramAiEnabled);
  const note = state == null || state.error || ready ? '' : AI_OFF_NOTE;
  const write = () => {
    if (!ready || !sentence.trim()) return;
    setBusy(true); setErr('');
    api.diagramFromSentence(sentence.trim())
      .then((r) => { if (r?.text) onWritten(r.text); else setErr('Nothing came back. Try other words.'); })
      .catch((e) => setErr(e?.body?.code === 'ai_off' ? AI_OFF_NOTE : (e?.body?.message || e?.message || 'That did not work. Try again in a moment.')))
      .finally(() => setBusy(false));
  };
  return (<>
    <label className="nx-dg-label" htmlFor="nx-dg-sentence">Describe it in a sentence</label>
    <textarea id="nx-dg-sentence" className="nx-dg-text nx-dg-sentence" value={sentence} onChange={(e) => setSentence(e.target.value)}
      placeholder="Our Escondido site: the office opens the gate, the gate leads to the drive-up and climate units, and cameras watch the gate." />
    <button type="button" style={{ ...btn('primary'), alignSelf: 'flex-start', opacity: ready && sentence.trim() && !busy ? 1 : 0.55 }}
      onClick={write} disabled={!ready || !sentence.trim() || busy} aria-describedby={note ? 'nx-dg-ai-note' : undefined}>
      {busy ? 'Writing...' : 'Write the Diagram'}
    </button>
    {note && <p id="nx-dg-ai-note" className="nx-dg-hint nx-dg-ai-off">{note}</p>}
    {state?.error && (
      <p className="nx-dg-error" role="alert">
        Whether this is on did not load.{' '}
        <button type="button" style={btn('ghost')} onClick={() => { setState(null); setTries((t) => t + 1); }}>Retry</button>
      </p>
    )}
    {!note && !state?.error && <p className="nx-dg-hint">Nexus writes the diagram as text first, in the box under Type It, so you can check it before anything goes on the board.</p>}
    {err && <p className="nx-dg-error" role="alert">{err}</p>}
  </>);
}

export default function DiagramSheet({ mode = 'text', initialRef = '', onPlace, onClose }) {
  const isText = mode === 'text';
  const isAdmin = !!useRole()?.can?.('administrator');
  const [text, setText] = useState(STARTERS[0].text);
  const [textMode, setTextMode] = useState('type');   // 'type' | 'sentence'
  const [dir, setDir] = useState('TB');
  const [options, setOptions] = useState(null);
  const [ref, setRef] = useState(initialRef);
  const [data, setData] = useState(null);       // { ref, key, graph } | { ref, key, error }
  const [optError, setOptError] = useState('');
  const [byCompany, setByCompany] = useState(false);
  const group = mode === 'org' && byCompany ? 'company' : '';
  // Systems: Nexus Connections needs no list; A Property needs the server's list.
  const nexusMap = mode === 'systems' && ref === 'nexus';
  const needsRef = mode !== 'org';

  useEffect(() => {
    if (isText) return undefined;
    let on = true;
    sourceOptions(mode)
      .then((o) => {
        if (!on) return;
        setOptions(o);
        if (!initialRef && needsRef) setRef(o[0]?.value || (mode === 'systems' && isAdmin ? 'nexus' : ''));
      })
      .catch((e) => {
        if (!on) return;
        setOptions([]);
        setOptError(e?.status === 403 ? 'You do not have access to this list.' : 'This list did not load. Try again in a moment.');
        if (mode === 'systems' && isAdmin && !initialRef) setRef('nexus');
      });
    return () => { on = false; };
  }, [mode, isText, initialRef, needsRef, isAdmin]);

  const key = `${ref}|${group}`;
  useEffect(() => {
    if (isText || (!nexusMap && options == null) || (needsRef && !ref)) return undefined;
    let on = true;
    loadGraph(mode, ref, { group })
      .then((graph) => { if (on) setData({ key, graph }); })
      .catch(() => { if (on) setData({ key, error: true }); });
    return () => { on = false; };
  }, [mode, ref, group, key, isText, options, nexusMap, needsRef]);

  const graph = useMemo(() => (isText ? parseText(text) : data?.key === key ? data.graph : null), [isText, text, data, key]);
  const placed = useMemo(() => (graph ? layout(graph, { dir }) : null), [graph, dir]);
  const routes = useMemo(() => (placed ? routeAll(placed, 2) : null), [placed]);
  const count = graph?.nodes?.length || 0;
  const loading = !isText && !(optError && !nexusMap) && (needsRef && !ref ? options == null : data?.key !== key);
  const title = isText ? 'Diagram from Text' : SOURCES[mode]?.label || 'Diagram';
  const nothingToPick = !isText && needsRef && !ref && options && !options.length && !optError;
  const empty = nothingToPick ? 'There is nothing here for you to pick yet.'
    : !isText && !loading && graph && !count
      ? (mode === 'tasks' ? 'No task in this project waits on another.' : mode === 'systems' ? 'This property has no equipment, utilities or vendors on file yet.' : 'Nothing to draw here yet.') : '';
  const sentenceOpen = isText && textMode === 'sentence';

  const place = () => {
    if (!count || sentenceOpen) return;
    onPlace?.(graph, { dir, source: isText ? '' : mode, ref: isText ? '' : ref, ...(group ? { group } : {}) });
  };

  const footer = (
    <div className="nx-dg-foot">
      <span className="nx-dg-count">{count ? `${count} ${count === 1 ? 'box' : 'boxes'}${graph?.truncated ? ' (first 200)' : ''}` : ''}</span>
      <button type="button" style={btn('outline')} onClick={onClose}>Cancel</button>
      <button type="button" style={{ ...btn('primary'), opacity: count && !sentenceOpen ? 1 : 0.55 }} onClick={place} disabled={!count || sentenceOpen}>Place on Board</button>
    </div>
  );
  const propertyOptions = (options || []).filter((o) => String(o.value).startsWith('property:'));

  return (
    <Modal title={title} onClose={onClose} footer={footer} zIndex={4200}>
      <div className="nx-dg">
        <div className="nx-dg-side">
          {isText ? (<>
            <div className="nx-dg-seg" role="radiogroup" aria-label="How">
              <button type="button" role="radio" aria-checked={textMode === 'type'} onClick={() => setTextMode('type')}>Type It</button>
              <button type="button" role="radio" aria-checked={textMode === 'sentence'} onClick={() => setTextMode('sentence')}>From a Sentence</button>
            </div>
            {sentenceOpen ? <SentenceBox onWritten={(t) => { setText(t); setTextMode('type'); }} /> : (<>
              <div className="nx-dg-starters" role="group" aria-label="Start From">
                {STARTERS.map((s) => (
                  <button key={s.key} type="button" className="nx-dg-chip" onClick={() => setText(s.text)}>{s.label}</button>
                ))}
              </div>
              <textarea className="nx-dg-text nx-fill" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false}
                aria-label="Diagram Text" placeholder="(Start) -> Review -> Approved?" />
              <p className="nx-dg-hint">{TEXT_HINT}</p>
              {graph?.notes?.map((n) => <p key={n} className="nx-dg-hint nx-dg-note">{n}</p>)}
            </>)}
          </>) : (<>
            {mode === 'systems' && isAdmin && (
              <div className="nx-dg-seg" role="radiogroup" aria-label="Map">
                <button type="button" role="radio" aria-checked={!nexusMap} onClick={() => setRef(propertyOptions[0]?.value || '')}>A Property</button>
                <button type="button" role="radio" aria-checked={nexusMap} onClick={() => setRef('nexus')}>Nexus Connections</button>
              </div>
            )}
            {!nexusMap && (<>
              <label className="nx-dg-label" htmlFor="nx-dg-ref">{mode === 'org' ? 'Start From' : mode === 'workflow' ? 'Workflow' : mode === 'systems' ? 'Property' : 'Project'}</label>
              <select id="nx-dg-ref" className="nx-dg-select" value={ref} onChange={(e) => setRef(e.target.value)} disabled={!options?.length}>
                {(options || []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              {optError && <p className="nx-dg-error" role="alert">{optError}</p>}
            </>)}
            {mode === 'org' && (
              <label className="nx-dg-check">
                <input type="checkbox" checked={byCompany} onChange={(e) => setByCompany(e.target.checked)} /> Group By Company
              </label>
            )}
            {data?.error && data.key === key && <p className="nx-dg-error" role="alert">This did not load. Try again in a moment.</p>}
            <p className="nx-dg-hint">
              {mode === 'org' && 'Drawn from the Contact Directory: each person under their manager.'}
              {mode === 'workflow' && 'The workflow as the builder lays it out: its trigger, steps, branches and answers.'}
              {mode === 'tasks' && 'Tasks that wait on another, an arrow from the blocker to what it holds up. Finished tasks are ovals.'}
              {mode === 'systems' && !nexusMap && 'The property from Asset Management, with its equipment, utilities and vendors.'}
              {mode === 'systems' && nexusMap && 'What Nexus runs on and connects to. Dashed arrows are the sync jobs.'}
              {' '}It is a snapshot - select it later and choose Refresh from Source to draw it again from today's data.
            </p>
          </>)}
          {!sentenceOpen && (<>
            <div className="nx-dg-label">Direction</div>
            <div className="nx-dg-seg" role="radiogroup" aria-label="Direction">
              {DIRS.map((d) => (
                <button key={d.key} type="button" role="radio" aria-checked={dir === d.key} onClick={() => setDir(d.key)}>{d.label}</button>
              ))}
            </div>
          </>)}
        </div>
        <div className="nx-dg-preview nx-fill">
          {loading ? <div className="nx-dg-empty">Loading...</div>
            : empty ? <div className="nx-dg-empty">{empty}</div>
              : <Preview placed={placed} routes={routes} />}
        </div>
      </div>
    </Modal>
  );
}
