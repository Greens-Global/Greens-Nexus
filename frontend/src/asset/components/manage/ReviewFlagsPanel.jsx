import { useState } from 'react';
import { normLabel } from '../../lib/format.js';

/**
 * One flagged field: shows the reason chip, which asset/group/field it's on, an editable input
 * pre-filled with the field's CURRENT value, and two actions:
 *   - "Push Fix"  -> writes the input's value back to that field and auto-clears the flag
 *   - "Resolve"   -> clears the flag WITHOUT changing the value (it was fine as-is, or the fix
 *                    was already made some other way)
 *
 * flag shape: { pid, name, g (snapshot group), f (field label), user, reason, curVal }
 */
function FlagRow({ flag, onOpen, onClearFlag, onPushFix }) {
  const [draft, setDraft] = useState(flag.curVal || '');

  return (
    <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: 7 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{
          fontSize: '0.64rem', fontWeight: 700, padding: '2px 8px', borderRadius: 999,
          color: 'hsl(var(--color-orange))', backgroundColor: 'hsla(var(--color-orange), 0.14)', whiteSpace: 'nowrap',
        }}>
          {flag.reason || 'Needs review'}
        </span>
        <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {flag.g} · {flag.f}
        </span>
      </div>

      <div style={{ fontSize: '0.74rem', color: 'var(--text-secondary)' }}>
        <button
          onClick={() => onOpen && onOpen(flag.pid)}
          style={{ border: 'none', background: 'none', padding: 0, color: 'hsl(var(--color-blue))', cursor: 'pointer', fontWeight: 600, fontSize: '0.74rem' }}
        >
          {flag.name}
        </button>
        {flag.user ? ` · flagged by ${flag.user}` : ''}
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          className="form-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Correct value…"
          style={{ flex: '1 1 200px', fontSize: '0.82rem' }}
        />
        <button
          className="primary-btn"
          onClick={() => onPushFix && onPushFix(flag.pid, flag.g, flag.f, draft)}
          style={{ fontSize: '0.76rem', padding: '6px 13px', flexShrink: 0 }}
        >
          Push Fix
        </button>
        <button
          className="secondary-btn"
          onClick={() => onClearFlag && onClearFlag(flag.pid, flag.g, flag.f)}
          style={{ fontSize: '0.76rem', padding: '6px 13px', flexShrink: 0 }}
        >
          Resolve
        </button>
      </div>
    </div>
  );
}

/**
 * "Flagged for Review" tab — every field flagged across the whole portfolio, flattened into one
 * list. Each asset carries its own `reviewFlags` array ({ g: group, f: field label, user, reason }
 * per flag); this panel joins each flag back to its field's CURRENT value (looked up by matching
 * normLabel(flag.f) against the asset's snapshot) so the row can show an editable, pre-filled
 * input rather than a blank one.
 *
 * props: { props (all live assets), onClearFlag(id, group, field), onOpen(id), onPushFix(id, group, field, value) }
 */
export function ReviewFlagsPanel({ props: assets, onClearFlag, onOpen, onPushFix }) {
  const flags = [];
  (assets || []).forEach((asset) => {
    (asset.reviewFlags || []).forEach((flag) => {
      const group = (asset.snapshot || []).find((g) => g.group === flag.g);
      const field = group && (group.fields || []).find((f) => normLabel(f.label) === normLabel(flag.f));
      flags.push({
        pid: asset.id,
        name: asset.name || asset.id,
        g: flag.g,
        f: flag.f,
        user: flag.user,
        reason: flag.reason,
        curVal: field ? field.value : '',
      });
    });
  });

  return (
    <div style={{ marginBottom: 18, border: '1px solid var(--border-color)', borderRadius: 12, backgroundColor: 'var(--bg-card)', boxShadow: 'var(--shadow-sm)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)' }}>
        <span style={{ color: 'hsl(var(--color-orange))', fontSize: '1rem' }}>⚑</span>
        <strong style={{ fontSize: '0.95rem', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>Flagged for Review</strong>
        <span style={{
          marginLeft: 'auto', fontSize: '0.72rem', fontWeight: 700,
          color: flags.length ? 'hsl(var(--color-orange))' : 'var(--text-muted)',
          backgroundColor: flags.length ? 'hsla(var(--color-orange), 0.12)' : 'var(--bg-secondary)',
          padding: '2px 9px', borderRadius: 999,
        }}>
          {flags.length}
        </span>
      </div>

      {flags.length ? (
        <div style={{ maxHeight: 440, overflowY: 'auto' }}>
          {flags.map((flag, i) => (
            <FlagRow key={flag.pid + flag.g + flag.f + i} flag={flag} onOpen={onOpen} onClearFlag={onClearFlag} onPushFix={onPushFix} />
          ))}
        </div>
      ) : (
        <div style={{ padding: '18px 16px', fontSize: '0.82rem', color: 'var(--text-secondary)', textAlign: 'center' }}>
          No fields flagged for review. On any asset's overview, use the ⚐ beside a field to flag it and pick a reason — it will appear here, editable and ready to push a fix.
        </div>
      )}
    </div>
  );
}
