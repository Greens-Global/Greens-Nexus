// Dictation as you speak (Pranshu, Nov 5 2026): the words the browser is
// still working out appear at the cursor in gray and are replaced as each
// phrase is finished and typed for real (useDictation's `interim` vs its
// final results). A widget decoration, so nothing is in the document until
// the phrase is final.
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export const dictationKey = new PluginKey('nexusDictationLive');

export const DictationLive = Extension.create({
  name: 'nexusDictationLive',
  addProseMirrorPlugins() {
    return [new Plugin({
      key: dictationKey,
      state: {
        init: () => DecorationSet.empty,
        apply(tr, old) {
          const meta = tr.getMeta(dictationKey);
          if (meta !== undefined) {
            if (!meta) return DecorationSet.empty;
            const pos = tr.selection.to;
            const span = document.createElement('span');
            span.className = 'doc-dictation-live';
            span.textContent = ` ${meta}`;
            return DecorationSet.create(tr.doc, [Decoration.widget(pos, span, { side: 1, key: 'dictation-live' })]);
          }
          return tr.docChanged ? old.map(tr.mapping, tr.doc) : old;
        },
      },
      props: { decorations(state) { return dictationKey.getState(state); } },
    })];
  },
});

/** Show `text` at the editor's cursor ('' clears it). */
export function showDictationLive(editor, text) {
  if (!editor || editor.isDestroyed) return;
  editor.view.dispatch(editor.state.tr.setMeta(dictationKey, text || null));
}
