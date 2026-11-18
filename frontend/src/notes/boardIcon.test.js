// The board glyph (Neil, 11/12/2026, components/icons/BoardIcon.jsx) is the
// ONE icon for a board. lucide's PenTool is the pen nib Nexus Sign uses for a
// signature; after the first swap it survived in eleven board places (the
// Notes tile's New Board among them - Neil, 11/17/2026: "Why does new board
// still have that pen icon"). This keeps it out of Notes and every board
// surface outside it.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..');
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
  const p = path.join(dir, d.name);
  return d.isDirectory() ? walk(p) : /\.(jsx?|tsx?)$/.test(d.name) && !/\.test\./.test(d.name) ? [p] : [];
});
const usesPen = (file) => /\bPenTool\b/.test(fs.readFileSync(file, 'utf8'));

describe('the board icon', () => {
  it('is never the signature pen anywhere in Notes', () => {
    const offenders = walk(path.join(SRC, 'notes')).filter(usesPen).map((f) => path.relative(SRC, f));
    expect(offenders).toEqual([]);
  });

  it('is the board glyph wherever a board is started, found or shown outside Notes', () => {
    for (const f of ['lib/quickCreate.js', 'components/search/useNexusSearch.js']) {
      const src = fs.readFileSync(path.join(SRC, f), 'utf8');
      expect(src, f).toMatch(/import BoardIcon from/);
      expect(src, f).not.toMatch(/\bPenTool\b/);
    }
    // Settings > Notes & Boards and its Diagram From a Sentence group.
    const admin = fs.readFileSync(path.join(SRC, 'views/AdminConsole.jsx'), 'utf8');
    expect(admin).toMatch(/label: 'Notes & Boards',\s+Icon: BoardIcon/);
    expect(admin).toMatch(/icon: BoardIcon, title: 'Diagram From a Sentence'/);
  });
});
