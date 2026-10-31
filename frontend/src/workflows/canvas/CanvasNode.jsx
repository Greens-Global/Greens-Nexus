// One block on the sheet (Blueprint, 10/30/2026): the trigger, the Only If
// gate, a step, the fault-lane header, a join dot or a ghost drop slot.
// Every block still speaks its sentence (lib/text.js) - the canvas is the
// recipe laid out, not a different workflow.
import { moduleLabel } from '../lib/modules';
import { CANVAS_ICONS, KIND_LABEL, nodeColor, nodeModule } from './palette';
import { nodeWords } from './words';

const at = (n) => ({ transform: `translate(${n.x}px, ${n.y}px)` });

export default function CanvasNode({ node, catalog, entityDef, selected, blank, listening, replayClass, armed = false, onPointerDown, onSelect, nodeRef }) {
  if (node.kind === 'join') {
    return <div ref={nodeRef} className={`wfc-join${replayClass ? ` ${replayClass}` : ''}`} data-id={node.id} style={{ ...at(node), width: node.w, height: node.h }} aria-hidden="true" />;
  }
  if (node.kind === 'ghost') {
    return (
      <button type="button" ref={nodeRef} className={`wfc-ghost${armed ? ' is-armed' : ''}`} data-id={node.id} data-insert-path={node.path.join('.')} data-insert-index={node.index}
        style={at(node)} onClick={() => onSelect && onSelect(node.id)} aria-label="Add a step here">
        Drop a step here
      </button>
    );
  }
  const Icon = CANVAS_ICONS[node.kind] || CANVAS_ICONS.action;
  const words = nodeWords(node, catalog, entityDef);
  const kind = KIND_LABEL[node.kind] || node.kind;
  const mod = node.kind === 'action' || node.kind === 'trigger' ? nodeModule(node, catalog) : '';
  const skipped = !!node.step && node.step.enabled === false;
  const cls = ['wfc-node', `k-${node.kind}`, selected ? 'is-selected' : '', skipped ? 'is-skipped' : '', listening ? 'is-listening' : '', replayClass || ''].filter(Boolean).join(' ');
  const interactive = node.kind !== 'fault';
  return (
    <div ref={nodeRef} className={cls} data-id={node.id} data-blank={blank ? 'true' : undefined} style={at(node)}
      role={interactive ? 'button' : undefined} tabIndex={interactive ? 0 : -1} aria-label={`${kind}: ${words}`} aria-pressed={interactive ? !!selected : undefined}
      onPointerDown={interactive ? (e) => onPointerDown && onPointerDown(e, node) : undefined}
      onKeyDown={interactive ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect && onSelect(node.id); } } : undefined}>
      <span className="wfc-ic" style={{ background: nodeColor(node, catalog) }} aria-hidden="true"><Icon /></span>
      <span className="wfc-tx">
        <span className="wfc-kind">{kind}{mod ? <><i /> {moduleLabel(mod)}</> : null}</span>
        <span className="wfc-title">{node.step?.label ? `${node.step.label}: ` : ''}{words}</span>
      </span>
      <span className="wfc-dot" aria-hidden="true" />
    </div>
  );
}
