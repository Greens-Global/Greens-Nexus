import { useState, useEffect, useRef } from 'react';
import { Flag } from 'lucide-react';
import AnchoredMenu from '../../../components/AnchoredMenu';
import { DateField } from '../../../tasks/components.jsx';
import { PT } from '../../lib/propertyFields.js';
import { inferAssetKind } from '../../lib/vehicleFields.js';
import { normLabel, formatFieldValue } from '../../lib/format.js';
import { STAGE_FORM, baseStage } from '../../lib/stages.js';
import { editGuard } from '../../lib/editGuard.js';
import { deriveType } from '../../lib/portfolioCards.js';
import { ContactCell } from '../shared/ContactCell.jsx';
import { MultiDateInput, toIsoDay } from '../shared/FieldInput.jsx';
import { companyIdOf, companyName, companyOptions } from '../../lib/companies.js';
import { egnyteFolderOf } from '../../lib/egnyteFolder.js';
import { EgnyteFolderInput } from './EgnyteFolderField.jsx';

const FLAG_REASONS = ['Appears Incorrect', 'Needs Verification', 'Outdated', 'Missing Info', 'Other'];

const labelStyle = { fontSize: 12, fontWeight: 400, color: 'var(--text-secondary)', lineHeight: 1.4 };
const inputStyle = { width: '100%', padding: '5px 9px', fontSize: 13 };
const linkBtn = { border: 'none', background: 'none', padding: 0, fontFamily: 'inherit', fontSize: 'inherit', fontWeight: 600, color: 'hsl(var(--color-green))', cursor: 'pointer' };
const sectionHead = { display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 14 };
const sectionTitle = { margin: 0, fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' };
// Shown in the title band above the details, so read mode does not repeat them.
const IN_TITLE_BAND = new Set(['Project Name', 'Development Stage']);
// A long "Not filled" list names this many, then "and N more".
const MISSING_SHOWN = 8;

/** "a, b and c" */
const listWords = (items) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

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
 *
 * The read look (Neil, 11/17/2026): no card per section - each section is a title, a "7 of 8
 * filled" count, its FILLED fields as label / value pairs in two columns, then one line
 * "Not filled: a, b. Fill In". A section with nothing filled folds into the one "Nothing
 * Recorded Yet" row at the end. An operating property (Stabilized) reads its fields under
 * Location, Site and Building and Ownership and Team (`displaySections` - display only; a
 * field's storage group `g` stays the flag key). Edit mode is the full form, every field, with
 * the On This Page rail beside it. `onFillIn(label?)` starts editing at a field (the page's
 * own start-edit, which also scrolls there); without it Fill In starts editing here.
 */
export function AssetDetailForm({ p: asset, highlight, onSaveDetail, onSaveContact, onOpenLead, onFlag, onFillIn, companies = [], canClearCompany = false, egnyteLocked = false }) {
  const flagMap = new Map((asset.reviewFlags || []).map((x) => [(x.g || '') + '~#~' + (x.f || ''), x.reason || '']));
  const isProperty = inferAssetKind(asset) === 'property';
  // Data Gaps chips name the completeness check, not always the row label.
  const FIELD_ALIASES = { 'insurance carrier': 'carrier', 'lot size': 'lot size (sf / acres)' };
  const SECTION_TARGETS = { photos: 'media' };
  const highlightRaw = (highlight?.field || '').toLowerCase();
  const highlightField = FIELD_ALIASES[highlightRaw] || highlightRaw;
  const highlightAt = highlight?.at || 0;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({});
  const [dirty, setDirty] = useState(false);
  // Empty fields a deep link scrolled to stay on screen after the 4s highlight ends.
  const [revealed, setRevealed] = useState(() => new Set());
  // The one flag menu: which row's button opened it ({ key, section, label }).
  const [flagMenu, setFlagMenu] = useState(null);
  const flagBtnRef = useRef(null);
  // The form stays mounted from one asset to the next (Open Assemblage, a Critical
  // Items row): the revealed rows and an open flag menu belong to the asset they
  // were opened on.
  useEffect(() => { setRevealed(new Set()); setFlagMenu(null); }, [asset.id]);

  const sections = displaySections(buildSections(asset, isProperty, editing), asset, isProperty);

  const nav = [...sections.map((sec, i) => ['sec' + i, sec.title]), ['media', 'Media']];
  const jumpTo = (key) => {
    const el = document.getElementById('gt-' + key);
    el && el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // Scroll-spy for the "On This Page" rail (edit mode): the first section (in rail order)
  // crossing the band just under the page header is the current one; between
  // two sections the last hit stays lit, and before any scroll the first is.
  const [current, setCurrent] = useState(null);
  const navKeys = nav.map(([key]) => key).join('|');
  useEffect(() => {
    if (!editing || typeof IntersectionObserver === 'undefined') return undefined;
    const keys = navKeys.split('|').filter(Boolean);
    const hits = new Map();
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => hits.set(en.target.id.slice(3), en.isIntersecting));
      const hit = keys.find((k) => hits.get(k));
      setCurrent((prev) => hit || prev || keys[0] || null);
    }, { rootMargin: '-96px 0px -55% 0px', threshold: 0 });
    keys.forEach((k) => { const el = document.getElementById('gt-' + k); el && io.observe(el); });
    return () => io.disconnect();
  }, [navKeys, asset.id, editing]);

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

  // Deep-link to a specific field (a search result, a flagged-field notice, a Key Details
  // gap, Fill In): scroll to it, and in edit mode put the cursor in it.
  useEffect(() => {
    if (!highlightField) return;
    if (highlightField === 'google maps link' && !editing) { jumpTo('map'); return; }
    if (SECTION_TARGETS[highlightField]) { jumpTo(SECTION_TARGETS[highlightField]); return; }
    setRevealed((r) => (r.has(highlightField) ? r : new Set([...r, highlightField])));
    const el = document.querySelector(`[data-fl="${highlightField}"]`);
    if (!el) return;
    el.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    if (editing) el.querySelector('input,select,textarea,button')?.focus?.({ preventScroll: true });
  }, [highlightField, highlightAt, editing]); // eslint-disable-line react-hooks/exhaustive-deps

  const startEdit = () => {
    if (editing) return;
    const d = {};
    // The draft is built from the FULL field set (edit mode shows dev-only fields too).
    displaySections(buildSections(asset, isProperty, true), asset, isProperty).forEach((sec) => sec.fields.forEach((f) => {
      d[f.l] = f.raw == null ? '' : String(f.raw);
      if (f.unitLabel) d[f.unitLabel] = f.unitRaw || 'Acres';
    }));
    setDraft(d);
    setEditing(true);
    setDirty(false);
  };
  const cancel = () => { setEditing(false); setDraft({}); setDirty(false); };
  const save = () => { onSaveDetail && onSaveDetail(draft); setEditing(false); setDraft({}); setDirty(false); };
  const fillIn = (label) => (onFillIn ? onFillIn(label) : startEdit());

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

  const renderEditInput = (f) => f.t === 'company' ? (() => {
    // The Company picker: the companies this person may assign (the server
    // checks the same rule on save); read-only when the asset sits in a
    // company outside theirs.
    const { options, locked } = companyOptions(companies, f.raw, canClearCompany);
    return (
      <select className="form-input" aria-label="Company" value={draft[f.l] ?? ''} disabled={locked}
        title={locked ? 'This asset belongs to a company outside yours - a Super Administrator can move it.' : undefined}
        onChange={(e) => setField(f.l, e.target.value)} style={inputStyle}>
        {options.map((o) => <option key={o.v || 'none'} value={o.v}>{o.l}</option>)}
      </select>
    );
  })() : f.t === 'egnyte' ? (
    // Connecting is one time (Neil, 11/05/2026): a connected folder is read only below an Owner.
    egnyteLocked ? (
      <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.45, wordBreak: 'break-word' }}>
        {egnyteFolderOf(asset)}
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Connected - only an Asset Management Owner can change it.</div>
      </div>
    ) : <EgnyteFolderInput assetId={asset.id} value={draft[f.l] ?? ''} onChange={(v) => setField(f.l, v)} />
  ) : f.unitLabel ? (
    <div style={{ display: 'flex', gap: 6 }}>
      <input className="form-input" type="text" aria-label={f.l} value={draft[f.l] ?? ''} onChange={(e) => setField(f.l, e.target.value)} style={{ ...inputStyle, flex: 1 }} />
      <select className="form-input" aria-label={f.unitLabel} value={draft[f.unitLabel] ?? 'Acres'} onChange={(e) => setField(f.unitLabel, e.target.value)} style={{ ...inputStyle, width: 84, flexShrink: 0 }}>
        <option value="Acres">Acres</option>
        <option value="SF">SF</option>
      </select>
    </div>
  ) : f.t === 'stage' ? (
    <select className="form-input" aria-label={f.l} value={draft[f.l] ?? ''} onChange={(e) => setField(f.l, e.target.value)} style={inputStyle}>
      <option value="">-</option>
      {STAGE_FORM.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  ) : f.t === 'select' ? (
    <select className="form-input" aria-label={f.l} value={draft[f.l] ?? ''} onChange={(e) => setField(f.l, e.target.value)} style={inputStyle}>
      <option value="">-</option>
      {(f.options || []).map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  ) : f.t === 'dates' ? (
    <MultiDateInput value={draft[f.l] ?? ''} onChange={(v) => setField(f.l, v)} />
  ) : f.t === 'date' && (!String(draft[f.l] ?? '').trim() || toIsoDay(draft[f.l])) ? (
    // The Nexus date box, never a native one (it follows the computer's region).
    <div className="form-input" role="group" aria-label={f.l} style={{ ...inputStyle, display: 'flex', alignItems: 'center' }}>
      <DateField value={toIsoDay(draft[f.l])} onChange={(v) => setField(f.l, v || '')} title={f.l} style={{ flex: 1 }} />
    </div>
  ) : (
    <input className="form-input" type="text" aria-label={f.l} value={draft[f.l] ?? ''} onChange={(e) => setField(f.l, e.target.value)} style={inputStyle} />
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

  // The flag: a quiet icon that shows on hover (always on a touch screen,
  // always once flagged - asset-styles .gt-flag). A click opens the reasons; a
  // flagged one clears on click. Company is a picker and the Egnyte Folder a
  // pin: nothing to flag on either.
  const flagButton = (f, sectionKey) => {
    if (!onFlag || f.t === 'company' || f.t === 'egnyte') return <span />;
    const isFlagged = flagMap.has(f.flagKey);
    const menuOpen = flagMenu?.key === f.flagKey;
    return (
      <button
        type="button"
        ref={menuOpen ? flagBtnRef : undefined}
        className={isFlagged ? 'gt-flag on' : 'gt-flag'}
        aria-haspopup={isFlagged ? undefined : 'menu'}
        aria-expanded={isFlagged ? undefined : menuOpen}
        aria-label={isFlagged ? `Flagged: ${flagMap.get(f.flagKey) || 'Needs review'}. Clear the flag` : `Flag ${f.l} for review`}
        title={isFlagged ? `Flagged (${flagMap.get(f.flagKey) || 'Needs review'}) - click to clear` : 'Flag this field for review'}
        onClick={(e) => {
          e.stopPropagation();
          if (isFlagged) onFlag(asset.id, sectionKey, f.l);
          else setFlagMenu(menuOpen ? null : { key: f.flagKey, section: sectionKey, label: f.l });
        }}
        style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 7, border: 'none', cursor: 'pointer', justifySelf: 'end',
          background: 'transparent', color: isFlagged ? 'hsl(var(--color-orange))' : 'var(--text-secondary)' }}
      >
        <Flag size={14} fill={isFlagged ? 'currentColor' : 'none'} />
      </button>
    );
  };

  const flagMenuNode = () => {
    if (!onFlag) return null;
    return (
      <AnchoredMenu anchorRef={flagBtnRef} open={!!flagMenu} onClose={() => setFlagMenu(null)} align="end" minWidth={210}
        style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, boxShadow: 'var(--shadow-lg)', padding: 6 }}>
        <div style={{ padding: '6px 10px 4px', fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>Flag for Review</div>
        {FLAG_REASONS.map((r) => (
          <button key={r} type="button" role="menuitem"
            onClick={() => { const m = flagMenu; setFlagMenu(null); if (m) onFlag(asset.id, m.section, m.label, r); }}
            style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px', border: 'none', background: 'none', cursor: 'pointer', borderRadius: 7, fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', fontFamily: 'inherit' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--mist)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}>
            {r}
          </button>
        ))}
      </AnchoredMenu>
    );
  };

  const prepared = sections.map((sec, si) => {
    const all = sec.fields.map((f) => ({ ...f, value: f.t === 'company' ? companyName(companies, f.raw) : formatFieldValue(f.raw, f.t), flagKey: (f.g || sec.title || '') + '~#~' + f.l }));
    const countable = editing ? all : all.filter((f) => !IN_TITLE_BAND.has(f.l));
    const hasValue = (f) => String(f.value ?? '').trim() !== '' && !(f.t === 'company' && !f.raw);
    const lc = (f) => String(f.l).toLowerCase();
    // Read mode: the filled fields, plus any empty one that is flagged or deep-linked.
    const shown = countable.filter((f) => hasValue(f) || (onFlag && flagMap.has(f.flagKey)) || revealed.has(lc(f)) || (highlightField && lc(f) === highlightField));
    const missing = countable.filter((f) => !shown.includes(f));
    return { sec, si, all, countable, shown, missing, filled: countable.filter(hasValue).length };
  });

  if (editing) {
    return (
      <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start' }}>
        {/* Flat rail (Neil, 10/28/2026): the look is .gt-toc-item in
            asset-styles.scoped.css - a hairline, the current section in ink. */}
        <nav className="gt-toc" aria-label="On This Page" style={{ position: 'sticky', top: 'calc(64px + var(--nx-announce-h, 0px))', flexShrink: 0, width: 178, display: 'flex', flexDirection: 'column' }}>
          <div style={{ ...labelStyle, fontWeight: 600, color: 'var(--text-primary)', padding: '2px 12px 10px' }}>On This Page</div>
          {nav.map(([key, title]) => (
            <button key={key} type="button" className="gt-toc-item" aria-current={current === key ? 'true' : undefined} onClick={() => jumpTo(key)}>
              {title}
            </button>
          ))}
        </nav>

        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          {dirty && headerOff && (
            <div className="save-bar" style={{ position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 300, display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', background: 'var(--bg-card)', borderTop: '1px solid var(--border-color)', boxShadow: '0 -6px 20px rgba(0,0,0,0.18)' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>You&apos;ve made changes</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Save before you leave this page</div>
              </div>
              <button className="secondary-btn" onClick={cancel} style={{ padding: '9px 14px', flexShrink: 0 }}>Cancel</button>
              <button className="primary-btn" onClick={save} style={{ padding: '9px 22px', flexShrink: 0 }}>Save Changes</button>
            </div>
          )}
          {prepared.map(({ sec, si, all }) => (
            <section key={'sec' + si} id={'gt-sec' + si} aria-labelledby={'gt-sec' + si + '-h'} style={{ padding: si ? '22px 0' : '0 0 22px', borderTop: si ? '1px solid var(--border-color)' : 'none', scrollMarginTop: 108 }}>
              <div style={sectionHead}><h3 id={'gt-sec' + si + '-h'} style={sectionTitle}>{sec.title}</h3></div>
              {all.map((f, fi) => (
                <div key={f.l} className="gt-frow gt-editing" data-fl={String(f.l).toLowerCase()}
                  style={{ display: 'grid', gridTemplateColumns: 'minmax(150px,34%) 1fr 44px', gap: 16, alignItems: 'center', padding: '7px 0', borderTop: fi ? '1px solid var(--border-color)' : 'none', scrollMarginTop: 80 }}>
                  <span style={{ ...labelStyle, fontSize: 13 }}>{f.l}</span>
                  {renderEditInput(f)}
                  {flagButton(f, f.g || sec.title)}
                </div>
              ))}
            </section>
          ))}
          {flagMenuNode()}
        </div>
      </div>
    );
  }

  const blank = prepared.filter((x) => x.shown.length === 0 && x.countable.length > 0);
  const told = prepared.filter((x) => x.shown.length > 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {asset.assembled && asset.parentId && (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', padding: '0 0 18px', marginBottom: 18, borderBottom: '1px solid var(--border-color)' }}>
          <p style={{ flex: '1 1 320px', margin: 0, fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            <b style={{ color: 'var(--text-primary)', fontWeight: 600 }}>Parcel of {asset.siteName || 'an assembled asset'}.</b>{' '}
            Ownership, financials, zoning and the team are kept on the assemblage; this page holds what is specific to this parcel.
          </p>
          {onOpenLead && <button type="button" className="secondary-btn" onClick={() => onOpenLead(asset.parentId)}>Open Assemblage</button>}
        </div>
      )}

      {told.map(({ sec, si, countable, shown, missing, filled }, ti) => (
        <section key={'sec' + si} id={'gt-sec' + si} aria-labelledby={'gt-sec' + si + '-h'}
          style={{ padding: ti ? '22px 0' : '0 0 22px', borderTop: ti ? '1px solid var(--border-color)' : 'none', scrollMarginTop: 108 }}>
          <div style={sectionHead}>
            <h3 id={'gt-sec' + si + '-h'} style={sectionTitle}>{sec.title}</h3>
            <span title="Fields with a value" style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
              {filled} of {countable.length} filled
            </span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))', columnGap: 40, rowGap: 12 }}>
            {shown.map((f) => {
              const isHighlighted = highlightField && String(f.l).toLowerCase() === highlightField;
              const empty = String(f.value ?? '').trim() === '';
              return (
                <div key={f.l} className="gt-frow" data-fl={String(f.l).toLowerCase()}
                  style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', columnGap: 6, alignItems: 'start', scrollMarginTop: 80, borderRadius: 6, margin: '-3px -6px', padding: '3px 6px', transition: 'background-color .3s',
                    background: isHighlighted ? 'hsla(var(--color-gold), 0.16)' : 'transparent' }}>
                  <span style={{ ...labelStyle, gridColumn: 1, gridRow: 1 }}>{f.l}</span>
                  <span style={{ gridColumn: 1, gridRow: 2, minWidth: 0 }}>
                    {f.t === 'egnyte' && !empty
                      ? <span style={{ fontSize: 13, color: 'var(--text-primary)', wordBreak: 'break-word' }}>{f.value}</span>
                      : f.contact && !empty
                        ? <ContactCell name={f.value} label={f.l} contacts={asset.contacts} onSave={onSaveContact} />
                        : empty
                          ? <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>Not filled</span>
                          : <span style={{ fontSize: 13, color: 'var(--text-primary)', wordBreak: 'break-word', fontVariantNumeric: 'tabular-nums' }}>{f.unitLabel ? `${f.value} ${String(f.unitRaw || '').toLowerCase() === 'sf' ? 'sf' : 'acres'}` : f.value}</span>}
                  </span>
                  <span style={{ gridColumn: 2, gridRow: '1 / 3', alignSelf: 'center' }}>{flagButton(f, f.g || sec.title)}</span>
                </div>
              );
            })}
          </div>
          {missing.length > 0 && (
            <p style={{ margin: '14px 0 0', fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              Not filled: {missing.slice(0, MISSING_SHOWN).map((f) => (f.t === 'egnyte' ? `${f.l} (matched by name)` : f.l)).join(', ')}
              {missing.length > MISSING_SHOWN ? ` and ${missing.length - MISSING_SHOWN} more` : ''}.{' '}
              <button type="button" onClick={() => fillIn(missing[0].l)} style={linkBtn} aria-label={`Fill in ${sec.title}`}>Fill In</button>
            </p>
          )}
        </section>
      ))}

      {blank.length > 0 && (
        <section aria-labelledby="gt-blank-h" style={{ padding: told.length ? '22px 0' : '0 0 22px', borderTop: told.length ? '1px solid var(--border-color)' : 'none' }}>
          <div style={sectionHead}><h3 id="gt-blank-h" style={sectionTitle}>Nothing Recorded Yet</h3></div>
          {blank.map(({ si }) => <span key={si} id={'gt-sec' + si} style={{ scrollMarginTop: 108 }} />)}
          <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>{listWords(blank.map(({ sec }) => sec.title))}.</p>
          <button type="button" onClick={() => fillIn(blank[0].countable[0]?.l)} style={{ ...linkBtn, fontSize: 13, marginTop: 10 }}>Add Details</button>
        </section>
      )}
      {flagMenuNode()}
    </div>
  );

}

// The operating property's sections (Neil, 11/17/2026): display names only - the PT groups,
// the snapshot and every flag key are untouched. A field moves to the section a reader
// looks for it in; the rest keep their group, in PT's order, after these three.
const OPERATING_ORDER = ['Location', 'Site and Building', 'Ownership and Team'];
const OPERATING_GROUP = { 'Project Details': 'Location', 'Site Data': 'Site and Building', 'Existing Improvements': 'Site and Building', 'Unit Mix': 'Site and Building', 'Project Team': 'Ownership and Team' };
const OPERATING_FIELD = {
  'Flood Zone': 'Location', 'Street Frontage': 'Location', Jurisdiction: 'Location', Zoning: 'Location',
  Company: 'Ownership and Team', 'Ownership Entity': 'Ownership and Team', 'Egnyte Folder': 'Ownership and Team',
};

/** Sections as read: an operating property's fields regrouped under the three names above. */
export function displaySections(sections, asset, isProperty) {
  if (!isProperty || (asset.assembled && asset.parentId) || baseStage(asset.devStage) !== 'Stabilized') return sections;
  const out = new Map(OPERATING_ORDER.map((t) => [t, { title: t, fields: [] }]));
  sections.forEach((sec) => {
    sec.fields.forEach((f) => {
      const t = OPERATING_FIELD[f.l] || OPERATING_GROUP[sec.title] || sec.title;
      if (!out.has(t)) out.set(t, { title: t, fields: [] });
      out.get(t).fields.push(f);
    });
  });
  return [...out.values()].filter((s) => s.fields.length);
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
  // Every asset class carries the Company field (11/03/2026) - on a vehicle or
  // a piece of equipment it leads the first section (their snapshot has no row
  // for it; App.jsx saveDetail writes it to `companyId`, never the snapshot).
  const companyField = { l: 'Company', raw: companyIdOf(asset), t: 'company', key: 'companyId', g: 'Details' };
  if (!isProperty) {
    const groups = (asset.snapshot && asset.snapshot.length)
      ? asset.snapshot.map((g) => ({
          title: g.group,
          fields: (g.fields || []).map((f) => ({ l: String(f.label || '').trim(), raw: f.value, g: g.group })),
        }))
      : [{ title: 'Details', fields: [] }];
    return [{ ...groups[0], fields: [companyField, ...groups[0].fields.filter((f) => f.l !== 'Company')] }, ...groups.slice(1)];
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
    if (field.type === 'company') return companyIdOf(asset);
    if (field.type === 'egnyte') return egnyteFolderOf(asset);
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
      { label: 'Company', key: 'companyId', type: 'company' },
      { label: 'Property Address', key: 'address' },
      { label: 'City', key: 'city' },
      { label: 'County', key: 'county' },
      { label: 'State', key: 'state' },
      { label: 'Zip', key: 'zip' },
      { label: 'APN', key: 'apn' },
      { label: 'Egnyte Folder', key: 'egnyteFolder', type: 'egnyte' },
      { label: 'Lot Size (SF / Acres)', key: 'acreage', unitKey: 'acreageUnit', unitLabel: 'Lot Size Unit' },
      { label: 'Acquisition Price', type: 'money' },
      { label: 'Acquisition Date', type: 'date' },
      { label: 'Zoning', key: 'zoning' },
    ];
    return [{
      title: 'Parcel Information',
      fields: PARCEL_INFO_FIELDS.map((f) => ({ l: f.label, raw: resolveValue({ label: f.label, key: f.key, type: f.type }), t: f.type, key: f.key, g: 'Parcel Information', ...withUnit(f) })),
    }];
  }

  return PT
    .filter((group) => (editing || !(stabilized && group.dev) || group.fields.some(hasValue)) && classAllowed(group.cls))
    .map((group) => ({
      title: group.group,
      fields: group.fields
        // The Google Maps Link is edited here; read mode shows the map instead (never the URL).
        .filter((f) => (editing || !(stabilized && f.dev) || hasValue(f)) && classAllowed(f.cls) && (editing || f.key !== 'mapUrl') && !f.hidden)
        .map((f) => ({ l: f.label, raw: resolveValue(f), t: f.type, contact: f.contact, key: f.key, options: f.options, g: group.group, ...withUnit(f) })),
    }));
}
