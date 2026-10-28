// Add Step (Oct 2026): the flow steps first (If / Else, Ask For Approval,
// Wait, For Each, Stop), then every action the catalog serves, grouped by
// module, searchable, with a New badge on what was added since the person
// last opened Workflows. Picking one hands a fresh step to `onAdd`.
import { useRef, useState } from 'react';
import { ListChecks, Plus, Search, Zap } from 'lucide-react';
import { useClickOutside } from '../../tasks/components';
import { newStep } from '../lib/definition';
import { STEP_ICONS, chip, groupBy, hint, moduleLabel, textInput } from '../lib/text.builder-helpers';

const FLOW = [
  { kind: 'if', label: 'If / Else', hint: 'Branch on a condition' },
  { kind: 'approval', label: 'Ask For Approval', hint: 'Wait for a decision' },
  { kind: 'wait', label: 'Wait', hint: 'A duration, a date or the next morning' },
  { kind: 'for_each', label: 'For Each', hint: 'Repeat steps for every item in a list' },
  { kind: 'stop', label: 'Stop', hint: 'End the run here' },
];

export default function AddStepMenu({ catalog, isNew, onAdd, label = 'Add Step', compact = false }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const btnRef = useRef(null);
  const menuRef = useRef(null);
  useClickOutside([btnRef, menuRef], () => setOpen(false), open);
  const actions = catalog?.actions || [];
  const query = q.trim().toLowerCase();
  const flow = query ? FLOW.filter((f) => `${f.label} ${f.hint}`.toLowerCase().includes(query)) : FLOW;
  const shown = query ? actions.filter((a) => `${a.label} ${a.module} ${a.key}`.toLowerCase().includes(query)) : actions;
  const add = (kind, actionDef) => { onAdd(newStep(kind, actionDef)); setOpen(false); setQ(''); };
  const row = { display: 'flex', width: '100%', justifyContent: 'space-between', alignItems: 'center', gap: 8, border: 'none', background: 'transparent', padding: '7px 10px', borderRadius: 8, cursor: 'pointer', fontSize: 13, color: 'var(--nx-ink)', textAlign: 'left', fontFamily: 'inherit' };

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button ref={btnRef} type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} style={{
        ...chip, cursor: 'pointer', fontWeight: 600, ...(compact ? { fontSize: 12 } : { padding: '6px 12px', fontSize: 13 }),
        borderStyle: 'dashed',
      }}><Plus size={13} /> {label}</button>
      {open && (
        <div ref={menuRef} role="menu" aria-label="Add a step" style={{
          position: 'absolute', top: '100%', left: 0, zIndex: 60, marginTop: 4, width: 'min(380px, 92vw)',
          background: 'var(--nx-surface)', border: '1px solid var(--nx-border)', borderRadius: 12,
          boxShadow: '0 16px 40px rgba(17,24,39,0.18)', padding: 10, display: 'flex', flexDirection: 'column', gap: 8,
        }}>
          <div style={{ position: 'relative' }}>
            <Search size={14} style={{ position: 'absolute', left: 9, top: 9, color: 'var(--nx-faint)' }} />
            <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search steps" aria-label="Search steps" autoFocus style={{ ...textInput, paddingLeft: 28 }} />
          </div>
          <div style={{ maxHeight: 320, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
            {!!flow.length && <div style={{ ...hint, fontWeight: 700, padding: '6px 6px 2px' }}>Flow</div>}
            {flow.map((f) => {
              const Icon = STEP_ICONS[f.kind] || ListChecks;
              return (
                <button key={f.kind} type="button" role="menuitem" onClick={() => add(f.kind)} style={row}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Icon size={14} style={{ color: 'var(--nx-dim)' }} />{f.label}</span>
                  <span style={{ ...hint, fontSize: 11.5 }}>{f.hint}</span>
                </button>
              );
            })}
            {groupBy(shown, (a) => a.module).map(([module, items]) => (
              <div key={module}>
                <div style={{ ...hint, fontWeight: 700, padding: '6px 6px 2px' }}>{moduleLabel(module)}</div>
                {items.map((a) => (
                  <button key={a.key} type="button" role="menuitem" onClick={() => add('action', a)} style={row}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Zap size={14} style={{ color: 'var(--nx-dim)' }} />{a.label}</span>
                    <span style={{ display: 'inline-flex', gap: 4 }}>
                      {a.adminOnly && <span style={{ ...chip, fontSize: 10.5, padding: '1px 6px' }}>Global Admins</span>}
                      {isNew?.(a.key) && <span style={{ ...chip, fontSize: 10.5, padding: '1px 6px', color: 'var(--nx-primary)', borderColor: 'var(--nx-primary)' }}>New</span>}
                    </span>
                  </button>
                ))}
              </div>
            ))}
            {!flow.length && !shown.length && <div style={{ ...hint, padding: 6 }}>No step matches.</div>}
          </div>
        </div>
      )}
    </div>
  );
}
