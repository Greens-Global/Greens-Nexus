// Time-off recommendation (Neil, 11/02/2026): a soft chip beside a pending
// request - "Recommended: Approve" or "Check First" - with the reasons as its
// title. It is a hint for the person deciding, never a decision: the Approve
// and Decline buttons beside it are exactly what they were. The same
// StatusLabel tones as every other list (never a solid fill). It takes the
// inbox row's `hint` ({ tone, text, reasons }) or the time-off serializer's
// `recommendation` ({ tone, label, reasons }).
import { StatusLabel } from './StatusLabel';

const TONE = { good: '#16a34a', check: '#d97706' };

export const recommendationText = (hint) => (hint && (hint.text || hint.label)) || '';
export const recommendationReasons = (hint) => (hint?.reasons || []).filter(Boolean).join(' ');

export function RecommendationChip({ hint, size = 'sm', className, style }) {
  const text = recommendationText(hint);
  if (!text) return null;
  return <StatusLabel label={text} color={TONE[hint.tone] || '#64748b'} size={size} title={recommendationReasons(hint) || undefined} className={className} style={style} />;
}
