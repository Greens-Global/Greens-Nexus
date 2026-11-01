import { useState, useEffect, useRef } from 'react';
import { Flag, ChevronDown, ChevronUp } from 'lucide-react';
import AnchoredMenu from '../../../components/AnchoredMenu';
import { PT } from '../../lib/propertyFields.js';
import { inferAssetKind } from '../../lib/vehicleFields.js';
import { normLabel, formatFieldValue } from '../../lib/format.js';
import { STAGE_FORM, baseStage } from '../../lib/stages.js';
import { editGuard } from '../../lib/editGuard.js';
import { deriveType } from '../../lib/portfolioCards.js';
import { ContactCell } from '../shared/ContactCell.jsx';
import { MultiDateInput } from '../shared/FieldInput.jsx';
import { PropertyMapLink } from './PropertyMapLink.jsx';
import { PhotoGallery } from './PhotoGallery.jsx';
import { SiteModelSection } from './SiteModelSection.jsx';

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
 *     normLabel()-keyed lookup - PT defines the current desired grouping/order, snapshot only
 *     holds values. This means renaming/reordering PT fields doesn't require migrating data.
 *   - VEHICLES/EQUIPMENT read directly from their own pre-built `snapshot` array (populated at
 *     seed/normalization time from VEHICLE_FIELDS/EQUIPMENT_FIELDS) - there is no live schema
 *     re-derivation step for these kinds, the snapshot already IS the display structure.
 *
 * Editing writes back through `onSaveDetail`, keyed by field LABEL (not field key) - the parent
 * is responsible for mapping label -> the right storage location (top-level field vs. snapshot
 * value), same asymmetry as the read path above.
 */
export function AssetDetailForm({ p: asset, onSaveImages, highlight, onSaveDetail, onSaveContact, onOpenLead, onFlag }) {
  const flagMap = new Map((asset.reviewFlags || []).map((x) => [(x.g || '') + '~#~' + (x.f || ''), x.reason || '']));
  const isProperty = inferAssetKind(asset) === 'property';
  // Data Gaps chips name the completeness check, not always the row label.
  const FIELD_ALIASES = { 'insurance carrier': 'carrier', 'lot size': 'lot size (sf / acres)' };
  const SECTION_TARGETS = { 'google maps link': 'map', photos: 'media' };
  const highlightRaw = (highlight?.field || '').toLowerCase();
  const highlightField = FIELD_ALIASES[highlightRaw] || highlightRaw;
  const highlightAt = highlight?.at || 0;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({});
  const [dirty, setDirty] = useState(false);
  // Read mode shows only the fields that hold a value; a section's empty fields
  // fold behind one "Show N empty fields" line (per section, this visit).
  const [showEmpty, setShowEmpty] = useState({});
  // Empty fields a deep link scrolled to stay on screen after the 4s highlight ends.
  const [revealed, setRevealed] = useState(() => new Set());
  // The one flag menu: which row's button opened it ({ key, section, label }).
  const [flagMenu, setFlagMenu] = useState(null);
  const flagBtnRef = useRef(null);
  // The form stays mounted from one asset to the next (Open Assemblage, a Critical
  // Items row): the per-section toggles, the revealed rows and an open flag menu
  // belong to the asset they were opened on.
  useEffect(() => { setShowEmpty({}); setRevealed(new Set()); setFlagMenu(null); }, [asset.id]);

  const sections = buildSections(asset, isProperty, editing);

  const nav = [...sections.map((sec, i) => ['sec' + i, sec.title]), ['map', 'Map'], ['media', 'Media']];
  const jumpTo = (key) => {
    const el = document.getElementById('gt-' + key);
    el && el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // Scroll-spy for the "On This Page" rail: the first section (in rail order)
  // crossing the band just under the page header is the current one; between
  // two sections the last hit stays lit, and before any scroll the first is.
  const [current, setCurrent] = useState(null);
  const navKeys = nav.map(([key]) => key).join('|');
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return undefined;
    const keys = navKeys.split('|').filter(Boolean);
    const hits = new Map();
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => hits.set(en.target.id.slice(3), en.isIntersecting));
      const hit = keys.find((k) => hits.get(k));
      setCurrent((prev) => hit || prev || keys[0] || null);
    }, { rootMargin: '-96px 0px -55% 0px', threshold: 0 });
    keys.forEach((k) => { const el = document.getElementById('gt-' + k); el && io.observe(el); });
    return () => io.disconnect();
  }, [navKeys, asset.id]);

  // The fixed Save / Cancel bar is the page header's twin: the header already
  // holds Cancel / Save Changes while editing, so the bar shows only once the
  // header has scrolled off screen. No header on the page (a test, another
  // host) = the bar is always there.
  const [headerOff, setHeaderOff] = useState(false);
  useEffect(() => {
    if (!editing) { setHeaderOff(false); return undefined; }
    const head = document.querySelector('.nexus-asset-root .asset-head');
    if (!head || typeof IntersectionObserver === 'undefined') { setHeaderOff(true); return undefined; }
    const io = new IntersectionObserver(([en]) => setHeaderOff(!en.isIntersecting), { threshold: 0 });
    io.observe(head);
    return () => io.disconnect();
  }, [editing]);

  // Deep-link to a specific field (a search result, a flagged-field notice, a Data Gaps
  // chip): scroll to it, and in edit mode put the cursor in it.
  useEffect(() => {
    if (!highlightField) return;
    if (SECTION_TARGETS[highlightField]) { jumpTo(SECTION_TARGETS[highlightField]); return; }
    setRevealed((r) => (r.has(highlightField) ? r : new Set([...r, highlightField])));
    const el = document.querySelector(`[data-fl="${highlightField}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (editing) el.querySelector('input,select,textarea')?.focus?.({ preventScroll: true });
  }, [highlightField, highlightAt, editing]); // eslint-disable-line react-hooks/exhaustive-deps

  const startEdit = () => {
    if (editing) return;
    const d = {};
    sections.forEach((sec) => sec.fields.forEach((f) => {
      d[f.l] = f.raw == null ? '' : String(f.raw);
      if (f.unitLabel) d[f.unitLabel] = f.unitRaw || 'Acres';
    }));
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

  const renderEditInput = (f) => f.unitLabel ? (
    <div style={{ display: 'flex', gap: 6 }}>
      <input className="form-input" type="text" value={draft[f.l] ?? ''} onChange={(e) => setField(f.l, e.target.value)} style={{ ...inputStyle, flex: 1 }} />
      <select className="form-input" value={draft[f.unitLabel] ?? 'Acres'} onChange={(e) => setField(f.unitLabel, e.target.value)} style={{ ...inputStyle, width: 84, flexShrink: 0 }}>
        <option value="Acres">Acres</option>
        <option value="SF">SF</option>
      </select>
    </div>
  ) : f.t === 'stage' ? (
    <select className="form-input" value={draft[f.l] ?? ''} onChange={(e) => setField(f.l, e.target.value)} style={inputStyle}>
      <option value="">-</option>
      {STAGE_FORM.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  ) : f.t === 'select' ? (
    <select className="form-input" value={draft[f.l] ?? ''} onChange={(e) => setField(f.l, e.target.value)} style={inputStyle}>
      <option value="">-</option>
      {(f.options || []).map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  ) : f.t === 'dates' ? (
    <MultiDateInput value={draft[f.l] ?? ''} onChange={(v) => setField(f.l, v)} />
  ) : (
    <input className="form-input" type={f.t === 'date' ? 'date' : 'text'} value={draft[f.l] ?? ''} onChange={(e) => setField(f.l, e.target.value)} style={inputStyle} />
  );

  // Register with the shared navigation-away guard whenever this form is mounted/dirty;
  // the page header reads `editing`/`dirty` through editGuard.subscribe.
  // The callbacks close over the current draft, so they are refreshed every
  // render; the state is published only when it changes (publishing from a
  // deps-less effect re-rendered the App, which re-rendered this form, which
  // published again - a render loop).
  useEffect(() => {
    editGuard.save = save;
    editGuard.cancel = cancel;
    editGuard.startEdit = startEdit;
  });
  useEffect(() => {
    editGuard.editing = editing;
    editGuard.dirty = editing && dirty;
    editGuard.notify();
    return () => { editGuard.dirty = false; editGuard.editing = false; editGuard.notify(); };
  }, [editing, dirty]);

  return (
    <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
      {/* Flat rail (Neil, 10/28/2026): the look is .gt-toc-item in
          asset-styles.scoped.css - a hairline, the current section in ink. */}
      <nav className="gt-toc" aria-label="On This Page" style={{ position: 'sticky', top: 'calc(64px + var(--nx-announce-h, 0px))', flexShrink: 0, width: 178, display: 'flex', flexDirection: 'column' }}>
        <div style={{ ...labelStyle, fontWeight: 600, color: 'var(--text-primary)', padding: '2px 12px 10px' }}>On This Page</div>
        {nav.map(([key, title]) => (
          <button
            key={key}
            type="button"
            className="gt-toc-item"
            aria-current={current === key ? 'true' : undefined}
            onClick={() => jumpTo(key)}
          >
            {title}
          </button>
        ))}
      </nav>

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {editing && dirty && headerOff && (
          <div className="save-bar" style={{ position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 300, display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', background: 'var(--bg-card)', borderTop: '1px solid var(--border-color)', boxShadow: '0 -6px 20px rgba(0,0,0,0.18)' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '0.86rem', fontWeight: 700, color: 'var(--text-primary)' }}>You've made changes</div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Save before you leave this page</div>
            </div>
            <button className="secondary-btn" onClick={cancel} style={{ padding: '9px 14px', flexShrink: 0 }}>Cancel</button>
            <button className="primary-btn" onClick={save} style={{ padding: '9px 22px', flexShrink: 0 }}>Save Changes</button>
          </div>
        )}

        {asset.assembled && asset.parentId && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 13px', borderRadius: 11, border: '1px solid hsl(var(--color-purple) / 0.35)', backgroundColor: 'hsl(var(--color-purple) / 0.07)', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '0.82rem', fontWeight: 700, color: 'hsl(var(--color-purple))' }}>Parcel of {asset.siteName || 'an assembled asset'}</div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: 2, lineHeight: 1.45 }}>
                Project detail (ownership, financials, zoning, team) is managed on the assemblage. This page holds only the info specific to this parcel.
              </div>
            </div>
            {onOpenLead && (
              <button className="primary-btn" onClick={() => onOpenLead(asset.parentId)} style={{ flexShrink: 0, padding: '8px 14px', fontSize: '0.8rem' }}>
                Open Assemblage
              </button>
            )}
          </div>
        )}

        {!editing && <div style={{ fontSize: '0.98rem', fontWeight: 700, color: 'var(--text-primary)', margin: '4px 0 -6px' }}>Details</div>}
        {sections.map((sec, si) => {
          const all = sec.fields.map((f) => ({ ...f, value: formatFieldValue(f.raw, f.t), flagKey: (sec.title || '') + '~#~' + f.l }));
          const hasValue = (f) => String(f.value ?? '').trim() !== '';
          const filled = all.filter(hasValue).length;
          // Read mode: the filled fields, plus any empty one that is flagged or deep-linked.
          const open = editing || !!showEmpty[sec.title];
          const rows = open ? all : all.filter((f) => hasValue(f) || (onFlag && flagMap.has(f.flagKey)) || revealed.has(String(f.l).toLowerCase()) || (highlightField && String(f.l).toLowerCase() === highlightField));
          const hidden = all.length - rows.length;
          return (
          <section key={'sec' + si} id={'gt-sec' + si} style={sectionCardStyle}>
            {/* The card's own header, flat (no tinted band) - a hairline under it. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 18px 12px', borderBottom: '1px solid var(--border-color)' }}>
              <strong style={{ fontSize: '0.98rem', color: 'var(--text-primary)' }}>{sec.title}</strong>
              <span title="Fields with a value" style={{ marginLeft: 'auto', fontSize: '0.78rem', fontWeight: 600, color: filled === all.length ? 'hsl(var(--color-green))' : 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
                {filled} of {all.length}
              </span>
            </div>
            <div>
              {rows.map((f, fi) => {
                const label = f.l;
                const value = f.value;
                const isHighlighted = !editing && highlightField && String(label).toLowerCase() === highlightField;
                const isFlagged = onFlag && flagMap.has(f.flagKey);
                const menuOpen = flagMenu?.key === f.flagKey;

                return (
                  <div
                    key={label}
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
                        : <span style={{ fontSize: '0.85rem', fontWeight: 600, color: (value ?? '') === '' ? 'var(--text-muted)' : 'var(--text-primary)', wordBreak: 'break-word', fontVariantNumeric: 'tabular-nums' }}>
                          {(value ?? '') === '' ? '-' : f.unitLabel ? `${value} ${f.unitRaw}` : value}
                        </span>}

                    {/* The flag: a quiet icon that shows on hover (always on a touch
                        screen, always once flagged - asset-styles .gt-flag). A click
                        opens the reasons; a flagged one clears on click. */}
                    {onFlag ? (
                      <button
                        type="button"
                        ref={menuOpen ? flagBtnRef : undefined}
                        className={isFlagged ? 'gt-flag on' : 'gt-flag'}
                        aria-haspopup={isFlagged ? undefined : 'menu'}
                        aria-expanded={isFlagged ? undefined : menuOpen}
                        aria-label={isFlagged ? `Flagged: ${flagMap.get(f.flagKey) || 'Needs review'}. Clear the flag` : `Flag ${label} for review`}
                        title={isFlagged ? `Flagged (${flagMap.get(f.flagKey) || 'Needs review'}) - click to clear` : 'Flag this field for review'}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (isFlagged) onFlag(asset.id, sec.title, label);
                          else setFlagMenu(menuOpen ? null : { key: f.flagKey, section: sec.title, label });
                        }}
                        style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 7, border: 'none', cursor: 'pointer', justifySelf: 'end',
                          background: isFlagged ? 'hsla(var(--color-orange), 0.14)' : 'transparent', color: isFlagged ? 'hsl(var(--color-orange))' : 'var(--text-secondary)' }}
                      >
                        <Flag size={14} fill={isFlagged ? 'currentColor' : 'none'} />
                      </button>
                    ) : <span />}
                  </div>
                );
              })}
              {!editing && (hidden > 0 || showEmpty[sec.title]) && (
                <button
                  type="button"
                  onClick={() => setShowEmpty((m) => ({ ...m, [sec.title]: !m[sec.title] }))}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: '9px 18px', border: 'none', borderTop: rows.length ? '1px solid var(--border-color)' : 'none', background: 'none', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)', fontFamily: 'inherit', textAlign: 'left' }}
                >
                  {showEmpty[sec.title] ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  {showEmpty[sec.title] ? 'Hide empty fields' : `Show ${hidden} empty ${hidden === 1 ? 'field' : 'fields'}`}
                </button>
              )}
            </div>
          </section>
          );
        })}

        {onFlag && (
          <AnchoredMenu anchorRef={flagBtnRef} open={!!flagMenu} onClose={() => setFlagMenu(null)} align="end" minWidth={210}
            style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, boxShadow: 'var(--shadow-lg)', padding: 6 }}>
            <div style={{ padding: '6px 10px 4px', fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--text-secondary)' }}>Flag for Review</div>
            {FLAG_REASONS.map((r) => (
              <button key={r} type="button" role="menuitem"
                onClick={() => { const m = flagMenu; setFlagMenu(null); if (m) onFlag(asset.id, m.section, m.label, r); }}
                style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px', border: 'none', background: 'none', cursor: 'pointer', borderRadius: 7, fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', fontFamily: 'inherit' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--mist)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}>
                {r}
              </button>
            ))}
          </AnchoredMenu>
        )}

        {isProperty && (
          <div id="gt-map" style={{ scrollMarginTop: 108 }}>
            <PropertyMapLink p={asset} onSave={onSaveDetail} />
          </div>
        )}
        {isProperty && (
          <div id="gt-model" style={{ scrollMarginTop: 108 }}>
            <SiteModelSection p={asset} />
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
 *     section only - full detail lives on the lead parcel.
 *   - Property (normal or lead): live from PT, filtered by devStage (dev-only fields hide once
 *     Stabilized, unless actively editing) and by asset class (`okC` - storage/self-storage/
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
  // it's empty - a populated one must stay visible, otherwise a value the user saved (dev fields
  // are still editable in edit mode) silently disappears from the view and looks unsaved.
  const hasValue = (field) => String(resolveValue(field) ?? '').trim() !== '';
  // Pulls a field's paired unit-picker value (see Lot Size's unitKey/unitLabel in
  // propertyFields.js) alongside its own - resolved the same way as any other field, so it
  // reads live from the top-level record or falls back to the free-text snapshot.
  const withUnit = (f) => f.unitLabel
    ? { unitLabel: f.unitLabel, unitRaw: resolveValue({ label: f.unitLabel, key: f.unitKey }) || 'Acres' }
    : {};

  if (asset.assembled && asset.parentId) {
    const PARCEL_INFO_FIELDS = [
      { label: 'Property Address', key: 'address' },
      { label: 'City', key: 'city' },
      { label: 'County', key: 'county' },
      { label: 'State', key: 'state' },
      { label: 'Zip', key: 'zip' },
      { label: 'APN', key: 'apn' },
      { label: 'Lot Size (SF / Acres)', key: 'acreage', unitKey: 'acreageUnit', unitLabel: 'Lot Size Unit' },
      { label: 'Acquisition Price', type: 'money' },
      { label: 'Acquisition Date', type: 'date' },
      { label: 'Zoning', key: 'zoning' },
    ];
    return [{
      title: 'Parcel Information',
      fields: PARCEL_INFO_FIELDS.map((f) => ({ l: f.label, raw: resolveValue({ label: f.label, key: f.key, type: f.type }), t: f.type, key: f.key, ...withUnit(f) })),
    }];
  }

  return PT
    .filter((group) => (editing || !(stabilized && group.dev) || group.fields.some(hasValue)) && classAllowed(group.cls))
    .map((group) => ({
      title: group.group,
      fields: group.fields
        .filter((f) => (editing || !(stabilized && f.dev) || hasValue(f)) && classAllowed(f.cls) && f.key !== 'mapUrl' && !f.hidden)
        .map((f) => ({ l: f.label, raw: resolveValue(f), t: f.type, contact: f.contact, key: f.key, options: f.options, ...withUnit(f) })),
    }));
}
