import { ArrowDownRight, ArrowUpRight, ExternalLink, Info } from 'lucide-react';
import { SkeletonBlocks } from '../../AsyncState';
import { pct } from '../../../accounting/dashboard/model/money';

// Small pieces every dashboard tab shares, in the Nexus idiom: inline styles
// on the app's CSS variables, Inter, the same card and pill shapes the rest
// of the Accounting screen uses.

export const OK = 'var(--ok-fg, #15803d)';
export const BAD = 'var(--bad-fg, #dc2626)';
export const WARN = '#b45309';
export const BRAND = 'var(--wk-brand, #2b45e1)';
export const toneColor = (good) => (good ? OK : BAD);

export const card = { backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, boxShadow: 'var(--shadow-sm)' };
export const input = { padding: '6px 8px', borderRadius: 8, border: '1px solid var(--border-color)', fontSize: '0.8rem', fontFamily: 'inherit', background: 'var(--bg-card)', color: 'var(--text-primary)' };
export const pill = (active) => ({
  padding: '6px 12px', borderRadius: 999, fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
  border: `1px solid ${active ? BRAND : 'var(--border-color)'}`,
  background: active ? 'var(--wk-brand-tint, #e8ecfd)' : 'var(--bg-card)',
  color: active ? BRAND : 'var(--text-secondary)',
});

const CHIP = {
  ok: { background: 'rgba(21,128,61,0.12)', color: OK, border: '1px solid transparent' },
  bad: { background: 'rgba(220,38,38,0.1)', color: BAD, border: '1px solid transparent' },
  wait: { background: 'rgba(180,83,9,0.12)', color: WARN, border: '1px solid transparent' },
  fyi: { background: 'transparent', color: 'var(--text-muted)', border: '1px dashed var(--border-color)' },
  neutral: { background: 'var(--bg-secondary)', color: 'var(--text-secondary)', border: '1px solid transparent' },
};

export function Chip({ tone = 'neutral', children, title, style }) {
  return (
    <span title={title} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, height: 20, padding: '0 8px', borderRadius: 999, fontSize: '0.68rem', fontWeight: 700, whiteSpace: 'nowrap', ...CHIP[tone], ...style }}>
      {children}
    </span>
  );
}

/** Signed % change pill. `goodUp=false` for costs: a rise is bad. */
export function Delta({ v, goodUp = true, suffix, style }) {
  if (v == null || !Number.isFinite(v)) return null;
  const up = v >= 0;
  const good = goodUp ? up : !up;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, fontSize: '0.72rem', fontWeight: 700, color: toneColor(good), fontVariantNumeric: 'tabular-nums', ...style }}>
      {up ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
      {pct(v)}
      {suffix ? <span style={{ fontWeight: 500, color: 'var(--text-muted)' }}>&nbsp;{suffix}</span> : null}
    </span>
  );
}

export function Eyebrow({ children, style }) {
  return <div style={{ fontSize: '0.66rem', fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--text-muted)', ...style }}>{children}</div>;
}

/** The framed card every widget and page panel renders inside. */
export function Panel({ title, sub, right, children, style, bodyStyle, flash, onOpenReport, reportLabel = 'Open report' }) {
  return (
    <div style={{ ...card, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden', outline: flash ? `2px solid ${BRAND}` : 'none', ...style }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, padding: '12px 16px', borderBottom: '1px solid var(--border-color)' }}>
        <div style={{ minWidth: 0 }}>
          <h3 style={{ margin: 0, fontSize: '0.86rem', fontWeight: 700, lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</h3>
          {sub ? <div style={{ marginTop: 2, fontSize: '0.74rem', color: 'var(--text-muted)' }}>{sub}</div> : null}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {right}
          {onOpenReport ? (
            <button type="button" onClick={onOpenReport} style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '0.72rem', fontWeight: 600, color: BRAND, fontFamily: 'inherit' }}>
              {reportLabel} <ExternalLink size={12} />
            </button>
          ) : null}
        </div>
      </div>
      <div style={{ flex: 1, padding: 16, ...bodyStyle }}>{children}</div>
    </div>
  );
}

export function EmptyBox({ title, body, style }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4, minHeight: 96, height: '100%', padding: '24px 16px', textAlign: 'center', border: '1px dashed var(--border-color)', borderRadius: 10, ...style }}>
      <Info size={16} style={{ color: 'var(--text-muted)' }} />
      <div style={{ fontSize: '0.86rem', fontWeight: 600 }}>{title}</div>
      {body ? <div style={{ maxWidth: 360, fontSize: '0.76rem', color: 'var(--text-muted)' }}>{body}</div> : null}
    </div>
  );
}

export function LoadingBox({ height = 120 }) {
  return <SkeletonBlocks count={1} height={height} borderRadius={10} />;
}

/** Stacked horizontal meter. Segments are shares 0..1 with a color. */
export function Meter({ segments, height = 8, style }) {
  return (
    <div aria-hidden style={{ display: 'flex', height, width: '100%', overflow: 'hidden', borderRadius: 999, background: 'var(--bg-secondary)', ...style }}>
      {segments.map((s, i) => (
        <div key={i} title={s.title} style={{ height: '100%', width: `${Math.max(0, Math.min(100, s.share * 100))}%`, background: s.color ?? seriesColor(i) }} />
      ))}
    </div>
  );
}

/** Big-number tile for the tab headers (Cash, Performance, Close). */
export function Tile({ label, value, sub, subColor, style }) {
  return (
    <div style={{ ...card, padding: '12px 14px', ...style }}>
      <Eyebrow>{label}</Eyebrow>
      <div style={{ marginTop: 4, fontSize: '1.25rem', fontWeight: 700, lineHeight: 1.15, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {sub ? <div style={{ marginTop: 4, fontSize: '0.74rem', color: subColor ?? 'var(--text-muted)' }}>{sub}</div> : null}
    </div>
  );
}

export function Footnote({ children, style }) {
  return <p style={{ margin: '12px 0 0', fontSize: '0.7rem', lineHeight: 1.4, color: 'var(--text-muted)', ...style }}>{children}</p>;
}

export function Dot({ color }) {
  return <span aria-hidden style={{ display: 'inline-block', width: 10, height: 10, flexShrink: 0, borderRadius: 3, background: color }} />;
}

/** In-page section switcher: one section at a time, no scrolling between them. */
export function SectionTabs({ tabs, value, onChange, style }) {
  return (
    <div role="tablist" aria-label="Section" className="scroll-tabs" style={{ display: 'flex', gap: 6, ...style }}>
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={t.id === value} onClick={() => onChange(t.id)} style={pill(t.id === value)}>
          {t.label}{t.badge != null ? <span style={{ marginLeft: 6, fontWeight: 500, opacity: 0.8 }}>{t.badge}</span> : null}
        </button>
      ))}
    </div>
  );
}

/** Row group heading inside a req-table. */
export function GroupRow({ title, cols }) {
  return (
    <tr style={{ background: 'var(--bg-secondary)' }}>
      <td colSpan={cols} style={{ padding: '6px 10px', fontSize: '0.66rem', fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>{title}</td>
    </tr>
  );
}

export const SERIES = [BRAND, '#0998c3', '#d97706', '#dc2626', '#15803d', '#7b4ea0', '#6b8fd6', '#8a9a9f'];
export const seriesColor = (i) => SERIES[i % SERIES.length];
export const num = { textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
export const mono = { fontFamily: 'monospace', fontSize: '0.74rem', color: 'var(--text-muted)', marginRight: 6 };
