import { NX, FONT } from '../tasks/theme';

// "Create a Ticket" | "Batch Create" (Neil, Oct 13 2026: Property Walkthrough
// folded into Submit a Ticket as a second tab, and named for what it does -
// a batch can be IT, maintenance, anything, not only a property). Sits in the
// title of both forms, so switching reads as one dialog with two tabs. Only
// shown to people who may batch-file (/ticket-properties canWalkthrough).
const MODES = [['single', 'Create a Ticket'], ['batch', 'Batch Create']];

export default function CreateModeTabs({ active, onChange }) {
  return (
    <div role="tablist" aria-label="How to create tickets" className="scroll-tabs"
      style={{ display: 'inline-flex', gap: 2, background: NX.border2, borderRadius: 9, padding: 2, fontFamily: FONT }}>
      {MODES.map(([key, label]) => {
        const on = active === key;
        return (
          <button key={key} type="button" role="tab" aria-selected={on} onClick={() => { if (!on) onChange(key); }}
            style={{
              border: 'none', cursor: on ? 'default' : 'pointer', fontFamily: FONT, fontSize: 13.5, fontWeight: 700,
              padding: '6px 12px', borderRadius: 7, whiteSpace: 'nowrap',
              background: on ? NX.surface : 'transparent', color: on ? NX.ink : NX.dim,
              boxShadow: on ? '0 1px 2px rgba(0,0,0,0.08)' : 'none',
            }}>
            {label}
          </button>
        );
      })}
    </div>
  );
}
