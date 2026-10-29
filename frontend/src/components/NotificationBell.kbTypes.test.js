import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// Every Knowledge Base bell the server sends has its own icon and label in
// NotificationBell's TYPE_META (WP 1.7, Oct 29 2026). Without one a bell
// falls back to the generic "Request approved" style. A new `ntype="kb_..."`
// in the backend fails this test until it gets an entry.

const SRC = path.join(__dirname, '..');
const BACKEND = path.join(SRC, '..', '..', 'backend');

function pyFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name.startsWith('.') || e.name === '__pycache__') return [];
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return pyFiles(p);
    return e.name.endsWith('.py') && !e.name.startsWith('test_') ? [p] : [];
  });
}

describe('Knowledge Base bells', () => {
  it('every kb_ type the server sends has a TYPE_META entry', () => {
    const sent = new Set();
    for (const f of pyFiles(BACKEND)) {
      for (const m of fs.readFileSync(f, 'utf8').matchAll(/ntype="(kb_[a-z_]+)"/g)) sent.add(m[1]);
    }
    expect(sent.size).toBeGreaterThan(10);
    const bell = fs.readFileSync(path.join(SRC, 'components', 'NotificationBell.jsx'), 'utf8');
    const meta = bell.slice(bell.indexOf('const TYPE_META = {'), bell.indexOf('};', bell.indexOf('const TYPE_META = {')));
    const styled = new Set([...meta.matchAll(/^\s+(kb_[a-z_]+):/gm)].map((m) => m[1]));
    expect([...sent].filter((t) => !styled.has(t)).sort()).toEqual([]);
  });
});
