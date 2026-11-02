// Role copy guard (Neil, 11/02/2026: the two top tiers are "Super
// Administrator" and "Administrator" - never "Global Admin" or "IT Admin").
// Runs with `npm run lint`, which CI runs on every PR.
//
// The role KEYS in code (`owner`, `administrator`, the group flag
// `global_admins`, identifiers like `isGlobalAdmin`) never change - only the
// words people see. This guard fails on the old words wherever a person could
// read them: a string literal, a template literal or JSX text under src/.
// Comments are exempt (a comment may say "(now Super Administrator)" to keep
// the history), and so is any identifier - "Global Admin" with a space is
// never an identifier, and the check is case-sensitive so `global_admins`
// passes.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const OLD_WORDS = /\b(?:Global|IT) Admins?\b/g;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(js|jsx|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

// Blank out every comment (line and block, JSX `{/* */}` included) while
// respecting string and template literals, so a `//` inside a URL string
// survives and the old words inside a comment are not seen. Newlines are
// kept so line numbers stay right.
function stripComments(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < n && text[i] !== quote) {
        if (text[i] === '\\') {
          out += text[i] + (text[i + 1] ?? '');
          i += 2;
          continue;
        }
        out += text[i];
        i++;
      }
      out += text[i] ?? '';
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const hits = [];
for (const file of walk(SRC)) {
  const rel = relative(SRC, file).split(sep).join('/');
  const lines = stripComments(readFileSync(file, 'utf8')).split('\n');
  lines.forEach((line, idx) => {
    const found = line.match(OLD_WORDS);
    if (found) hits.push(`  ${rel}:${idx + 1}: ${found.join(', ')}`);
  });
}

if (hits.length) {
  console.error('role copy guard: the old tier words found in text people can read:\n' + hits.join('\n'));
  console.error('\nSay "Super Administrator" (was Global Admin) and "Administrator" (was IT Admin);');
  console.error('plural "Super Administrators". Role keys (owner, administrator, global_admins) stay.');
  console.error('See frontend/scripts/check-role-copy.mjs.');
  process.exit(1);
}
console.log('role copy guard: ok');
