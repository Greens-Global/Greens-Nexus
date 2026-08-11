// Egnyte module - the Wiring tab (manager+).
//
// Neil (Aug 6): the folder taxonomy lives in Egnyte; Nexus surfaces are WIRED
// to folders in it. This tab is where that wiring is changed - by any manager,
// in the UI, so re-pointing "where do a person's documents live" or "which
// roots hold properties" never needs a developer or a deploy.
//
// Redesigned for LAYPEOPLE (Visesh, Aug 11): every slot reads as a plain
// sentence about a screen someone knows ("Documents on a person's HR card"),
// the template renders as a breadcrumb with "filled in automatically" chips
// instead of {placeholder} jargon, and the mechanics (descriptions, overrides,
// editors) stay folded away until a row is opened. The slot list itself still
// comes from the server registry - nothing here is invented client-side.
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Building2, Cable, ChevronRight, FileSignature, FolderSearch, HardHat, Loader2,
  Pencil, Plus, RefreshCw, RotateCcw, Sparkles, Trash2, Users, X,
} from 'lucide-react';
import { api } from '../api';
import { dialog } from '../ui/dialog';
import FolderPickModal from './EgnyteFolderPick';
import { BODY, CARD, EgnyteDialog, ELLIPSIS, HEADING, Loading, Notice, ProblemNote } from './ui';

// ── plain-language layer ─────────────────────────────────────────────────────
// The backend registry stays the truth for WHICH slots exist; this maps each
// one onto words a non-technical manager recognizes. Unknown slots fall back
// to the server's own label/description, so a new slot is never invisible.

const FRIENDLY = {
  'people.person-folder': {
    title: "Documents on a person's HR card",
    plain: 'When HR opens someone on the People screen, the Documents section shows this Egnyte folder. It is the whole folder - including Confidential - so only HR ever sees it.',
  },
  'people.my-documents': {
    title: 'My Documents (what employees see)',
    plain: 'When someone opens My HR - My Documents, they see this folder: only the Contractor Documents part of their folder, never the Confidential folder next to it.',
  },
  'property.roots': {
    title: "Where property folders are found",
    plain: "When a property's documents open anywhere in Nexus, the property's folder is looked for in these places, in order. The first place that has it wins.",
  },
  'property.plans-subfolders': {
    title: 'The documents folder inside a property',
    plain: "Inside a property's folder, the documents live in the first of these subfolders that actually exists.",
  },
  'property.create-root': {
    title: 'New property folders go here',
    plain: 'When someone creates a folder for a property that has none yet, it is created inside this folder.',
  },
  'construction.root': {
    title: 'Construction photos without a property',
    plain: 'Daily-log photos from a construction project with no linked property land here, in a folder named after the project.',
  },
  'esign.default-folder': {
    title: 'Signed documents are filed here',
    plain: 'When a signed document is filed to Egnyte, it goes to this folder unless its template says otherwise.',
  },
};

// {placeholder} -> words. These render as tinted chips inside the breadcrumb.
const PLACEHOLDER_WORDS = {
  entity: 'Company', bucket: 'Employees or Contractors', person: "Person's name",
  email: 'Work email', property: 'Property name', project: 'Project name',
};

const GROUP_ICONS = [
  [/people/i, Users],
  [/property|asset/i, Building2],
  [/construction/i, HardHat],
  [/sign/i, FileSignature],
];
const groupIcon = (name) => (GROUP_ICONS.find(([re]) => re.test(name || ''))?.[1]) || Cable;

// One value -> breadcrumb rows. Comma-separated values (search roots, subfolder
// candidates) become numbered choices; placeholders become friendly chips.
function PathWords({ value }) {
  const parts = (value || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!parts.length) {
    return <span style={{ ...BODY, fontSize: 12.5, color: 'var(--wk-faint)' }}>Not set - this screen decides on its own.</span>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
      {parts.map((p, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', minWidth: 0 }}>
          {parts.length > 1 && (
            <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--wk-faint)', width: 44, flexShrink: 0 }}>
              {i === 0 ? '1st try' : `${i + 1}${i === 1 ? 'nd' : i === 2 ? 'rd' : 'th'} try`}
            </span>
          )}
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', minWidth: 0 }}>
            {p.split('/').filter(Boolean).map((seg, j) => {
              const m = seg.match(/^\{(\w+)\}$/);
              return (
                <span key={j} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  {j > 0 && <ChevronRight size={11} style={{ color: 'var(--wk-faint)' }} />}
                  {m ? (
                    <span title="Filled in automatically for each record" style={{ fontSize: 11.5, fontStyle: 'italic', fontWeight: 600, padding: '1px 7px', borderRadius: 99, background: 'color-mix(in srgb, var(--wk-brand) 9%, transparent)', color: 'var(--wk-brand)', whiteSpace: 'nowrap' }}>
                      {PLACEHOLDER_WORDS[m[1]] || m[1]}
                    </span>
                  ) : (
                    <span style={{ fontSize: 12.5, color: 'var(--wk-ink)', whiteSpace: 'nowrap' }}>{seg}</span>
                  )}
                </span>
              );
            })}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── shared editor (value + Browse) - unchanged mechanics ─────────────────────
function SlotEditor({ slot, initial, onSave, onCancel, saving, scopeId = '', people = null, scopeLabel }) {
  const [value, setValue] = useState(initial);
  const [scope, setScope] = useState(scopeId);
  const [picking, setPicking] = useState(false);
  const needsScope = people !== null && !scopeId;   // adding a NEW exception
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 0 2px' }}>
      {needsScope && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <label style={{ ...BODY, fontSize: 12.5, fontWeight: 600, color: 'var(--wk-ink)' }}>{scopeLabel || 'For person'}</label>
          <input
            className="form-input"
            list={`wiring-people-${slot}`}
            value={scope}
            onChange={e => setScope(e.target.value)}
            placeholder="Work email"
            style={{ flex: '1 1 240px', minWidth: 0 }}
          />
          <datalist id={`wiring-people-${slot}`}>
            {(people || []).map(p => <option key={p.email} value={p.email}>{p.name}</option>)}
          </datalist>
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <input
          className="form-input"
          value={value}
          onChange={e => setValue(e.target.value)}
          placeholder="/Shared/…"
          style={{ flex: '1 1 320px', minWidth: 0, fontFamily: 'ui-monospace, monospace', fontSize: 12.5 }}
        />
        <button type="button" className="secondary-btn" onClick={() => setPicking(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <FolderSearch size={13} /> Browse…
        </button>
        <button
          type="button" className="primary-btn"
          disabled={saving || !value.trim() || (needsScope && !scope.trim())}
          onClick={() => onSave(value.trim(), (scope || '').trim().toLowerCase())}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="secondary-btn" onClick={onCancel}>Cancel</button>
      </div>
      {picking && (
        <FolderPickModal
          startPath=""
          onPick={(p) => { setValue(p || '/Shared'); setPicking(false); }}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}

// ── one slot = one expandable row ────────────────────────────────────────────
function SlotRow({ spec, people, onChanged, last }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);        // false | 'default' | {scopeId, path}
  const [addingOverride, setAddingOverride] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const friendly = FRIENDLY[spec.slot] || {};
  const title = friendly.title || spec.label;
  const plain = friendly.plain || spec.description;
  const exceptions = spec.overrideRows || [];

  const save = async (path, scopeId) => {
    setSaving(true);
    setError('');
    try {
      await api.egnyteWiringSet(spec.slot, path, scopeId);
      setEditing(false);
      setAddingOverride(false);
      onChanged();
    } catch (e) {
      setError(e?.message || 'Could not save that.');
    } finally {
      setSaving(false);
    }
  };

  const reset = async (scopeId) => {
    setSaving(true);
    setError('');
    try {
      await api.egnyteWiringReset(spec.slot, scopeId);
      onChanged();
    } catch (e) {
      setError(e?.message || 'Could not reset that.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ borderBottom: last ? 'none' : '1px solid var(--wk-line2)' }}>
      {/* Collapsed: the sentence + where it points, one glance. */}
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', padding: '11px 12px', border: 'none', background: 'none', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', minWidth: 0 }}
      >
        <ChevronRight size={14} style={{ color: 'var(--wk-faint)', flexShrink: 0, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s ease' }} />
        <span style={{ flex: '0 1 285px', minWidth: 180, fontSize: 13.5, fontWeight: 600, color: 'var(--wk-ink)' }}>
          {title}
          {spec.customized && (
            <span style={{ marginLeft: 8, fontSize: 10.5, fontWeight: 700, padding: '2px 7px', borderRadius: 99, background: 'color-mix(in srgb, var(--wk-green) 12%, transparent)', color: 'var(--wk-green)', whiteSpace: 'nowrap' }}>
              Changed here
            </span>
          )}
        </span>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
          <PathWords value={spec.effective.path} />
        </span>
      </button>

      {open && (
        <div className="egx-tree-kids" style={{ padding: '0 12px 12px 38px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ ...BODY, fontSize: 12.5, maxWidth: 720 }}>{plain}</div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <button type="button" className="secondary-btn" onClick={() => setEditing(editing === 'default' ? false : 'default')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Pencil size={13} /> Change Folder
            </button>
            {spec.customized && (
              <button type="button" className="secondary-btn" disabled={saving} onClick={() => reset('')} title="Go back to the standard location" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <RotateCcw size={13} /> Reset to Standard
              </button>
            )}
          </div>

          {editing === 'default' && (
            <SlotEditor
              slot={spec.slot}
              initial={spec.effective.path}
              saving={saving}
              onSave={(path) => save(path, '')}
              onCancel={() => setEditing(false)}
            />
          )}

          {/* Exceptions (per-person overrides) */}
          {spec.overrides === 'person' && (
            <div style={{ borderTop: '1px solid var(--wk-line2)', paddingTop: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                <div style={{ ...BODY, fontSize: 12, fontWeight: 600, color: 'var(--wk-ink)' }}>
                  Exceptions
                  <span style={{ fontWeight: 400, color: 'var(--wk-faint)' }}> - people whose folder has a different name, pointed at it by hand</span>
                </div>
                <button type="button" className="secondary-btn" onClick={() => setAddingOverride(o => !o)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <Plus size={13} /> Add Exception
                </button>
              </div>
              {exceptions.length === 0 && !addingOverride && (
                <div style={{ ...BODY, fontSize: 12, color: 'var(--wk-faint)', padding: '6px 0' }}>None - everyone uses the standard location above.</div>
              )}
              {exceptions.map(r => (
                <div key={r.scopeId} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', minWidth: 0, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--wk-ink)', flexShrink: 0 }}>{r.scopeId}</span>
                  <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, color: 'var(--wk-dim)', flex: '1 1 220px', ...ELLIPSIS }} title={r.path}>{r.path}</span>
                  <button type="button" className="secondary-btn" disabled={saving} onClick={() => setEditing({ scopeId: r.scopeId, path: r.path })} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <Pencil size={12} /> Edit
                  </button>
                  <button type="button" className="secondary-btn" disabled={saving} onClick={() => reset(r.scopeId)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <X size={12} /> Remove
                  </button>
                </div>
              ))}
              {addingOverride && (
                <SlotEditor
                  slot={spec.slot}
                  initial=""
                  saving={saving}
                  people={people}
                  onSave={save}
                  onCancel={() => setAddingOverride(false)}
                />
              )}
              {editing && typeof editing === 'object' && (
                <SlotEditor
                  slot={spec.slot}
                  initial={editing.path}
                  scopeId={editing.scopeId}
                  saving={saving}
                  people={people}
                  onSave={(path) => save(path, editing.scopeId)}
                  onCancel={() => setEditing(false)}
                />
              )}
            </div>
          )}

          {error && <Notice tone="error" onDismiss={() => setError('')}>{error}</Notice>}
        </div>
      )}
    </div>
  );
}

// ── Folder Groups - friendly labels for rule-condition chips ─────────────────
const FIELD_LABELS = {
  entity_country: 'Country', company: 'Company', department: 'Department',
  division: 'Division', employment_type: 'Employment', status: 'Status',
  location: 'Location', pay_type: 'Pay cycle', pay_currency: 'Currency',
};
const VALUE_LABELS = { hourly: 'Biweekly (hourly)', fixed: 'Monthly (fixed)' };
const condLabel = (c) => `${FIELD_LABELS[c.field] || c.field}: ${VALUE_LABELS[c.value] || c.value}`;

function RuleChips({ rule }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      {(rule || []).map((c, i) => (
        <span key={i} style={{ fontSize: 11.5, fontWeight: 600, padding: '3px 9px', borderRadius: 99, background: 'var(--wk-hover, rgba(0,0,0,0.05))', color: 'var(--wk-ink)', whiteSpace: 'nowrap' }}>
          {condLabel(c)}
        </span>
      ))}
    </div>
  );
}

// Value labels for the dropdowns - raw stored values stay what the matcher
// expects; only the display is humanized.
const OPTION_LABELS = {
  hourly: 'Biweekly (hourly)', fixed: 'Monthly (fixed)',
  full_time: 'Full-time', part_time: 'Part-time', contractor: 'Contractor', intern: 'Intern',
  onboarding: 'Onboarding', active: 'Active', inactive: 'Inactive',
};
const optionLabel = (v) => OPTION_LABELS[v] || v;

// Dropdown-first group builder (Visesh, Aug 11: no AI required). Conditions
// come from RULE_FIELDS via /folder-groups/options, values from THIS company's
// data, membership previews live through /folder-groups/preview - all plain
// code. "Describe it in words" stays available as an optional AI assist that
// just fills the same dropdowns.
function FolderGroupDialog({ onClose, onSaved }) {
  const [options, setOptions] = useState(null);      // field -> [values]
  const [conds, setConds] = useState([{ field: 'entity_country', value: '' }]);
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [members, setMembers] = useState(null);
  const [suggestions, setSuggestions] = useState([]);
  const [previewing, setPreviewing] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.egnyteFolderGroupOptions().then(d => setOptions(d?.values || {})).catch(() => setOptions({}));
  }, []);

  const validConds = conds.filter(c => c.field && String(c.value || '').trim());
  const condsKey = JSON.stringify(validConds);

  // Live "who matches" preview, debounced so dropdown fiddling doesn't spam.
  useEffect(() => {
    if (!validConds.length) { setMembers(null); setSuggestions([]); return undefined; }
    const t = setTimeout(() => {
      setPreviewing(true);
      api.egnyteFolderGroupPreview(validConds)
        .then(d => {
          setMembers(d?.members || []);
          setSuggestions(d?.folderSuggestions || []);
          setPath(p => p || d?.folderSuggestions?.[0] || '');
        })
        .catch(() => {})
        .finally(() => setPreviewing(false));
    }, 450);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [condsKey]);

  const setCond = (i, patch) => setConds(cs => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const removeCond = (i) => setConds(cs => (cs.length > 1 ? cs.filter((_, j) => j !== i) : [{ field: cs[0].field, value: '' }]));
  const addCond = () => {
    const used = new Set(conds.map(c => c.field));
    const next = Object.keys(FIELD_LABELS).find(f => !used.has(f)) || 'department';
    setConds(cs => [...cs, { field: next, value: '' }]);
  };

  const makeDraft = async (e) => {
    e?.preventDefault();
    setDrafting(true);
    setError('');
    try {
      const d = await api.egnyteFolderGroupDraft(prompt.trim());
      // The AI just fills the same builder - the human still sees and can
      // change every condition before anything saves.
      setConds(d.rule?.length ? d.rule : conds);
      if (d.name && !name.trim()) setName(d.name);
      if (d.folderSuggestions?.length) { setSuggestions(d.folderSuggestions); setPath(p => p || d.folderSuggestions[0]); }
      setMembers(d.members || []);
      if (d.notes) setError(d.notes);
      setAiOpen(false);
    } catch (err) {
      setError(err?.message || 'Could not understand that - try rephrasing, or use the dropdowns.');
    } finally {
      setDrafting(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await api.egnyteFolderGroupCreate({ name: name.trim(), prompt: prompt.trim(), rule: validConds, path });
      onSaved();
    } catch (err) {
      setError(err?.message || 'Could not save the group.');
    } finally {
      setSaving(false);
    }
  };

  const valueChoices = (field) => options?.[field] || [];
  const freeText = (field) => field === 'location' || !valueChoices(field).length;

  return (
    <EgnyteDialog title="New Folder Group" onClose={onClose} width={680}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ ...BODY, fontSize: 12.5 }}>
          Pick who the group is for. Everyone who matches every condition - now or hired later -
          automatically gets their documents folder inside the group&apos;s folder.
        </div>

        {/* ── conditions ── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {conds.map((c, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ ...BODY, fontSize: 12, width: 34, textAlign: 'right', color: 'var(--wk-faint)', flexShrink: 0 }}>
                {i === 0 ? 'Where' : 'and'}
              </span>
              <select
                className="form-input"
                value={c.field}
                onChange={e => setCond(i, { field: e.target.value, value: '' })}
                style={{ flex: '0 1 170px', minWidth: 130 }}
              >
                {Object.entries(FIELD_LABELS).map(([f, label]) => <option key={f} value={f}>{label}</option>)}
              </select>
              <span style={{ ...BODY, fontSize: 12, color: 'var(--wk-faint)' }}>is</span>
              {freeText(c.field) ? (
                <input
                  className="form-input"
                  value={c.value}
                  onChange={e => setCond(i, { value: e.target.value })}
                  placeholder={c.field === 'location' ? 'Part of the location, e.g. Temecula' : 'Value'}
                  style={{ flex: '1 1 180px', minWidth: 120 }}
                />
              ) : (
                <select
                  className="form-input"
                  value={c.value}
                  onChange={e => setCond(i, { value: e.target.value })}
                  style={{ flex: '1 1 180px', minWidth: 120 }}
                >
                  <option value="">Choose…</option>
                  {valueChoices(c.field).map(v => <option key={v} value={v}>{optionLabel(v)}</option>)}
                </select>
              )}
              <button type="button" onClick={() => removeCond(i)} title="Remove condition" aria-label="Remove condition"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--wk-faint)', padding: 4, display: 'inline-flex', borderRadius: 5 }}>
                <X size={14} />
              </button>
            </div>
          ))}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <button type="button" className="secondary-btn" onClick={addCond} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Plus size={13} /> Add Condition
            </button>
            <button type="button" onClick={() => setAiOpen(o => !o)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--wk-brand)', fontSize: 12.5, fontWeight: 600, padding: 4, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <Sparkles size={13} /> Or describe it in words
            </button>
          </div>
          {aiOpen && (
            <form onSubmit={makeDraft} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <input
                className="form-input"
                autoFocus
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                placeholder="For example: contractors in the India office"
                style={{ flex: '1 1 280px', minWidth: 0 }}
              />
              <button type="submit" className="secondary-btn" disabled={drafting || prompt.trim().length < 8} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {drafting ? <Loader2 size={13} style={{ animation: 'spin 0.7s linear infinite' }} /> : <Sparkles size={13} />}
                {drafting ? 'Thinking…' : 'Fill the Dropdowns'}
              </button>
            </form>
          )}
        </div>

        {/* ── live membership preview ── */}
        <div style={{ ...BODY, fontSize: 12.5, minHeight: 18 }}>
          {previewing ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Loader2 size={12} style={{ animation: 'spin 0.7s linear infinite' }} /> Checking who matches…</span>
          ) : members === null ? (
            <span style={{ color: 'var(--wk-faint)' }}>Pick at least one condition to see who matches.</span>
          ) : (
            <>
              <Users size={12} style={{ verticalAlign: -2, marginRight: 5 }} />
              <strong style={{ color: 'var(--wk-ink)' }}>{members.length} {members.length === 1 ? 'person matches' : 'people match'} right now</strong>
              {members.length > 0 && (
                <span> - {members.slice(0, 10).map(m => m.name).join(', ')}{members.length > 10 ? ` +${members.length - 10} more` : ''}</span>
              )}
            </>
          )}
        </div>

        {/* ── name + folder ── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <label style={{ ...BODY, fontSize: 12.5, fontWeight: 600, color: 'var(--wk-ink)' }}>Group name</label>
          <input className="form-input" value={name} onChange={e => setName(e.target.value)}
            placeholder={validConds.length ? validConds.map(condLabel).join(' · ') : 'e.g. US Biweekly Team'}
            style={{ flex: '1 1 220px', minWidth: 0 }} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ ...BODY, fontSize: 12.5, fontWeight: 600, color: 'var(--wk-ink)' }}>Group folder <span style={{ fontWeight: 400, color: 'var(--wk-faint)' }}>- each person gets their subfolder inside it</span></div>
          {suggestions.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              {suggestions.map(p => (
                <button key={p} type="button" onClick={() => setPath(p)}
                  style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11.5, padding: '4px 9px', borderRadius: 8, cursor: 'pointer', border: path === p ? '1.5px solid var(--wk-brand, #16a34a)' : '1px solid var(--wk-line2, rgba(0,0,0,0.12))', background: path === p ? 'var(--wk-brand-tint, rgba(22,163,74,0.08))' : 'transparent', color: 'var(--wk-ink)' }}>
                  {p}
                </button>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <input
              className="form-input"
              value={path}
              onChange={e => setPath(e.target.value)}
              placeholder="/Shared/… - pick a suggestion, browse, or paste"
              style={{ flex: '1 1 260px', minWidth: 0, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
            />
            <button type="button" className="secondary-btn" onClick={() => setPicking(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <FolderSearch size={13} /> Browse…
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button type="button" className="primary-btn" disabled={saving || !validConds.length || !name.trim() || !path.trim()} onClick={save}>
            {saving ? 'Saving…' : 'Save Group'}
          </button>
          <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
        </div>

        {error && <Notice tone="error" onDismiss={() => setError('')}>{error}</Notice>}
      </div>
      {picking && (
        <FolderPickModal
          title={`Folder for ${name || 'the group'}`}
          startPath={path || ''}
          onPick={(p) => { setPath(p); setPicking(false); }}
          onClose={() => setPicking(false)}
        />
      )}
    </EgnyteDialog>
  );
}

function FolderGroups({ onWiringChanged }) {
  const [groups, setGroups] = useState(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [syncing, setSyncing] = useState('');
  const [syncResult, setSyncResult] = useState(null);

  const load = useCallback(() => {
    api.egnyteFolderGroups().then(d => setGroups(d?.groups || [])).catch(() => setGroups([]));
  }, []);
  useEffect(() => { load(); }, [load]);

  const remove = async (g) => {
    if (!await dialog.confirm(`Delete the folder group "${g.name}"? People it matched fall back to the standard location - no folders are deleted in Egnyte.`, { title: 'Delete folder group', confirmText: 'Delete', danger: true })) return;
    try { await api.egnyteFolderGroupDelete(g.id); load(); onWiringChanged?.(); }
    catch (err) { setError(err?.message || 'Could not delete the group.'); }
  };

  const sync = async (g) => {
    setSyncing(g.id);
    setSyncResult(null);
    setError('');
    try { setSyncResult({ id: g.id, ...(await api.egnyteFolderGroupSync(g.id)) }); }
    catch (err) { setError(err?.message || 'Sync failed.'); }
    finally { setSyncing(''); }
  };

  return (
    <div style={{ ...CARD, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 12px 10px', borderBottom: '1px solid var(--wk-line2)' }}>
        <Sparkles size={15} style={{ color: 'var(--wk-dim)', flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ ...HEADING, fontSize: 13.5 }}>Folder Groups</div>
          <div style={{ ...BODY, fontSize: 12 }}>
            Give a whole group of people (say, everyone in the US on biweekly pay) their folders in one place, automatically.
          </div>
        </div>
        <button type="button" className="primary-btn" onClick={() => setCreating(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <Plus size={13} /> New Folder Group
        </button>
      </div>

      {groups === null ? (
        <div style={{ ...BODY, fontSize: 12.5, padding: 12 }}>Loading…</div>
      ) : groups.length === 0 ? (
        <div style={{ ...BODY, fontSize: 12.5, padding: 12, color: 'var(--wk-faint)' }}>
          No groups yet. Press &ldquo;New Folder Group&rdquo; and describe one in plain words.
        </div>
      ) : groups.map((g, i) => (
        <div key={g.id} style={{ padding: '10px 12px', borderBottom: i === groups.length - 1 ? 'none' : '1px solid var(--wk-line2)', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', minWidth: 0 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--wk-ink)', flexShrink: 0 }}>{g.name}</span>
            <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 99, background: 'var(--wk-hover, rgba(0,0,0,0.05))', color: 'var(--wk-dim)', flexShrink: 0 }}>
              {g.memberCount} {g.memberCount === 1 ? 'person' : 'people'}
            </span>
            <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11.5, color: 'var(--wk-dim)', flex: '1 1 200px', ...ELLIPSIS }} title={g.path}>{g.path}</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
              <button type="button" className="secondary-btn" disabled={syncing === g.id} onClick={() => sync(g)} title="Create any missing person folders inside the group folder" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {syncing === g.id ? <Loader2 size={13} style={{ animation: 'spin 0.7s linear infinite' }} /> : <RefreshCw size={13} />} Sync Folders
              </button>
              <button type="button" className="secondary-btn" onClick={() => remove(g)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Trash2 size={13} /> Delete
              </button>
            </span>
          </div>
          <div style={{ marginTop: 5 }}><RuleChips rule={g.rule} /></div>
          {syncResult?.id === g.id && (
            <div style={{ ...BODY, fontSize: 12.5, marginTop: 6 }}>
              {syncResult.created.length
                ? <>Created {syncResult.created.length} folder{syncResult.created.length === 1 ? '' : 's'}: {syncResult.created.map(c => c.name).join(', ')}. </>
                : null}
              {syncResult.existing.length} already had folders.
              {syncResult.errors.length ? <span style={{ color: 'hsl(var(--color-red))' }}> {syncResult.errors.length} failed.</span> : null}
            </div>
          )}
        </div>
      ))}

      {error && <div style={{ padding: '0 12px 10px' }}><Notice tone="error" onDismiss={() => setError('')}>{error}</Notice></div>}

      {creating && (
        <FolderGroupDialog
          onClose={() => setCreating(false)}
          onSaved={() => { setCreating(false); load(); onWiringChanged?.(); }}
        />
      )}
    </div>
  );
}

export default function EgnyteWiring() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [people, setPeople] = useState([]);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    api.egnyteWiring()
      .then(d => setData(d))
      .catch(e => setError(e?.message || 'Could not load the wiring.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.getPeopleDirectory()
      .then(d => setPeople((d?.people || d || []).map(p => ({ email: (p.email || p.work_email || '').toLowerCase(), name: p.name || p.display_name || '' })).filter(p => p.email)))
      .catch(() => {});
  }, []);

  const groups = useMemo(() => {
    const out = new Map();
    for (const s of data?.slots || []) {
      if (!out.has(s.group)) out.set(s.group, []);
      out.get(s.group).push(s);
    }
    return [...out.entries()];
  }, [data]);

  if (loading) return <Loading label="Loading…" />;
  if (error) return <ProblemNote message={error} onRetry={load} />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
      <div style={{ ...CARD, padding: '12px 14px' }}>
        <div style={{ ...HEADING, fontSize: 14.5, display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
          <Cable size={15} /> Where Nexus Looks in Egnyte
        </div>
        <div style={{ ...BODY, fontSize: 12.5, maxWidth: 780 }}>
          Every row below is a screen in Nexus that shows files, and the Egnyte folder those files
          come from. Open a row to read what it does or point it at a different folder - the change
          takes effect within a minute, and nothing is moved or copied inside Egnyte.
        </div>
      </div>

      {groups.map(([group, slots]) => {
        const Icon = groupIcon(group);
        return (
          <div key={group} style={{ display: 'flex', flexDirection: 'column', gap: 7, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11.5, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--wk-faint)', paddingLeft: 2 }}>
              <Icon size={13} /> {group}
            </div>
            <div style={{ ...CARD, minWidth: 0 }}>
              {slots.map((s, i) => (
                <SlotRow key={s.slot} spec={s} people={people} onChanged={load} last={i === slots.length - 1} />
              ))}
            </div>
          </div>
        );
      })}

      <FolderGroups onWiringChanged={load} />
    </div>
  );
}
