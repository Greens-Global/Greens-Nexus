// The small repeated pieces: type and status chips, avatars, a verified
// chip, a section header. Soft labels (dot + tint), never solid fills.
import { ShieldCheck } from 'lucide-react';
import { typeMeta, statusMeta, trainingColor, initials, colorFor, fmtDate } from '../lib';

export function Chip({ color = '#64748b', children, plain = false, title, style }) {
  return <span className={`kb-chip${plain ? ' plain' : ''}`} style={{ '--c': color, ...style }} title={title}>{children}</span>;
}

export function TypeChip({ type }) {
  const m = typeMeta(type);
  return <Chip color={m.color}>{m.label}</Chip>;
}

export function StatusChip({ status }) {
  const m = statusMeta(status);
  return <Chip color={m.color}>{m.label}</Chip>;
}

export function TrainingChip({ status }) {
  return <Chip color={trainingColor(status)}>{status}</Chip>;
}

export function VerifiedChip({ page }) {
  if (!page?.verified_at || page.status !== 'approved') return null;
  if (page.stale) return <Chip color="#dc2626" title={`Review was due ${fmtDate(page.next_review)}`}>Needs Review</Chip>;
  return <Chip color="#1e7b4e" title={page.verified_by ? `Verified by ${page.verified_by}` : ''}><ShieldCheck size={12} style={{ marginLeft: -2 }} />Verified {fmtDate(page.verified_at)}</Chip>;
}

export function Av({ name, email, size = 28, color }) {
  const bg = color || colorFor(email || name || '');
  return <span className={`kb-av${size <= 24 ? ' sm' : ''}`} style={{ background: bg, width: size, height: size, fontSize: size <= 24 ? 10 : 11 }} title={name || email}>{initials(name || email)}</span>;
}

export function SectionHead({ title, sub, right, count }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
      <h3 className="kb-h2" style={{ fontSize: 16 }}>{title}</h3>
      {count > 0 && <Chip color="#dc2626">{count}</Chip>}
      {sub && <span className="kb-sub" style={{ margin: 0 }}>{sub}</span>}
      {right && <span style={{ marginLeft: 'auto' }}>{right}</span>}
    </div>
  );
}

export function Stat({ value, label, color }) {
  return <div className="kb-stat"><b style={{ color }}>{value}</b><span>{label}</span></div>;
}

export function Banner({ kind = 'amber', icon: Icon, children, action }) {
  return (
    <div className={`kb-banner ${kind}`}>
      {Icon && <Icon />}
      <div className="kb-grow">{children}</div>
      {action}
    </div>
  );
}
