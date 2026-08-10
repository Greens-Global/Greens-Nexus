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
import { Cable, FolderSearch, Pencil, Plus, RotateCcw, X } from 'lucide-react';
import { api } from '../api';
import FolderPickModal from './EgnyteFolderPick';
import { BODY, CARD, ELLIPSIS, HEADING, Loading, Notice, ProblemNote } from './ui';

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
      {groups.map(([group, slots]) => (
        <div key={group} style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
          <div style={{ ...BODY, fontSize: 11.5, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--wk-faint)' }}>{group}</div>
          {slots.map(s => <SlotCard key={s.slot} spec={s} people={people} onChanged={load} />)}
        </div>
      ))}
    </div>
  );
}
