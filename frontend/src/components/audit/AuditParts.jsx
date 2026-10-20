// Small building blocks the Audit Log feed and its detail drawer share:
// the person avatar, module badge, Act As badge, action icon, and the
// kind-aware before -> after views (a text diff for comments and other
// prose, Yes/No for switches, US dates, collapsible JSON, hidden values).
import { useState } from 'react';
import { Plus, Pencil, Trash2, MessageSquare, LogIn, ShieldAlert, Activity, UserCog, ArrowRight } from 'lucide-react';
import { usePhotoMap } from '../../lib/peoplePhotos';
import { colorForKey, initialsOf } from '../../tasks/theme';
import { StatusLabel } from '../StatusLabel';
import { moduleColor, titleCase, formatValue, shortValue, diffWords, isLongText } from './auditModel';

export const AMBER = '#b45309';
export const AMBER_BG = 'rgba(180,83,9,0.09)';

export function PersonAvatar({ email, name, size = 30 }) {
  const photos = usePhotoMap();
  const label = name || email || '?';
  const photo = email ? photos[email.toLowerCase()] : '';
  if (photo) {
    return <img src={photo} alt="" style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />;
  }
  return (
    <span aria-hidden="true" style={{
      width: size, height: size, borderRadius: '50%', flexShrink: 0, background: email ? colorForKey(email) : 'var(--mist)',
      color: email ? '#fff' : 'var(--muted)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.38, fontWeight: 700,
    }}>{email ? initialsOf(label) : <Activity size={size * 0.5} />}</span>
  );
}

export function ModuleBadge({ module, label }) {
  if (!module && !label) return null;
  return <StatusLabel size="sm" label={label || titleCase(module)} color={moduleColor(module || label)} />;
}

// The key ask: who was really at the keyboard vs. whose access they used.
export function ActAsBadge({ name, compact = false }) {
  if (!name) return null;
  return (
    <span title={`Done while acting as ${name}`} style={{
      display: 'inline-flex', alignItems: 'center', gap: 4, padding: compact ? '1px 7px' : '2px 9px', borderRadius: 999,
      background: AMBER_BG, color: AMBER, border: '1px solid rgba(180,83,9,0.28)', fontSize: 11, fontWeight: 700,
      whiteSpace: 'nowrap', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis',
    }}>
      <UserCog size={12} style={{ flexShrink: 0 }} />
      Acting as {name}
    </span>
  );
}

const ACTION_ICONS = {
  create: Plus, update: Pencil, delete: Trash2, comment: MessageSquare, login: LogIn, denied: ShieldAlert,
};
export function ActionIcon({ action, size = 13 }) {
  const Icon = ACTION_ICONS[action] || Activity;
  const danger = action === 'denied' || action === 'delete';
  return <Icon size={size} aria-hidden="true" style={{ flexShrink: 0, color: danger ? 'hsl(var(--color-red))' : 'var(--muted)' }} />;
}

const emptyStyle = { color: 'var(--muted)', fontStyle: 'italic' };

// One side of a change ("before" or "after"), by its kind.
export function ChangeValue({ value, kind }) {
  const s = formatValue(value, kind);
  if (kind === 'redacted') return <span style={emptyStyle}>Hidden for privacy</span>;
  if (s === null) return <span style={emptyStyle}>Empty</span>;
  if (kind === 'json') return <JsonValue text={s} />;
  return <span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{s}</span>;
}

function JsonValue({ text }) {
  const lines = text.split('\n');
  if (lines.length <= 4) return <code style={{ fontSize: 11.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{text}</code>;
  return (
    <details>
      <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--muted)' }}>{lines.length} lines of data</summary>
      <pre style={{ margin: '6px 0 0', padding: 10, background: 'var(--mist)', borderRadius: 8, fontSize: 11.5, maxHeight: 280, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{text}</pre>
    </details>
  );
}

const DEL = { background: 'hsla(var(--color-red),0.12)', color: 'hsl(var(--color-red))', textDecoration: 'line-through', borderRadius: 3 };
const ADD = { background: 'hsla(var(--color-green),0.14)', color: 'hsl(var(--color-green))', borderRadius: 3 };
const block = { padding: '10px 12px', borderRadius: 8, background: 'var(--mist)', fontSize: 13, lineHeight: 1.55, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' };

// A prose change: a new comment reads as the comment itself; an edit reads as
// one text with the removed words struck through and the added ones tinted.
export function TextDiff({ before, after, kind }) {
  const [side, setSide] = useState(false);
  const b = formatValue(before, kind) || '';
  const a = formatValue(after, kind) || '';
  if (!b && a) {
    return <div style={{ ...block, borderLeft: '3px solid hsl(var(--color-green))' }} data-testid="added-text">{a}</div>;
  }
  if (b && !a) {
    return (
      <div>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>Removed - it read:</div>
        <div style={{ ...block, borderLeft: '3px solid hsl(var(--color-red))', color: 'var(--muted)' }}>{b}</div>
      </div>
    );
  }
  const parts = diffWords(b, a);
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
        <button type="button" onClick={() => setSide(s => !s)}
          style={{ background: 'none', border: 'none', color: 'var(--wk-brand, var(--pine))', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', padding: 0, fontFamily: 'inherit' }}>
          {side ? 'Show Inline Changes' : 'Show Before and After'}
        </button>
      </div>
      {side ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 8 }}>
          <div><div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 3 }}>Before</div><div style={block}>{b}</div></div>
          <div><div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 3 }}>After</div><div style={block}>{a}</div></div>
        </div>
      ) : (
        <div style={block}>
          {parts.map((p, i) => (
            <span key={i} style={p.type === 'del' ? DEL : p.type === 'add' ? ADD : undefined}>{p.text}</span>
          ))}
        </div>
      )}
    </div>
  );
}

// The full before -> after list for one event.
export function ChangesTable({ changes }) {
  if (!changes?.length) return null;
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden' }}>
      {changes.map((c, i) => {
        const label = c.label || titleCase(c.field || '');
        const long = isLongText(c);
        return (
          <div key={`${c.field}-${i}`} style={{ padding: '10px 14px', borderTop: i ? '1px solid var(--line)' : 'none', fontSize: 13 }}>
            {long ? (
              <>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', marginBottom: 6 }}>{label}</div>
                <TextDiff before={c.before} after={c.after} kind={c.kind} />
              </>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(110px, 180px) 1fr', gap: 12, alignItems: 'start' }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', paddingTop: 1 }}>{label}</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
                  <span style={{ color: 'var(--muted)' }}><ChangeValue value={c.before} kind={c.kind} /></span>
                  <ArrowRight size={13} aria-label="changed to" style={{ color: 'var(--muted)', flexShrink: 0, alignSelf: 'center' }} />
                  <span style={{ fontWeight: 600, color: 'var(--ink)' }}><ChangeValue value={c.after} kind={c.kind} /></span>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// "Status: In Progress -> Done" - the feed's compact preview of one change.
export function ChangePreview({ change, action }) {
  const label = change.label || titleCase(change.field || '');
  const b = formatValue(change.before, change.kind);
  if (action === 'comment' || ((change.kind === 'html' || change.kind === 'text') && !b && change.after)) {
    return (
      <div style={{ fontSize: 12.5, color: 'var(--ink)', borderLeft: '2px solid var(--line)', paddingLeft: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {shortValue(change.after, change.kind, 140)}
      </div>
    );
  }
  return (
    <div style={{ fontSize: 12, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
      <span style={{ fontWeight: 600, flexShrink: 0 }}>{label}:</span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{shortValue(change.before, change.kind, 40)}</span>
      <ArrowRight size={12} aria-hidden="true" style={{ flexShrink: 0 }} />
      <span style={{ color: 'var(--ink)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{shortValue(change.after, change.kind, 40)}</span>
    </div>
  );
}
