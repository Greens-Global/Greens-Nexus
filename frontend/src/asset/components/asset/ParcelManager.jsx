// Parcel linking — the "Asset Group" panel shown on any property that either belongs to a
// group already, or can be linked into one.
//
// GROUP-FIRST MODEL — READ THIS BEFORE TOUCHING THE LOGIC BELOW.
//
// This is deliberately NOT a parent/child hierarchy with one fixed "parent" parcel and
// subordinate "children". It is a flat group of equal members that happens to need ONE of
// them to act as the anchor record (the one other members' `parentId` points at), because
// something has to hold the shared group-level fields (`siteName`, `assembled`). Concretely:
//
//   - `order` (the `parcelOrder` field): every member has a position. Reordering (the ▲/▼
//     arrows) swaps two members' `parcelOrder` values — see `onMove` / moveParcelOrder in the
//     parent. Order is purely a display/navigation convenience (chip switcher, table rows);
//     it does NOT imply ownership or precedence.
//
//   - `primary` (the ★ flag): a boolean per parcel. MULTIPLE members can be marked primary
//     at the same time — togglePrimaryParcel (parent-side) simply flips the flag on the one
//     parcel you clicked and never touches anyone else's flag. This is intentional, not a
//     bug: "primary" here is closer to "pin this one as important" than "the sole parent".
//     Do not add auto-unset-others-when-one-is-set logic without confirming that's actually
//     what's wanted — it would be a behavior change, not a bug fix.
//
//   - The "anchor" (see groupAnchorOf in lib/parcelGrouping.js) is just whichever member
//     currently has no `parentId` — a transient bookkeeping role, not a designated "parent
//     parcel". If the anchor is unlinked from the group, the parent-side unlinkParcel logic
//     promotes whichever remaining member has the lowest `parcelOrder` to be the new anchor,
//     and propagates the group's `siteName` onto it. Any member could end up as anchor over
//     the group's lifetime.
//
//   - "Asset Group" renaming (the Group Name input below) writes `siteName` onto the anchor
//     AND every other member whose `parentId` points at the anchor — i.e. it renames the
//     WHOLE group, not just the parcel you happen to be viewing. This is separate from each
//     parcel's own `name`.
//
// The chip-style "Go to" <select> and the Parcels table below both let you switch which
// group member you're viewing/editing — there is no single "detail" parcel you're locked
// into, unlike a strict parent/child model where only the parent shows full detail.
// (Contrast with AssemblageParcels.jsx, which layers an OPTIONAL "one of these is the lead
// for full project detail" convention on top of this group for assembled-asset display —
// that's a display choice per group via the `assembled` flag, not a change to this
// underlying group-first data model.)

import { useState } from 'react';
import { Link2 } from 'lucide-react';
import { inferAssetKind } from '../../lib/vehicleFields.js';
import { groupAnchorOf, groupMembersOf, parcelAcres, parcelLot, parcelReveal } from '../../lib/parcelGrouping.js';

function ReorderArrow({ children, disabled, onClick }) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      title="Reorder"
      style={{
        display: 'block',
        lineHeight: 0.85,
        padding: '1px 7px',
        fontSize: '0.72rem',
        border: 'none',
        background: 'none',
        cursor: disabled ? 'default' : 'pointer',
        color: disabled ? 'var(--border-color)' : 'hsl(var(--color-purple))',
      }}
    >
      {children}
    </button>
  );
}

export function ParcelManager({
  active,
  all,
  onOpen,
  onLink,
  onUnlink,
  onTogglePrimary,
  onMove,
  onRenameGroup,
  onDuplicate,
  onSetAssembled,
}) {
  // Hooks must run unconditionally and in the same order every render, so they precede the
  // non-property early return below (React rules-of-hooks).
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState('');
  const [reveal, setReveal] = useState(false);

  if (inferAssetKind(active) !== 'property') return null;

  const members = groupMembersOf(active, all);
  const grouped = members.length > 1;
  const hasChildren = (id) => all.some((p) => p.parentId === id);
  const anchor = groupAnchorOf(active, all);
  const assembled = anchor.assembled;
  const linkable = all.filter(
    (p) =>
      inferAssetKind(p) === 'property' &&
      !p.deleted &&
      !p.parentId &&
      !hasChildren(p.id) &&
      !members.some((m) => m.id === p.id)
  );
  const groupName = anchor.siteName || anchor.name;
  const totalAcres = members.reduce((sum, m) => sum + parcelAcres(m), 0);

  // Exposed so a "Link this asset to a parcel or group" button elsewhere in the detail view
  // can force this panel open even when the asset isn't grouped yet (see parcelReveal in
  // lib/parcelGrouping.js — same mutable-singleton pattern as editGuard.js).
  parcelReveal.show = () => setReveal(true);

  if (!grouped && !reveal) return null;

  return (
    <div
      style={{
        padding: '11px 13px',
        marginBottom: 14,
        borderRadius: 14,
        border: '1px solid hsl(var(--color-purple) / 0.4)',
        backgroundColor: 'hsl(var(--color-purple) / 0.07)',
        boxShadow: 'var(--shadow-sm)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, flexWrap: 'wrap' }}>
        <span
          style={{
            flexShrink: 0,
            width: 34,
            height: 34,
            borderRadius: 9,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#fff',
            background: 'hsl(var(--color-purple))',
          }}
        >
          <Link2 size={17} />
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              fontSize: '0.62rem',
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              color: 'hsl(var(--color-purple))',
            }}
          >
            {grouped ? 'Asset Group' : 'Linked Parcels'}
          </div>
          {grouped ? (
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
              <span
                style={{
                  fontSize: '0.98rem',
                  fontWeight: 700,
                  color: 'var(--text-primary)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  maxWidth: '100%',
                }}
              >
                {groupName}
              </span>
              <span style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                {members.length} parcels{totalAcres > 0 ? ` · ~${totalAcres.toFixed(1)} ac` : ''}
              </span>
            </div>
          ) : (
            <div style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--text-muted)' }}>
              Not linked to other parcels
            </div>
          )}
        </div>
        <button
          onClick={() => setOpen((o) => !o)}
          style={{
            flexShrink: 0,
            padding: '7px 15px',
            borderRadius: 999,
            fontSize: '0.8rem',
            fontWeight: 700,
            cursor: 'pointer',
            border: 'none',
            background: 'hsl(var(--color-purple))',
            color: '#fff',
          }}
        >
          {open ? 'Done' : grouped ? 'Manage' : 'Link'}
        </button>
      </div>

      {grouped && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
          <span style={{ flexShrink: 0, fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
            Go to
          </span>
          {/* Dropdown switcher between group members — not a parent/child drill-down, every
              member (including the anchor) is just another option in this list. */}
          <select
            value={active.id}
            onChange={(e) => {
              if (e.target.value && e.target.value !== active.id) onOpen(e.target.value);
            }}
            className="form-input"
            aria-label="Switch to parcel"
            style={{ flex: 1, minWidth: 0, fontSize: '0.85rem', padding: '9px 11px', cursor: 'pointer' }}
          >
            {members.map((m, i) => (
              <option key={m.id} value={m.id}>
                {i + 1}.  {m.name}
                {m.primary ? '   ★ Primary' : ''}
                {m.id === active.id ? '   • viewing' : ''}
              </option>
            ))}
          </select>
        </div>
      )}

      {open && (
        <div
          style={{
            marginTop: 13,
            paddingTop: 13,
            borderTop: '1px solid hsl(var(--color-purple) / 0.25)',
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
          }}
        >
          {grouped && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <label
                style={{
                  fontSize: '0.66rem',
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                  color: 'var(--text-muted)',
                }}
              >
                Group Name
              </label>
              <input
                key={groupName}
                className="form-input"
                defaultValue={groupName}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v && v !== groupName) onRenameGroup(v);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                }}
                placeholder="Name this asset group"
                style={{ width: '100%', boxSizing: 'border-box', fontSize: '0.9rem', padding: '9px 11px' }}
              />
              <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                Renames the whole group (separate from each parcel's own name). Saves when you tap away.
              </span>
            </div>
          )}

          {grouped && (
            <label
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 9,
                cursor: 'pointer',
                padding: '10px 11px',
                borderRadius: 10,
                border: '1px solid ' + (assembled ? 'hsl(var(--color-purple))' : 'var(--border-color)'),
                backgroundColor: assembled ? 'hsl(var(--color-purple) / 0.08)' : 'transparent',
              }}
            >
              <input
                type="checkbox"
                checked={!!assembled}
                onChange={(e) => onSetAssembled && onSetAssembled(e.target.checked)}
                style={{ marginTop: 2, width: 16, height: 16, flexShrink: 0, cursor: 'pointer', accentColor: 'hsl(var(--color-purple))' }}
              />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: '0.84rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                  Treat parcels as one assembled asset
                </div>
                <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.45 }}>
                  Fill the project detail once on the lead parcel. Other parcels keep only their own APN,
                  address, lot size, acquisition & zoning — no full detail needed on each.
                </div>
              </div>
            </label>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span
              style={{
                fontSize: '0.66rem',
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
                color: 'var(--text-muted)',
              }}
            >
              {grouped ? 'Add a parcel' : 'Link with another parcel'}
            </span>
            {linkable.length ? (
              <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
                <select
                  className="form-input"
                  value={selected}
                  onChange={(e) => setSelected(e.target.value)}
                  style={{ flex: '1 1 180px', minWidth: 0, padding: '8px 10px', fontSize: '0.85rem' }}
                >
                  <option value="">— Select a standalone property —</option>
                  {linkable.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <button
                  className="primary-btn"
                  disabled={!selected}
                  onClick={() => {
                    if (selected) onLink(selected);
                    setSelected('');
                  }}
                  style={{ flexShrink: 0, padding: '8px 15px', fontSize: '0.82rem', opacity: selected ? 1 : 0.5 }}
                >
                  {grouped ? 'Add' : 'Link'}
                </button>
              </div>
            ) : (
              <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                No standalone properties available to link.
              </span>
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <span
              style={{
                fontSize: '0.66rem',
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
                color: 'var(--text-muted)',
              }}
            >
              Quick start
            </span>
            <button
              onClick={() => onDuplicate && onDuplicate()}
              style={{
                alignSelf: 'flex-start',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '9px 14px',
                borderRadius: 999,
                fontSize: '0.82rem',
                fontWeight: 600,
                cursor: 'pointer',
                border: '1px dashed hsl(var(--color-purple) / 0.65)',
                background: 'transparent',
                color: 'hsl(var(--color-purple))',
              }}
            >
              {'⧉ Duplicate this parcel'}
            </button>
            <span style={{ fontSize: '0.66rem', color: 'var(--text-muted)' }}>
              Copies this parcel's details into a new linked parcel — records start empty, ready to edit.
            </span>
          </div>

          {grouped && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span
                style={{
                  fontSize: '0.66rem',
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                  color: 'var(--text-muted)',
                }}
              >
                Parcels ({members.length}) — drag order with arrows, {'★'} marks primary
              </span>
              {members.map((m, i) => {
                const isCurrent = m.id === active.id;
                return (
                  <div
                    key={m.id}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 7,
                      padding: '9px 11px',
                      borderRadius: 11,
                      border: isCurrent ? '1px solid hsl(var(--color-purple) / 0.55)' : '1px solid var(--border-color)',
                      backgroundColor: 'var(--bg-card)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{ display: 'inline-flex', flexDirection: 'column', flexShrink: 0 }}>
                        <ReorderArrow disabled={i === 0} onClick={() => onMove(m.id, -1)}>
                          {'▲'}
                        </ReorderArrow>
                        <ReorderArrow disabled={i === members.length - 1} onClick={() => onMove(m.id, 1)}>
                          {'▼'}
                        </ReorderArrow>
                      </div>
                      <span
                        style={{
                          flexShrink: 0,
                          width: 22,
                          height: 22,
                          borderRadius: 6,
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: '0.74rem',
                          fontWeight: 700,
                          color: 'var(--text-secondary)',
                          backgroundColor: 'var(--bg-secondary)',
                        }}
                      >
                        {i + 1}
                      </span>
                      <button
                        onClick={() => {
                          if (!isCurrent) onOpen(m.id);
                        }}
                        title={isCurrent ? 'Current parcel' : `Open ${m.name}`}
                        style={{
                          flex: 1,
                          minWidth: 0,
                          textAlign: 'left',
                          background: 'none',
                          border: 'none',
                          padding: 0,
                          cursor: isCurrent ? 'default' : 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 7,
                          overflow: 'hidden',
                        }}
                      >
                        <span
                          style={{
                            fontWeight: 600,
                            fontSize: '0.9rem',
                            color: isCurrent ? 'hsl(var(--color-purple))' : 'var(--text-primary)',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {m.name}
                        </span>
                        {isCurrent ? (
                          <span style={{ flexShrink: 0, fontSize: '0.6rem', fontWeight: 700, color: 'hsl(var(--color-purple))' }}>
                            {'• VIEWING'}
                          </span>
                        ) : null}
                      </button>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 34, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: '0.74rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                        Lot: {parcelLot(m) || '—'}
                      </span>
                      <span style={{ flex: 1, minWidth: 8 }} />
                      {/* Set Primary: toggles ONLY this parcel's flag. Other members' `primary`
                          flags are left untouched — see the group-first note at the top of this
                          file. Multiple parcels showing a filled star at once is expected. */}
                      <button
                        onClick={() => onTogglePrimary(m.id)}
                        title={m.primary ? 'Primary — tap to unset' : 'Mark as primary'}
                        style={{
                          flexShrink: 0,
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 4,
                          padding: '5px 11px',
                          borderRadius: 999,
                          fontSize: '0.72rem',
                          fontWeight: 700,
                          cursor: 'pointer',
                          border: m.primary ? '1px solid hsl(var(--color-purple))' : '1px solid var(--border-color)',
                          background: m.primary ? 'hsl(var(--color-purple) / 0.13)' : 'transparent',
                          color: m.primary ? 'hsl(var(--color-purple))' : 'var(--text-muted)',
                        }}
                      >
                        {m.primary ? '★' : '☆'} Primary
                      </button>
                      <button
                        onClick={() => onUnlink(m.id)}
                        title="Remove from group"
                        style={{
                          flexShrink: 0,
                          padding: '5px 11px',
                          borderRadius: 999,
                          fontSize: '0.72rem',
                          fontWeight: 600,
                          cursor: 'pointer',
                          border: '1px solid hsl(var(--color-red) / 0.45)',
                          background: 'transparent',
                          color: 'hsl(var(--color-red))',
                        }}
                      >
                        Unlink
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
