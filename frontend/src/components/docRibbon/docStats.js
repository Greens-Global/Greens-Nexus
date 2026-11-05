// Word's Review > Word Count and Check Accessibility, read live from the
// page editors (each page is its own editor, so the counts walk all of them).

export function countWords(editors) {
  let words = 0, chars = 0, charsNoSpace = 0, paragraphs = 0;
  for (const ed of editors) {
    ed.state.doc.descendants((node) => {
      if (node.isTextblock && node.textContent.trim()) paragraphs += 1;
      if (node.isText) {
        const t = node.text;
        chars += t.length;
        charsNoSpace += t.replace(/\s/g, '').length;
        words += (t.match(/\S+/g) || []).length;
      }
    });
  }
  return { words, chars, charsNoSpace, paragraphs };
}

// Word's two most common accessibility findings this editor can see:
// pictures with no alt text and headings that skip a level.
export function accessibilityIssues(editors) {
  const issues = [];
  let last = 0;
  editors.forEach((ed, pageIdx) => {
    ed.state.doc.descendants((node) => {
      if (node.type.name === 'image' && !(node.attrs.alt || '').trim()) {
        issues.push({ page: pageIdx + 1, text: 'A picture has no alt text. Select it and type a description in Alt Text.' });
      }
      if (node.type.name === 'heading') {
        const level = node.attrs.level || 1;
        if (last && level > last + 1) issues.push({ page: pageIdx + 1, text: `"${node.textContent.slice(0, 40)}" is a Heading ${level} after a Heading ${last}. Headings should not skip a level.` });
        last = level;
      }
    });
  });
  return issues;
}

// Every heading, for the Navigation pane: { page, pos, level, text }.
export function headingsOf(editors, pages) {
  const out = [];
  pages.forEach((p, i) => {
    const ed = editors.get(p.id);
    if (!ed) return;
    ed.state.doc.forEach((node, offset) => {
      if (node.type.name === 'heading' && node.textContent.trim()) out.push({ pageId: p.id, page: i + 1, pos: offset, level: node.attrs.level || 1, text: node.textContent.trim() });
    });
  });
  return out;
}
