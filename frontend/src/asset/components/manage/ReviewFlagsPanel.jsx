import { useState } from 'react';
import { X } from 'lucide-react';
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
    <div style={{ padding: '12px 0', borderTop: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: 7 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', fontSize: 13 }}>
        <span style={{ fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {flag.g} · {flag.f}
        </span>
        <span style={{ fontWeight: 600, color: 'hsl(var(--color-orange))', whiteSpace: 'nowrap' }}>{flag.reason || 'Needs review'}</span>
      </div>

      <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
        <button
          onClick={() => onOpen && onOpen(flag.pid)}
          style={{ border: 'none', background: 'none', padding: 0, color: 'hsl(var(--color-green))', cursor: 'pointer', fontWeight: 600, fontSize: 12, fontFamily: 'inherit' }}
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
          style={{ flex: '1 1 200px', fontSize: 13 }}
        />
        <button
          className="primary-btn"
          onClick={() => onPushFix && onPushFix(flag.pid, flag.g, flag.f, draft)}
          style={{ fontSize: 12, padding: '6px 13px', flexShrink: 0 }}
        >
          Push Fix
        </button>
        <button
          className="secondary-btn"
          onClick={() => onClearFlag && onClearFlag(flag.pid, flag.g, flag.f)}
          style={{ fontSize: 12, padding: '6px 13px', flexShrink: 0 }}
        >
          Resolve
        </button>
      </div>
    </div>
  );
}

/**
 * "Flagged for Review" tab - every field flagged across the whole portfolio, flattened into one
 * list. Each asset carries its own `reviewFlags` array ({ g: group, f: field label, user, reason }
 * per flag); this panel joins each flag back to its field's CURRENT value (looked up by matching
 * normLabel(flag.f) against the asset's snapshot) so the row can show an editable, pre-filled
 * input rather than a blank one.
 *
 * props: { props (all live assets), onClearFlag(id, group, field), onOpen(id), onPushFix(id, group, field, value) }
 */
export function ReviewFlagsPanel({ props: assets, onClearFlag, onOpen, onPushFix, onClose }) {
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
    <section aria-label="Flagged for Review" style={{ marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, paddingBottom: 10 }}>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>Flagged for Review</h3>
        <span style={{ fontSize: 13, color: flags.length ? 'hsl(var(--color-orange))' : 'var(--text-secondary)', fontWeight: flags.length ? 600 : 400 }}>
          {flags.length ? `${flags.length} ${flags.length === 1 ? 'field waits' : 'fields wait'} for a look` : 'nothing flagged'}
        </span>
        {onClose && (
          <button type="button" className="secondary-btn" onClick={onClose} aria-label="Close Flagged for Review" style={{ marginLeft: 'auto', padding: 6, alignSelf: 'center' }}><X size={15} /></button>
        )}
      </div>

      {flags.length ? (
        <div style={{ maxHeight: 440, overflowY: 'auto' }}>
          {flags.map((flag, i) => (
            <FlagRow key={flag.pid + flag.g + flag.f + i} flag={flag} onOpen={onOpen} onClearFlag={onClearFlag} onPushFix={onPushFix} />
          ))}
        </div>
      ) : (
        <p style={{ margin: 0, padding: '12px 0', borderTop: '1px solid var(--border-color)', fontSize: 13, color: 'var(--text-secondary)' }}>
          No fields flagged for review. On any asset&apos;s overview, use the flag beside a field to flag it and pick a reason - it will appear here, editable and ready to push a fix.
        </p>
      )}
    </section>
  );
}
