// Pick a project's icon and color (Neil, Oct 15 2026). Sits in front of the
// Name field on Create / Edit Project: a square showing the project's icon
// in its color, which opens a panel with the twelve colors, the icon set by
// group, a search, and Reset to Default.
//
// Controlled: `color` / `icon` are the form's values, and every pick calls
// onChange({ color, icon }) at once - the form's own Save is what stores it,
// so Cancel still discards a pick like any other edit.
import { useRef, useState } from 'react';
import { Check, Search } from 'lucide-react';
import AnchoredMenu from '../components/AnchoredMenu';
import { NX, FONT, btn } from './theme';
import {
  PROJECT_COLORS, PROJECT_ICON_GROUPS, DEFAULT_PROJECT_COLOR, DEFAULT_PROJECT_ICON, projectLook,
} from './projectLook';

const micro = { fontSize: 12, fontWeight: 600, color: NX.dim, margin: '0 0 8px' };

export default function ProjectLookPicker({ color, icon, onChange, size = 38 }) {
  const anchor = useRef(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const look = projectLook({ color, icon });
  const pick = (patch) => onChange({ color: look.color, icon: look.iconKey, ...patch });
  const q = query.trim().toLowerCase();
  const groups = PROJECT_ICON_GROUPS
    .map((g) => ({ ...g, icons: q ? g.icons.filter(([key, label]) => `${key} ${label} ${g.label}`.toLowerCase().includes(q)) : g.icons }))
    .filter((g) => g.icons.length);
  const isDefault = look.color === DEFAULT_PROJECT_COLOR && look.iconKey === DEFAULT_PROJECT_ICON;

  return (
    <>
      <button ref={anchor} type="button" onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog" aria-expanded={open}
        aria-label={`Project icon and color: ${look.iconLabel}, ${look.colorLabel}. Change`}
        title="Change Icon and Color"
        style={{
          width: size, height: size, flexShrink: 0, borderRadius: 8, cursor: 'pointer',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          border: `1px solid ${open ? look.color : NX.border}`, background: `${look.color}1f`, color: look.color,
        }}>
        <look.Icon size={Math.round(size * 0.47)} aria-hidden="true" />
      </button>
      <AnchoredMenu anchorRef={anchor} open={open} onClose={() => { setOpen(false); setQuery(''); }} role="dialog"
        style={{ width: 336, maxWidth: 'calc(100vw - 16px)', background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 12, boxShadow: '0 12px 32px rgba(0,0,0,0.16)', padding: 14, fontFamily: FONT }}>
        <div aria-label="Project icon and color">
          <p style={micro}>Color</p>
          <div role="group" aria-label="Color" style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 8, justifyItems: 'center', marginBottom: 14 }}>
            {PROJECT_COLORS.map((c) => {
              const on = c.hex === look.color;
              return (
                <button key={c.hex} type="button" onClick={() => pick({ color: c.hex })}
                  aria-label={c.label} aria-pressed={on} title={c.label}
                  style={{
                    width: 28, height: 28, borderRadius: '50%', border: 'none', cursor: 'pointer', padding: 0,
                    background: c.hex, color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    // The picked one: a ring in its own color, set off by a gap.
                    boxShadow: on ? `0 0 0 2px ${NX.surface}, 0 0 0 4px ${c.hex}` : 'none',
                  }}>
                  {on && <Check size={15} strokeWidth={3} aria-hidden="true" />}
                </button>
              );
            })}
          </div>

          <p style={micro}>Icon</p>
          <div style={{ position: 'relative', marginBottom: 6 }}>
            <Search size={14} aria-hidden="true" style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: NX.faint }} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search icons" aria-label="Search icons"
              style={{ width: '100%', boxSizing: 'border-box', padding: '7px 10px 7px 30px', border: `1px solid ${NX.border}`, borderRadius: 8, fontFamily: FONT, fontSize: 13, color: NX.ink, background: NX.surface }} />
          </div>
          <div style={{ maxHeight: 236, overflowY: 'auto', margin: '0 -4px', padding: '0 4px' }}>
            {groups.length === 0 ? (
              <p style={{ fontSize: 13, color: NX.faint, textAlign: 'center', padding: '18px 0', margin: 0 }}>No icons match "{query.trim()}".</p>
            ) : groups.map((g) => (
              <div key={g.label} role="group" aria-label={g.label}>
                <div style={{ fontSize: 11.5, color: NX.faint, padding: '8px 0 4px' }}>{g.label}</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: 4 }}>
                  {g.icons.map(([key, label, Icon]) => {
                    const on = key === look.iconKey;
                    return (
                      <button key={key} type="button" onClick={() => pick({ icon: key })}
                        aria-label={label} aria-pressed={on} title={label} className={on ? undefined : 'nx-row-hover'}
                        style={{
                          height: 34, borderRadius: 8, cursor: 'pointer', padding: 0,
                          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                          border: `1px solid ${on ? look.color : 'transparent'}`,
                          background: on ? `${look.color}1f` : 'transparent', color: on ? look.color : NX.dim,
                        }}>
                        <Icon size={17} aria-hidden="true" />
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, paddingTop: 10, borderTop: `1px solid ${NX.border2}` }}>
            <button type="button" disabled={isDefault} onClick={() => onChange({ color: '', icon: '' })}
              style={{ ...btn('ghost'), padding: '4px 0', fontSize: 13, color: isDefault ? NX.faint : NX.dim, cursor: isDefault ? 'default' : 'pointer' }}>
              Reset to Default
            </button>
            <button type="button" onClick={() => { setOpen(false); setQuery(''); }} style={{ ...btn('primary'), padding: '6px 14px', fontSize: 13 }}>Done</button>
          </div>
        </div>
      </AnchoredMenu>
    </>
  );
}
