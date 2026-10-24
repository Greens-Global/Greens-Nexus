// Source location stamps for Build Mode (Oct 24 2026). A Babel plugin, run
// through @vitejs/plugin-react's `babel.plugins`, that gives every HOST JSX
// element (a lowercase tag - never a component or a fragment) a
// data-nx-src="<file relative to frontend/>:<line>:<col>" attribute, so a
// pin can say exactly which line of which file drew the element it sits on
// (devnotes/lib/capture.js sourceOf). vite.config.js enables it only on dev
// builds (CF_PAGES_BRANCH=dev), with VITE_NX_SRC=1, or in `vite` dev serve -
// never on a production build. No dependency: Babel hands the plugin its own
// `types`. Options: { root } - the directory file paths are made relative to.
//
// `only: 'interactive'` (the fallback the contract allows if the dev bundle
// goes over budget) stamps only elements with text, a handler or an
// aria / role attribute.
import { relative, sep } from 'node:path';

const HANDLER = /^on[A-Z]/;
const ARIA = /^(aria-|role$)/;

function hasText(node) {
  return node.children?.some((c) => (c.type === 'JSXText' && c.value.trim()) || c.type === 'JSXExpressionContainer');
}
function hasHandlerOrAria(opening) {
  return opening.attributes.some((a) => a.type === 'JSXAttribute' && typeof a.name?.name === 'string' && (HANDLER.test(a.name.name) || ARIA.test(a.name.name)));
}
// only: 'interactive' = a handler, an aria / role attribute, or text;
// only: 'handlers' = a handler or an aria / role attribute (no text rule).
// Both also stamp COMPONENT ROOTS - the outermost host element a function
// returns (roughly one stamp per component), so a pin on plain text still
// resolves to the file of the component that drew the area.
function wanted(only, opening, element, roots) {
  if (!only) return true;
  if (element && roots?.has(element)) return true;
  if (hasHandlerOrAria(opening)) return true;
  return only === 'interactive' && element ? hasText(element) : false;
}

// The JSX element(s) a returned expression resolves to: through parentheses,
// both arms of a conditional, both sides of && / ||, the last of a sequence,
// and every direct element child of a fragment.
function collectRoots(node, roots, depth = 0) {
  if (!node || depth > 8) return;
  switch (node.type) {
    case 'JSXElement': roots.add(node); return;
    case 'JSXFragment': for (const c of node.children) if (c.type === 'JSXElement') roots.add(c); return;
    case 'ParenthesizedExpression': case 'TSAsExpression': case 'TSNonNullExpression': collectRoots(node.expression, roots, depth + 1); return;
    case 'ConditionalExpression': collectRoots(node.consequent, roots, depth + 1); collectRoots(node.alternate, roots, depth + 1); return;
    case 'LogicalExpression': collectRoots(node.left, roots, depth + 1); collectRoots(node.right, roots, depth + 1); return;
    case 'SequenceExpression': collectRoots(node.expressions[node.expressions.length - 1], roots, depth + 1); return;
    default:
  }
}

// The Vite side. @vitejs/plugin-react 6 (Vite 8, oxc) no longer runs Babel,
// so the Babel plugin above is run from a plain `transform` hook on every
// source file that can hold JSX, BEFORE the JSX is compiled. @babel/core is
// already in the tree (a dependency of the toolchain), loaded lazily so a
// production build never touches it.
//
// Size (measured Oct 24 2026 on the full app): the stamp is paid per element,
// so the value is kept SHORT - "<fileId>:<line>:<col>" - and the file table is
// emitted once as /nx-src-files.json (served by the dev server too), which
// devnotes/lib/capture.js loads when Build Mode turns on. A full path per
// element would have cost 1.9 MB of JavaScript.
export function nxSrcVitePlugin({ root, only } = {}) {
  const INCLUDE = /\.[jt]sx?$/;
  const files = [];
  const ids = new Map();
  const fileId = (rel) => {
    let id = ids.get(rel);
    if (id == null) { id = files.length; files.push(rel); ids.set(rel, id); }
    return id;
  };
  return {
    name: 'nexus-nx-src',
    enforce: 'pre',
    async transform(code, id) {
      const file = id.split('?')[0];
      if (!INCLUDE.test(file) || file.includes('/node_modules/') || !code.includes('<')) return null;
      const { transformAsync } = await import('@babel/core');
      const res = await transformAsync(code, {
        filename: file, babelrc: false, configFile: false, sourceMaps: true, compact: false, retainLines: true,
        parserOpts: { plugins: ['jsx', ...(/\.tsx?$/.test(file) ? ['typescript'] : [])], sourceType: 'module' },
        plugins: [[nxSrcPlugin, { root, only, fileId }]],
      });
      return res?.code ? { code: res.code, map: res.map } : null;
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'nx-src-files.json', source: JSON.stringify(files) });
    },
    configureServer(server) {
      server.middlewares.use('/nx-src-files.json', (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify(files));
      });
    },
  };
}

export default function nxSrcPlugin({ types: t }) {
  return {
    name: 'nx-src',
    pre() { this.roots = new WeakSet(); },
    visitor: {
      // Component roots are collected before their elements are visited
      // (parents first), so the opening-element visitor below can ask.
      ReturnStatement(path, state) { collectRoots(path.node.argument, state.roots); },
      ArrowFunctionExpression(path, state) { if (path.node.body.type !== 'BlockStatement') collectRoots(path.node.body, state.roots); },
      JSXOpeningElement(path, state) {
        const name = path.node.name;
        if (!t.isJSXIdentifier(name)) return;              // Foo.Bar is a component
        if (!/^[a-z]/.test(name.name)) return;              // components start upper-case; fragments have no name
        if (path.node.attributes.some((a) => t.isJSXAttribute(a) && a.name?.name === 'data-nx-src')) return;
        const loc = path.node.loc?.start;
        if (!loc) return;
        if (!wanted(state.opts?.only, path.node, path.parentPath?.node, state.roots)) return;
        const root = state.opts?.root || process.cwd();
        const file = state.filename ? relative(root, state.filename).split(sep).join('/') : '';
        // With a file index (the Vite plugin) the value is "<id>:<line>:<col>"; alone, the path itself.
        const head = typeof state.opts?.fileId === 'function' ? String(state.opts.fileId(file)) : file;
        path.node.attributes.push(t.jsxAttribute(t.jsxIdentifier('data-nx-src'), t.stringLiteral(`${head}:${loc.line}:${loc.column + 1}`)));
      },
    },
  };
}
