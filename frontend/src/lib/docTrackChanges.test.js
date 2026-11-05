// Track Changes behaves like Word Online: with tracking on, typing is an
// insertion, deleting leaves a struck-through deletion, replacing a selection
// is both; deleting your own insertion really deletes; accept and reject do
// the right thing per kind; Accept All / Reject All sweep the page; Next
// steps through the changes; with tracking off the editor is plain.
//
//     npx vitest run src/lib/docTrackChanges.test.js
import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { BODY_EXTENSIONS } from './docBuilderSchema';
import { listChanges } from './docTrackChanges';

const ME = { email: 'pranshu@greensglobal.com', name: 'Pranshu Pandey' };
const OTHER = { email: 'sagar@greensglobal.com', name: 'Sagar' };
const doc = (text) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

function mount(text, user = ME) {
  const ed = new Editor({ extensions: BODY_EXTENSIONS, content: doc(text) });
  ed.commands.setTrackChanges(true, user);
  return ed;
}
// The paragraph's words as the page shows them, tagged: [+ins] and [-del].
function shown(ed) {
  const runs = [];     // [tag, text], adjacent runs of one kind merged (as listChanges does)
  ed.state.doc.descendants((n) => {
    if (!n.isText) return;
    const m = n.marks.find((x) => x.type.name === 'insertion' || x.type.name === 'deletion');
    const tag = m ? (m.type.name === 'insertion' ? '+' : '-') : '';
    const last = runs[runs.length - 1];
    if (last && last[0] === tag) last[1] += n.text; else runs.push([tag, n.text]);
  });
  return runs.map(([tag, t]) => (tag ? `[${tag}${t}]` : t)).join('');
}
const select = (ed, from, to) => ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, from, to)));
const backspace = (ed) => ed.view.dispatch(ed.state.tr.delete(ed.state.selection.from - 1, ed.state.selection.from));

describe('tracking', () => {
  it('typing is an insertion by the person, and the cursor stays after it', () => {
    const ed = mount('Net 30 days.');
    ed.commands.focus('end');
    ed.commands.insertContent(' Late fees apply.');
    expect(shown(ed)).toBe('Net 30 days.[+ Late fees apply.]');
    const [c] = listChanges(ed.state.doc);
    expect(c.author).toBe(ME.email);
    expect(c.name).toBe(ME.name);
    expect(c.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(ed.state.selection.from).toBe(ed.state.doc.content.size - 1);
  });

  it('backspace keeps the deleted text as a deletion and the cursor walks back over it', () => {
    const ed = mount('Net 30 days.');
    select(ed, 7, 7);                      // after "30"
    backspace(ed);
    expect(shown(ed)).toBe('Net 3[-0] days.');
    expect(ed.state.selection.from).toBe(6);
    backspace(ed);
    expect(shown(ed)).toBe('Net [-30] days.');
  });

  it('replacing a selection is a deletion followed by an insertion', () => {
    const ed = mount('Net 30 days.');
    select(ed, 5, 7);                      // "30"
    ed.commands.insertContent('45');
    expect(shown(ed)).toBe('Net [-30][+45] days.');
    expect(ed.state.selection.from).toBe(9);   // after "45"
  });

  it('deleting your own insertion really deletes it; someone else\'s is marked', () => {
    const ed = mount('Net 30 days.');
    ed.commands.focus('end');
    ed.commands.insertContent('X');
    backspace(ed);
    expect(shown(ed)).toBe('Net 30 days.');
    const two = mount('Net 30 days.', OTHER);
    two.commands.focus('end');
    two.commands.insertContent('X');
    two.commands.setTrackChanges(true, ME);
    backspace(two);
    expect(shown(two)).toBe('Net 30 days.[-X]');
  });

  it('accept keeps an insertion and removes a deletion; reject does the opposite', () => {
    const ed = mount('Net 30 days.');
    select(ed, 5, 7);
    ed.commands.insertContent('45');       // Net [-30][+45] days.
    select(ed, 5, 5);
    ed.commands.acceptChange();            // the deletion goes
    expect(shown(ed)).toBe('Net [+45] days.');
    select(ed, 6, 6);
    ed.commands.rejectChange();            // the insertion goes
    expect(shown(ed)).toBe('Net  days.');
    expect(listChanges(ed.state.doc)).toEqual([]);
  });

  it('accept all and reject all sweep every change', () => {
    const a = mount('Net 30 days.');
    select(a, 5, 7); a.commands.insertContent('45');
    a.commands.acceptAllChanges();
    expect(shown(a)).toBe('Net 45 days.');
    const r = mount('Net 30 days.');
    select(r, 5, 7); r.commands.insertContent('45');
    r.commands.rejectAllChanges();
    expect(shown(r)).toBe('Net 30 days.');
  });

  it('next and previous step through the changes and select each', () => {
    const ed = mount('Net 30 days.');
    select(ed, 5, 7); ed.commands.insertContent('45');
    select(ed, 1, 1);
    ed.commands.selectChange(1);
    expect([ed.state.selection.from, ed.state.selection.to]).toEqual([5, 7]);
    ed.commands.selectChange(1);
    expect([ed.state.selection.from, ed.state.selection.to]).toEqual([7, 9]);
    ed.commands.selectChange(1);           // wraps
    expect(ed.state.selection.from).toBe(5);
    ed.commands.selectChange(-1);
    expect(ed.state.selection.from).toBe(7);
  });

  it('with tracking off the editor is plain, and the marks survive JSON', () => {
    const ed = new Editor({ extensions: BODY_EXTENSIONS, content: doc('Net 30 days.') });
    select(ed, 5, 7); ed.commands.insertContent('45');
    expect(shown(ed)).toBe('Net 45 days.');
    const t = mount('Net 30 days.');
    select(t, 5, 7); t.commands.insertContent('45');
    const again = new Editor({ extensions: BODY_EXTENSIONS, content: t.getJSON() });
    expect(shown(again)).toBe('Net [-30][+45] days.');
  });
});
