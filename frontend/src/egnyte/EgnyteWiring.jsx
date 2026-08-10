// Egnyte module - the Wiring tab (manager+).
//
// Neil (Aug 6): the folder taxonomy lives in Egnyte; Nexus surfaces are WIRED
// to folders in it. This tab is where that wiring is changed - by any manager,
// in the UI, so re-pointing "where do a person's documents live" or "which
// roots hold properties" never needs a developer or a deploy.
//
// Each card is one slot the backend actually consumes (the list comes from the
// server's registry - nothing here is invented client-side). A slot shows its
// effective value and where it came from (custom / env / default). Paths can
// be typed, or picked by browsing Egnyte. Person-scoped slots also take
// per-person overrides for folders whose names don't match the template.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Cable, FolderSearch, Loader2, Pencil, Plus, RefreshCw, RotateCcw, Sparkles, Trash2, Users, X } from 'lucide-react';
import { api } from '../api';
import { dialog } from '../ui/dialog';
import FolderPickModal from './EgnyteFolderPick';
import { BODY, CARD, ELLIPSIS, HEADING, Loading, Notice, ProblemNote } from './ui';

// Friendly labels for rule-condition chips - mirrors backend RULE_FIELDS.
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

// ── Folder Groups: describe a cohort in plain English, the AI turns it into a
// rule, a real folder gets attached, and every matching person (current and
// future) is wired to their subfolder inside it. The whole point is that
// nobody edits templates or per-person overrides for cohorts.
function FolderGroups({ onWiringChanged }) {
  const [groups, setGroups] = useState(null);
  const [prompt, setPrompt] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [draft, setDraft] = useState(null);        // {name, rule, notes, members, folderSuggestions, path?}
  const [saving, setSaving] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState('');
  const [syncing, setSyncing] = useState('');      // group id being synced
  const [syncResult, setSyncResult] = useState(null); // {id, created, existing, errors}

  const load = useCallback(() => {
    api.egnyteFolderGroups().then(d => setGroups(d?.groups || [])).catch(() => setGroups([]));
  }, []);
  useEffect(() => { load(); }, [load]);

  const makeDraft = async (e) => {
    e?.preventDefault();
    setDrafting(true);
    setError('');
    try {
      const d = await api.egnyteFolderGroupDraft(prompt.trim());
      setDraft({ ...d, path: d.folderSuggestions?.[0] || '' });
    } catch (err) {
      setError(err?.message || 'Could not understand that - try rephrasing.');
    } finally {
      setDrafting(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await api.egnyteFolderGroupCreate({ name: draft.name, prompt: prompt.trim(), rule: draft.rule, path: draft.path });
      setDraft(null);
      setPrompt('');
      load();
      onWiringChanged?.();
    } catch (err) {
      setError(err?.message || 'Could not save the group.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (g) => {
    if (!await dialog.confirm(`Delete the folder group "${g.name}"? People it matched fall back to the standard wiring - no folders are deleted in Egnyte.`, { title: 'Delete folder group', confirmText: 'Delete', danger: true })) return;
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
      <div style={{ ...BODY, fontSize: 11.5, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--wk-faint)' }}>Folder Groups</div>

      {/* Prompt box */}
      <div style={{ ...CARD, padding: 14 }}>
        <div style={{ ...HEADING, fontSize: 13.5, display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <Sparkles size={15} /> Create a Folder Group
        </div>
        <div style={{ ...BODY, fontSize: 12.5, marginBottom: 10 }}>
          Describe who the group is for, in plain words. Every person who matches - now or hired
          later - gets their documents folder inside the group&apos;s folder automatically.
        </div>
        <form onSubmit={makeDraft} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <input
            className="form-input"
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            placeholder='For example: people working from the US with biweekly salary'
            style={{ flex: '1 1 340px', minWidth: 0 }}
          />
          <button type="submit" className="primary-btn" disabled={drafting || prompt.trim().length < 8} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {drafting ? <Loader2 size={13} style={{ animation: 'spin 0.7s linear infinite' }} /> : <Sparkles size={13} />}
            {drafting ? 'Thinking…' : 'Create With AI'}
          </button>
        </form>

        {/* Draft review - the human confirms what the AI understood before anything saves */}
        {draft && (
          <div style={{ marginTop: 12, borderTop: '1px solid var(--wk-line, rgba(0,0,0,0.08))', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <label style={{ ...BODY, fontSize: 12.5, fontWeight: 600, color: 'var(--wk-ink)' }}>Group name</label>
              <input className="form-input" value={draft.name} onChange={e => setDraft(d => ({ ...d, name: e.target.value }))} style={{ flex: '1 1 220px', minWidth: 0 }} />
            </div>
            <RuleChips rule={draft.rule} />
            {draft.notes && <div style={{ ...BODY, fontSize: 12, color: 'var(--wk-faint)' }}>{draft.notes}</div>}
            <div style={{ ...BODY, fontSize: 12.5 }}>
              <Users size={12} style={{ verticalAlign: -2, marginRight: 5 }} />
              <strong style={{ color: 'var(--wk-ink)' }}>{draft.members.length} {draft.members.length === 1 ? 'person matches' : 'people match'} right now</strong>
              {draft.members.length > 0 && (
                <span> - {draft.members.slice(0, 10).map(m => m.name).join(', ')}{draft.members.length > 10 ? ` +${draft.members.length - 10} more` : ''}</span>
              )}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ ...BODY, fontSize: 12.5, fontWeight: 600, color: 'var(--wk-ink)' }}>Group folder</div>
              {(draft.folderSuggestions || []).length > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  {draft.folderSuggestions.map(p => (
                    <button key={p} type="button" onClick={() => setDraft(d => ({ ...d, path: p }))}
                      style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11.5, padding: '4px 9px', borderRadius: 8, cursor: 'pointer', border: draft.path === p ? '1.5px solid var(--wk-brand, #16a34a)' : '1px solid var(--wk-line2, rgba(0,0,0,0.12))', background: draft.path === p ? 'var(--wk-brand-tint, rgba(22,163,74,0.08))' : 'transparent', color: 'var(--wk-ink)' }}>
                      {p}
                    </button>
                  ))}
                </div>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <input
                  className="form-input"
                  value={draft.path}
                  onChange={e => setDraft(d => ({ ...d, path: e.target.value }))}
                  placeholder="/Shared/… - pick a suggestion, browse, or paste"
                  style={{ flex: '1 1 300px', minWidth: 0, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
                />
                <button type="button" className="secondary-btn" onClick={() => setPicking(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <FolderSearch size={13} /> Browse…
                </button>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button type="button" className="primary-btn" disabled={saving || !draft.name.trim() || !draft.path.trim()} onClick={save}>
                {saving ? 'Saving…' : 'Save Group'}
              </button>
              <button type="button" className="secondary-btn" onClick={() => setDraft(null)}>Discard</button>
            </div>
          </div>
        )}
        {error && <div style={{ marginTop: 8 }}><Notice tone="error" onDismiss={() => setError('')}>{error}</Notice></div>}
      </div>

      {/* Existing groups */}
      {(groups || []).map(g => (
        <div key={g.id} style={{ ...CARD, padding: 14, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ minWidth: 0, flex: '1 1 260px', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ ...HEADING, fontSize: 13.5, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                {g.name}
                <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 99, background: 'var(--wk-hover, rgba(0,0,0,0.05))', color: 'var(--wk-dim)' }}>
                  {g.memberCount} {g.memberCount === 1 ? 'person' : 'people'}
                </span>
              </div>
              {g.prompt && <div style={{ ...BODY, fontSize: 12, fontStyle: 'italic', color: 'var(--wk-faint)' }}>&ldquo;{g.prompt}&rdquo;</div>}
              <RuleChips rule={g.rule} />
              <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11.5, color: 'var(--wk-dim)', ...ELLIPSIS }} title={g.path}>{g.path}</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
              <button type="button" className="secondary-btn" disabled={syncing === g.id} onClick={() => sync(g)} title="Create any missing person folders inside the group folder" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {syncing === g.id ? <Loader2 size={13} style={{ animation: 'spin 0.7s linear infinite' }} /> : <RefreshCw size={13} />} Sync Folders
              </button>
              <button type="button" className="secondary-btn" onClick={() => remove(g)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Trash2 size={13} /> Delete
              </button>
            </div>
          </div>
          {syncResult?.id === g.id && (
            <div style={{ ...BODY, fontSize: 12.5, marginTop: 8 }}>
              {syncResult.created.length
                ? <>Created {syncResult.created.length} folder{syncResult.created.length === 1 ? '' : 's'}: {syncResult.created.map(c => c.name).join(', ')}. </>
                : null}
              {syncResult.existing.length} already had folders.
              {syncResult.errors.length ? <span style={{ color: 'hsl(var(--color-red))' }}> {syncResult.errors.length} failed.</span> : null}
            </div>
          )}
        </div>
      ))}

      {picking && draft && (
        <FolderPickModal
          title={`Folder for ${draft.name || 'the group'}`}
          startPath={draft.path || ''}
          onPick={(p) => { setDraft(d => ({ ...d, path: p })); setPicking(false); }}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}

const SOURCE_LABEL = {
  custom:  { text: 'Set here',        color: 'var(--color-green, 150 60% 40%)' },
  env:     { text: 'Server setting',  color: 'var(--color-orange, 30 90% 45%)' },
  default: { text: 'Built-in default', color: '' },
};

function SourceChip({ source }) {
  const meta = SOURCE_LABEL[source] || SOURCE_LABEL.default;
  return (
    <span style={{
      fontSize: 10.5, fontWeight: 700, letterSpacing: 0.3, textTransform: 'uppercase',
      padding: '2px 7px', borderRadius: 99, whiteSpace: 'nowrap',
      background: meta.color ? `hsla(${meta.color}, 0.12)` : 'var(--wk-hover, rgba(0,0,0,0.05))',
      color: meta.color ? `hsl(${meta.color})` : 'var(--wk-dim)',
    }}>
      {meta.text}
    </span>
  );
}

// One slot's editor row: text value + Browse. For template slots the picked
// folder replaces the whole value (placeholders can then be typed back in),
// which is honest - a picker cannot know where the template part starts.
function SlotEditor({ slot, initial, onSave, onCancel, saving, scopeId = '', people = null, scopeLabel }) {
  const [value, setValue] = useState(initial);
  const [scope, setScope] = useState(scopeId);
  const [picking, setPicking] = useState(false);
  const needsScope = people !== null && !scopeId;   // adding a NEW override
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
          {saving ? 'Saving…' : 'Save Wiring'}
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

function SlotCard({ spec, people, onChanged }) {
  const [editing, setEditing] = useState(false);        // false | 'default' | {scopeId}
  const [addingOverride, setAddingOverride] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const save = async (path, scopeId) => {
    setSaving(true);
    setError('');
    try {
      await api.egnyteWiringSet(spec.slot, path, scopeId);
      setEditing(false);
      setAddingOverride(false);
      onChanged();
    } catch (e) {
      setError(e?.message || 'Could not save that wiring.');
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
      setError(e?.message || 'Could not reset that wiring.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ ...CARD, padding: 14, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0, flex: '1 1 260px' }}>
          <div style={{ ...HEADING, fontSize: 13.5, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {spec.label} <SourceChip source={spec.effective.source} />
          </div>
          <div style={{ ...BODY, fontSize: 12, marginTop: 3 }}>{spec.description}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          {spec.customized && (
            <button type="button" className="secondary-btn" disabled={saving} onClick={() => reset('')} title="Back to the server/default value" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <RotateCcw size={13} /> Reset
            </button>
          )}
          <button type="button" className="secondary-btn" onClick={() => setEditing(editing === 'default' ? false : 'default')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Pencil size={13} /> Edit
          </button>
        </div>
      </div>

      <div style={{ marginTop: 8, padding: '7px 10px', borderRadius: 8, background: 'var(--wk-hover, rgba(0,0,0,0.04))', fontFamily: 'ui-monospace, monospace', fontSize: 12.5, color: 'var(--wk-ink)', overflowX: 'auto', whiteSpace: 'nowrap' }}>
        {spec.effective.path || <span style={{ color: 'var(--wk-faint)' }}>(not set - surface decides on its own)</span>}
      </div>

      {spec.placeholders?.length > 0 && (
        <div style={{ ...BODY, fontSize: 11.5, color: 'var(--wk-faint)', marginTop: 6 }}>
          Placeholders filled per person: {spec.placeholders.map(p => `{${p}}`).join('  ')}
        </div>
      )}

      {editing === 'default' && (
        <SlotEditor
          slot={spec.slot}
          initial={spec.effective.path}
          saving={saving}
          onSave={(path) => save(path, '')}
          onCancel={() => setEditing(false)}
        />
      )}

      {/* ── per-person overrides ── */}
      {spec.overrides === 'person' && (
        <div style={{ marginTop: 10, borderTop: '1px solid var(--wk-line, rgba(0,0,0,0.08))', paddingTop: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <div style={{ ...BODY, fontSize: 12, fontWeight: 600, color: 'var(--wk-ink)' }}>
              Per-person overrides
              <span style={{ fontWeight: 400, color: 'var(--wk-faint)' }}> - for folders the template can't find by name</span>
            </div>
            <button type="button" className="secondary-btn" onClick={() => setAddingOverride(o => !o)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Plus size={13} /> Add Override
            </button>
          </div>
          {(spec.overrideRows || []).map(r => (
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

      {error && <div style={{ marginTop: 8 }}><Notice tone="error" onDismiss={() => setError('')}>{error}</Notice></div>}
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

  if (loading) return <Loading label="Loading the wiring…" />;
  if (error) return <ProblemNote message={error} onRetry={load} />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
      <div style={{ ...CARD, padding: 14 }}>
        <div style={{ ...HEADING, fontSize: 14.5, display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <Cable size={16} /> Egnyte Wiring
        </div>
        <div style={{ ...BODY, fontSize: 12.5 }}>
          Each entry below is a place in Nexus that reads or writes Egnyte, and the folder it is
          wired to. Changes apply within about a minute - no deploy, no developer. The folder
          taxonomy itself still lives in Egnyte; this only points Nexus at it.
        </div>
      </div>
      <FolderGroups onWiringChanged={load} />
      {groups.map(([group, slots]) => (
        <div key={group} style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
          <div style={{ ...BODY, fontSize: 11.5, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--wk-faint)' }}>{group}</div>
          {slots.map(s => <SlotCard key={s.slot} spec={s} people={people} onChanged={load} />)}
        </div>
      ))}
    </div>
  );
}
