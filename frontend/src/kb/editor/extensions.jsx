// The Knowledge Base editor's own blocks, as TipTap nodes: Steps / Step,
// Callout, Checklist / CheckItem, Video, Embed a Page. Same JSON the server
// reads (backend/kb_blocks.py); the reader (components/Blocks.jsx) draws
// the same shapes. Node views are React so the step tools live in place.
import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import { useRef, useState } from 'react';
import { AlertTriangle, Camera, Lightbulb, Info, ShieldAlert, Trash2, Plus, Play, BookOpen, X } from 'lucide-react';
import { api } from '../../api';
import { readAsDataUrl } from '../lib';

const CALLOUT_ICON = { warning: AlertTriangle, safety: ShieldAlert, tip: Lightbulb, note: Info };

// ── Steps ───────────────────────────────────────────────────────────────
function StepView({ node, updateAttributes, deleteNode, editor, getPos }) {
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const a = node.attrs;
  let num = 1;
  try {
    const pos = getPos();
    const $pos = editor.state.doc.resolve(pos);
    num = $pos.index() + 1;
    // count the steps in earlier steps blocks so numbering runs through the page
    const parentPos = $pos.before();
    editor.state.doc.descendants((n, p) => {
      if (p >= parentPos) return false;
      if (n.type.name === 'steps') num += n.childCount;
      return n.type.name !== 'steps';
    });
  } catch { /* unplaced */ }

  const addPhotos = async (files) => {
    const list = Array.from(files || []).filter((f) => f.type.startsWith('image/'));
    if (!list.length) return;
    setBusy(true);
    const urls = [];
    for (const f of list.slice(0, 6)) {
      try { const r = await api.kbUploadMedia(await readAsDataUrl(f), 'steps'); urls.push(r.url); } catch { /* skip */ }
    }
    if (urls.length) updateAttributes({ photos: [...(a.photos || []), ...urls] });
    setBusy(false);
  };
  const addStepAfter = () => {
    const pos = getPos() + node.nodeSize;
    editor.chain().focus().insertContentAt(pos, { type: 'step', attrs: { photos: [], warning: '', tip: '', photoRequired: false }, content: [{ type: 'paragraph' }] }).run();
  };
  return (
    <NodeViewWrapper className="kb-step" data-step="">
      <span className="kb-step-num" contentEditable={false}>{num}</span>
      <div className="kb-step-title"><NodeViewContent /></div>
      {a.photos?.length > 0 && (
        <div className="kb-step-photos" contentEditable={false}>
          {a.photos.map((p, i) => (
            <span key={i} style={{ position: 'relative' }}>
              <img src={p} alt="" />
              <button type="button" aria-label="Remove photo" onClick={() => updateAttributes({ photos: a.photos.filter((_, j) => j !== i) })}
                      style={{ position: 'absolute', top: 4, right: 4, width: 22, height: 22, borderRadius: '50%', border: 0, background: 'rgba(15,23,42,.7)', color: '#fff', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><X size={12} /></button>
            </span>
          ))}
        </div>
      )}
      {a.warning !== undefined && a.warning !== '' && (
        <div className="kb-step-flag warn" contentEditable={false}><AlertTriangle size={15} />
          <input value={a.warning} onChange={(e) => updateAttributes({ warning: e.target.value })} placeholder="Warning for this step" className="kb-bare" style={{ flex: 1, border: 0, background: 'transparent', font: 'inherit', color: 'inherit' }} />
          <button type="button" aria-label="Remove warning" onClick={() => updateAttributes({ warning: '' })} style={{ border: 0, background: 'none', cursor: 'pointer', color: 'inherit' }}><X size={13} /></button></div>
      )}
      {a.tip && (
        <div className="kb-step-flag tip" contentEditable={false}><Lightbulb size={15} />
          <input value={a.tip} onChange={(e) => updateAttributes({ tip: e.target.value })} placeholder="Tip for this step" className="kb-bare" style={{ flex: 1, border: 0, background: 'transparent', font: 'inherit', color: 'inherit' }} />
          <button type="button" aria-label="Remove tip" onClick={() => updateAttributes({ tip: '' })} style={{ border: 0, background: 'none', cursor: 'pointer', color: 'inherit' }}><X size={13} /></button></div>
      )}
      <div className="kb-step-tools" contentEditable={false}>
        <button type="button" className="kb-btn sm" disabled={busy} onClick={() => fileRef.current?.click()}><Camera />{busy ? 'Uploading...' : 'Add Photo'}</button>
        <span className="kb-meta" style={{ alignSelf: 'center' }}>or press Ctrl+V with an image copied</span>
        <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => { addPhotos(e.target.files); e.target.value = ''; }} />
        {!a.warning && <button type="button" className="kb-btn sm ghost" onClick={() => updateAttributes({ warning: ' ' })}><AlertTriangle />Warning</button>}
        {!a.tip && <button type="button" className="kb-btn sm ghost" onClick={() => updateAttributes({ tip: ' ' })}><Lightbulb />Tip</button>}
        <label className="kb-check" style={{ fontSize: 12.5 }}><input type="checkbox" checked={!!a.photoRequired} onChange={(e) => updateAttributes({ photoRequired: e.target.checked })} />Photo required as a task</label>
        <button type="button" className="kb-btn sm ghost" style={{ marginLeft: 'auto' }} onClick={addStepAfter}><Plus />Step After</button>
        <button type="button" className="kb-btn sm ghost danger" aria-label="Delete step" onClick={deleteNode}><Trash2 /></button>
      </div>
    </NodeViewWrapper>
  );
}

export const Step = Node.create({
  name: 'step',
  content: 'paragraph+',
  defining: true,
  isolating: true,
  addAttributes() {
    return {
      photos: { default: [] }, warning: { default: '' }, tip: { default: '' }, photoRequired: { default: false },
    };
  },
  parseHTML() { return [{ tag: 'div[data-step]' }]; },
  renderHTML({ HTMLAttributes }) { return ['div', mergeAttributes(HTMLAttributes, { 'data-step': '', class: 'kb-step' }), 0]; },
  addNodeView() { return ReactNodeViewRenderer(StepView); },
  addKeyboardShortcuts() {
    return {
      'Mod-Enter': () => {
        const { state } = this.editor;
        const $from = state.selection.$from;
        for (let d = $from.depth; d > 0; d -= 1) {
          if ($from.node(d).type.name === 'step') {
            const pos = $from.after(d);
            return this.editor.chain().insertContentAt(pos, { type: 'step', attrs: { photos: [], warning: '', tip: '', photoRequired: false }, content: [{ type: 'paragraph' }] }).focus(pos + 2).run();
          }
        }
        return false;
      },
    };
  },
});

export const Steps = Node.create({
  name: 'steps',
  group: 'block',
  content: 'step+',
  defining: true,
  parseHTML() { return [{ tag: 'div[data-steps]' }]; },
  renderHTML({ HTMLAttributes }) { return ['div', mergeAttributes(HTMLAttributes, { 'data-steps': '', class: 'kb-steps' }), 0]; },
  addCommands() {
    return {
      insertSteps: () => ({ commands }) => commands.insertContent({
        type: 'steps', content: [{ type: 'step', attrs: { photos: [], warning: '', tip: '', photoRequired: false }, content: [{ type: 'paragraph' }] }],
      }),
    };
  },
});

// ── Callout ─────────────────────────────────────────────────────────────
function CalloutView({ node, updateAttributes, deleteNode }) {
  const kind = node.attrs.kind || 'note';
  const Icon = CALLOUT_ICON[kind] || Info;
  return (
    <NodeViewWrapper className={`kb-callout ${kind}`} data-callout="">
      <span contentEditable={false}><Icon /></span>
      <div><NodeViewContent /></div>
      <span contentEditable={false} style={{ display: 'flex', gap: 2, alignItems: 'flex-start' }}>
        <select className="kb-callout-kind" value={kind} onChange={(e) => updateAttributes({ kind: e.target.value })} aria-label="Callout kind" style={{ position: 'static' }}>
          <option value="warning">Warning</option><option value="safety">Safety</option><option value="tip">Tip</option><option value="note">Note</option>
        </select>
        <button type="button" aria-label="Remove callout" onClick={deleteNode} style={{ border: 0, background: 'none', cursor: 'pointer', color: 'inherit', padding: 2 }}><X size={13} /></button>
      </span>
    </NodeViewWrapper>
  );
}

export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes() { return { kind: { default: 'note' } }; },
  parseHTML() { return [{ tag: 'div[data-callout]', getAttrs: (el) => ({ kind: el.getAttribute('data-kind') || 'note' }) }]; },
  renderHTML({ node, HTMLAttributes }) { return ['div', mergeAttributes(HTMLAttributes, { 'data-callout': '', 'data-kind': node.attrs.kind, class: `kb-callout ${node.attrs.kind}` }), 0]; },
  addNodeView() { return ReactNodeViewRenderer(CalloutView); },
  addCommands() {
    return {
      insertCallout: (kind = 'warning') => ({ commands }) => commands.insertContent({ type: 'callout', attrs: { kind }, content: [{ type: 'paragraph' }] }),
    };
  },
});

// ── Checklist ───────────────────────────────────────────────────────────
function CheckItemView({ node, updateAttributes }) {
  return (
    <NodeViewWrapper className="kb-check-item" data-check-item="">
      <input type="checkbox" contentEditable={false} checked={!!node.attrs.checked} onChange={(e) => updateAttributes({ checked: e.target.checked })} />
      <NodeViewContent as="span" style={{ flex: 1 }} />
    </NodeViewWrapper>
  );
}

export const CheckItem = Node.create({
  name: 'checkItem',
  content: 'inline*',
  defining: true,
  addAttributes() { return { checked: { default: false } }; },
  parseHTML() { return [{ tag: 'div[data-check-item]' }]; },
  renderHTML({ HTMLAttributes }) { return ['div', mergeAttributes(HTMLAttributes, { 'data-check-item': '', class: 'kb-check-item' }), 0]; },
  addNodeView() { return ReactNodeViewRenderer(CheckItemView); },
  addKeyboardShortcuts() {
    return {
      Enter: () => this.editor.commands.splitBlock(),
    };
  },
});

export const Checklist = Node.create({
  name: 'checklist',
  group: 'block',
  content: 'checkItem+',
  defining: true,
  parseHTML() { return [{ tag: 'div[data-checklist]' }]; },
  renderHTML({ HTMLAttributes }) { return ['div', mergeAttributes(HTMLAttributes, { 'data-checklist': '' }), 0]; },
  addCommands() {
    return {
      insertChecklist: () => ({ commands }) => commands.insertContent({ type: 'checklist', content: [{ type: 'checkItem', attrs: { checked: false }, content: [] }] }),
    };
  },
});

// ── Video link ──────────────────────────────────────────────────────────
function VideoView({ node, deleteNode }) {
  let host = '';
  try { host = new URL(node.attrs.url).hostname.replace(/^www\./, ''); } catch { host = ''; }
  return (
    <NodeViewWrapper className="kb-video" data-video="" contentEditable={false}>
      <span className="play"><Play size={18} /></span>
      <span className="kb-grow"><span className="kb-title" style={{ display: 'block' }}>{node.attrs.title || 'Video'}</span><span className="kb-meta">{host} · {node.attrs.url}</span></span>
      <button type="button" className="kb-ibtn" style={{ width: 28, height: 28 }} aria-label="Remove video" onClick={deleteNode}><X size={14} /></button>
    </NodeViewWrapper>
  );
}

export const Video = Node.create({
  name: 'video',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() { return { url: { default: '' }, title: { default: '' } }; },
  parseHTML() { return [{ tag: 'div[data-video]', getAttrs: (el) => ({ url: el.getAttribute('data-url') || '', title: el.getAttribute('data-title') || '' }) }]; },
  renderHTML({ node, HTMLAttributes }) { return ['div', mergeAttributes(HTMLAttributes, { 'data-video': '', 'data-url': node.attrs.url, 'data-title': node.attrs.title })]; },
  addNodeView() { return ReactNodeViewRenderer(VideoView); },
});

// ── Embed a page ────────────────────────────────────────────────────────
function EmbedView({ node, deleteNode }) {
  return (
    <NodeViewWrapper className="kb-embed" data-embed-page="" contentEditable={false} style={{ cursor: 'default' }}>
      <BookOpen size={18} style={{ color: 'var(--kb-green)', flex: '0 0 auto' }} />
      <span className="kb-grow"><span className="kb-title" style={{ display: 'block' }}>{node.attrs.title || 'A page'}</span><span className="kb-meta">Embedded page. Readers see its title and summary and open it in one tap.</span></span>
      <button type="button" className="kb-ibtn" style={{ width: 28, height: 28 }} aria-label="Remove" onClick={deleteNode}><X size={14} /></button>
    </NodeViewWrapper>
  );
}

export const EmbedPage = Node.create({
  name: 'embedPage',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() { return { docId: { default: '' }, title: { default: '' } }; },
  parseHTML() { return [{ tag: 'div[data-embed-page]', getAttrs: (el) => ({ docId: el.getAttribute('data-doc-id') || '', title: el.getAttribute('data-title') || '' }) }]; },
  renderHTML({ node, HTMLAttributes }) { return ['div', mergeAttributes(HTMLAttributes, { 'data-embed-page': '', 'data-doc-id': node.attrs.docId, 'data-title': node.attrs.title })]; },
  addNodeView() { return ReactNodeViewRenderer(EmbedView); },
});

export const KB_NODES = [Steps, Step, Callout, Checklist, CheckItem, Video, EmbedPage];
