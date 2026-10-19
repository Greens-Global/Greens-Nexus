// Settings > Ticket Manager > Help Topics (Pranshu, Sep 30): which choices
// "What do you need help with?" offers for each department on Submit a
// Ticket. It was a compiled-in default (ticket_taxonomy.DEFAULT_HELP_TOPICS);
// this is where an admin changes it - add, rename, remove and drag to reorder
// a department's topics.
//
// Each topic still carries a service area (the queue's Service Area filter
// and reports group by it), but it is no longer picked here (Pranshu, Oct 1:
// the column did not help anyone). A topic keeps the area it has; a new one
// files under General. The defaults in ticket_taxonomy.py set the areas.
//
// Stored as the taxonomy config's `helpTopics` groups, matched to a ticket
// department by NAME (departments are per-company rows, so a key would not
// carry across companies): two companies' "IT" share one list. A department
// with no topics asks the requester to type what it is about instead.
//
// Sub-options (Neil, Oct 1 2026): a topic may carry a short "Which one?"
// list - Microsoft -> Outlook, Teams, OneDrive; Nexus -> its modules. Edited
// per topic below the topic list (its own drag list, so the two lists' drags
// never mix). Optional for the requester; a topic without any asks nothing more.
//
// Default assignee (Oct 2026, backend/ticket_auto_assign.py): a topic may
// name who a new ticket about it goes straight to, chosen per company (the
// topic list is shared by every company with a department of that name).
// It wins over the department's own default (Routing & Escalation). The
// server checks the person is on that company's desk, and keeps another
// company's choice - which this screen is not shown - exactly as it was.
//
// Manager+ only, like the SLA & Ticket Types panel next to it; the backend's
// require_manager on the save is the real boundary.
import { useEffect, useMemo, useState } from 'react';
import { Plus, Save, RotateCcw, X, Tags, ListTree, UserCheck } from 'lucide-react';
import { LoadingState } from '../components/AsyncState';
import { api } from '../api';
import { useRole } from '../contexts/RoleContext';
import { NX, FONT, btn, input as inputStyle, card } from '../tasks/theme';
import { TOPIC_MAX_LEN } from './ticketMeta';
import { refreshTicketConfig } from './ticketConfig';
import DragList from './DragList';
import { PersonSelect, usePeople } from '../tasks/components';
import { useDeskAgents, agentOptions } from './deskAgents';

let _seq = 0;
const tid = () => `t${++_seq}`;
const norm = (s) => (s || '').trim().toLowerCase();

// Current department names (unique, case-insensitive, in desk order) -> their
// topic lists, read out of the saved groups. Also returns the groups (or the
// parts of groups) that match NO current department, so saving never throws
// away a list that belongs to a department about to be renamed back.
function buildState(groups, depts) {
  const names = [];
  const seen = new Set();
  for (const d of depts) {
    const k = norm(d.name);
    if (k && !seen.has(k)) { seen.add(k); names.push(d.name.trim()); }
  }
  const lists = {};
  for (const n of names) {
    const g = (groups || []).find((x) => (x.departments || []).includes(norm(n)));
    lists[norm(n)] = (g?.topics || []).map((tp) => ({
      id: tid(), name: tp.name || '', area: tp.area || 'general',
      options: (Array.isArray(tp.options) ? tp.options : []).map((o) => ({ id: tid(), name: String(o || '') })),
      defaultAssignees: (tp.defaultAssignees && typeof tp.defaultAssignees === 'object') ? { ...tp.defaultAssignees } : {},
      // Intake questions are edited elsewhere, but must travel with the topic -
      // a save without them used to wipe every topic's questions.
      ...(Array.isArray(tp.questions) ? { questions: tp.questions } : {}),
    }));
  }
  const orphans = (groups || [])
    .map((g) => ({ ...g, departments: (g.departments || []).filter((a) => !seen.has(a)) }))
    .filter((g) => g.departments.length && (g.topics || []).length);
  return { names, lists, orphans };
}

export default function TicketHelpTopicsSettings() {
  const { myLevel } = useRole();
  const [depts, setDepts] = useState([]);
  const [state, setState] = useState(null);     // { names, lists, orphans }
  const [sel, setSel] = useState('');           // normalized department name
  const [newTopic, setNewTopic] = useState('');
  const [optFor, setOptFor] = useState(null);   // id of the topic whose sub-options are open
  const [newOption, setNewOption] = useState('');
  const [asgFor, setAsgFor] = useState(null);   // id of the topic whose default assignees are open
  const [companies, setCompanies] = useState([]);
  const people = usePeople();
  const asgCompanyIds = useMemo(() => (state && sel ? companies.filter((c) => depts.some((d) => d.companyId === c.id && norm(d.name) === sel)).map((c) => c.id) : []),
    [state, sel, companies, depts]);
  const deskAgents = useDeskAgents(asgFor ? asgCompanyIds : []);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');

  const apply = (groups, ds) => {
    const next = buildState(groups, ds);
    setState(next);
    setSel((cur) => (cur && next.lists[cur] ? cur : norm(next.names[0])));
  };
  const load = () => Promise.all([api.getTicketTaxonomySettings(), api.getTicketDepartments()])
    .then(([cfg, ds]) => {
      // Deleted from the company's department list - nothing to set up for.
      const live = (ds || []).filter((d) => !d.removed);
      setDepts(live);
      apply(cfg.helpTopics || [], live);
    })
    .catch((e) => setErr(e.message || String(e)));
  useEffect(() => {
    load();
    api.getTicketCompanies().then((rows) => setCompanies(Array.isArray(rows) ? rows : [])).catch(() => {});
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps -- once, on mount

  const topics = useMemo(() => (state && sel ? state.lists[sel] || [] : []), [state, sel]);
  const setTopics = (next) => setState((s) => ({ ...s, lists: { ...s.lists, [sel]: next } }));

  if (myLevel < 3) {
    return <div style={{ padding: 40, textAlign: 'center', color: NX.faint, fontSize: 13.5 }}>Manager access or above is required to edit help topics.</div>;
  }
  if (!state) return err ? <div style={{ padding: 24, fontSize: 13, color: NX.faint }}>{err}</div> : <LoadingState />;

  const selName = state.names.find((n) => norm(n) === sel) || '';
  const dup = (name, id) => topics.some((tp) => tp.id !== id && norm(tp.name) === norm(name));
  const addTopic = () => {
    const n = newTopic.trim();
    if (!n || dup(n)) return;
    setTopics([...topics, { id: tid(), name: n.slice(0, TOPIC_MAX_LEN), area: 'general', options: [] }]);
    setNewTopic('');
  };

  // The companies that have a department of the selected name - the ones a
  // topic default can be set for.
  const selCompanies = companies.filter((c) => depts.some((d) => d.companyId === c.id && norm(d.name) === sel));
  const asgTopic = topics.find((tp) => tp.id === asgFor) || null;
  const setAssignee = (companyId, email) => setTopics(topics.map((x) => {
    if (x.id !== asgFor) return x;
    const next = { ...(x.defaultAssignees || {}) };
    if (email) next[companyId] = email; else delete next[companyId];
    return { ...x, defaultAssignees: next };
  }));
  const optTopic = topics.find((tp) => tp.id === optFor) || null;
  const options = optTopic ? optTopic.options || [] : [];
  const setOptions = (next) => setTopics(topics.map((x) => (x.id === optFor ? { ...x, options: next } : x)));
  const dupOption = (name, id) => options.some((o) => o.id !== id && norm(o.name) === norm(name));
  const addOption = () => {
    const n = newOption.trim();
    if (!n || dupOption(n)) return;
    setOptions([...options, { id: tid(), name: n.slice(0, TOPIC_MAX_LEN) }]);
    setNewOption('');
  };

  const save = async () => {
    setSaving(true); setErr(''); setSaved(false);
    try {
      const out = state.names
        .map((n) => ({
          label: n, departments: [norm(n)],
          topics: (state.lists[norm(n)] || [])
            .map((tp) => {
              const opts = (tp.options || []).map((o) => o.name.trim())
                .filter((o, i, arr) => o && arr.findIndex((x) => norm(x) === norm(o)) === i);
              const asg = Object.fromEntries(Object.entries(tp.defaultAssignees || {}).filter(([c, e]) => c && e));
              return { name: tp.name.trim(), area: tp.area || 'general', ...(opts.length ? { options: opts } : {}),
                ...(Array.isArray(tp.questions) ? { questions: tp.questions } : {}),
                ...(Object.keys(asg).length ? { defaultAssignees: asg } : {}) };
            })
            .filter((tp, i, arr) => tp.name && arr.findIndex((x) => norm(x.name) === norm(tp.name)) === i),
        }))
        .filter((g) => g.topics.length);
      const next = await api.updateTicketTaxonomySettings({ helpTopics: [...out, ...state.orphans] });
      apply(next.helpTopics || [], depts);
      await refreshTicketConfig();
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) { setErr(e.message || String(e)); }
    finally { setSaving(false); }
  };

  return (
    <div style={{ fontFamily: FONT, color: NX.ink }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <Tags size={15} style={{ color: NX.dim }} />
        <div style={{ fontSize: 13.5, fontWeight: 700 }}>What Do You Need Help With?</div>
      </div>
      <div style={{ fontSize: 12, color: NX.faint, marginBottom: 14, maxWidth: 760, lineHeight: 1.5 }}>
        The choices Submit a Ticket offers once a department is picked. Drag to reorder. A department with no topics
        asks the requester to type it in a few words. Departments are matched by name, so the same name in two companies
        shares one list. Other is always offered.
      </div>

      {state.names.length === 0 ? (
        <div style={{ fontSize: 12.5, color: NX.faint }}>No departments yet - add them in Settings &gt; Company Settings.</div>
      ) : (
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div role="tablist" aria-label="Departments" style={{ ...card, padding: 6, flex: '0 0 220px', display: 'flex', flexDirection: 'column', gap: 2 }}>
            {state.names.map((n) => {
              const k = norm(n);
              const on = k === sel;
              const count = (state.lists[k] || []).filter((tp) => tp.name.trim()).length;
              return (
                <button key={k} type="button" role="tab" aria-selected={on} onClick={() => { setSel(k); setNewTopic(''); setOptFor(null); setAsgFor(null); }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 8, border: 'none',
                    cursor: 'pointer', fontFamily: FONT, fontSize: 13, textAlign: 'left',
                    background: on ? NX.hover : 'transparent', color: NX.ink, fontWeight: on ? 700 : 500,
                  }}>
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n}</span>
                  <span style={{ fontSize: 11.5, color: count ? NX.dim : NX.faint, fontWeight: 600 }}>{count || 'Typed'}</span>
                </button>
              );
            })}
          </div>

          <div style={{ ...card, padding: 16, flex: '1 1 420px', minWidth: 0, maxWidth: 720 }}>
            <div style={{ fontSize: 13.5, fontWeight: 700, marginBottom: 2 }}>{selName}</div>
            <div style={{ fontSize: 12, color: NX.faint, marginBottom: 12 }}>
              {topics.length ? `${topics.length} topic${topics.length === 1 ? '' : 's'}, plus Other.` : 'No topics - requesters type what it is about.'}
            </div>
            <DragList items={topics} getKey={(tp) => tp.id} onReorder={setTopics} label="topic" gap={6}
              renderItem={(tp, handle) => (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {handle}
                  <input value={tp.name} maxLength={TOPIC_MAX_LEN} aria-label="Topic name"
                    onChange={(e) => setTopics(topics.map((x) => (x.id === tp.id ? { ...x, name: e.target.value } : x)))}
                    style={{ ...inputStyle, flex: 1, minWidth: 0, ...(dup(tp.name, tp.id) || !tp.name.trim() ? { borderColor: NX.red } : null) }} />
                  <button type="button" onClick={() => { setOptFor(optFor === tp.id ? null : tp.id); setNewOption(''); }}
                    aria-pressed={optFor === tp.id} aria-label={`Sub-options for ${tp.name}`}
                    title="The optional Which One? list for this topic"
                    style={{ ...btn(optFor === tp.id ? 'primary' : 'ghost'), padding: '5px 8px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                    <ListTree size={12} /> {(tp.options || []).length || 'None'}
                  </button>
                  <button type="button" onClick={() => setAsgFor(asgFor === tp.id ? null : tp.id)}
                    aria-pressed={asgFor === tp.id} aria-label={`Default assignee for ${tp.name}`}
                    title="Who a new ticket about this topic goes straight to"
                    style={{ ...btn(asgFor === tp.id ? 'primary' : 'ghost'), padding: '5px 8px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                    <UserCheck size={12} /> {Object.keys(tp.defaultAssignees || {}).length || 'None'}
                  </button>
                  <button type="button" onClick={() => { if (optFor === tp.id) setOptFor(null); if (asgFor === tp.id) setAsgFor(null); setTopics(topics.filter((x) => x.id !== tp.id)); }}
                    title={`Remove ${tp.name}`} aria-label={`Remove ${tp.name}`}
                    style={{ border: 'none', background: 'none', cursor: 'pointer', color: NX.dim, display: 'grid', placeItems: 'center', padding: 4, flexShrink: 0 }}>
                    <X size={14} />
                  </button>
                </div>
              )} />
            <div style={{ display: 'flex', gap: 8, marginTop: topics.length ? 12 : 0 }}>
              <input value={newTopic} maxLength={TOPIC_MAX_LEN} onChange={(e) => setNewTopic(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addTopic()} placeholder={`Add a topic for ${selName}…`}
                style={{ ...inputStyle, flex: 1 }} />
              <button type="button" onClick={addTopic} disabled={!newTopic.trim() || dup(newTopic)}
                style={{ ...btn('outline'), display: 'inline-flex', alignItems: 'center', gap: 5, opacity: (!newTopic.trim() || dup(newTopic)) ? 0.55 : 1 }}>
                <Plus size={13} /> Add Topic
              </button>
            </div>
            {newTopic.trim() && dup(newTopic) && <div style={{ fontSize: 11.5, color: NX.red, marginTop: 4 }}>{selName} already has that topic.</div>}

            {asgTopic && (
              <div role="region" aria-label={`Default assignee for ${asgTopic.name}`}
                style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${NX.border}` }}>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 2 }}>Default Assignee - {asgTopic.name || 'New Topic'}</div>
                <div style={{ fontSize: 12, color: NX.faint, marginBottom: 10, lineHeight: 1.5 }}>
                  A new ticket about this topic that nobody assigned goes straight to this person, ahead of the department&apos;s
                  default. Pick someone on that company&apos;s ticket desk. Leave it empty to use the department&apos;s default.
                </div>
                {selCompanies.length === 0 ? (
                  <div style={{ fontSize: 12, color: NX.faint }}>No company you can see has a {selName} department.</div>
                ) : selCompanies.map((c) => (
                  <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                    <span style={{ width: 140, flexShrink: 0, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.name}>{c.name}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <PersonSelect value={(asgTopic.defaultAssignees || {})[c.id] || null}
                        people={agentOptions(deskAgents[c.id], (asgTopic.defaultAssignees || {})[c.id], people)}
                        onChange={(email) => setAssignee(c.id, email || '')} placeholder="No default assignee" />
                    </div>
                  </div>
                ))}
                <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 4 }}>Saved with the topics - click Save below.</div>
              </div>
            )}

            {optTopic && (
              <div role="region" aria-label={`Which One? options for ${optTopic.name}`}
                style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${NX.border}` }}>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 2 }}>Which One? - {optTopic.name || 'New Topic'}</div>
                <div style={{ fontSize: 12, color: NX.faint, marginBottom: 10, lineHeight: 1.5 }}>
                  Optional second dropdown once this topic is picked. Keep it short and use the names people know
                  (Outlook, Teams), so it narrows to the exact issue quickly. Leave it empty to ask nothing more.
                </div>
                <DragList items={options} getKey={(o) => o.id} onReorder={setOptions} label="option" gap={6}
                  renderItem={(o, handle) => (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {handle}
                      <input value={o.name} maxLength={TOPIC_MAX_LEN} aria-label="Option name"
                        onChange={(e) => setOptions(options.map((x) => (x.id === o.id ? { ...x, name: e.target.value } : x)))}
                        style={{ ...inputStyle, flex: 1, minWidth: 0, ...(dupOption(o.name, o.id) || !o.name.trim() ? { borderColor: NX.red } : null) }} />
                      <button type="button" onClick={() => setOptions(options.filter((x) => x.id !== o.id))}
                        title={`Remove ${o.name}`} aria-label={`Remove option ${o.name}`}
                        style={{ border: 'none', background: 'none', cursor: 'pointer', color: NX.dim, display: 'grid', placeItems: 'center', padding: 4, flexShrink: 0 }}>
                        <X size={14} />
                      </button>
                    </div>
                  )} />
                <div style={{ display: 'flex', gap: 8, marginTop: options.length ? 10 : 0 }}>
                  <input value={newOption} maxLength={TOPIC_MAX_LEN} onChange={(e) => setNewOption(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && addOption()} placeholder={`Add an option for ${optTopic.name || 'this topic'}…`}
                    style={{ ...inputStyle, flex: 1 }} />
                  <button type="button" onClick={addOption} disabled={!newOption.trim() || dupOption(newOption)}
                    style={{ ...btn('outline'), display: 'inline-flex', alignItems: 'center', gap: 5, opacity: (!newOption.trim() || dupOption(newOption)) ? 0.55 : 1 }}>
                    <Plus size={13} /> Add Option
                  </button>
                </div>
                {newOption.trim() && dupOption(newOption) && <div style={{ fontSize: 11.5, color: NX.red, marginTop: 4 }}>That option is already listed.</div>}
              </div>
            )}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16 }}>
        <button onClick={save} disabled={saving} style={{ ...btn('primary'), display: 'inline-flex', alignItems: 'center', gap: 7 }}>
          <Save size={14} /> {saving ? 'Saving…' : 'Save'}
        </button>
        <button onClick={() => { setState(null); load(); }} disabled={saving} style={{ ...btn('ghost'), display: 'inline-flex', alignItems: 'center', gap: 7 }}>
          <RotateCcw size={14} /> Discard Changes
        </button>
        {saved && <span style={{ color: NX.green, fontSize: 12.5, fontWeight: 600 }}>Saved.</span>}
        {err && <span style={{ color: NX.red, fontSize: 12.5, fontWeight: 600 }}>{err}</span>}
      </div>
    </div>
  );
}
