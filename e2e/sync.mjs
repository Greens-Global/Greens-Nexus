// Pull AI-generated specs from the dev Testing module into tests/generated/.
// Specs live in the qa_test_cases table (no commit loop: record → generate in
// the app, CI picks them up here on its next run). Skips gracefully when the
// secrets aren't configured so the committed smoke specs still run.
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';

const API = process.env.NEXUS_DEV_API_URL || '';
const TOKEN = process.env.NEXUS_QA_CI_TOKEN || '';
const OUT = new URL('./tests/generated/', import.meta.url);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

if (!API || !TOKEN) {
  console.log('[sync] NEXUS_DEV_API_URL / NEXUS_QA_CI_TOKEN not set — running committed specs only.');
  process.exit(0);
}

const res = await fetch(`${API}/qa/e2e-specs`, { headers: { 'X-QA-CI-Token': TOKEN } });
if (!res.ok) {
  console.error(`[sync] ${API}/qa/e2e-specs → ${res.status}; running committed specs only.`);
  process.exit(0);
}
const specs = await res.json();
for (const s of specs) {
  writeFileSync(new URL(`./${s.id}.spec.mjs`, OUT),
    s.spec.replaceAll("from '../helpers.mjs'", "from '../../helpers.mjs'"));
}
console.log(`[sync] wrote ${specs.length} generated spec(s).`);
