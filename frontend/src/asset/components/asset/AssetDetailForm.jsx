import { useState, useEffect } from 'react';
import { PT } from '../../lib/propertyFields.js';
import { inferAssetKind } from '../../lib/vehicleFields.js';
import { normLabel, formatFieldValue } from '../../lib/format.js';
import { STAGE_FORM, baseStage } from '../../lib/stages.js';
import { editGuard } from '../../lib/editGuard.js';
import { deriveType } from '../../lib/portfolioCards.js';
import { ContactCell } from '../shared/ContactCell.jsx';
import { PropertyMapLink } from './PropertyMapLink.jsx';
import { PhotoGallery } from './PhotoGallery.jsx';

const FLAG_REASONS = ['Appears Incorrect', 'Needs Verification', 'Outdated', 'Missing Info', 'Other'];

const labelStyle = { fontSize: '0.78rem', fontWeight: 500, color: 'var(--text-secondary)', lineHeight: 1.4 };
const sectionCardStyle = { backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 14, boxShadow: 'var(--shadow-sm)', overflow: 'hidden', scrollMarginTop: 108 };
const inputStyle = { width: '100%', padding: '5px 9px', fontSize: '0.82rem' };

/**
 * The universal spec-sheet: renders AND inline-edits the full field set for any asset kind.
 *
 * Two very different data sources feed the same rendering path, and reconciling them is the
 * core trick of this component:
 *   - PROPERTIES read live from PT (the schema) + the free-text `snapshot` (values), via
 *     normLabel()-keyed lookup — PT defines the current desired grouping/order, snapshot only
 *     holds values. This means renaming/reordering PT fields doesn't require migrating data.
 *   - VEHICLES/EQUIPMENT read directly from their own pre-built `snapshot` array (populated at
 *     seed/normalization time from VEHICLE_FIELDS/EQUIPMENT_FIELDS) — there is no live schema
 *     re-derivation step for these kinds, the snapshot already IS the display structure.
 *
 * Editing writes back through `onSaveDetail`, keyed by field LABEL (not field key) — the parent
 * is responsible for mapping label -> the right storage location (top-level field vs. snapshot
 * value), same asymmetry as the read path above.
 */
export function AssetDetailForm({ p: asset, onSaveImages, highlight, onSaveDetail, onSaveContact, onOpenLead, onFlag }) {
  const flagMap = new Map((asset.reviewFlags || []).map((x) => [(x.g || '') + '~#~' + (x.f || ''), x.reason || '']));
  const isProperty = inferAssetKind(asset) === 'property';
  const highlightField = (highlight?.field || '').toLowerCase();

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({});
  const [dirty, setDirty] = useState(false);

  const sections = buildSections(asset, isProperty, editing);

  const nav = [...sections.map((sec, i) => ['sec' + i, sec.title]), ['map', 'Map'], ['media', 'Media']];
  const jumpTo = (key) => {
    const el = document.getElementById('gt-' + key);
    el && el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // Deep-link to a specific field (e.g. from a search result or a flagged-field notification).
  useEffect(() => {
    if (!highlightField || editing) return;
    const el = document.querySelector(`[data-fl="${highlightField}"]`);
    el && el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [highlightField, editing]);

  const startEdit = () => {
    if (editing) return;
    const d = {};
    sections.forEach((sec) => sec.fields.forEach((f) => { d[f.l] = f.raw == null ? '' : String(f.raw); }));
    setDraft(d);
    setEditing(true);
    setDirty(false);
  };
  const cancel = () => { setEditing(false); setDraft({}); setDirty(false); };
  const save = () => { onSaveDetail && onSaveDetail(draft); setEditing(false); setDraft({}); setDirty(false); };

  // Unit Mix auto-sum: editing any of the three sub-counts recomputes "Total Storage Units".
  const UNIT_MIX_PARTS = ['Climate-Controlled Units', 'Non-Climate Units', 'Vehicle Storage Spaces'];
  const setField = (label, value) => {
    setDirty(true);
    setDraft((d) => {
      const next = { ...d, [label]: value };
      if (UNIT_MIX_PARTS.includes(label)) {
        const sum = UNIT_MIX_PARTS.reduce((total, key) => total + (parseInt(String(next[key] ?? '').replace(/[^0-9]/g, ''), 10) || 0), 0);
        next['Total Storage Units'] = String(sum);
      }
      return next;
    });
  };

  const renderEditInput = (f) => f.t === 'stage' ? (
    <select className="form-input" value={draft[f.l] ?? ''} onChange={(e) => setField(f.l, e.target.value)} style={inputStyle}>
      <option value="">—</option>
      {STAGE_FORM.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  ) : (
    <input className="form-input" type={f.t === 'date' ? 'date' : 'text'} value={draft[f.l] ?? ''} onChange={(e) => setField(f.l, e.target.value)} style={inputStyle} />
  );

  // Register with the shared navigation-away guard whenever this form is mounted/dirty.
  useEffect(() => {
    editGuard.dirty = editing && dirty;
    editGuard.save = save;
    editGuard.cancel = cancel;
    editGuard.startEdit = startEdit;
    return () => { editGuard.dirty = false; };
  });

  return (
    <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
      <nav className="gt-toc" style={{ position: 'sticky', top: 64, flexShrink: 0, width: 178, display: 'flex', flexDirection: 'column', gap: 1 }}>
        <div style={{ ...labelStyle, padding: '2px 11px 8px' }}>On this page</div>
        {nav.map(([key, title]) => (
          <button
            key={key}
            onClick={() => jumpTo(key)}
            style={{ textAlign: 'left', padding: '7px 11px', borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-secondary)', fontFamily: 'Inter,sans-serif', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-secondary)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
          >
            {title}
          </button>
        ))}
      </nav>

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {editing && dirty && (
          <div className="save-bar" style={{ position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 300, display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', background: 'var(--bg-card)', borderTop: '1px solid var(--border-color)', boxShadow: '0 -6px 20px rgba(0,0,0,0.18)' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '0.86rem', fontWeight: 700, color: 'var(--text-primary)' }}>You've made changes</div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Save before you leave this page</div>
            </div>
            <button className="secondary-btn" onClick={cancel} style={{ padding: '9px 14px', flexShrink: 0 }}>Discard</button>
            <button className="primary-btn" onClick={save} style={{ padding: '9px 22px', flexShrink: 0 }}>Save</button>
          </div>
        )}

        {asset.assembled && asset.parentId && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 13px', borderRadius: 11, border: '1px solid hsl(var(--color-purple) / 0.35)', backgroundColor: 'hsl(var(--color-purple) / 0.07)', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '0.82rem', fontWeight: 700, color: 'hsl(var(--color-purple))' }}>Parcel of {asset.siteName || 'an assembled asset'}</div>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', marginTop: 2, lineHeight: 1.45 }}>
                Project detail (ownership, financials, zoning, team) is managed on the assemblage. This page holds only the info specific to this parcel.
              </div>
            </div>
            {onOpenLead && (
              <button className="primary-btn" onClick={() => onOpenLead(asset.parentId)} style={{ flexShrink: 0, padding: '8px 14px', fontSize: '0.8rem' }}>
                Open assemblage
              </button>
            )}
          </div>
        )}

        {onSaveDetail && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: -2 }}>
            {editing && (
              <>
                <button className="secondary-btn" onClick={cancel}>Cancel</button>
                <button className="primary-btn" onClick={save}>Save changes</button>
              </>
            )}
          </div>
        )}

        {sections.map((sec, si) => (
          <section key={'sec' + si} id={'gt-sec' + si} style={sectionCardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 18px', borderBottom: '1px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)' }}>
              <strong style={{ fontSize: '0.98rem', fontFamily: "'Plus Jakarta Sans', sans-serif", color: 'var(--text-primary)' }}>{sec.title}</strong>
              {onFlag && <span style={{ marginLeft: 'auto', fontSize: '0.62rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.04em' }}>Flag</span>}
            </div>
            <div>
              {sec.fields.map((f, fi) => {
                const label = f.l;
                const value = formatFieldValue(f.raw, f.t);
                const isHighlighted = !editing && highlightField && String(label).toLowerCase() === highlightField;
                const flagKey = (sec.title || '') + '~#~' + label;
                const isFlagged = onFlag && flagMap.has(flagKey);

                return (
                  <div
                    key={fi}
                    className={editing ? 'gt-frow gt-editing' : 'gt-frow'}
                    data-fl={String(label).toLowerCase()}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'minmax(150px,34%) 1fr 44px',
                      gap: 16,
                      alignItems: editing ? 'center' : 'baseline',
                      padding: '8px 18px',
                      borderTop: fi ? '1px solid var(--border-color)' : 'none',
                      background: isHighlighted ? 'hsla(var(--color-gold), 0.16)' : isFlagged ? 'hsla(var(--color-orange), 0.09)' : 'transparent',
                      scrollMarginTop: 80,
                    }}
                  >
                    <span style={labelStyle}>{label}</span>

                    {editing ? renderEditInput(f)
                      : f.contact && String(value ?? '').trim()
                        ? <ContactCell name={value} label={f.l} contacts={asset.contacts} onSave={onSaveContact} />
                        : <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)', wordBreak: 'break-word', fontVariantNumeric: 'tabular-nums' }}>{(value ?? '') === '' ? '—' : value}</span>}

                    {onFlag ? (
                      isFlagged ? (
                        <button
                          onClick={(e) => { e.stopPropagation(); onFlag(asset.id, sec.title, label); }}
                          title={`Flagged (${flagMap.get(flagKey) || 'Needs review'}) — click to clear`}
                          style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, boxSizing: 'border-box', borderRadius: '50%', border: 'none', cursor: 'pointer', backgroundColor: 'hsla(var(--color-orange), 0.18)', color: 'hsl(var(--color-orange))', fontSize: '1.05rem', lineHeight: 1, verticalAlign: 'middle', padding: 0, margin: 0 }}
                        >
                          ⚑
                        </button>
                      ) : (
                        <select
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => { const v = e.target.value; v && onFlag(asset.id, sec.title, label, v); e.target.value = ''; }}
                          value=""
                          title="Flag this field for review"
                          style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: '0.95rem', color: 'var(--text-muted)', width: 40, height: 26, boxSizing: 'border-box', textAlignLast: 'center', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '0 6px 0 0', margin: 0, verticalAlign: 'middle' }}
                        >
                          <option value="">⚐</option>
                          {FLAG_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
                        </select>
                      )
                    ) : null}
                  </div>
                );
              })}
            </div>
          </section>
        ))}

        {isProperty && (
          <div id="gt-map" style={{ scrollMarginTop: 108 }}>
            <PropertyMapLink p={asset} onSave={onSaveDetail} />
          </div>
        )}
        <div id="gt-media" style={{ scrollMarginTop: 108 }}>
          <PhotoGallery p={asset} onSave={onSaveImages} />
        </div>
      </div>
    </div>
  );
}

/**
 * Derives the section/field list to render.
 *   - Property, part of an assembled group (not the lead parcel): a minimal "Parcel Information"
 *     section only — full detail lives on the lead parcel.
 *   - Property (normal or lead): live from PT, filtered by devStage (dev-only fields hide once
 *     Stabilized, unless actively editing) and by asset class (`okC` — storage/self-storage/
 *     RV/income gating per group/field `cls`).
 *   - Vehicle/equipment: straight from the pre-built `snapshot` array, no live schema filtering.
 */
function buildSections(asset, isProperty, editing) {
  if (!isProperty) {
    return (asset.snapshot && asset.snapshot.length)
      ? asset.snapshot.map((g) => ({
          title: g.group,
          fields: (g.fields || []).map((f) => ({ l: String(f.label || '').trim(), raw: f.value })),
        }))
      : [];
  }

  const stabilized = baseStage(asset.devStage) === 'Stabilized';
  const typeText = String(asset.type || deriveType(asset) || '').toLowerCase();
  const isSelfStorage = /self.?storage|mini.?storage|storage facility/.test(typeText);
  const isRV = /\brv\b|vehicle stor/.test(typeText);
  const isStorage = isSelfStorage || isRV;
  const isIncome = ['Retail', 'Office / Medical', 'Residential', 'Mixed-Use'].includes(deriveType(asset) || '');
  const classAllowed = (cls) => !cls || (
    cls === 'storage' ? isStorage :
    cls === 'selfstorage' ? isSelfStorage :
    cls === 'rv' ? isRV :
    cls === 'income' ? isIncome : true
  );

  // Build a normLabel()-keyed lookup of every value currently in the free-text snapshot.
  const snapshotValues = {};
  (asset.snapshot || []).forEach((g) => (g.fields || []).forEach((f) => {
    const key = normLabel(f.label);
    if (snapshotValues[key] === undefined || snapshotValues[key] === '') snapshotValues[key] = f.value;
  }));
  const resolveValue = (field) => {
    if (field.type === 'stage') return asset.devStage || snapshotValues[normLabel(field.label)] || '';
    if (field.key && asset[field.key] != null && String(asset[field.key]).trim() !== '') return String(asset[field.key]);
    const v = snapshotValues[normLabel(field.label)];
    return v !== undefined && v !== '' ? v : '';
  };
  // A dev-only field/group is decluttered from the VIEW of a Stabilized property, but only when
  // it's empty — a populated one must stay visible, otherwise a value the user saved (dev fields
  // are still editable in edit mode) silently disappears from the view and looks unsaved.
  const hasValue = (field) => String(resolveValue(field) ?? '').trim() !== '';

  if (asset.assembled && asset.parentId) {
    const PARCEL_INFO_FIELDS = [
      { label: 'Property Address', key: 'address' },
      { label: 'City', key: 'city' },
      { label: 'County', key: 'county' },
      { label: 'State', key: 'state' },
      { label: 'Zip', key: 'zip' },
      { label: 'APN', key: 'apn' },
      { label: 'Lot Size (SF / Acres)', key: 'acreage' },
      { label: 'Acquisition Price', type: 'money' },
      { label: 'Acquisition Date', type: 'date' },
      { label: 'Zoning', key: 'zoning' },
    ];
    return [{
      title: 'Parcel Information',
      fields: PARCEL_INFO_FIELDS.map((f) => ({ l: f.label, raw: resolveValue({ label: f.label, key: f.key, type: f.type }), t: f.type, key: f.key })),
    }];
  }

  return PT
    .filter((group) => (editing || !(stabilized && group.dev) || group.fields.some(hasValue)) && classAllowed(group.cls))
    .map((group) => ({
      title: group.group,
      fields: group.fields
        .filter((f) => (editing || !(stabilized && f.dev) || hasValue(f)) && classAllowed(f.cls) && f.key !== 'mapUrl')
        .map((f) => ({ l: f.label, raw: resolveValue(f), t: f.type, contact: f.contact, key: f.key })),
    }));
}
