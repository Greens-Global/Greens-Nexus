// Live task lists in a note (Neil, 11/07/2026 - Macro's "embed a live view in
// a doc"). A block that shows "My Open Tasks" or one project's tasks as they
// are NOW, read for each reader through GET /tasks/embed with the task lists'
// own rule - a note shared with someone shows them only what they could
// already open. Only the choice is saved in the note:
//   <div data-type="liveList" data-source="mine|project:<id>" data-show="open|all"><p>words</p></div>
// (routers/notes.py keeps exactly those attributes). The words are what a
// plain copy of the note (Markdown, print) reads.
import { useEffect, useState } from 'react';
import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import { ListTodo, Circle, CircleCheck, RefreshCw } from 'lucide-react';
import { api } from '../api';
import { formatDate } from '../lib/datetime';
import { openTask } from './notesTasks';
import { EDITED } from './noteMedia';

const SOURCE = /^(mine|project:[A-Za-z0-9_\-.]{1,100})$/;   // mirrors routers/notes.py _LIST_SOURCE
export const safeSource = (v) => (typeof v === 'string' && SOURCE.test(v) ? v : 'mine');
const safeShow = (v) => (v === 'all' ? 'all' : 'open');
const SHOWN = 15;

function useProjects(on) {
  const [list, setList] = useState(null);
  useEffect(() => {
    if (!on || list) return undefined;
    let alive = true;
    Promise.resolve().then(() => api.getTaskProjects())
      .then((r) => { if (alive) setList((Array.isArray(r) ? r : []).filter((p) => !p.archived).sort((a, b) => String(a.name).localeCompare(String(b.name)))); })
      .catch(() => { if (alive) setList([]); });
    return () => { alive = false; };
  }, [on, list]);
  return list || [];
}

function LiveListView({ node, editor, getPos }) {
  const source = safeSource(node.attrs.source);
  const show = safeShow(node.attrs.show);
  const editable = editor.isEditable;
  const projects = useProjects(editable);
  const [data, setData] = useState({ key: '', tasks: [], total: 0, projectName: '', visible: true, error: '' });
  const [tick, setTick] = useState(0);
  const key = `${source}|${show}|${tick}`;
  useEffect(() => {
    let alive = true;
    Promise.resolve().then(() => api.taskListEmbed(source, show))
      .then((r) => { if (alive) setData({ key, tasks: r?.tasks || [], total: r?.total || 0, projectName: r?.projectName || '', visible: r?.visible !== false, error: '' }); })
      .catch((e) => { if (alive) setData({ key, tasks: [], total: 0, projectName: '', visible: true, error: e?.message || 'Could not load the tasks' }); });
    return () => { alive = false; };
  }, [source, show, key]);
  const loading = data.key !== key;
  // A change of list is the person's edit (saved), like typing.
  const set = (attrs) => {
    const pos = typeof getPos === 'function' ? getPos() : null;
    if (pos == null) return;
    editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs }).setMeta(EDITED, true));
  };
  const title = source === 'mine' ? 'My Tasks' : (data.projectName || projects.find((p) => `project:${p.id}` === source)?.name || 'A Project');

  return (
    <NodeViewWrapper className="nt-live" data-source={source} contentEditable={false}>
      <div className="nt-live-head">
        <ListTodo size={15} aria-hidden="true" />
        {editable ? (
          <select className="nt-live-pick" value={source} aria-label="Which tasks" onChange={(e) => set({ source: safeSource(e.target.value) })}>
            <option value="mine">My Tasks</option>
            {projects.map((p) => <option key={p.id} value={`project:${p.id}`}>{p.name || 'Untitled Project'}</option>)}
            {source !== 'mine' && !projects.some((p) => `project:${p.id}` === source) && <option value={source}>{title}</option>}
          </select>
        ) : <span className="nt-live-title">{title}</span>}
        {editable ? (
          <span className="nt-live-seg" role="group" aria-label="Show">
            {[['open', 'Open'], ['all', 'All']].map(([v, lab]) => (
              <button key={v} type="button" aria-pressed={show === v} className={show === v ? 'is-on' : ''} onClick={() => set({ show: v })}>{lab}</button>
            ))}
          </span>
        ) : <span className="nt-live-note">{show === 'all' ? 'All' : 'Open'}</span>}
        <button type="button" className="nt-live-refresh" aria-label="Refresh the list" title="Refresh" onClick={() => setTick((t) => t + 1)}>
          <RefreshCw size={13} aria-hidden="true" />
        </button>
      </div>
      {loading ? <div className="nt-live-empty">Loading…</div>
        : data.error ? <div className="nt-live-empty">{data.error}</div>
        : !data.visible ? <div className="nt-live-empty">You cannot see this project's tasks.</div>
        : !data.tasks.length ? <div className="nt-live-empty">{show === 'open' ? 'Nothing open here.' : 'No tasks here yet.'}</div>
        : (
          <ul className="nt-live-rows" aria-label={`${title} - tasks`}>
            {data.tasks.slice(0, SHOWN).map((t) => {
              const Mark = t.done ? CircleCheck : Circle;
              return (
                <li key={t.id}>
                  <button type="button" className={`nt-live-row${t.done ? ' is-done' : ''}`} onClick={() => openTask(t.id)} title={`Open "${t.title}"`}>
                    <Mark size={15} aria-label={t.done ? 'Done' : 'Open'} />
                    <span className="nt-live-name">{t.title || 'Untitled Task'}</span>
                    {t.dueOn && <span className="nt-live-due">{formatDate(t.dueOn)}</span>}
                  </button>
                </li>
              );
            })}
            {data.total > SHOWN && <li className="nt-live-more">and {data.total - SHOWN} more</li>}
          </ul>
        )}
    </NodeViewWrapper>
  );
}

export const LiveList = Node.create({
  name: 'liveList',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return {
      source: { default: 'mine', parseHTML: (el) => safeSource(el.getAttribute('data-source') || ''), renderHTML: (a) => ({ 'data-source': safeSource(a.source) }) },
      show: { default: 'open', parseHTML: (el) => safeShow(el.getAttribute('data-show')), renderHTML: (a) => ({ 'data-show': safeShow(a.show) }) },
    };
  },
  parseHTML() { return [{ tag: 'div[data-type="liveList"]' }]; },
  renderHTML({ node, HTMLAttributes }) {
    const words = `Live task list: ${safeSource(node.attrs.source) === 'mine' ? 'My Tasks' : 'a project'} (${safeShow(node.attrs.show) === 'all' ? 'all' : 'open'})`;
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'liveList' }), ['p', {}, words]];
  },
  addCommands() {
    return { insertLiveList: (attrs = {}) => ({ commands }) => commands.insertContent({ type: this.name, attrs: { source: 'mine', show: 'open', ...attrs } }) };
  },
  addNodeView() {
    return ReactNodeViewRenderer(LiveListView, {
      stopEvent: ({ event }) => event.target instanceof HTMLElement && !!event.target.closest('.nt-live-head, .nt-live-rows'),
    });
  },
});
