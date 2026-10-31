// The Blueprint canvas (Neil, 10/30/2026): the builder's graph-paper view
// of a workflow. Left the dock of blocks, middle the sheet (pan, zoom,
// minimap), right the side panel. The sheet is `layout(definition)` drawn
// as divs for blocks and one SVG for the ink; nothing about the canvas is
// stored. Edits (a dropped block, a moved step, a change in the panel) come
// back as a whole new definition through onChange, built with the same
// helpers the recipe uses. Motion: blocks rise in on open, slide to their
// new place after an edit (FLIP), connectors draw and morph; all of it off
// under reduced motion and in tests.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Plus } from 'lucide-react';
import { useReducedMotion } from '../../lib/motion';
import { STEP_KINDS } from '../lib/definition';
import { isBlankStep } from '../lib/blanks';
import { bezierPoint, layout as layoutDefinition } from './layout';
import { gridStyle } from './viewport';
import { useCanvasView } from './useCanvasView';
import { useDragDrop } from './useDragDrop';
import { useReplay } from './useReplay';
import { canMove as canMoveStep, insertKind, moveBetween } from './edits';
import CanvasNode from './CanvasNode';
import Minimap from './Minimap';
import Dock from './Dock';
import Inspector from './Inspector';
import { CANVAS_ICONS, KIND_COLOR, MODULE_COLOR } from './palette';
import './canvas.css';

const TEST = import.meta.env.MODE === 'test';
const EASE = 'cubic-bezier(.16,1,.3,1)';
const SPRING = 'cubic-bezier(.34,1.4,.64,1)';
const edgeKey = (e) => `${e.from}>${e.to}`;

export default function Canvas({
  definition, catalog, ctx, skin = 'paper', onSkin, selectedId = null, onSelect, onChange, canEdit = true,
  workflowStatus = 'draft', blanks = [], replay = null, onReplayDone = null, panel = null, overlay = null, people = [], isNew, entityDef, eventDef, initialView = null,
}) {
  const sheetRef = useRef(null);
  const worldRef = useRef(null);
  const ghostRef = useRef(null);
  const nodeEls = useRef(new Map());
  const reduced = useReducedMotion();
  const animate = !TEST && !reduced;

  // A layout that throws (a definition shape this engine does not know)
  // never blanks the screen: the sheet says so and Recipe still works.
  const { L, layoutError } = useMemo(() => {
    try { return { L: layoutDefinition(definition), layoutError: null }; } catch (e) { return { L: null, layoutError: e }; }
  }, [definition]);
  const layoutRef = useRef(L);
  useLayoutEffect(() => { layoutRef.current = L; }, [L]);

  const { view, viewRef, fit, zoomIn, zoomOut, startPan, panning, box } = useCanvasView(sheetRef, L, initialView);

  // ── edits ──
  const firstAction = useMemo(() => (catalog?.actions || [])[0] || null, [catalog]);
  const insert = useCallback((kind, to) => { if (canEdit) onChange(insertKind(definition, kind, to, kind === 'action' ? null : firstAction)); }, [canEdit, definition, onChange, firstAction]);
  const move = useCallback((from, to) => { if (canEdit) onChange(moveBetween(definition, from, to)); }, [canEdit, definition, onChange]);
  const canMove = useCallback((from, to) => canEdit && canMoveStep(definition, from, to), [canEdit, definition]);
  const append = useCallback((kind) => insert(kind, { path: ['steps'], index: (definition?.steps || []).length }), [insert, definition]);
  const select = useCallback((id) => { if (onSelect) onSelect(id); }, [onSelect]);

  const { nodePointerDown, palettePointerDown, armed, ghostKind, dragging } = useDragDrop({
    sheetRef, viewRef, layoutRef, nodeEls, ghostRef, onInsert: insert, onMove: move, canMove, onTap: append, onNodeClick: select, enabled: true, animate,
  });

  // A click on the paper (not a drag) clears the selection.
  const press = useRef(null);
  const onSheetPointerDown = (e) => {
    if (e.target.closest('.wfc-node, .wfc-ghost, .wfc-hotspot, .wfc-chrome, .wfc-corner, .wfc-overlay, .wfc-replaybar')) return;
    press.current = { x: e.clientX, y: e.clientY };
    startPan(e);
  };
  const onSheetClick = (e) => {
    const p = press.current; press.current = null;
    if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) < 5 && !e.target.closest('.wfc-node, .wfc-ghost, .wfc-hotspot, .wfc-chrome, .wfc-corner, .wfc-overlay, .wfc-replaybar')) select(null);
  };

  // ── motion: rise in once, FLIP after every relayout ──
  const prevPos = useRef(null);
  const prevD = useRef(null);
  useLayoutEffect(() => {
    if (!L) return;
    const first = prevPos.current === null;
    const pos = new Map(); L.nodes.forEach((n) => pos.set(n.id, { x: n.x, y: n.y }));
    const ds = new Map(); L.edges.forEach((e) => ds.set(edgeKey(e), e.d));
    if (animate && worldRef.current) {
      let i = 0;
      L.nodes.forEach((n) => {
        const el = nodeEls.current.get(n.id); if (!el || typeof el.animate !== 'function') return;
        const was = prevPos.current && prevPos.current.get(n.id);
        try {
          if (was && (was.x !== n.x || was.y !== n.y)) el.animate([{ transform: `translate(${was.x}px, ${was.y}px)` }, { transform: `translate(${n.x}px, ${n.y}px)` }], { duration: 380, easing: SPRING });
          else if (!was) el.animate([{ opacity: 0, transform: `translate(${n.x}px, ${n.y + 12}px)` }, { opacity: 1, transform: `translate(${n.x}px, ${n.y}px)` }], { duration: 260, delay: first ? (i++) * 30 : 0, easing: EASE, fill: 'backwards' });
        } catch { /* a browser without WAAPI simply shows the new place */ }
      });
      let j = 0;
      worldRef.current.querySelectorAll('path.wfc-edge').forEach((p) => {
        const key = p.dataset.key; const old = prevD.current && prevD.current.get(key); const now = p.getAttribute('d');
        if (typeof p.animate !== 'function') return;
        try {
          if (old && old !== now) p.animate([{ d: `path("${old}")` }, { d: `path("${now}")` }], { duration: 380, easing: SPRING });
          else if (!old && typeof p.getTotalLength === 'function') {
            const len = p.getTotalLength();
            p.animate([{ strokeDasharray: len, strokeDashoffset: len }, { strokeDasharray: len, strokeDashoffset: 0 }], { duration: 420, delay: first ? 200 + (j++) * 40 : 60, easing: EASE, fill: 'backwards' });
          }
        } catch { /* no draw-in, the ink is simply there */ }
      });
    }
    prevPos.current = pos; prevD.current = ds;
  }, [L, animate]);

  // ── replay: useReplay tells the run's story one block at a time (all at
  // once under reduced motion and in tests); the sheet just wears the classes ──
  const rp = useReplay(replay, { reduced: reduced || TEST, onDone: onReplayDone });

  // ── keyboard: Escape clears the selection from the sheet too ──
  useEffect(() => {
    if (!selectedId) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') select(null); };
    const el = sheetRef.current; if (!el) return undefined;
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [selectedId, select]);

  const setNodeRef = (id) => (el) => { if (el) nodeEls.current.set(id, el); else nodeEls.current.delete(id); };
  const GhostIcon = ghostKind ? CANVAS_ICONS[ghostKind] : null;
  const armedPath = armed && L ? (L.hots.find((h) => h.id === armed)?.insert.path.join('.') || '') : '';

  if (layoutError) {
    return (
      <div className="wfc" data-skin={skin} role="alert" style={{ display: 'grid', placeItems: 'center', minHeight: 240, height: 'auto', padding: 24, textAlign: 'center' }}>
        <div>This workflow could not be drawn as a canvas. Switch to Recipe to keep editing it.<br /><span style={{ fontSize: 12.5, color: 'var(--cv-muted)' }}>{String(layoutError.message || layoutError)}</span></div>
      </div>
    );
  }

  return (
    <div className="wfc" data-skin={skin} data-testid="wfc">
      <Dock canEdit={canEdit} onPaletteDown={palettePointerDown} />
      <div ref={sheetRef} className={`wfc-sheet${panning ? ' is-panning' : ''}${dragging ? ' is-dragging' : ''}`} data-testid="wfc-sheet" tabIndex={-1}
        style={gridStyle(view)} onPointerDown={onSheetPointerDown} onClick={onSheetClick} aria-label="Workflow canvas">
        <div className="wfc-aurora" aria-hidden="true" />
        <div ref={worldRef} className="wfc-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})` }}>
          {L && (
            <svg width={L.w} height={L.h} aria-hidden="true">
              <defs>
                <marker id="wfc-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M 1 1 L 9 5 L 1 9" fill="none" stroke="context-stroke" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </marker>
              </defs>
              {L.frames.map((f) => (
                <g key={f.id}>
                  <rect className="wfc-frame" x={f.x} y={f.y} width={f.w} height={f.h} rx="16" />
                  <text className="wfc-frame-lbl" x={f.x + 14} y={f.y - 6}>{f.label}</text>
                </g>
              ))}
              {L.edges.map((e) => {
                const key = edgeKey(e);
                const toEnd = e.to === 'tail' || e.to === 'fault-tail' || e.to.startsWith('frame-');
                const cls = ['wfc-edge', e.dashed ? 'is-dashed' : '', armed === `h-${e.id}` ? 'wfc-hot' : '', rp.edgeClass(`wfc-${e.id}`, e.from, e.to)].filter(Boolean).join(' ');
                const lbl = e.label ? bezierPoint(e.a, e.b, 0.36) : null;
                const lw = e.label ? e.label.length * 6.6 + 14 : 0;
                return (
                  <g key={key}>
                    <path id={`wfc-${e.id}`} data-key={key} className={cls} d={e.d} markerEnd={toEnd ? undefined : 'url(#wfc-arrow)'} />
                    {lbl && <rect className="wfc-edge-label-bg" x={lbl.x - lw / 2} y={lbl.y - 9} width={lw} height={18} rx="9" />}
                    {lbl && <text className="wfc-edge-label" x={lbl.x} y={lbl.y + 3.5} textAnchor="middle">{e.label}</text>}
                  </g>
                );
              })}
            </svg>
          )}
          {L && L.nodes.map((n) => (
            <CanvasNode key={n.id} node={n} catalog={catalog} entityDef={entityDef} nodeRef={setNodeRef(n.id)}
              selected={selectedId === n.id}
              blank={n.step && n.path && n.path.length === 1 && isBlankStep(blanks, n.index, n.step.id)}
              listening={n.kind === 'trigger' && workflowStatus === 'active'}
              replayClass={rp.nodeClass(n.id)} armed={n.kind === 'ghost' && !!armedPath && armedPath === n.path.join('.')}
              onPointerDown={nodePointerDown}
              onSelect={n.kind === 'ghost' ? () => insert('action', { path: n.path, index: n.index }) : select} />
          ))}
          {L && canEdit && L.hots.map((h) => (
            <button key={h.id} type="button" className={`wfc-hotspot${armed === h.id ? ' is-armed' : ''}`} data-hot={h.id}
              data-insert-path={h.insert.path.join('.')} data-insert-index={h.insert.index}
              style={{ left: h.x, top: h.y }} aria-label="Insert a step here" title="Insert a step here"
              onPointerDown={(e) => e.stopPropagation()} onClick={() => insert('action', h.insert)}>
              <Plus size={12} />
            </button>
          ))}
        </div>
        <div className="wfc-vignette" aria-hidden="true" />
        {overlay && <div className="wfc-overlay">{overlay}</div>}
        {replay && (
          <div className="wfc-replaybar" role="status">
            <span>{replay.label || 'Replaying the run'}{replay.note ? ` · ${replay.note}` : ''}</span>
            <button type="button" className="wfc-replaystop" onClick={() => { rp.stop(); onReplayDone?.({ stoppedAt: null, failed: false }); }}>Stop</button>
          </div>
        )}
        {onSkin && (
          <div className="wfc-chrome wfc-skin" role="group" aria-label="Canvas skin">
            <button type="button" aria-pressed={skin === 'paper'} onClick={() => onSkin('paper')}>Paper</button>
            <button type="button" aria-pressed={skin === 'night'} onClick={() => onSkin('night')}>Night</button>
          </div>
        )}
        <div className="wfc-corner">
          <Minimap layout={L} catalog={catalog} view={view} box={box} />
          <div className="wfc-chrome wfc-zoom" role="group" aria-label="Zoom">
            <button type="button" onClick={zoomOut} aria-label="Zoom Out">−</button>
            <span className="wfc-pct" aria-live="polite">{Math.round(view.s * 100)}%</span>
            <button type="button" onClick={zoomIn} aria-label="Zoom In">+</button>
            <button type="button" className="wfc-fit" onClick={fit} aria-label="Fit To View">Fit</button>
          </div>
        </div>
      </div>
      <Inspector definition={definition} catalog={catalog} ctx={ctx} selectedId={selectedId} nodes={L ? L.nodes : []} onChange={onChange} onSelect={select}
        canEdit={canEdit} people={people} isNew={isNew} entityDef={entityDef} eventDef={eventDef} panel={panel} />
      {ghostKind && GhostIcon && (
        <div ref={ghostRef} className="wfc-block wfc-ghost-block" aria-hidden="true">
          <span className="wfc-ic" style={{ background: KIND_COLOR[ghostKind] || MODULE_COLOR.tasks }}><GhostIcon /></span>{STEP_KINDS[ghostKind]?.label}
        </div>
      )}
    </div>
  );
}
