// Item Management - The checkout stage tracker.
// Moved out of views/InventoryManagement.jsx unchanged (items split, Nov 2 2026).
import React from 'react';

// ── Stage Tracker ─────────────────────────────────────────────────────────────
const STAGES = [
  { key:'pending',         label:'Requested'   },
  { key:'approved',        label:'Approved'    },
  { key:'pending_receipt', label:'Handed over' },
  { key:'allocated',       label:'In use'      },
  { key:'returned',        label:'Returned'    },
];
export function StageTracker({ checkout }) {
  const ORDER = ['pending','approved','pending_receipt','allocated','returned'];
  // Treat 'allocated' reached directly (no pending_receipt) as if pending_receipt was passed
  let status = checkout.status;
  if (status === 'allocated' && !checkout.handedOverAt && checkout.handoverPhotoBy !== 'employee') {
    // allocator-direct path: skip the pending_receipt dot visually by treating it as done
  }
  const idx = ORDER.indexOf(status);
  const isRejected  = checkout.status === 'rejected';
  const isCancelled = checkout.status === 'cancelled';

  if (isRejected || isCancelled) return (
    <div style={{ marginTop:8, fontSize:12, color:'hsl(var(--color-red))', background:'hsla(var(--color-red),0.08)', borderRadius:6, padding:'4px 10px', display:'inline-block' }}>
      {isRejected ? `Rejected${checkout.rejectReason ? ` - "${checkout.rejectReason}"` : ''}` : 'Cancelled'}
    </div>
  );

  return (
    <div style={{ display:'flex', alignItems:'center', margin:'10px 0 6px' }}>
      {STAGES.map((stage, i) => {
        const done    = i < idx;
        const current = i === idx;
        return (
          <React.Fragment key={stage.key}>
            <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:3 }}>
              <div style={{ width:10, height:10, borderRadius:'50%', transition:'background 0.2s',
                background: done ? 'hsl(var(--color-green))' : current ? 'hsl(var(--color-blue))' : 'var(--line)',
                outline: current ? '2px solid hsla(var(--color-blue),0.3)' : 'none', outlineOffset:2 }} />
              <span style={{ fontSize:9.5, fontWeight: current ? 700 : 400, whiteSpace:'nowrap',
                color: done ? 'hsl(var(--color-green))' : current ? 'hsl(var(--color-blue))' : 'var(--muted)' }}>
                {stage.label}
              </span>
            </div>
            {i < STAGES.length - 1 && (
              <div style={{ flex:1, height:2, marginBottom:13, marginLeft:4, marginRight:4, transition:'background 0.2s',
                background: done ? 'hsl(var(--color-green))' : 'var(--line)' }} />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}
