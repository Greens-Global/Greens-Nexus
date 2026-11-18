import { AlertTriangle } from 'lucide-react';

// The warning icon that goes with the house warning color (`--warn-fg`): a
// warning is never color alone (11/11/2026 Accounting pass, picture 8).
export function WarnMark({ size = 13 }) {
  return <AlertTriangle size={size} aria-hidden="true" style={{ flexShrink: 0, verticalAlign: -2, marginRight: 5 }} />;
}
