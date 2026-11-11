// The Variables rail (Sagar, 11/04/2026: "whatever variable is used in that
// particular document it should be listed at right side so we can reuse the
// same variable wherever we want"), on demand since the redesign (Neil,
// 11/11/2026: "only show it when someone clicks on the variable icon or
// insert -> variable"). It floats over the desk's right margin like
// Comments, which it takes turns with.
//
// In This Document: every variable placed, in page order, with how many
// places it is used and - when the document can say - the value it prints.
// A click puts it at the cursor, a drag drops it where it lands, a
// double-click edits its field (templates), the arrow steps through the
// places it is used. Add More: the whole Variable Library.
import { useState } from 'react';
import { X, Search, Variable, CornerDownRight, GripVertical } from 'lucide-react';
import { VARIABLE_DRAG_TYPE } from '../../lib/mergeFieldTypes';

export default function VariablesPane({ tab = 'used', onTab, rows = [], kind = 'document', onInsert, onEdit, onGo, onClose, library }) {
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const shown = needle ? rows.filter((r) => `${r.label} ${r.token} ${r.value || ''}`.toLowerCase().includes(needle)) : rows;
  return (
    <div className="doc-varpane">
      <div className="doc-varpane-head">
        <Variable size={15} aria-hidden="true" />
        <span>Variables</span>
        <span className="doc-varpane-n">{rows.length}</span>
        <button type="button" className="doc-varpane-close" onClick={onClose} title="Close" aria-label="Close Variables"><X size={15} /></button>
      </div>
      <div className="doc-varpane-tabs" role="tablist" aria-label="Variables">
        <button type="button" role="tab" aria-selected={tab === 'used'} className={tab === 'used' ? 'is-on' : ''} onClick={() => onTab?.('used')}>In This Document</button>
        <button type="button" role="tab" aria-selected={tab === 'library'} className={tab === 'library' ? 'is-on' : ''} onClick={() => onTab?.('library')}>Add More</button>
      </div>
      {tab === 'used' ? (
        <section className="doc-varpane-body" role="complementary" aria-label="Variables used in this document">
          {rows.length > 5 && (
            <label className="doc-varpane-search">
              <Search size={13} aria-hidden="true" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter" aria-label="Filter the variables in this document" />
            </label>
          )}
          {rows.length === 0 ? (
            <p className="nx-docb-vars-empty">
              {kind === 'template'
                ? 'None yet. Select any text and click Make Variable, or add one from Add More.'
                : 'None yet. Add one from Add More, or drag one onto the page.'}
            </p>
          ) : shown.length === 0 ? (
            <p className="nx-docb-vars-empty">Nothing matches.</p>
          ) : shown.map((v) => (
            <div key={v.token} className="nx-docb-var-row">
              <button type="button" className="nx-docb-var" draggable
                title={`Insert {{${v.token}}} at the cursor${kind === 'template' ? '. Double-click to edit the field.' : ''}`}
                onClick={() => onInsert?.(v.token)}
                onDoubleClick={kind === 'template' ? () => onEdit?.(v.token) : undefined}
                onDragStart={(e) => {
                  e.dataTransfer.setData(VARIABLE_DRAG_TYPE, v.token);
                  e.dataTransfer.setData('text/plain', `{{${v.token}}}`);
                  e.dataTransfer.effectAllowed = 'copy';
                }}>
                <GripVertical size={13} className="nx-docb-var-grip" aria-hidden="true" />
                <span className="nx-docb-var-text">
                  <span className="nx-docb-var-label">{v.label}</span>
                  <span className="nx-docb-var-meta">{v.meta} · {v.count === 1 ? '1 place' : `${v.count} places`}</span>
                  {v.value ? <span className="nx-docb-var-value" title="What this document prints here">{v.value}</span> : null}
                </span>
              </button>
              <button type="button" className="nx-docb-var-go" title={`Go to the next place "${v.label}" is used`} aria-label={`Go to ${v.label}`} onClick={() => onGo?.(v.token)}>
                <CornerDownRight size={14} />
              </button>
            </div>
          ))}
        </section>
      ) : (
        <section className="doc-varpane-body is-library" aria-label="Variable library">{library}</section>
      )}
    </div>
  );
}
