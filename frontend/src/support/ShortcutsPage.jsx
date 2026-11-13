// Help > Keyboard Shortcuts (11/13/2026): the shortcuts Nexus has, grouped,
// read inside the Help panel like a guide article. The list is
// lib/shortcutList.js - the ONE source; this file only draws it, with Ctrl
// or Cmd for the computer it is read on.
import { ChevronLeft } from 'lucide-react';
import { FS } from '../lib/typeScale';
import { shortcutGroups } from '../lib/shortcutList';

const ROW = {
  display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12,
  padding: '7px 8px', borderBottom: '1px solid var(--line)', fontSize: FS.body, color: 'var(--ink)',
};

function Keys({ keys }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0, whiteSpace: 'nowrap' }}>
      {keys.map((k, i) => (
        <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          {i > 0 && <span style={{ fontSize: FS.meta, color: 'var(--muted)' }}>or</span>}
          <kbd className="hud-kbd">{k}</kbd>
        </span>
      ))}
    </span>
  );
}

export default function ShortcutsPage({ onBack, mac }) {
  const groups = shortcutGroups(mac === undefined ? undefined : { mac });
  return (
    <div className="hw-scroll hw-pad" data-help-shortcuts="">
      <button type="button" className="hw-back" onClick={onBack}><ChevronLeft size={16} /> Back</button>
      <h3 className="hw-article-title">Keyboard Shortcuts</h3>
      <p className="hw-p" style={{ color: 'var(--muted)' }}>Shortcuts pause while you type in a box.</p>
      {groups.map((g) => (
        <section key={g.title} aria-label={g.title} style={{ marginBottom: 14 }}>
          <div className="hw-group">{g.title}</div>
          <div role="list">
            {g.rows.map((r) => (
              <div key={r.label} role="listitem" style={ROW}>
                <span style={{ minWidth: 0 }}>
                  {r.label}
                  {r.note && <span style={{ display: 'block', fontSize: FS.label, color: 'var(--muted)', marginTop: 1 }}>{r.note}</span>}
                </span>
                {r.keys
                  ? <Keys keys={r.keys} />
                  : <span style={{ fontSize: FS.label, color: 'var(--muted)', textAlign: 'right', maxWidth: '52%' }}>{r.where}</span>}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
