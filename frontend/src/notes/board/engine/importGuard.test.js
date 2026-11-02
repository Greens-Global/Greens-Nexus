// @vitest-environment node
// The engine import guard (scripts/check-engine-imports.mjs, run by
// `npm run lint`): nothing outside notes/board/engine/ may import the
// drawing engine's package, so the engine stays a replaceable part behind
// one adapter (Neil, 11/02/2026).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan, ENGINE_DIR } from '../../../../scripts/check-engine-imports.mjs';

let root;
const plant = (rel, text) => {
  const p = join(root, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, text);
};

describe('check-engine-imports', () => {
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'nx-engine-guard-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('fails on a planted import outside the engine folder, in every import form', () => {
    plant('notes/board/Board.jsx', "import { Excalidraw } from '@excalidraw/excalidraw';\n");
    plant('notes/other.js', "const m = await import('@excalidraw/excalidraw');\n");
    plant('notes/style.jsx', 'import "@excalidraw/excalidraw/index.css";\n');
    plant('notes/cjs.js', "const e = require('@excalidraw/excalidraw');\n");
    const hits = scan(root);
    expect(hits.map((h) => h.file).sort()).toEqual(['notes/board/Board.jsx', 'notes/cjs.js', 'notes/other.js', 'notes/style.jsx']);
    expect(hits[0].line).toBe(1);
  });

  it('allows the adapter folder, and never trips on a comment or a test mock', () => {
    plant(`${ENGINE_DIR}/excalidraw.jsx`, "import { Excalidraw } from '@excalidraw/excalidraw';\nimport '@excalidraw/excalidraw/index.css';\n");
    plant('main.jsx', "// The engine (@excalidraw/excalidraw, lazy) sets its asset path here\nwindow.X = 1;\n");
    plant('notes/board/Board.test.jsx', "vi.mock('@excalidraw/excalidraw', () => ({}));\n");
    expect(scan(root)).toEqual([]);
  });

  it('the repository itself is clean', () => {
    const src = fileURLToPath(new URL('../../../', import.meta.url));
    expect(scan(src)).toEqual([]);
  });
});
