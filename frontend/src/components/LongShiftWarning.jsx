// The AM / PM warning shown inside a punch form before it saves (Charmi,
// Oct 21 2026 - SwipeClock's "Is it possible that AM/PM have been
// mis-entered?"). lib/longShift.js decides; this only shows it.
//   Fix Time      - the default: back to the time field.
//   Use 9:40 AM   - the AM / PM flip, when it makes a sane shift.
//   Save Anyway   - managers / HR only (a real double shift).
//   Keep and Explain - employees: sent with their reason, flagged for the approver.
import { AlertTriangle } from 'lucide-react';

const btn = { fontSize: 12, padding: '5px 12px', display: 'inline-flex', alignItems: 'center', gap: 5 };

export default function LongShiftWarning({ issue, manager = false, onFix, onUseSuggestion, onConfirm, busy = false, compact = false }) {
  if (!issue) return null;
  return (
    <div role="alert" data-testid="long-shift-warning"
      style={{ marginTop: compact ? 6 : 12, padding: compact ? '8px 10px' : '10px 12px', borderRadius: 10, background: 'rgba(180,83,9,0.09)',
        border: '1px solid rgba(180,83,9,0.3)', color: '#92400e', fontSize: compact ? 11.5 : 12.5, lineHeight: 1.5,
        maxWidth: compact ? 340 : undefined, whiteSpace: 'normal', textAlign: 'left' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <AlertTriangle size={compact ? 13 : 15} style={{ flexShrink: 0, marginTop: 2 }} />
        <span style={{ fontWeight: 600 }}>{issue.message}</span>
      </div>
      {!manager && (
        <div style={{ marginTop: 4, marginLeft: compact ? 21 : 23, fontSize: compact ? 11 : 11.5 }}>
          If the times are right, keep them and say why in the reason - your approver sees it.
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8, marginLeft: compact ? 21 : 23 }}>
        <button type="button" className="primary-btn" autoFocus onClick={onFix} disabled={busy} style={btn}>Fix Time</button>
        {issue.suggest && onUseSuggestion && (
          <button type="button" className="secondary-btn" onClick={() => onUseSuggestion(issue)} disabled={busy} style={btn}>
            Use {issue.suggestText}
          </button>
        )}
        <button type="button" className="secondary-btn" onClick={onConfirm} disabled={busy} style={{ ...btn, color: '#92400e' }}>
          {manager ? 'Save Anyway' : 'Keep and Explain'}
        </button>
      </div>
    </div>
  );
}
