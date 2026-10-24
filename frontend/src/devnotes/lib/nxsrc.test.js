import { describe, it, expect } from 'vitest';
import { transformSync } from '@babel/core';
import nxSrcPlugin from '../../../scripts/nxsrc-plugin.mjs';

// The dev-build source stamps: every host JSX element gets
// data-nx-src="file:line:col"; components, fragments and elements that
// already carry one are left alone.

const run = (code, opts = {}) => transformSync(code, {
  filename: '/repo/frontend/src/tasks/Home.jsx',
  babelrc: false, configFile: false,
  parserOpts: { plugins: ['jsx'] },
  plugins: [[nxSrcPlugin, { root: '/repo/frontend', ...opts }]],
}).code;

describe('nxsrc-plugin', () => {
  it('stamps host elements with the file, line and 1-based column; skips components, fragments and existing stamps', () => {
    const out = run('const A = () => <div className="x"><Button onClick={f}>Hi</Button><span data-nx-src="keep">t</span><></></div>;');
    expect(out).toContain('data-nx-src="src/tasks/Home.jsx:1:17"');   // `const A = () => ` is 16 chars; the `<` is column 17
    expect(out).toContain('data-nx-src="keep"');
    expect(out).not.toMatch(/Button[^>]*data-nx-src/);
    expect((out.match(/data-nx-src/g) || []).length).toBe(2);
  });

  it('uses the real line of each element and leaves member-expression components alone', () => {
    const out = run('const B = () => (\n  <ul>\n    <li>one</li>\n    <Menu.Item>x</Menu.Item>\n  </ul>\n);');
    expect(out).toContain('src/tasks/Home.jsx:2:3');
    expect(out).toContain('src/tasks/Home.jsx:3:5');
    expect(out).not.toMatch(/Menu\.Item[^>]*data-nx-src/);
  });

  it('with a file index (the built app) the value is "<id>:<line>:<col>"', () => {
    const files = [];
    const fileId = (rel) => { let i = files.indexOf(rel); if (i < 0) { files.push(rel); i = files.length - 1; } return i; };
    const out = run('const D = () => <p>hi</p>;', { fileId });
    expect(out).toContain('data-nx-src="0:1:17"');
    expect(files).toEqual(['src/tasks/Home.jsx']);
  });

  it('only: interactive stamps elements with text, a handler or an aria / role attribute', () => {
    const out = run('const C = () => <div><p>text</p><i /><b onClick={g} /><u role="button" /><em>{v}</em></div>;', { only: 'interactive' });
    expect(out).toMatch(/p\b[^>]*data-nx-src/);
    expect(out).toMatch(/\bb\b[^>]*data-nx-src/);
    expect(out).toMatch(/\bu\b[^>]*data-nx-src/);
    expect(out).toMatch(/\bem\b[^>]*data-nx-src/);
    expect(out).not.toMatch(/<i data-nx-src/);
    expect(out).not.toMatch(/<div data-nx-src/);
  });
});
