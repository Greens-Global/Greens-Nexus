import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { offlineFiles, OFFLINE_SCREENS } from '../../../scripts/offline-manifest.mjs';

// The offline app shell's file list (scripts/offline-manifest.mjs, Neil
// 11/03/2026): the entry and its static imports (first paint), every chunk
// holding a field screen with ITS static imports and CSS - and nothing else
// (a lazy screen nobody needs offline is not downloaded by every phone).
const chunk = (fileName, { isEntry = false, imports = [], moduleIds = [], css = [] } = {}) => ({
  type: 'chunk', fileName, isEntry, imports, moduleIds, viteMetadata: { importedCss: new Set(css) },
});

describe('offlineFiles', () => {
  const bundle = {
    'assets/index-nx2-a.js': chunk('assets/index-nx2-a.js', { isEntry: true, imports: ['assets/vendor-react-nx2-b.js'], css: ['assets/index-nx2-a.css'] }),
    'assets/vendor-react-nx2-b.js': chunk('assets/vendor-react-nx2-b.js'),
    'assets/FillForm-nx2-c.js': chunk('assets/FillForm-nx2-c.js', { moduleIds: ['/repo/frontend/src/forms/FillForm.jsx'], imports: ['assets/components-nx2-d.js'] }),
    'assets/components-nx2-d.js': chunk('assets/components-nx2-d.js', { css: ['assets/components-nx2-d.css'] }),
    'assets/Accounting-nx2-e.js': chunk('assets/Accounting-nx2-e.js', { moduleIds: ['/repo/frontend/src/views/Accounting.jsx'] }),
    'assets/index-nx2-a.css': { type: 'asset', fileName: 'assets/index-nx2-a.css' },
    'version.json': { type: 'asset', fileName: 'version.json' },
  };

  it('takes the entry, its imports, the field screens and their CSS - not the other lazy screens', () => {
    expect(offlineFiles(bundle)).toEqual([
      '/assets/FillForm-nx2-c.js',
      '/assets/components-nx2-d.css',
      '/assets/components-nx2-d.js',
      '/assets/index-nx2-a.css',
      '/assets/index-nx2-a.js',
      '/assets/vendor-react-nx2-b.js',
    ]);
  });

  it('lists the Forms proof screens and the offline layer itself', () => {
    expect(OFFLINE_SCREENS).toEqual(expect.arrayContaining(['src/lib/offline/', 'src/components/offline/', 'src/forms/FillForm.jsx', 'src/views/MyHR.jsx']));
  });

  it('public/sw.js keeps the one line the build fills', () => {
    const src = readFileSync(resolve(__dirname, '../../../public/sw.js'), 'utf8');
    expect(src.match(/const MANIFEST = null;/g)).toHaveLength(1);
  });
});
