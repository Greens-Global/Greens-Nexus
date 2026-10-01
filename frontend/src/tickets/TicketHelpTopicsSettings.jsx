// Settings > Ticket Manager > Help Topics (Pranshu, Sep 30): which choices
// "What do you need help with?" offers for each department on Submit a
// Ticket. It was a compiled-in default (ticket_taxonomy.DEFAULT_HELP_TOPICS);
// this is where an admin changes it - add, rename, remove and drag to reorder
// a department's topics.
//
// Each topic still carries a service area (it decides the follow-up questions -
// Cameras asks which facility and which camera or gate - and the queue's
// Service Area filter), but it is no longer picked here (Pranshu, Oct 1: the
// column did not help anyone). A topic keeps the area it has; a new one files
// under General. The defaults in ticket_taxonomy.py set the areas.
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
// Manager+ only, like the SLA & Ticket Types panel next to it; the backend's
// require_manager on the save is the real boundary.
import { useEffect, useMemo, useState } from 'react';
import { Plus, Save, RotateCcw, X, Tags, ListTree, MessageSquareText } from 'lucide-react';
import { LoadingState } from '../components/AsyncState';
import { api } from '../api';
import { useRole } from '../contexts/RoleContext';
import { NX, FONT, btn, input as inputStyle, card } from '../tasks/theme';
import {
  TOPIC_MAX_LEN, TOPIC_QUESTION_KINDS, TOPIC_QUESTION_ASK_ON, TOPIC_QUESTIONS_MAX, askOnOf, defaultTopicQuestions,
} from './ticketMeta';
import { refreshTicketConfig } from './ticketConfig';
import DragList from './DragList';

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
      // null = never edited: the topic asks its area's questions.
      questions: Array.isArray(tp.questions) ? tp.questions.map((q) => ({ ...q, id: tid() })) : null,
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
  const [qFor, setQFor] = useState(null);       // id of the topic whose questions are open
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
  useEffect(() => { load(); }, []);   // eslint-disable-line react-hooks/exhaustive-deps -- once, on mount

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
    setTopics([...topics, { id: tid(), name: n.slice(0, TOPIC_MAX_LEN), area: 'general', options: [], questions: null }]);
    setNewTopic('');
  };

  const optTopic = topics.find((tp) => tp.id === optFor) || null;
  const qTopic = topics.find((tp) => tp.id === qFor) || null;
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
              // `id` is screen-only; a topic never edited (null) sends no list.
              const qs = Array.isArray(tp.questions)
                ? { questions: tp.questions.filter((q) => (q.label || '').trim())
                  .map((q) => ({ ...q, id: undefined, label: q.label.trim() })) }
                : {};
              return { name: tp.name.trim(), area: tp.area || 'general', ...(opts.length ? { options: opts } : {}), ...qs };
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
                <button key={k} type="button" role="tab" aria-selected={on} onClick={() => { setSel(k); setNewTopic(''); setOptFor(null); setQFor(null); }}
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
                  <button type="button" onClick={() => { setQFor(qFor === tp.id ? null : tp.id); setOptFor(null); }}
                    aria-pressed={qFor === tp.id} aria-label={`Questions for ${tp.name}`}
                    title="The extra questions this topic asks (Which facility? Which camera?)"
                    style={{ ...btn(qFor === tp.id ? 'primary' : 'ghost'), padding: '5px 8px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                    <MessageSquareText size={12} /> {(tp.questions ?? defaultTopicQuestions(tp.area)).length || 'None'}
                  </button>
                  <button type="button" onClick={() => { setOptFor(optFor === tp.id ? null : tp.id); setQFor(null); setNewOption(''); }}
                    aria-pressed={optFor === tp.id} aria-label={`Sub-options for ${tp.name}`}
                    title="The optional Which One? list for this topic"
                    style={{ ...btn(optFor === tp.id ? 'primary' : 'ghost'), padding: '5px 8px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                    <ListTree size={12} /> {(tp.options || []).length || 'None'}
                  </button>
                  <button type="button" onClick={() => { if (optFor === tp.id) setOptFor(null); if (qFor === tp.id) setQFor(null); setTopics(topics.filter((x) => x.id !== tp.id)); }}
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

            {qTopic && (
              <TopicQuestionsEditor key={qTopic.id} topic={qTopic}
                questions={qTopic.questions ?? defaultTopicQuestions(qTopic.area).map((q) => ({ ...q, id: q.key }))}
                onChange={(next) => setTopics(topics.map((x) => (x.id === qFor ? { ...x, questions: next } : x)))} />
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

// The extra questions one topic asks once picked (Oct 1). Edits start from what
// the topic asks today - its area's questions until someone changes them -
// and the first change makes the list the topic's own.
function questionKey(label, taken) {
  const words = label.match(/[A-Za-z0-9]+/g) || ['question'];
  const tail = words.slice(1).map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join('');
  const base = `svc_${words[0].toLowerCase()}${tail}`.slice(0, 44);
  let key = base;
  for (let i = 2; taken.has(key) || key === 'svc_helpSubtopic'; i += 1) key = `${base}${i}`;
  return key;
}

function TopicQuestionsEditor({ topic, questions, onChange }) {
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState('text');
  const set = (id, patch) => onChange(questions.map((q) => (q.id === id ? { ...q, ...patch } : q)));
  const full = questions.length >= TOPIC_QUESTIONS_MAX;
  const add = () => {
    const l = label.trim();
    if (!l || full) return;
    const key = questionKey(l, new Set(questions.map((q) => q.key)));
    onChange([...questions, { id: tid(), key, label: l, type: kind, req: false, ...(kind === 'select' ? { options: [] } : {}) }]);
    setLabel(''); setKind('text');
  };
  const small = { ...inputStyle, flexShrink: 0, fontSize: 12.5 };
  return (
    <div role="region" aria-label={`Questions for ${topic.name}`}
      style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${NX.border}` }}>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 2 }}>Questions - {topic.name || 'New Topic'}</div>
      <div style={{ fontSize: 12, color: NX.faint, marginBottom: 10, lineHeight: 1.5 }}>
        Asked on Submit a Ticket once this topic is picked, under A Few More Details. Keep it to what the team
        really needs (Which facility? Which camera?). Up to {TOPIC_QUESTIONS_MAX}; with none, nothing more is asked.
        Answers already given on tickets stay on them when a question is removed.
      </div>
      {questions.length === 0 && <div style={{ fontSize: 12.5, color: NX.faint, marginBottom: 8 }}>No questions - this topic asks nothing more.</div>}
      <DragList items={questions} getKey={(q) => q.id} onReorder={onChange} label="question" gap={8}
        renderItem={(q, handle) => {
          const needsChoices = q.type === 'select' && !(q.options || []).length;
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 10px', borderRadius: 9, border: `1px solid ${NX.border}`, background: NX.surface }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                {handle}
                <input value={q.label} maxLength={120} aria-label="Question" placeholder="Question"
                  onChange={(e) => set(q.id, { label: e.target.value })}
                  style={{ ...inputStyle, flex: '1 1 180px', minWidth: 0, ...(!q.label.trim() ? { borderColor: NX.red } : null) }} />
                <select value={q.type} aria-label={`Answer type for ${q.label}`} style={{ ...small, width: 130 }}
                  onChange={(e) => set(q.id, { type: e.target.value, options: e.target.value === 'select' ? (q.options || []) : undefined })}>
                  {TOPIC_QUESTION_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
                </select>
                <select value={askOnOf(q.types)} aria-label={`Ask on for ${q.label}`} style={{ ...small, width: 160 }}
                  title="Which ticket types ask this question"
                  onChange={(e) => set(q.id, { types: TOPIC_QUESTION_ASK_ON.find((o) => o.id === e.target.value).types })}>
                  {TOPIC_QUESTION_ASK_ON.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                </select>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: NX.dim, fontWeight: 600, whiteSpace: 'nowrap' }}>
                  <input type="checkbox" checked={!!q.req} onChange={() => set(q.id, { req: !q.req })} aria-label={`Required: ${q.label}`} /> Required
                </label>
                <button type="button" onClick={() => onChange(questions.filter((x) => x.id !== q.id))}
                  title={`Remove ${q.label}`} aria-label={`Remove question ${q.label}`}
                  style={{ border: 'none', background: 'none', cursor: 'pointer', color: NX.dim, display: 'grid', placeItems: 'center', padding: 4, flexShrink: 0 }}>
                  <X size={14} />
                </button>
              </div>
              {q.type === 'select' && (
                <input defaultValue={(q.options || []).join(', ')} aria-label={`Choices for ${q.label}`}
                  onBlur={(e) => set(q.id, { options: e.target.value.split(',').map((o) => o.trim()).filter(Boolean) })}
                  placeholder="Choices, separated by commas - e.g. Front Gate, Back Gate, Office"
                  style={{ ...inputStyle, ...(needsChoices ? { borderColor: NX.red } : null) }} />
              )}
              {q.type === 'site' && (
                <div style={{ fontSize: 11.5, color: NX.faint }}>Lists the company&apos;s work sites.</div>
              )}
            </div>
          );
        }} />
      <div style={{ display: 'flex', gap: 8, marginTop: questions.length ? 10 : 0, flexWrap: 'wrap' }}>
        <input value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} disabled={full} aria-label="New question"
          onKeyDown={(e) => e.key === 'Enter' && add()}
          placeholder={full ? `${TOPIC_QUESTIONS_MAX} questions is the most a topic asks` : 'Add a question, e.g. Which door?'}
          style={{ ...inputStyle, flex: '1 1 200px' }} />
        <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Answer type for the new question"
          style={{ ...small, width: 130 }} disabled={full}>
          {TOPIC_QUESTION_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
        </select>
        <button type="button" onClick={add} disabled={!label.trim() || full}
          style={{ ...btn('outline'), display: 'inline-flex', alignItems: 'center', gap: 5, opacity: (!label.trim() || full) ? 0.55 : 1 }}>
          <Plus size={13} /> Add Question
        </button>
      </div>
    </div>
  );
}
